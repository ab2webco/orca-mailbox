// @ts-check
// From parsed IMAP responses to the normalized record, plus the page plan that walks
// a folder newest first. Pure.

/** @typedef {import('./protocol.mjs').Token} Token */
/** @typedef {import('../../domain/sync-state.mjs').Folder} Folder */
/** @typedef {import('../../domain/sync-state.mjs').FolderRole} FolderRole */
/** @typedef {import('../../domain/message.mjs').MessageInput} MessageInput */
/** @typedef {import('../../domain/message.mjs').Address} Address */

/**
 * Modified UTF-7 (RFC 3501 §5.1.3) to a display string.
 * @param {string} raw
 */
export function decodeMailboxName (raw) {
  return raw.replace(/&([^-]*)-/g, (_, encoded) => {
    if (encoded === '') return '&'
    const bytes = Buffer.from(encoded.replace(/,/g, '/'), 'base64')
    let out = ''
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1])
    }
    return out
  })
}

/**
 * @param {string} charset
 * @param {Uint8Array} bytes
 * @returns {string | null}
 */
function decodeCharset (charset, bytes) {
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes)
  } catch {
    return null
  }
}

/** @param {string} text */
function qBytes (text) {
  /** @type {number[]} */
  const out = []
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (c === '_') out.push(0x20)
    else if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      out.push(parseInt(text.slice(i + 1, i + 3), 16))
      i += 2
    } else out.push(c.charCodeAt(0) & 0xff)
  }
  return Uint8Array.from(out)
}

const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g

/**
 * RFC 2047 encoded words. A word in an unknown charset is left as it came.
 * @param {string} value
 */
export function decodeHeaderWords (value) {
  const joined = value.replace(/(\?=)\s+(=\?)/g, '$1$2')
  return joined.replace(ENCODED_WORD, (whole, charset, encoding, text) => {
    const bytes = encoding.toUpperCase() === 'B' ? Buffer.from(text, 'base64') : qBytes(text)
    return decodeCharset(charset.replace(/\*.*$/, ''), bytes) ?? whole
  })
}

/** @type {Record<string, FolderRole>} */
const SPECIAL_USE = {
  '\\TRASH': 'trash',
  '\\SENT': 'sent',
  '\\DRAFTS': 'drafts',
  '\\JUNK': 'junk',
  '\\ARCHIVE': 'archive',
  '\\ALL': 'all'
}

/**
 * @param {{ flags: string[], name: string }} list  A parsed LIST response.
 * @param {string[]} trashFallbacks  Names to treat as Trash when the server has no SPECIAL-USE.
 * @returns {Folder | null}  Null for a mailbox that cannot be selected.
 */
export function folderFromList (list, trashFallbacks) {
  const flags = list.flags.map((f) => f.toUpperCase())
  if (flags.includes('\\NOSELECT') || flags.includes('\\NONEXISTENT')) return null
  /** @type {FolderRole | null} */
  let role = null
  for (const flag of flags) {
    if (SPECIAL_USE[flag]) role = SPECIAL_USE[flag]
  }
  if (role === null && list.name.toUpperCase() === 'INBOX') role = 'inbox'
  if (role === null && trashFallbacks.includes(list.name)) role = 'trash'
  return { id: list.name, name: decodeMailboxName(list.name), role }
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

/**
 * INTERNALDATE ("17-Jul-1996 02:44:25 -0700") to ISO 8601, or '' if unreadable.
 * @param {Token | undefined} value
 */
function internalDateToIso (value) {
  if (typeof value !== 'string') return ''
  const m = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(value)
  if (!m) return ''
  const month = MONTHS.indexOf(m[2].toUpperCase())
  if (month === -1) return ''
  const offset = (m[7] === '-' ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9]))
  const utc = Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])) - offset * 60000
  return new Date(utc).toISOString()
}

/** @param {Token | undefined} value */
function envelopeDateToIso (value) {
  if (typeof value !== 'string') return ''
  const parsed = Date.parse(value.replace(/\s*\([^)]*\)\s*$/, ''))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : ''
}

/**
 * @param {Token | undefined} value  An ENVELOPE address list.
 * @returns {Address[]}
 */
function addresses (value) {
  if (!Array.isArray(value)) return []
  /** @type {Address[]} */
  const out = []
  for (const entry of value) {
    if (!Array.isArray(entry)) continue
    const [name, , mailbox, host] = entry
    // RFC 9051 group syntax: a null host opens or closes a group; it is not an address.
    if (typeof host !== 'string' || typeof mailbox !== 'string') continue
    out.push({ name: typeof name === 'string' ? decodeHeaderWords(name) : '', address: `${mailbox}@${host}` })
  }
  return out
}

/**
 * @param {{ attributes: Record<string, Token> }} fetch  A parsed FETCH response.
 * @param {{ accountId: string, folder: string, uidValidity: number }} context
 * @returns {MessageInput}
 */
export function envelopeToRecordInput (fetch, { accountId, folder, uidValidity }) {
  const a = fetch.attributes
  const envelope = Array.isArray(a.ENVELOPE) ? a.ENVELOPE : []
  const flags = Array.isArray(a.FLAGS) ? a.FLAGS.filter((f) => typeof f === 'string') : []
  const subject = typeof envelope[1] === 'string' ? decodeHeaderWords(envelope[1]) : ''
  return {
    accountId,
    provider: 'imap',
    id: `${folder}:${uidValidity}:${String(a.UID)}`,
    threadId: null,
    folder,
    from: addresses(envelope[2])[0] ?? null,
    to: addresses(envelope[5]),
    subject,
    date: internalDateToIso(a.INTERNALDATE) || envelopeDateToIso(envelope[0]),
    flags,
    labels: [],
    sizeBytes: Number(a['RFC822.SIZE'] ?? 0),
    snippet: ''
  }
}

/** @typedef {{ uidValidity: number, top: number, bottom: number }} ImapCursor */

/**
 * Which UIDs to fetch next. New mail above `top` goes first; then the backfill walks
 * down from `bottom`, newest first, so recent mail shows up early in a long sync.
 *
 * @param {ImapCursor | null} cursor
 * @param {{ uidValidity: number, uids: number[], pageSize: number }} folder
 * @returns {{ batch: number[], cursor: ImapCursor, done: boolean, reset: boolean }}
 */
export function planImapPage (cursor, { uidValidity, uids, pageSize }) {
  const reset = cursor !== null && cursor.uidValidity !== uidValidity
  const highest = uids.reduce((max, uid) => Math.max(max, uid), 0)
  const base = cursor === null || reset
    ? { uidValidity, top: highest, bottom: highest + 1 }
    : cursor
  const newer = uids.filter((u) => u > base.top).sort((x, y) => x - y)
  const older = uids.filter((u) => u < base.bottom).sort((x, y) => y - x)
  if (newer.length > 0) {
    const batch = newer.slice(0, pageSize)
    return {
      batch,
      cursor: { ...base, top: batch[batch.length - 1] },
      done: newer.length === batch.length && older.length === 0,
      reset
    }
  }
  const batch = older.slice(0, pageSize)
  return {
    batch,
    cursor: batch.length > 0 ? { ...base, bottom: batch[batch.length - 1] } : base,
    done: older.length === batch.length,
    reset
  }
}
