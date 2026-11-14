import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, appendFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { replayLog, createRecordStore, buildSnapshot, resolveDataDir, SNAPSHOT_MAX_BYTES } from '../../src/sync/record-store.mjs'
import { createMessageRecord } from '../../src/domain/message.mjs'
import { startSync, applyPage } from '../../src/domain/sync-state.mjs'

/** @param {Partial<import('../../src/domain/message.mjs').MessageInput>} over */
const record = (over) => createMessageRecord({
  accountId: 'imap-a1', provider: 'imap', id: 'INBOX:1:1', threadId: null, folder: 'INBOX',
  from: { name: 'Ana', address: 'ana@example.com' }, to: [], subject: 'Hello',
  date: '2026-11-01T00:00:00Z', flags: [], labels: [], sizeBytes: 100, snippet: '', ...over
})

test('replayLog applies puts and folder resets in order and skips a torn last line', () => {
  const lines = [
    JSON.stringify({ op: 'put', record: record({ id: 'INBOX:1:1' }) }),
    JSON.stringify({ op: 'put', record: record({ id: 'Archive:1:1', folder: 'Archive' }) }),
    JSON.stringify({ op: 'reset', folder: 'INBOX' }),
    JSON.stringify({ op: 'put', record: record({ id: 'INBOX:2:5' }) }),
    '{"op":"put","rec'
  ].join('\n')
  const records = replayLog(lines)
  assert.deepEqual([...records.keys()].sort(), ['imap-a1/Archive:1:1', 'imap-a1/INBOX:2:5'])
})

test('the store persists pages and state across instances, and compacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-store-'))
  try {
    const store = createRecordStore(dir, 'imap-a1')
    assert.equal(store.loadState(), null)
    store.appendPage('INBOX', [record({ id: 'INBOX:1:1' }), record({ id: 'INBOX:1:2' })], false)
    let state = startSync(null, 'imap-a1', [{ id: 'INBOX', name: 'INBOX', role: 'inbox' }], 0)
    state = applyPage(state, 'INBOX', { count: 2, cursor: { uidValidity: 1, top: 2, bottom: 1 }, done: false, total: 5 })
    store.saveState(state)

    const again = createRecordStore(dir, 'imap-a1')
    assert.equal(again.loadRecords().size, 2)
    assert.deepEqual(again.loadState()?.folders[0].cursor, { uidValidity: 1, top: 2, bottom: 1 })

    again.appendPage('INBOX', [record({ id: 'INBOX:2:9' })], true)
    again.compact()
    const lines = readFileSync(join(dir, 'imap-a1', 'records.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    assert.equal(createRecordStore(dir, 'imap-a1').loadRecords().size, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a torn line left by a crash does not lose the records around it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-store-'))
  try {
    const store = createRecordStore(dir, 'imap-a1')
    store.appendPage('INBOX', [record({ id: 'INBOX:1:1' })], false)
    // What a write cut short by a crash leaves: the writer's leading newline and half a line.
    appendFileSync(join(dir, 'imap-a1', 'records.jsonl'), '\n{"op":"put","record":{"acc')
    store.appendPage('INBOX', [record({ id: 'INBOX:1:2' })], false)
    assert.equal(createRecordStore(dir, 'imap-a1').loadRecords().size, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an account id that could escape the data directory is refused', () => {
  assert.throws(() => createRecordStore('/tmp/x', '../etc'), /account id/)
  assert.throws(() => createRecordStore('/tmp/x', 'a/b'), /account id/)
})

test('buildSnapshot carries totals, progress and the newest records, trimmed', () => {
  const records = new Map([
    record({ id: 'a', date: '2020-01-01T00:00:00Z', sizeBytes: 10 }),
    record({ id: 'b', date: '2026-01-01T00:00:00Z', sizeBytes: 20, subject: 'x'.repeat(1000) })
  ].map((r) => [r.key, r]))
  let state = startSync(null, 'imap-a1', [{ id: 'INBOX', name: 'INBOX', role: 'inbox' }], 0)
  state = applyPage(state, 'INBOX', { count: 2, cursor: null, done: false, total: 4 })
  const snapshot = buildSnapshot(records, state, 1, 99)
  assert.deepEqual(snapshot.totals, { count: 2, sizeBytes: 30, unread: 2 })
  assert.equal(snapshot.progress.ratio, 0.5)
  assert.equal(snapshot.phase, 'syncing')
  assert.equal(snapshot.updatedAt, 99)
  assert.equal(snapshot.recent.length, 1)
  assert.equal(snapshot.recent[0].key, 'imap-a1/b')
  assert.equal(snapshot.recent[0].subject.length, 200)
})

test('a snapshot stays under the panel message budget even with long fields', () => {
  const long = 'y'.repeat(5000)
  const records = new Map(Array.from({ length: 500 }, (_, i) => record({
    id: `m${i}`, subject: long, from: { name: long, address: `${long}@example.com` }
  })).map((r) => [r.key, r]))
  const snapshot = buildSnapshot(records, null, 500, 0)
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= SNAPSHOT_MAX_BYTES)
  assert.ok(snapshot.recent.length > 0)
})

test('resolveDataDir prefers Orca user data and falls back to the home directory', () => {
  assert.equal(resolveDataDir({ ORCA_USER_DATA_PATH: '/u' }, '/h'), join('/u', 'plugins-data', 'ab2web.orca-mail-inbox', 'mail'))
  assert.equal(resolveDataDir({}, '/h'), join('/h', '.orca-mail-inbox'))
})
