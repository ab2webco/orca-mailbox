// @ts-check
// Mailbox worker. It runs inside Orca's plugin sandbox: no sockets and no file
// writes (README, "Where each part runs"). It is the bridge between three things:
//   - the panels, which can only read and write host storage;
//   - the plugin's secrets (passwords), which only the worker can touch;
//   - the sidecar, which holds the IMAP connection and the on-disk record store.
//
// Panel -> worker: the panel writes `request` and runs `mailbox.request`.
// Worker -> panel: `accounts`, `requestResult`, `pending`, `status:<id>`, `snapshot:<id>`.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  validateImapInput,
  newAccountId,
  upsertAccount,
  removeAccount,
  parsePanelRequest,
  passwordSecretKey,
  sidecarSpawnCommand
} from './src/worker/accounts.mjs'
import { parseSidecarEvent } from './src/sidecar/messages.mjs'

/** @typedef {import('./src/worker/accounts.mjs').AccountConfig} AccountConfig */
/** @typedef {import('./src/sidecar/messages.mjs').SidecarEvent} SidecarEvent */
/** @typedef {import('./src/sidecar/messages.mjs').SidecarRequest} SidecarRequest */

/**
 * The object Orca hands to activate (orca-oss src/main/plugins/plugin-host-runtime.ts).
 * @typedef {object} OrcaWorkerApi
 * @property {{ register: (id: string, handler: (args: unknown) => Promise<unknown>) => void }} commands
 * @property {{ call: (method: string, params?: Record<string, unknown>) => Promise<unknown> }} host
 * @property {(message: string) => void} log
 */

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const SIDECAR = join(PLUGIN_DIR, 'sidecar', 'mail-sidecar.mjs')
const RECENT_LIMIT = 50
const CREDENTIAL_TIMEOUT_MS = 5 * 60_000

export const KEYS = Object.freeze({
  accounts: 'accounts',
  request: 'request',
  result: 'requestResult',
  pending: 'pending',
  /** @param {string} id */
  status: (id) => `status:${id}`,
  /** @param {string} id */
  snapshot: (id) => `snapshot:${id}`
})

/** Every child still running, so deactivate can stop them. */
const children = new Set()

/**
 * @param {OrcaWorkerApi} orca
 */
