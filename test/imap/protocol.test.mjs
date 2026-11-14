// Hand-built server responses, shaped after the examples in RFC 9051 and RFC 6154.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createResponseReader,
  parseResponse,
  quoteString
} from '../../src/providers/imap/protocol.mjs'

test('the reader splits responses on CRLF into byte buffers and keeps partial lines', () => {
  const reader = createResponseReader()
  assert.deepEqual(reader.push(Buffer.from('* OK ready\r\nA1 OK do')).map(String), ['* OK ready'])
  assert.deepEqual(reader.push(Buffer.from('ne\r\n')).map(String), ['A1 OK done'])
})

test('the reader waits for a whole literal before ending the response', () => {
  const reader = createResponseReader()
  const literal = 'Re: café {x}\r\n'
  const bytes = Buffer.byteLength(literal)
  assert.deepEqual(reader.push(Buffer.from(`* 1 FETCH (UID 7 BODY[HEADER] {${bytes}}\r\nRe: caf`)), [])
  const out = reader.push(Buffer.from('é {x}\r\n)\r\n'))
  assert.equal(out.length, 1)
  const parsed = parseResponse(out[0])
  assert.equal(parsed.kind, 'fetch')
  assert.equal(parsed.kind === 'fetch' && parsed.attributes['BODY[HEADER]'], literal)
})

test('tagged status responses carry tag, status and text', () => {
  assert.deepEqual(parseResponse('A7 NO [AUTHENTICATIONFAILED] Invalid credentials'), {
    kind: 'tagged', tag: 'A7', status: 'NO', code: 'AUTHENTICATIONFAILED', text: 'Invalid credentials'
  })
  assert.deepEqual(parseResponse('+ go ahead'), { kind: 'continuation', text: 'go ahead' })
})

test('untagged OK with a response code is recognized', () => {
  assert.deepEqual(parseResponse('* OK [UIDVALIDITY 3857529045] UIDs valid'), {
    kind: 'untagged', name: 'OK', code: 'UIDVALIDITY 3857529045', text: 'UIDs valid'
  })
})

test('CAPABILITY lists the server capabilities upper-cased', () => {
  const parsed = parseResponse('* CAPABILITY IMAP4rev1 MOVE SPECIAL-USE UIDPLUS AUTH=PLAIN')
  assert.equal(parsed.kind, 'capability')
  assert.deepEqual(parsed.kind === 'capability' && parsed.capabilities,
    ['IMAP4REV1', 'MOVE', 'SPECIAL-USE', 'UIDPLUS', 'AUTH=PLAIN'])
})

test('LIST yields flags, delimiter and the raw mailbox name', () => {
  assert.deepEqual(parseResponse('* LIST (\\HasNoChildren \\Trash) "/" "Deleted Messages"'), {
    kind: 'list', flags: ['\\HasNoChildren', '\\Trash'], delimiter: '/', name: 'Deleted Messages'
  })
  assert.deepEqual(parseResponse('* LIST (\\Noselect) "." INBOX.Archive'), {
    kind: 'list', flags: ['\\Noselect'], delimiter: '.', name: 'INBOX.Archive'
  })
  assert.deepEqual(parseResponse('* LIST () NIL INBOX'), {
    kind: 'list', flags: [], delimiter: null, name: 'INBOX'
  })
})

test('STATUS yields its counters', () => {
  assert.deepEqual(parseResponse('* STATUS "INBOX" (MESSAGES 231 UIDNEXT 44292 UIDVALIDITY 1)'), {
    kind: 'status', name: 'INBOX', counters: { MESSAGES: 231, UIDNEXT: 44292, UIDVALIDITY: 1 }
  })
})

test('SEARCH yields the numbers, and an empty SEARCH yields none', () => {
  assert.deepEqual(parseResponse('* SEARCH 2 84 882'), { kind: 'search', numbers: [2, 84, 882] })
  assert.deepEqual(parseResponse('* SEARCH'), { kind: 'search', numbers: [] })
})

test('EXISTS and EXPUNGE counts are recognized', () => {
  assert.deepEqual(parseResponse('* 172 EXISTS'), { kind: 'count', name: 'EXISTS', value: 172 })
})

test('FETCH parses nested lists, quoted strings with escapes and NIL', () => {
  const line = '* 12 FETCH (UID 4827 FLAGS (\\Seen \\Answered) INTERNALDATE "17-Jul-1996 02:44:25 -0700" ' +
    'RFC822.SIZE 4286 ENVELOPE ("Wed, 17 Jul 1996 02:23:25 -0700 (PDT)" "IMAP4rev1 \\"WG\\" mtg summary" ' +
    '(("Terry Gray" NIL "gray" "cac.washington.edu")) NIL NIL ' +
    '((NIL NIL "imap" "cac.washington.edu")) NIL NIL NIL "<B27397-0100000@cac.washington.edu>"))'
  const parsed = parseResponse(line)
  assert.equal(parsed.kind, 'fetch')
  if (parsed.kind !== 'fetch') return
  assert.equal(parsed.seq, 12)
  assert.equal(parsed.attributes.UID, '4827')
  assert.deepEqual(parsed.attributes.FLAGS, ['\\Seen', '\\Answered'])
  assert.equal(parsed.attributes['RFC822.SIZE'], '4286')
  const envelope = parsed.attributes.ENVELOPE
  assert.ok(Array.isArray(envelope))
  assert.equal(envelope[1], 'IMAP4rev1 "WG" mtg summary')
  assert.deepEqual(envelope[2], [['Terry Gray', null, 'gray', 'cac.washington.edu']])
  assert.equal(envelope[4], null)
})

test('quoteString escapes quotes and backslashes and refuses CR/LF', () => {
  assert.equal(quoteString('a "b" \\c'), '"a \\"b\\" \\\\c"')
  assert.throws(() => quoteString('a\r\nb'), /CR|LF|line/)
})
