// @ts-check
// Building IMAP command bytes. encodeCommand is the only way a command reaches the
// socket (test/imap/commands.test.mjs checks client.mjs writes nowhere else), and it
// runs the safety guard first.
import { assertSafeImapCommand } from '../../domain/safety.mjs'
import { quoteString } from './protocol.mjs'

/**
 * Slice 1 only reads. Anything that could change a mailbox (SELECT, which lets later
 * fetches set \Seen; STORE, COPY, MOVE, APPEND, CREATE, DELETE, RENAME) is refused
 * here, so "read-only" is enforced rather than merely avoided. Slice 3 widens this
 * list next to its own guards.
 */
const READ_ONLY_VERBS = new Set(['CAPABILITY', 'LOGIN', 'AUTHENTICATE', 'LIST', 'EXAMINE', 'STATUS', 'SEARCH', 'FETCH', 'NOOP', 'LOGOUT'])
/** FETCH items that set \Seen (RFC 9051 §6.4.5): BODY[...] without .PEEK, RFC822, RFC822.TEXT. */
const MARKS_SEEN = /\bBODY\[|\bRFC822(?:\.TEXT)?(?![.\w])/i

/** @param {string} command */
function assertReadOnly (command) {
  const verb = command.trim().toUpperCase().replace(/^UID\s+/, '').split(/\s+/)[0]
  if (!READ_ONLY_VERBS.has(verb) || (verb === 'FETCH' && MARKS_SEEN.test(command))) {
    throw new Error(`IMAP command refused: this version is read-only (${verb})`)
  }
}

/**
 * @param {string} tag
 * @param {string} command  Without tag and without CRLF.
 * @param {{ selected: string | null, trash: string | null }} state
 * @returns {Buffer}
 */
export function encodeCommand (tag, command, state) {
  if (/[\r\n]/.test(command)) {
    throw new RangeError('IMAP command must be a single line')
  }
  assertSafeImapCommand(command, state)
  assertReadOnly(command)
  return Buffer.from(`${tag} ${command}\r\n`, 'utf8')
}

/**
 * SASL PLAIN carries any bytes in the password; LOGIN needs a quotable one. PLAIN is
 * only used in its one-line form, which needs SASL-IR (RFC 4959); without it the
 * server expects a continuation round trip, and LOGIN does the same job in one line.
 * @param {string[]} capabilities  Upper-cased.
 * @param {string} user
 * @param {string} password
 */
export function authCommand (capabilities, user, password) {
  if (capabilities.includes('AUTH=PLAIN') && capabilities.includes('SASL-IR')) {
    const token = Buffer.from(`\u0000${user}\u0000${password}`, 'utf8').toString('base64')
    return `AUTHENTICATE PLAIN ${token}`
  }
  if (capabilities.includes('LOGINDISABLED')) {
    throw new Error('the server advertises LOGINDISABLED and no AUTH=PLAIN; it needs another sign-in method')
  }
  return `LOGIN ${quoteString(user)} ${quoteString(password)}`
}

/**
 * @param {number[]} uids
 */
export function toSequenceSet (uids) {
  if (uids.length === 0) throw new RangeError('cannot build an empty sequence set')
  const sorted = [...new Set(uids)].sort((a, b) => a - b)
  /** @type {string[]} */
  const parts = []
  let start = sorted[0]
  let prev = start
  for (const uid of sorted.slice(1).concat([Number.NaN])) {
    if (uid === prev + 1) {
      prev = uid
      continue
    }
    parts.push(start === prev ? String(start) : `${start}:${prev}`)
    start = uid
    prev = uid
  }
  return parts.join(',')
}
