import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { encodeCommand, authCommand, toSequenceSet } from '../../src/providers/imap/commands.mjs'

test('encodeCommand frames a tagged command line', () => {
  assert.equal(String(encodeCommand('A1', 'UID FETCH 1:3 (FLAGS)', { selected: 'INBOX', trash: 'Trash' })),
    'A1 UID FETCH 1:3 (FLAGS)\r\n')
})

test('encodeCommand refuses EXPUNGE outside Trash before producing any bytes', () => {
  assert.throws(() => encodeCommand('A2', 'EXPUNGE', { selected: 'INBOX', trash: 'Trash' }), /refused/)
  assert.throws(() => encodeCommand('A3', 'UID EXPUNGE 5', { selected: 'INBOX', trash: 'Trash' }), /refused/)
  assert.throws(() => encodeCommand('A4', 'CLOSE', { selected: 'INBOX', trash: 'Trash' }), /refused/)
})

test('encodeCommand refuses a command line that smuggles a second command', () => {
  assert.throws(() => encodeCommand('A5', 'NOOP\r\nA6 EXPUNGE', { selected: 'INBOX', trash: 'Trash' }), /line/)
})

test('the IMAP client writes to the socket in exactly one place, through encodeCommand', () => {
  const source = readFileSync(new URL('../../src/providers/imap/client.mjs', import.meta.url), 'utf8')
  const writes = source.match(/\.write\(/g) ?? []
  assert.equal(writes.length, 1)
  assert.match(source, /\.write\(encodeCommand\(/)
})

test('authCommand prefers one-line AUTHENTICATE PLAIN (SASL-IR) and falls back to LOGIN', () => {
  assert.equal(authCommand(['IMAP4REV1', 'AUTH=PLAIN', 'SASL-IR'], 'me@example.com', 'päss'),
    `AUTHENTICATE PLAIN ${Buffer.from('\u0000me@example.com\u0000päss').toString('base64')}`)
  assert.equal(authCommand(['IMAP4REV1'], 'me@example.com', 'a"b'), 'LOGIN "me@example.com" "a\\"b"')
  // Without SASL-IR the server wants a continuation round trip; LOGIN is one line.
  assert.equal(authCommand(['IMAP4REV1', 'AUTH=PLAIN'], 'u', 'p'), 'LOGIN "u" "p"')
})

test('authCommand refuses to send a password when the server disables LOGIN and has no PLAIN', () => {
  assert.throws(() => authCommand(['IMAP4REV1', 'LOGINDISABLED'], 'u', 'p'), /LOGINDISABLED/)
})

test('toSequenceSet compresses runs of UIDs', () => {
  assert.equal(toSequenceSet([7, 1, 2, 3, 9, 10]), '1:3,7,9:10')
  assert.equal(toSequenceSet([5]), '5')
  assert.throws(() => toSequenceSet([]), /empty/)
})

test('slice 1 is read-only by construction: only reading verbs reach the socket', () => {
  const state = { selected: 'INBOX', trash: 'Trash' }
  for (const allowed of ['CAPABILITY', 'LOGIN "u" "p"', 'AUTHENTICATE PLAIN eA==', 'LIST "" "*"', 'EXAMINE "INBOX"',
    'UID SEARCH ALL', 'UID FETCH 1:5 (UID FLAGS INTERNALDATE RFC822.SIZE ENVELOPE)', 'NOOP', 'LOGOUT']) {
    assert.doesNotThrow(() => encodeCommand('A1', allowed, state), allowed)
  }
  for (const refused of ['SELECT "INBOX"', 'UID STORE 5 +FLAGS (\\Seen)', 'UID MOVE 5 "Trash"', 'UID COPY 5 "Trash"',
    'DELETE "INBOX"', 'RENAME "a" "b"', 'APPEND "INBOX" {5}', 'CREATE "x"']) {
    assert.throws(() => encodeCommand('A1', refused, state), /read-only/, refused)
  }
})

test('a FETCH that would mark mail as read (BODY[] without PEEK) is refused', () => {
  const state = { selected: 'INBOX', trash: 'Trash' }
  assert.throws(() => encodeCommand('A1', 'UID FETCH 5 (BODY[HEADER])', state), /read-only/)
  assert.doesNotThrow(() => encodeCommand('A1', 'UID FETCH 5 (BODY.PEEK[HEADER])', state))
})
