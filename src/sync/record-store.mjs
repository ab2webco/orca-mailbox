// @ts-check
// Where synced metadata lives: one directory per account under the plugin's data
// directory, written by the sidecar. Host storage cannot hold it (5 MiB per plugin,
// 256 KiB per value) and the worker cannot write files, so only a small snapshot of
// each account goes to host storage for the panels.
//
//   <dataDir>/<accountId>/records.jsonl  append-only log: {op:'put',record} | {op:'reset',folder}
//   <dataDir>/<accountId>/state.json     SyncState, rewritten atomically after every page
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { summarize, recentFirst } from '../domain/message.mjs'
import { progressOf } from '../domain/sync-state.mjs'

/** @typedef {import('../domain/message.mjs').MessageRecord} MessageRecord */
/** @typedef {import('../domain/sync-state.mjs').SyncState} SyncState */

/** The panel bridge allows 64 KB per message; the snapshot leaves room for the envelope. */
export const SNAPSHOT_MAX_BYTES = 48 * 1024

const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} home
 */
export function resolveDataDir (env, home) {
  const userData = env.ORCA_USER_DATA_PATH
  return userData
    ? join(userData, 'plugins-data', 'ab2web.orca-mail-inbox', 'mail')
    : join(home, '.orca-mail-inbox')
}

/**
 * @param {string} text
 * @returns {Map<string, MessageRecord>}
 */
export function replayLog (text) {
  /** @type {Map<string, MessageRecord>} */
  const records = new Map()
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    /** @type {{ op?: string, record?: MessageRecord, folder?: string }} */
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      // A line torn by a crash mid-write; every line after it is still whole.
      continue
    }
    if (entry.op === 'put' && entry.record) records.set(entry.record.key, entry.record)
    else if (entry.op === 'reset' && typeof entry.folder === 'string') {
      for (const [key, r] of records) if (r.folder === entry.folder) records.delete(key)
    }
  }
  return records
}

/**
 * @param {string} dataDir
 * @param {string} accountId
 */
export function createRecordStore (dataDir, accountId) {
  if (!ACCOUNT_ID.test(accountId)) throw new RangeError(`invalid account id: ${accountId}`)
  const dir = join(dataDir, accountId)
  const logPath = join(dir, 'records.jsonl')
  const statePath = join(dir, 'state.json')
  const ensure = () => mkdirSync(dir, { recursive: true, mode: 0o700 })
  /** @param {string} path @param {string} text */
  const atomicWrite = (path, text) => {
    ensure()
    writeFileSync(`${path}.tmp`, text, { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
  }

  return {
    dir,

    /** @returns {SyncState | null} */
    loadState () {
      if (!existsSync(statePath)) return null
      try {
        return JSON.parse(readFileSync(statePath, 'utf8'))
      } catch {
        return null
      }
    },

    /** @param {SyncState} state */
    saveState (state) {
      atomicWrite(statePath, JSON.stringify(state))
    },

    /**
     * @param {string} folder
     * @param {MessageRecord[]} records
     * @param {boolean} reset  Drop the folder's earlier records first (UIDVALIDITY changed).
     */
    appendPage (folder, records, reset) {
      const lines = []
      if (reset) lines.push(JSON.stringify({ op: 'reset', folder }))
      for (const record of records) lines.push(JSON.stringify({ op: 'put', record }))
      if (lines.length === 0) return
      ensure()
      // Leading newline: if a crash tore the previous line, this one still starts clean.
      appendFileSync(logPath, `\n${lines.join('\n')}`, { mode: 0o600 })
    },

    /** @returns {Map<string, MessageRecord>} */
    loadRecords () {
      return existsSync(logPath) ? replayLog(readFileSync(logPath, 'utf8')) : new Map()
    },

    /** Rewrites the log with one line per live record. */
    compact () {
      const records = existsSync(logPath) ? replayLog(readFileSync(logPath, 'utf8')) : new Map()
      atomicWrite(logPath, [...records.values()].map((record) => JSON.stringify({ op: 'put', record })).join('\n'))
    }
  }
}

/** @param {string} text @param {number} max */
const trim = (text, max) => text.length > max ? text.slice(0, max) : text

/**
 * What the panel shows for one account. Fits in SNAPSHOT_MAX_BYTES by dropping the
 * oldest of the recent messages, never by cutting totals.
 *
 * @param {Map<string, MessageRecord>} records
 * @param {SyncState | null} state
 * @param {number} recentLimit
 * @param {number} nowMs
 */
export function buildSnapshot (records, state, recentLimit, nowMs) {
  const base = {
    totals: summarize(records.values()).overall,
    progress: state ? progressOf(state) : null,
    phase: state ? state.phase : 'idle',
    error: state ? state.error : null,
    updatedAt: nowMs
  }
  let budget = SNAPSHOT_MAX_BYTES - Buffer.byteLength(JSON.stringify({ ...base, recent: [] }))
  const recent = []
  for (const r of recentFirst(records.values(), recentLimit)) {
    const entry = {
      key: r.key,
      folder: trim(r.folder, 120),
      from: r.from ? { name: trim(r.from.name, 120), address: trim(r.from.address, 120) } : null,
      subject: trim(r.subject, 200),
      dateMs: r.dateMs,
      sizeBytes: r.sizeBytes,
      unread: r.unread
    }
    budget -= Buffer.byteLength(JSON.stringify(entry)) + 1
    if (budget < 0) break
    recent.push(entry)
  }
  return { ...base, recent }
}
