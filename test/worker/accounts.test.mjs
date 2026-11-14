import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateImapInput,
  newAccountId,
  upsertAccount,
  removeAccount,
  parsePanelRequest,
  passwordSecretKey,
  sidecarSpawnCommand
} from '../../src/worker/accounts.mjs'

test('validateImapInput accepts a complete form and normalizes it', () => {
  const result = validateImapInput({ label: ' Work ', host: ' Mail.Example.com ', port: '993', username: 'me@example.com', trashFolder: '' })
  assert.deepEqual(result, { ok: true, value: { label: 'Work', host: 'mail.example.com', port: 993, username: 'me@example.com', trashFallbacks: ['Trash', 'INBOX.Trash', 'Deleted Items', 'Deleted Messages'] } })
})

test('a configured trash folder goes first in the fallbacks', () => {
  const result = validateImapInput({ label: 'W', host: 'h.example', port: 993, username: 'u', trashFolder: 'Papelera' })
  assert.equal(result.ok && result.value.trashFallbacks[0], 'Papelera')
})

test('validateImapInput reports every bad field', () => {
  const result = validateImapInput({ label: '', host: 'not a host', port: 0, username: '' })
  assert.equal(result.ok, false)
  assert.deepEqual(Object.keys(result.ok ? {} : result.errors).sort(), ['host', 'label', 'port', 'username'])
  assert.equal(validateImapInput(null).ok, false)
})

test('validateImapInput never accepts a password field', () => {
  const result = validateImapInput({ label: 'W', host: 'h.example', port: 993, username: 'u', password: 'leak' })
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.errors.password, /browser/)
})

test('newAccountId is prefixed by provider and safe as a directory name', () => {
  assert.equal(newAccountId('imap', () => 'a1b2c3d4'), 'imap-a1b2c3d4')
  assert.match(newAccountId('imap', () => 'a1b2c3d4'), /^[a-z0-9-]+$/)
})

test('upsertAccount replaces by id and removeAccount drops it', () => {
  const a = { id: 'imap-1', provider: /** @type {const} */ ('imap'), label: 'A', host: 'h', port: 993, username: 'u', trashFallbacks: [], addedAt: 1 }
  const list = upsertAccount(upsertAccount([], a), { ...a, label: 'B' })
  assert.equal(list.length, 1)
  assert.equal(list[0].label, 'B')
  assert.deepEqual(removeAccount(list, 'imap-1'), [])
})

test('parsePanelRequest accepts known actions and rejects stale or malformed ones', () => {
  const now = 1_000_000
  assert.deepEqual(parsePanelRequest({ id: 'r1', action: 'sync', payload: {}, at: now - 1000 }, now),
    { ok: true, request: { id: 'r1', action: 'sync', payload: {}, at: now - 1000 } })
  assert.equal(parsePanelRequest({ id: 'r1', action: 'sync', payload: {}, at: now - 10 * 60_000 }, now).ok, false)
  assert.equal(parsePanelRequest({ id: 'r1', action: 'expunge', payload: {}, at: now }, now).ok, false)
  assert.equal(parsePanelRequest(null, now).ok, false)
})

test('passwordSecretKey namespaces the secret by account', () => {
  assert.equal(passwordSecretKey('imap-a1'), 'password:imap-a1')
})

test('the sidecar starts on Orca\'s Node without the worker\'s permission flags', () => {
  assert.deepEqual(sidecarSpawnCommand('darwin', '/x/Orca', '/p/sidecar/mail-sidecar.mjs'),
    { cmd: '/usr/bin/env', args: ['-u', 'NODE_OPTIONS', '/x/Orca', '/p/sidecar/mail-sidecar.mjs'] })
  assert.deepEqual(sidecarSpawnCommand('win32', 'C:\\Orca.exe', 'C:\\p\\s.mjs'),
    { cmd: 'C:\\Orca.exe', args: ['C:\\p\\s.mjs'] })
})