export default function activate (orca) {
  /** @type {Map<string, import('node:child_process').ChildProcess>} */
  const syncing = new Map()
  /** @type {{ accountId: string, child: import('node:child_process').ChildProcess } | null} */
  let credentialFlow = null

  // Writes are chained: two storage.set in flight may resolve out of order, and the
  // later one must not be overwritten by the earlier (orca-wa-inbox learned this live).
  let chain = Promise.resolve()
  /** @param {string} key @param {unknown} value */
  const put = (key, value) => {
    chain = chain.then(() => orca.host.call('storage.set', { key, value }))
      .then(() => {}, (error) => orca.log(`storage.set ${key} failed: ${error?.message}`))
    return chain
  }
  /** @param {string} key */
  const drop = (key) => {
    chain = chain.then(() => orca.host.call('storage.delete', { key }))
      .then(() => {}, (error) => orca.log(`storage.delete ${key} failed: ${error?.message}`))
    return chain
  }
  /** @param {string} key @returns {Promise<unknown>} */
  const get = async (key) => {
    await chain
    const result = /** @type {{ value?: unknown } | null} */ (await orca.host.call('storage.get', { key }).catch(() => null))
    return result?.value ?? null
  }
  const accounts = async () => {
    const value = await get(KEYS.accounts)
    return Array.isArray(value) ? /** @type {AccountConfig[]} */ (value) : []
  }

  /**
   * @param {SidecarRequest} request
   * @param {(event: SidecarEvent) => void} onEvent
   * @param {(code: number | null, stderr: string) => void} onExit
   */
  function startSidecar (request, onEvent, onExit) {
    const command = sidecarSpawnCommand(process.platform, process.execPath, SIDECAR)
    const child = spawn(command.cmd, command.args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    children.add(child)
    let buffer = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const event = parseSidecarEvent(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        if (event) {
          try { onEvent(event) } catch (error) { orca.log(`sidecar event failed: ${/** @type {Error} */ (error).message}`) }
        }
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000) })
    child.on('error', (error) => { stderr += error.message })
    child.on('close', (code) => {
      children.delete(child)
      onExit(code, stderr)
    })
    // The request goes over stdin, never argv or env: it may carry a password.
    // stdin stays open; closing it is how the worker tells the sidecar to stop.
    child.stdin?.write(`${JSON.stringify(request)}\n`)
    return child
  }

  /** @param {AccountConfig} account */
  async function syncAccount (account) {
    if (syncing.has(account.id)) return
    const secret = /** @type {{ value: string | null } | null} */ (await orca.host.call('secrets.get', { key: passwordSecretKey(account.id) }).catch(() => null))
    if (!secret?.value) {
      await put(KEYS.status(account.id), { running: false, error: { kind: 'auth', message: 'No saved password. Remove the account and add it again.' }, at: Date.now() })
      return
    }
    await put(KEYS.status(account.id), { running: true, error: null, at: Date.now() })
    /** @type {{ kind: string, message: string } | null} */
    let failure = null
    const child = startSidecar(
      { op: 'sync', account: { ...account }, password: secret.value, recentLimit: RECENT_LIMIT },
      (event) => {
        if (event.type === 'snapshot' && event.accountId === account.id) void put(KEYS.snapshot(account.id), event.snapshot)
        if (event.type === 'error') failure = { kind: event.kind, message: event.message }
      },
      (code, stderr) => {
        syncing.delete(account.id)
        if (code !== 0 && !failure) failure = { kind: 'internal', message: stderr.trim().split('\n').pop() || `sidecar exited with ${code}` }
        void put(KEYS.status(account.id), { running: false, error: failure, at: Date.now() })
      }
    )
    syncing.set(account.id, child)
  }

  async function syncAll () {
    for (const account of await accounts()) await syncAccount(account)
  }

  /**
   * @param {string} requestId
   * @param {Record<string, unknown>} payload
   */
  async function addImap (requestId, payload) {
    const checked = validateImapInput(payload)
    if (!checked.ok) {
      await put(KEYS.result, { requestId, ok: false, message: 'Check the highlighted fields.', errors: checked.errors, at: Date.now() })
      return
    }
    if (credentialFlow) {
      await put(KEYS.result, { requestId, ok: false, message: 'Another sign-in page is already open. Finish or cancel it first.', at: Date.now() })
      return
    }
    /** @type {AccountConfig} */
    const account = { id: newAccountId('imap', () => randomBytes(8).toString('hex')), provider: 'imap', addedAt: Date.now(), ...checked.value }
    await put(KEYS.pending, { accountId: account.id, label: account.label, state: 'starting', url: null, message: null, at: Date.now() })
    await put(KEYS.result, { requestId, ok: true, message: 'Opening the sign-in page in your browser.', at: Date.now() })
    let succeeded = false
    // Keeps the worker from idling out while the person types in the browser.
    const keepAlive = setInterval(() => { void get(KEYS.pending) }, 60_000)
    const child = startSidecar(
      { op: 'credential', account: { ...account }, timeoutMs: CREDENTIAL_TIMEOUT_MS },
      (event) => {
        if (event.type === 'waiting') {
          void put(KEYS.pending, { accountId: account.id, label: account.label, state: 'waiting', url: event.url, message: null, at: Date.now() })
        } else if (event.type === 'credential' && event.accountId === account.id) {
          succeeded = true
          void (async () => {
            await orca.host.call('secrets.set', { key: passwordSecretKey(account.id), value: event.password })
            await put(KEYS.accounts, upsertAccount(await accounts(), account))
            await drop(KEYS.pending)
            await syncAccount(account)
          })().catch((error) => {
            void put(KEYS.pending, { accountId: account.id, label: account.label, state: 'error', url: null, message: `Could not save the password: ${error?.message}`, at: Date.now() })
          })
        } else if (event.type === 'error') {
          const message = event.kind === 'timeout' ? 'The sign-in page was not completed in 5 minutes.' : event.kind === 'cancelled' ? 'Cancelled.' : event.message
          void put(KEYS.pending, { accountId: account.id, label: account.label, state: 'error', url: null, message, at: Date.now() })
        }
      },
      () => {
        clearInterval(keepAlive)
        credentialFlow = null
        if (!succeeded) void get(KEYS.pending).then((p) => {
          const pending = /** @type {{ state?: string } | null} */ (p)
          if (pending && pending.state !== 'error') void put(KEYS.pending, { accountId: account.id, label: account.label, state: 'error', url: null, message: 'The sign-in helper stopped.', at: Date.now() })
        })
      }
    )
    credentialFlow = { accountId: account.id, child }
  }

  /** @param {string} requestId @param {string} accountId */
  async function remove (requestId, accountId) {
    const list = await accounts()
    if (!list.some((a) => a.id === accountId)) {
      await put(KEYS.result, { requestId, ok: false, message: 'That account is not connected.', at: Date.now() })
      return
    }
    syncing.get(accountId)?.stdin?.end()
    await orca.host.call('secrets.delete', { key: passwordSecretKey(accountId) }).catch(() => {})
    await put(KEYS.accounts, removeAccount(list, accountId))
    await drop(KEYS.snapshot(accountId))
    await drop(KEYS.status(accountId))
    // Only the synced copy on this computer is deleted; the mailbox is not touched.
    startSidecar({ op: 'remove', accountId }, () => {}, () => {})
    await put(KEYS.result, { requestId, ok: true, message: 'Account removed from this computer. Your mailbox was not changed.', at: Date.now() })
  }

  async function handleRequest () {
    const raw = await get(KEYS.request)
    await drop(KEYS.request)
    const parsed = parsePanelRequest(raw, Date.now())
    if (!parsed.ok) {
      orca.log(`panel request ignored: ${parsed.reason}`)
      return
    }
    const { id, action, payload } = parsed.request
    if (action === 'add-imap') await addImap(id, payload)
    else if (action === 'remove' && typeof payload.accountId === 'string') await remove(id, payload.accountId)
    else if (action === 'sync') {
      // The panel works on one account at a time; so does its Sync button.
      const account = (await accounts()).find((a) => a.id === payload.accountId)
      if (!account) {
        await put(KEYS.result, { requestId: id, ok: false, message: 'That account is not connected.', at: Date.now() })
        return
      }
      await syncAccount(account)
      await put(KEYS.result, { requestId: id, ok: true, message: 'Sync started.', at: Date.now() })
    } else if (action === 'cancel') {
      credentialFlow?.child.stdin?.end()
      await drop(KEYS.pending)
    }
  }

  orca.commands.register('mailbox.request', async () => {
    // Commands time out after 30 s; the work goes on in the background.
    void handleRequest().catch((error) => orca.log(`request failed: ${error?.message}`))
    return { ok: true }
  })
  orca.commands.register('mailbox.sync', async () => {
    void syncAll().catch((error) => orca.log(`sync failed: ${error?.message}`))
    return { ok: true }
  })
}

export function deactivate () {
  for (const child of children) {
    child.stdin?.end()
    setTimeout(() => child.kill('SIGTERM'), 1500).unref()
  }
}
