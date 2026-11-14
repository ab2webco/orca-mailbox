// @ts-check
// Worker-side decisions that need no host: validating what the panel sends, the
// account list, secret names and how the sidecar is started.

/** @typedef {import('../domain/message.mjs').ProviderKind} ProviderKind */

/**
 * What the worker keeps in host storage per account. Never a password or token.
 * @typedef {object} AccountConfig
 * @property {string} id
 * @property {'imap'} provider
 * @property {string} label
 * @property {string} host
 * @property {number} port
 * @property {string} username
 * @property {string[]} trashFallbacks
 * @property {number} addedAt
 */

/** Common Trash names when a server lacks SPECIAL-USE (cPanel/Dovecot, Exchange, Apple). */
const DEFAULT_TRASH_FALLBACKS = ['Trash', 'INBOX.Trash', 'Deleted Items', 'Deleted Messages']
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

/** @param {unknown} v */
const text = (v) => typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''

/**
 * @param {unknown} input
 * @returns {{ ok: true, value: Omit<AccountConfig, 'id' | 'provider' | 'addedAt'> } | { ok: false, errors: Record<string, string> }}
 */
export function validateImapInput (input) {
  if (typeof input !== 'object' || input === null) return { ok: false, errors: { form: 'Nothing was sent.' } }
  const raw = /** @type {Record<string, unknown>} */ (input)
  /** @type {Record<string, string>} */
  const errors = {}
  if ('password' in raw) {
    errors.password = 'Passwords are typed in the browser page, never in the panel.'
  }
  const label = text(raw.label)
  if (label === '' || label.length > 60) errors.label = 'Give the account a name (up to 60 characters).'
  const host = text(raw.host).toLowerCase()
  if (!HOST.test(host)) errors.host = 'Enter the IMAP server name, for example mail.example.com.'
  const port = Number(text(raw.port))
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.port = 'Enter a port between 1 and 65535 (usually 993).'
  const username = text(raw.username)
  if (username === '' || username.length > 254 || /[\r\n]/.test(username)) errors.username = 'Enter the username, usually the full email address.'
  const trash = text(raw.trashFolder)
  if (trash.length > 200 || /[\r\n]/.test(trash)) errors.trashFolder = 'The Trash folder name is too long.'
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  const trashFallbacks = trash === '' ? DEFAULT_TRASH_FALLBACKS : [trash, ...DEFAULT_TRASH_FALLBACKS.filter((t) => t !== trash)]
  return { ok: true, value: { label, host, port, username, trashFallbacks } }
}

/**
 * @param {ProviderKind} provider
 * @param {() => string} randomHex
 */
export function newAccountId (provider, randomHex) {
  return `${provider}-${randomHex().toLowerCase().replace(/[^a-f0-9]/g, '').slice(0, 16)}`
}

/**
 * @param {AccountConfig[]} list
 * @param {AccountConfig} account
 */
export function upsertAccount (list, account) {
  return list.some((a) => a.id === account.id)
    ? list.map((a) => a.id === account.id ? account : a)
    : [...list, account]
}

/**
 * @param {AccountConfig[]} list
 * @param {string} id
 */
export function removeAccount (list, id) {
  return list.filter((a) => a.id !== id)
}

/** @param {string} accountId */
export function passwordSecretKey (accountId) {
  return `password:${accountId}`
}

export const PANEL_ACTIONS = /** @type {const} */ (['add-imap', 'remove', 'sync', 'cancel'])
/** A request older than this is a leftover from a closed panel, not something to do now. */
const REQUEST_MAX_AGE_MS = 2 * 60_000

/**
 * @typedef {{ id: string, action: typeof PANEL_ACTIONS[number], payload: Record<string, unknown>, at: number }} PanelRequest
 */

/**
 * @param {unknown} value
 * @param {number} nowMs
 * @returns {{ ok: true, request: PanelRequest } | { ok: false, reason: string }}
 */
export function parsePanelRequest (value, nowMs) {
  if (typeof value !== 'object' || value === null) return { ok: false, reason: 'no request' }
  const r = /** @type {Record<string, unknown>} */ (value)
  if (typeof r.id !== 'string' || r.id === '' || r.id.length > 64) return { ok: false, reason: 'request without id' }
  const action = PANEL_ACTIONS.find((a) => a === r.action)
  if (!action) return { ok: false, reason: `unknown action ${String(r.action)}` }
  if (typeof r.at !== 'number' || nowMs - r.at > REQUEST_MAX_AGE_MS) return { ok: false, reason: 'stale request' }
  const payload = typeof r.payload === 'object' && r.payload !== null ? /** @type {Record<string, unknown>} */ (r.payload) : {}
  return { ok: true, request: { id: r.id, action, payload, at: r.at } }
}

/**
 * The worker runs under Node's permission model; a child started plainly inherits
 * it (no file writes). Dropping NODE_OPTIONS starts the sidecar without it, the
 * pattern orca-wa-inbox ships. Windows has no /usr/bin/env: untested there.
 *
 * @param {NodeJS.Platform} platform
 * @param {string} execPath
 * @param {string} script
 */
export function sidecarSpawnCommand (platform, execPath, script) {
  if (platform === 'win32') return { cmd: execPath, args: [script] }
  return { cmd: '/usr/bin/env', args: ['-u', 'NODE_OPTIONS', execPath, script] }
}
