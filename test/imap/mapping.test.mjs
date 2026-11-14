import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeMailboxName,
  decodeHeaderWords,
  folderFromList,
  envelopeToRecordInput,
  planImapPage
} from '../../src/providers/imap/mapping.mjs'
import { parseResponse } from '../../src/providers/imap/protocol.mjs'

test('modified UTF-7 mailbox names decode for display', () => {
  assert.equal(decodeMailboxName('INBOX'), 'INBOX')
  assert.equal(decodeMailboxName('~peter/mail/&U,BTFw-/&ZeVnLIqe-'), '~peter/mail/台北/日本語')
  assert.equal(decodeMailboxName('Elementos enviados &AOE-'), 'Elementos enviados á')
  assert.equal(decodeMailboxName('A&-B'), 'A&B')
})

test('RFC 2047 encoded words decode in B and Q forms and across charsets', () => {
  assert.equal(decodeHeaderWords('=?UTF-8?B?Q2Fmw6kgeSB0w6k=?='), 'Café y té')
  assert.equal(decodeHeaderWords('=?ISO-8859-1?Q?Andr=E9_Pirard?='), 'André Pirard')
  assert.equal(decodeHeaderWords('=?utf-8?q?a?= =?utf-8?q?b?='), 'ab')
  assert.equal(decodeHeaderWords('Plain subject'), 'Plain subject')
  assert.equal(decodeHeaderWords('=?x-unknown?B?QQ==?='), '=?x-unknown?B?QQ==?=')
})

test('folderFromList maps SPECIAL-USE flags to roles and skips non-selectable', () => {
  const list = (/** @type {string} */ line) => {
    const parsed = parseResponse(line)
    if (parsed.kind !== 'list') throw new Error('not a list')
    return parsed
  }
  assert.deepEqual(folderFromList(list('* LIST (\\HasNoChildren \\Trash) "/" "Trash"'), []),
    { id: 'Trash', name: 'Trash', role: 'trash' })
  assert.deepEqual(folderFromList(list('* LIST (\\HasNoChildren) "/" INBOX'), []),
    { id: 'INBOX', name: 'INBOX', role: 'inbox' })
  assert.deepEqual(folderFromList(list('* LIST (\\Sent) "." "INBOX.Sent"'), []),
    { id: 'INBOX.Sent', name: 'INBOX.Sent', role: 'sent' })
  assert.equal(folderFromList(list('* LIST (\\Noselect \\HasChildren) "/" "[Gmail]"'), []), null)
  assert.equal(folderFromList(list('* LIST (\\NonExistent) "/" "Gone"'), []), null)
})

test('without SPECIAL-USE the configured trash name is used as fallback', () => {
  const parsed = parseResponse('* LIST (\\HasNoChildren) "." "INBOX.Trash"')
  if (parsed.kind !== 'list') throw new Error('not a list')
  assert.equal(folderFromList(parsed, ['INBOX.Trash', 'Trash'])?.role, 'trash')
  assert.equal(folderFromList(parsed, [])?.role, null)
})

test('an ENVELOPE maps to the normalized record input', () => {
  const parsed = parseResponse('* 3 FETCH (UID 17 FLAGS (\\Seen) INTERNALDATE "01-Nov-2026 10:00:00 +0000" ' +
    'RFC822.SIZE 2048 ENVELOPE ("Sat, 31 Oct 2026 09:00:00 -0500" "=?UTF-8?B?RmFjdHVyYSBuwrogNw==?=" ' +
    '(("=?UTF-8?Q?Ana_P=C3=A9rez?=" NIL "ana" "example.com")) NIL NIL ' +
    '((NIL NIL "me" "example.com")(NIL NIL "team" "example.com")) NIL NIL NIL "<x@y>"))')
  if (parsed.kind !== 'fetch') throw new Error('not a fetch')
  const record = envelopeToRecordInput(parsed, { accountId: 'acc-1', folder: 'INBOX', uidValidity: 4021 })
  assert.deepEqual(record, {
    accountId: 'acc-1',
    provider: 'imap',
    id: 'INBOX:4021:17',
    threadId: null,
    folder: 'INBOX',
    from: { name: 'Ana Pérez', address: 'ana@example.com' },
    to: [{ name: '', address: 'me@example.com' }, { name: '', address: 'team@example.com' }],
    subject: 'Factura nº 7',
    date: '2026-11-01T10:00:00.000Z',
    flags: ['\\Seen'],
    labels: [],
    sizeBytes: 2048,
    snippet: ''
  })
})

test('a FETCH without ENVELOPE still maps with empty fields', () => {
  const parsed = parseResponse('* 3 FETCH (UID 18 FLAGS () RFC822.SIZE 10)')
  if (parsed.kind !== 'fetch') throw new Error('not a fetch')
  const record = envelopeToRecordInput(parsed, { accountId: 'a', folder: 'INBOX', uidValidity: 1 })
  assert.equal(record.subject, '')
  assert.equal(record.from, null)
  assert.deepEqual(record.to, [])
  assert.equal(record.date, '')
})

test('the first page of a folder fetches the newest UIDs first', () => {
  const uids = [3, 5, 9, 12, 20]
  const plan = planImapPage(null, { uidValidity: 7, uids, pageSize: 2 })
  assert.deepEqual(plan.batch, [20, 12])
  assert.deepEqual(plan.cursor, { uidValidity: 7, top: 20, bottom: 12 })
  assert.equal(plan.done, false)
  assert.equal(plan.reset, false)
})

test('later pages walk backwards and finish at the oldest UID', () => {
  const uids = [3, 5, 9, 12, 20]
  const two = planImapPage({ uidValidity: 7, top: 20, bottom: 12 }, { uidValidity: 7, uids, pageSize: 2 })
  assert.deepEqual(two.batch, [9, 5])
  assert.equal(two.done, false)
  const three = planImapPage(two.cursor, { uidValidity: 7, uids, pageSize: 2 })
  assert.deepEqual(three.batch, [3])
  assert.equal(three.done, true)
  assert.deepEqual(three.cursor, { uidValidity: 7, top: 20, bottom: 3 })
})

test('new mail above the top is fetched before the backfill continues', () => {
  const plan = planImapPage({ uidValidity: 7, top: 20, bottom: 12 }, { uidValidity: 7, uids: [3, 12, 20, 21, 22, 23], pageSize: 2 })
  assert.deepEqual(plan.batch, [21, 22])
  assert.deepEqual(plan.cursor, { uidValidity: 7, top: 22, bottom: 12 })
  assert.equal(plan.done, false)
})

test('a finished folder with no new mail is done with an empty batch', () => {
  const plan = planImapPage({ uidValidity: 7, top: 20, bottom: 3 }, { uidValidity: 7, uids: [3, 20], pageSize: 50 })
  assert.deepEqual(plan.batch, [])
  assert.equal(plan.done, true)
})

test('an empty folder is done at once', () => {
  const plan = planImapPage(null, { uidValidity: 7, uids: [], pageSize: 50 })
  assert.deepEqual(plan.batch, [])
  assert.equal(plan.done, true)
  assert.deepEqual(plan.cursor, { uidValidity: 7, top: 0, bottom: 1 })
})

test('a changed UIDVALIDITY resets the folder', () => {
  const plan = planImapPage({ uidValidity: 7, top: 20, bottom: 3 }, { uidValidity: 8, uids: [1, 2], pageSize: 50 })
  assert.equal(plan.reset, true)
  assert.deepEqual(plan.batch, [2, 1])
  assert.equal(plan.done, true)
})
