// @ts-check
// The sidecar: the part of the plugin that may open sockets and write files.
//
// The worker starts it with Orca's own Node (ELECTRON_RUN_AS_NODE=1) and without the
// worker's permission flags (README, "Where each part runs"). It reads one JSON request
// on stdin, writes JSON lines on stdout, and exits when the request is done or when
// stdin closes (the worker went away).
import { homedir } from 'node:os'
import { rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { parseSidecarRequest } from '../src/sidecar/messages.mjs'
import { createImapProvider } from '../src/providers/imap/provider.mjs'
import { createRecordStore, buildSnapshot, resolveDataDir } from '../src/sync/record-store.mjs'
import { runSync } from '../src/sync/run-sync.mjs'
import { createRateLimiter } from '../src/domain/backoff.mjs'
import { startLoopbackServer, renderPasswordPage, renderMessagePage, openCommandFor } from '../src/sidecar/loopback.mjs'

/** @typedef {import('../src/sidecar/messages.mjs').SidecarEvent} SidecarEvent */

const PAGE_SIZE = 200
/** IMAP has no published quota; a few page requests per second keeps a shared cPanel host comfortable. */
const PAGES_PER_SECOND = 4

/** @param {SidecarEvent} event */
function emit (event) {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

/**
 * Exits once everything written to stdout has been flushed: pipe writes are
 * asynchronous, and exiting earlier can drop the last snapshot and the `done` line.
 * @param {number} code
 */
function finish (code) {
  process.stdout.write('', () => process.exit(code))
}

/** @param {unknown} error */
function kindOf (error) {
  const kind = /** @type {{ kind?: unknown }} */ (error)?.kind
  return typeof kind === 'string' ? kind : 'internal'
}

/** @param {unknown} error */
function messageOf (error) {
  return String(/** @type {Error} */ (error)?.message ?? error).slice(0, 500)
}

let stopping = false
process.stdin.on('end', () => { stopping = true })

const dataDir = resolveDataDir(process.env, homedir())

/** @param {import('../src/sidecar/messages.mjs').SidecarRequest} request */
async function handle (request) {
  switch (request.op) {
    case 'sync': {
      const { account, password, recentLimit } = request
      const store = createRecordStore(dataDir, account.id)
      const provider = createImapProvider(account, password)
      let lastSnapshotAt = 0
      const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms))
      await runSync({
        accountId: account.id,
        provider,
        store,
        pageSize: PAGE_SIZE,
        now: Date.now,
        sleep,
        limiter: createRateLimiter({ unitsPerSecond: PAGES_PER_SECOND, now: Date.now, sleep }),
        shouldStop: () => stopping,
        onPage: (state) => {
          // Replaying the log every page is what keeps the snapshot honest; pace it.
          const now = Date.now()
          if (now - lastSnapshotAt < 1500 && state.phase === 'syncing') return
          lastSnapshotAt = now
          emit({ type: 'snapshot', accountId: account.id, snapshot: buildSnapshot(store.loadRecords(), state, recentLimit, now) })
        }
      })
      emit({ type: 'snapshot', accountId: account.id, snapshot: buildSnapshot(store.loadRecords(), store.loadState(), recentLimit, Date.now()) })
      emit({ type: 'done', accountId: account.id })
      return
    }
    case 'remove': {
      const store = createRecordStore(dataDir, request.accountId)
      rmSync(store.dir, { recursive: true, force: true })
      emit({ type: 'removed', accountId: request.accountId })
      return
    }
    case 'credential': {
      await collectPassword(request.account, request.timeoutMs)
    }
  }
}

/**
 * Opens a password form in the system browser, tests the password against the server
 * and hands it to the worker, which keeps it in the plugin's secrets.
 * @param {import('../src/sidecar/messages.mjs').ImapAccountConfig} account
 * @param {number} timeoutMs
 */
async function collectPassword (account, timeoutMs) {
  /** @type {(error: Error | null) => void} */
  let settle = () => {}
  const outcome = new Promise((resolve, reject) => {
    settle = (error) => error ? reject(error) : resolve(undefined)
  })
  let finished = false
  const server = await startLoopbackServer(async (req) => {
    const view = { label: account.label, username: account.username, host: account.host, action: req.url }
    if (finished) return { status: 410, html: renderMessagePage('Already done', 'You can close this tab.') }
    if (req.method !== 'POST') return { status: 200, html: renderPasswordPage({ ...view, error: null }) }
    const password = req.body.password ?? ''
    if (password === '') return { status: 200, html: renderPasswordPage({ ...view, error: 'Enter the password.' }) }
    const provider = createImapProvider(account, password, { timeoutMs: 20000 })
    try {
      await provider.connect()
      const folders = await provider.listFolders()
      finished = true
      emit({ type: 'credential', accountId: account.id, password, folders: folders.length })
      setTimeout(() => settle(null), 200)
      return { status: 200, html: renderMessagePage('Connected', `Found ${folders.length} folders. You can close this tab and go back to Orca.`) }
    } catch (error) {
      const text = kindOf(error) === 'auth'
        ? 'The server rejected this password. Check it, or use an app password.'
        : `Could not connect: ${messageOf(error)}`
      return { status: 200, html: renderPasswordPage({ ...view, error: text }) }
    } finally {
      await provider.close().catch(() => {})
    }
  })
  emit({ type: 'waiting', accountId: account.id, url: server.url })
  const opener = openCommandFor(process.platform, server.url)
  spawn(opener.cmd, opener.args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
  const timer = setTimeout(() => {
    finished = true
    settle(Object.assign(new Error('nobody completed the sign-in page in time'), { kind: 'timeout' }))
  }, timeoutMs)
  const watch = setInterval(() => {
    if (stopping) settle(Object.assign(new Error('cancelled'), { kind: 'cancelled' }))
  }, 500)
  try {
    await outcome
  } finally {
    clearTimeout(timer)
    clearInterval(watch)
    server.close()
  }
}

let input = ''
process.stdin.setEncoding('utf8')
let started = false
process.stdin.on('data', (chunk) => {
  // Keep reading after the request so 'end' fires when the worker goes away.
  if (started) return
  input += chunk
  const newline = input.indexOf('\n')
  if (newline === -1) return
  started = true
  const parsed = parseSidecarRequest(input.slice(0, newline))
  input = ''
  if (!parsed.ok) {
    emit({ type: 'error', accountId: null, kind: 'input', message: parsed.reason })
    finish(2)
    return
  }
  const accountId = 'account' in parsed.request ? parsed.request.account.id : parsed.request.accountId
  handle(parsed.request).then(
    () => finish(0),
    (error) => {
      emit({ type: 'error', accountId, kind: kindOf(error), message: messageOf(error) })
      finish(1)
    }
  )
})
