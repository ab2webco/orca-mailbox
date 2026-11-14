import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertSafeScopes,
  assertSafeImapCommand,
  assertSafeGraphRequest,
  assertSafeGmailRequest
} from '../../src/domain/safety.mjs'
import { GMAIL_SCOPES } from '../../src/providers/gmail/scopes.mjs'
import { GRAPH_SCOPES } from '../../src/providers/outlook/scopes.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SAFETY_FILE = 'src/domain/safety.mjs'

/** Every shipped source file: the worker, the panels and src/. Tests and docs are not shipped code. */
function shippedSources () {
  /** @type {string[]} */
  const files = []
  /** @param {string} dir */
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(mjs|js|cjs|html)$/.test(name)) files.push(full)
    }
  }
  walk(join(ROOT, 'src'))
  for (const name of readdirSync(ROOT)) {
    if (/\.(mjs|html)$/.test(name)) files.push(join(ROOT, name))
  }
  return files.map((f) => ({ path: relative(ROOT, f), text: readFileSync(f, 'utf8') }))
}

test('the requested Gmail scopes never include https://mail.google.com/', () => {
  assert.ok(!GMAIL_SCOPES.includes('https://mail.google.com/'))
  assert.doesNotThrow(() => assertSafeScopes(GMAIL_SCOPES))
})

test('assertSafeScopes rejects the full-access Gmail scope', () => {
  assert.throws(() => assertSafeScopes(['https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/']), /mail\.google\.com/)
})

test('the Graph permission set is delegated mail read/write only', () => {
  assert.deepEqual([...GRAPH_SCOPES].sort(), ['Mail.ReadWrite', 'User.Read', 'offline_access'].sort())
  assert.doesNotThrow(() => assertSafeScopes(GRAPH_SCOPES))
})

test('no shipped file mentions the full-access Gmail scope except the guard', () => {
  const offenders = shippedSources()
    .filter((f) => f.path !== SAFETY_FILE && f.text.includes('mail.google.com'))
    .map((f) => f.path)
  assert.deepEqual(offenders, [])
})

test('IMAP EXPUNGE, UID EXPUNGE and CLOSE are refused outside the Trash folder', () => {
  const trash = 'Trash'
  for (const command of ['EXPUNGE', 'UID EXPUNGE 4:7', 'expunge', 'CLOSE', 'close']) {
    assert.throws(() => assertSafeImapCommand(command, { selected: 'INBOX', trash }), /refused/, command)
    assert.throws(() => assertSafeImapCommand(command, { selected: null, trash }), /refused/, command)
    assert.throws(() => assertSafeImapCommand(command, { selected: 'INBOX', trash: null }), /refused/, command)
  }
  assert.doesNotThrow(() => assertSafeImapCommand('EXPUNGE', { selected: 'Trash', trash }))
  assert.doesNotThrow(() => assertSafeImapCommand('UID FETCH 1:* (FLAGS)', { selected: 'INBOX', trash }))
})

test('no shipped file builds an IMAP EXPUNGE or CLOSE command except the guard', () => {
  const offenders = shippedSources()
    .filter((f) => f.path !== SAFETY_FILE && /['"`]\s*(UID\s+)?(EXPUNGE|CLOSE)\b/i.test(f.text))
    .map((f) => f.path)
  assert.deepEqual(offenders, [])
})

test('Graph permanentDelete and DELETE requests are refused', () => {
  assert.throws(() => assertSafeGraphRequest('POST', '/me/messages/AAA/permanentDelete'), /refused/)
  assert.throws(() => assertSafeGraphRequest('POST', '/me/mailFolders/inbox/messages/A/PERMANENTDELETE'), /refused/)
  assert.throws(() => assertSafeGraphRequest('DELETE', '/me/messages/AAA'), /refused/)
  assert.doesNotThrow(() => assertSafeGraphRequest('GET', '/me/mailFolders/inbox/messages'))
  assert.doesNotThrow(() => assertSafeGraphRequest('POST', '/me/messages/AAA/move'))
})

test('no shipped file mentions permanentDelete except the guard', () => {
  const offenders = shippedSources()
    .filter((f) => f.path !== SAFETY_FILE && /permanentdelete/i.test(f.text))
    .map((f) => f.path)
  assert.deepEqual(offenders, [])
})

test('Gmail delete and batchDelete requests are refused', () => {
  assert.throws(() => assertSafeGmailRequest('DELETE', '/gmail/v1/users/me/messages/abc'), /refused/)
  assert.throws(() => assertSafeGmailRequest('DELETE', '/gmail/v1/users/me/threads/abc'), /refused/)
  assert.throws(() => assertSafeGmailRequest('POST', '/gmail/v1/users/me/messages/batchDelete'), /refused/)
  assert.doesNotThrow(() => assertSafeGmailRequest('POST', '/gmail/v1/users/me/messages/abc/trash'))
  assert.doesNotThrow(() => assertSafeGmailRequest('GET', '/gmail/v1/users/me/messages'))
})
