import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startSync, nextFolder, applyPage, finishSync, failSync, progressOf } from '../../src/domain/sync-state.mjs'

const folders = [
  { id: 'INBOX', name: 'INBOX', role: /** @type {const} */ ('inbox') },
  { id: 'Archive', name: 'Archive', role: null },
  { id: 'Trash', name: 'Trash', role: /** @type {const} */ ('trash') }
]

test('a first run starts every folder with no cursor', () => {
  const state = startSync(null, 'acc-1', folders, 1000)
  assert.equal(state.accountId, 'acc-1')
  assert.equal(state.phase, 'syncing')
  assert.equal(state.startedAt, 1000)
  assert.deepEqual(state.folders.map((f) => [f.id, f.cursor, f.done, f.fetched]), [
    ['INBOX', null, false, 0], ['Archive', null, false, 0], ['Trash', null, false, 0]
  ])
  assert.equal(nextFolder(state)?.id, 'INBOX')
})

test('applyPage advances the cursor, counts and completes a folder', () => {
  let state = startSync(null, 'acc-1', folders, 0)
  state = applyPage(state, 'INBOX', { count: 100, cursor: { lastUid: 100 }, done: false, total: 250 })
  assert.deepEqual(state.folders[0].cursor, { lastUid: 100 })
  assert.equal(state.folders[0].fetched, 100)
  assert.equal(state.folders[0].total, 250)
  assert.equal(nextFolder(state)?.id, 'INBOX')
  state = applyPage(state, 'INBOX', { count: 150, cursor: { lastUid: 250 }, done: true, total: 250 })
  assert.equal(state.folders[0].done, true)
  assert.equal(nextFolder(state)?.id, 'Archive')
})

test('applyPage on an unknown folder is an error, not a silent no-op', () => {
  const state = startSync(null, 'acc-1', folders, 0)
  assert.throws(() => applyPage(state, 'Nope', { count: 1, cursor: null, done: true, total: null }), /Nope/)
})

test('a resumed run keeps cursors and counts of an interrupted run', () => {
  let state = startSync(null, 'acc-1', folders, 0)
  state = applyPage(state, 'INBOX', { count: 100, cursor: { lastUid: 100 }, done: false, total: 250 })
  const resumed = startSync(state, 'acc-1', folders, 5000)
  assert.deepEqual(resumed.folders[0].cursor, { lastUid: 100 })
  assert.equal(resumed.folders[0].fetched, 100)
  assert.equal(nextFolder(resumed)?.id, 'INBOX')
})

test('a new run after a finished one keeps cursors so only new mail is fetched', () => {
  let state = startSync(null, 'acc-1', folders.slice(0, 1), 0)
  state = applyPage(state, 'INBOX', { count: 10, cursor: { lastUid: 10 }, done: true, total: 10 })
  state = finishSync(state, 100)
  assert.equal(state.phase, 'done')
  const again = startSync(state, 'acc-1', folders.slice(0, 1), 200)
  assert.equal(again.folders[0].done, false)
  assert.deepEqual(again.folders[0].cursor, { lastUid: 10 })
  assert.equal(again.folders[0].fetched, 10)
})

test('folders that disappeared are dropped and new ones are added', () => {
  const state = startSync(null, 'acc-1', folders, 0)
  const next = startSync(state, 'acc-1', [folders[0], { id: 'Projects', name: 'Projects', role: null }], 1)
  assert.deepEqual(next.folders.map((f) => f.id), ['INBOX', 'Projects'])
})

test('a state of another account is never reused', () => {
  let state = startSync(null, 'acc-1', folders, 0)
  state = applyPage(state, 'INBOX', { count: 5, cursor: { lastUid: 5 }, done: false, total: 9 })
  const other = startSync(state, 'acc-2', folders, 1)
  assert.equal(other.folders[0].cursor, null)
  assert.equal(other.folders[0].fetched, 0)
})

test('progress sums fetched and known totals', () => {
  let state = startSync(null, 'acc-1', folders, 0)
  state = applyPage(state, 'INBOX', { count: 100, cursor: 1, done: false, total: 300 })
  state = applyPage(state, 'Archive', { count: 50, cursor: 1, done: true, total: 100 })
  assert.deepEqual(progressOf(state), { fetched: 150, total: 400, foldersDone: 1, foldersTotal: 3, ratio: 0.375 })
})

test('progress has no ratio while no total is known', () => {
  const state = startSync(null, 'acc-1', folders, 0)
  assert.equal(progressOf(state).ratio, null)
})

test('failSync records the error and keeps cursors for the next resume', () => {
  let state = startSync(null, 'acc-1', folders, 0)
  state = applyPage(state, 'INBOX', { count: 100, cursor: { lastUid: 100 }, done: false, total: 250 })
  state = failSync(state, 'connection reset', 99)
  assert.equal(state.phase, 'error')
  assert.equal(state.error, 'connection reset')
  assert.deepEqual(startSync(state, 'acc-1', folders, 100).folders[0].cursor, { lastUid: 100 })
})
