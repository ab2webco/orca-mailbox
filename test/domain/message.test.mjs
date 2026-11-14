import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMessageRecord, summarize, recentFirst } from '../../src/domain/message.mjs'

/** @returns {import('../../src/domain/message.mjs').MessageInput} */
function input (overrides = {}) {
  return {
    accountId: 'acc-1',
    provider: 'imap',
    id: 'INBOX:4021:17',
    threadId: null,
    folder: 'INBOX',
    from: { name: 'Ana', address: 'ana@example.com' },
    to: [{ name: '', address: 'me@example.com' }],
    subject: 'Invoice',
    date: '2026-11-01T10:00:00.000Z',
    flags: ['\\Seen'],
    labels: [],
    sizeBytes: 2048,
    snippet: '',
    ...overrides
  }
}

test('a record keeps accountId and provider and the normalized fields', () => {
  const record = createMessageRecord(input())
  assert.equal(record.accountId, 'acc-1')
  assert.equal(record.provider, 'imap')
  assert.equal(record.key, 'acc-1/INBOX:4021:17')
  assert.equal(record.unread, false)
  assert.equal(record.sizeBytes, 2048)
  assert.equal(record.dateMs, Date.parse('2026-11-01T10:00:00.000Z'))
})

test('a record without accountId or provider is rejected', () => {
  assert.throws(() => createMessageRecord(input({ accountId: '' })), /accountId/)
  assert.throws(() => createMessageRecord(input({ provider: /** @type {never} */ ('pop3') })), /provider/)
})

test('unread follows the provider flag model', () => {
  assert.equal(createMessageRecord(input({ flags: [] })).unread, true)
  assert.equal(createMessageRecord(input({ provider: 'gmail', flags: [], labels: ['INBOX', 'UNREAD'] })).unread, true)
  assert.equal(createMessageRecord(input({ provider: 'gmail', flags: [], labels: ['INBOX'] })).unread, false)
  assert.equal(createMessageRecord(input({ provider: 'outlook', flags: ['read'] })).unread, false)
  assert.equal(createMessageRecord(input({ provider: 'outlook', flags: [] })).unread, true)
})

test('an unparseable date or negative size does not break the record', () => {
  const record = createMessageRecord(input({ date: 'not a date', sizeBytes: -5 }))
  assert.equal(record.dateMs, 0)
  assert.equal(record.sizeBytes, 0)
})

test('summarize counts messages and bytes per account and overall', () => {
  const records = [
    createMessageRecord(input({ id: 'a', sizeBytes: 100 })),
    createMessageRecord(input({ id: 'b', sizeBytes: 300, flags: [] })),
    createMessageRecord(input({ accountId: 'acc-2', id: 'c', sizeBytes: 50 }))
  ]
  const totals = summarize(records)
  assert.deepEqual(totals.overall, { count: 3, sizeBytes: 450, unread: 1 })
  assert.deepEqual(totals.byAccount['acc-1'], { count: 2, sizeBytes: 400, unread: 1 })
  assert.deepEqual(totals.byAccount['acc-2'], { count: 1, sizeBytes: 50, unread: 0 })
})

test('recentFirst returns the newest records first, limited', () => {
  const records = [
    createMessageRecord(input({ id: 'old', date: '2020-01-01T00:00:00Z' })),
    createMessageRecord(input({ id: 'new', date: '2026-01-01T00:00:00Z' })),
    createMessageRecord(input({ id: 'mid', date: '2023-01-01T00:00:00Z' }))
  ]
  assert.deepEqual(recentFirst(records, 2).map((r) => r.id), ['new', 'mid'])
})
