import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSidecarRequest, parseSidecarEvent } from '../../src/sidecar/messages.mjs'

const account = { id: 'imap-a1b2', label: 'Work', host: 'mail.example.com', port: 993, username: 'me@example.com', trashFallbacks: ['Trash'] }

test('a sync request needs a well-formed account and a password', () => {
  const ok = parseSidecarRequest(JSON.stringify({ op: 'sync', account, password: 'pw', recentLimit: 50 }))
  assert.equal(ok.ok, true)
  assert.equal(ok.ok && ok.request.op, 'sync')
  assert.equal(parseSidecarRequest(JSON.stringify({ op: 'sync', account, recentLimit: 50 })).ok, false)
  assert.equal(parseSidecarRequest(JSON.stringify({ op: 'sync', account: { ...account, port: 70000 }, password: 'p', recentLimit: 50 })).ok, false)
  assert.equal(parseSidecarRequest(JSON.stringify({ op: 'sync', account: { ...account, id: '../x' }, password: 'p', recentLimit: 50 })).ok, false)
  assert.equal(parseSidecarRequest(JSON.stringify({ op: 'sync', account: { ...account, host: 'a b' }, password: 'p', recentLimit: 50 })).ok, false)
})

test('credential and remove requests are recognized; there is no separate snapshot op', () => {
  assert.equal(parseSidecarRequest(JSON.stringify({ op: 'credential', account, timeoutMs: 300000 })).ok, true)
  assert.equal(parseSidecarRequest(JSON.stringify({ op: 'snapshot', accountId: 'imap-a1b2', recentLimit: 50 })).ok, false)
  assert.equal(parseSidecarRequest(JSON.stringify({ op: 'remove', accountId: 'imap-a1b2' })).ok, true)
  assert.equal(parseSidecarRequest(JSON.stringify({ op: 'remove', accountId: 'A/B' })).ok, false)
})

test('garbage and unknown operations are refused with a reason', () => {
  const bad = parseSidecarRequest('{not json')
  assert.equal(bad.ok, false)
  assert.match(bad.ok ? '' : bad.reason, /JSON/)
  const unknown = parseSidecarRequest(JSON.stringify({ op: 'expunge' }))
  assert.equal(unknown.ok, false)
  assert.match(unknown.ok ? '' : unknown.reason, /op/)
})

test('sidecar events are parsed and unknown lines are ignored', () => {
  assert.deepEqual(parseSidecarEvent('{"type":"done","accountId":"imap-a1"}'), { type: 'done', accountId: 'imap-a1' })
  assert.equal(parseSidecarEvent('(node:1) SecurityWarning'), null)
  assert.equal(parseSidecarEvent('{"type":"mystery"}'), null)
})
