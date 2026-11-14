// @ts-check
// Worker <-> sidecar protocol: one JSON request on stdin, JSON lines on stdout.
// Both sides validate what they receive; neither trusts the other's shapes.

/** @typedef {import('../providers/imap/provider.mjs').ImapAccount & { label: string }} ImapAccountConfig */

/**
 * @typedef {{ op: 'sync', account: ImapAccountConfig, password: string, recentLimit: number }
 *   | { op: 'credential', account: ImapAccountConfig, timeoutMs: number }
 *   | { op: 'snapshot', accountId: string, recentLimit: number }
 *   | { op: 'remove', accountId: string }} SidecarRequest
 */

/**
 * @typedef {{ type: 'snapshot', accountId: string, snapshot: ReturnType<typeof import('../sync/record-store.mjs').buildSnapshot> }
 *   | { type: 'waiting', accountId: string, url: string }
 *   | { type: 'credential', accountId: string, password: string, folders: number }
 *   | { type: 'done', accountId: string }
 *   | { type: 'removed', accountId: string }
 *   | { type: 'error', accountId: string | null, kind: string, message: string }} SidecarEvent
 */

export const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const HOST_PATTERN = /^[A-Za-z0-9.-]{1,253}$/

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
/** @param {unknown} v @returns {v is string} */
const isText = (v) => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\r\n]/.test(v)

/**
 * @param {unknown} value
 * @returns {ImapAccountConfig | null}
 */
export function asImapAccount (value) {
  if (!isObject(value)) return null
  const { id, label, host, port, username, trashFallbacks } = value
  if (typeof id !== 'string' || !ACCOUNT_ID_PATTERN.test(id)) return null
  if (!isText(label) || !isText(username)) return null
  if (typeof host !== 'string' || !HOST_PATTERN.test(host)) return null
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null
  if (!Array.isArray(trashFallbacks) || !trashFallbacks.every(isText)) return null
  return { id, label, host, port, username, trashFallbacks: [...trashFallbacks] }
}

/** @param {unknown} v */
const isLimit = (v) => typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 1000

/**
 * @param {string} line
 * @returns {{ ok: true, request: SidecarRequest } | { ok: false, reason: string }}
 */
export function parseSidecarRequest (line) {
  /** @type {unknown} */
  let value
  try {
    value = JSON.parse(line)
  } catch {
    return { ok: false, reason: 'request is not valid JSON' }
  }
  if (!isObject(value)) return { ok: false, reason: 'request is not an object' }
  switch (value.op) {
    case 'sync': {
      const account = asImapAccount(value.account)
      if (!account) return { ok: false, reason: 'sync: invalid account' }
      if (typeof value.password !== 'string' || value.password === '') return { ok: false, reason: 'sync: missing password' }
      if (!isLimit(value.recentLimit)) return { ok: false, reason: 'sync: invalid recentLimit' }
      return { ok: true, request: { op: 'sync', account, password: value.password, recentLimit: Number(value.recentLimit) } }
    }
    case 'credential': {
      const account = asImapAccount(value.account)
      if (!account) return { ok: false, reason: 'credential: invalid account' }
      const timeoutMs = typeof value.timeoutMs === 'number' && value.timeoutMs > 0 ? value.timeoutMs : 300000
      return { ok: true, request: { op: 'credential', account, timeoutMs } }
    }
    case 'snapshot':
      if (typeof value.accountId !== 'string' || !ACCOUNT_ID_PATTERN.test(value.accountId)) return { ok: false, reason: 'snapshot: invalid accountId' }
      if (!isLimit(value.recentLimit)) return { ok: false, reason: 'snapshot: invalid recentLimit' }
      return { ok: true, request: { op: 'snapshot', accountId: value.accountId, recentLimit: Number(value.recentLimit) } }
    case 'remove':
      if (typeof value.accountId !== 'string' || !ACCOUNT_ID_PATTERN.test(value.accountId)) return { ok: false, reason: 'remove: invalid accountId' }
      return { ok: true, request: { op: 'remove', accountId: value.accountId } }
    default:
      return { ok: false, reason: `unknown op: ${String(value.op)}` }
  }
}

const EVENT_TYPES = new Set(['snapshot', 'waiting', 'credential', 'done', 'removed', 'error'])

/**
 * @param {string} line
 * @returns {SidecarEvent | null}  Null for anything that is not an event (warnings, noise).
 */
export function parseSidecarEvent (line) {
  if (!line.startsWith('{')) return null
  try {
    const value = JSON.parse(line)
    return isObject(value) && typeof value.type === 'string' && EVENT_TYPES.has(value.type)
      ? /** @type {SidecarEvent} */ (value)
      : null
  } catch {
    return null
  }
}
