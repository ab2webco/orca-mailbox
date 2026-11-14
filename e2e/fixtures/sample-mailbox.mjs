// SAMPLE DATA, hand-built for the screenshot harness only (approved by the lead for
// GMAIL-SYNC slice 1). Invented people, example.com / example.org addresses and
// invented subjects. No shipped file imports this (test/manifest.test.mjs checks it).
//
// The panels' storage values are built with the plugin's own domain code, so the
// screenshots show what the real snapshot shape renders like.
import { createMessageRecord } from '../../src/domain/message.mjs'
import { startSync, applyPage, finishSync } from '../../src/domain/sync-state.mjs'
import { buildSnapshot } from '../../src/sync/record-store.mjs'

const NOW = Date.UTC(2026, 10, 13, 15, 30)

export const SAMPLE_ACCOUNTS = [
  { id: 'imap-sample0work', provider: 'imap', label: 'Work (sample)', host: 'mail.example.com', port: 993, username: 'team@example.com', trashFallbacks: ['Trash'], addedAt: NOW - 86400000 },
  { id: 'imap-sample0home', provider: 'imap', label: 'Personal (sample)', host: 'imap.example.org', port: 993, username: 'someone@example.org', trashFallbacks: ['Trash'], addedAt: NOW - 3600000 }
]

const SENDERS = [
  ['Billing Team', 'billing@example.com'], ['Ana Example', 'ana@example.org'], ['Weekly Digest', 'digest@news.example.com'],
  ['', 'no-reply@shop.example.org'], ['Carlos Sample', 'carlos@example.com'], ['Support Desk', 'help@support.example.com'],
  ['A sender with a rather long display name that will not fit', 'very.long.address.for.layout.checks@subdomain.example.org']
]
const SUBJECTS = [
  'Invoice 1042 for October', 'Re: Notes from Tuesday', 'This week: 12 stories picked for you', 'Your order has shipped',
  'Draft of the proposal, second pass', 'Ticket 5531 was updated', 'A subject line long enough to be cut at the edge of the panel on a narrow phone screen'
]

/**
 * @param {string} accountId
 * @param {number} count
 */
function records (accountId, count) {
  return new Map(Array.from({ length: count }, (_, i) => {
    const [name, address] = SENDERS[i % SENDERS.length]
    return createMessageRecord({
      accountId,
      provider: 'imap',
      id: `INBOX:1:${1000 - i}`,
      threadId: null,
      folder: i % 5 === 0 ? 'Archive' : 'INBOX',
      from: { name, address },
      to: [{ name: '', address: 'team@example.com' }],
      subject: SUBJECTS[i % SUBJECTS.length],
      date: new Date(NOW - i * 7.3 * 3600000).toISOString(),
      flags: i % 3 === 0 ? [] : ['\\Seen'],
      labels: [],
      sizeBytes: 3000 + ((i * 7919) % 900000),
      snippet: ''
    })
  }).map((r) => [r.key, r]))
}

const folders = [
  { id: 'INBOX', name: 'INBOX', role: /** @type {const} */ ('inbox') },
  { id: 'Archive', name: 'Archive', role: null },
  { id: 'Sent', name: 'Sent', role: /** @type {const} */ ('sent') },
  { id: 'Trash', name: 'Trash', role: /** @type {const} */ ('trash') }
]

function syncingSnapshot () {
  let state = startSync(null, 'imap-sample0work', folders, NOW - 120000)
  // 40 sample records synced so far, out of 100 in the mailbox.
  state = applyPage(state, 'INBOX', { count: 40, cursor: null, done: false, total: 70 })
  state = applyPage(state, 'Archive', { count: 0, cursor: null, done: false, total: 30 })
  return buildSnapshot(records('imap-sample0work', 40), state, 50, NOW)
}

function doneSnapshot () {
  let state = startSync(null, 'imap-sample0home', folders, NOW - 900000)
  // 24 sample records, all synced.
  for (const [i, f] of folders.entries()) state = applyPage(state, f.id, { count: i === 0 ? 24 : 0, cursor: null, done: true, total: i === 0 ? 24 : 0 })
  state = finishSync(state, NOW - 600000)
  return { ...buildSnapshot(records('imap-sample0home', 24), state, 50, NOW - 600000) }
}

/** Host storage per screenshot state, keyed like the worker writes it. */
export const INBOX_STATES = {
  empty: { accounts: [] },
  syncing: {
    accounts: SAMPLE_ACCOUNTS,
    'ui:selectedAccount': 'imap-sample0work',
    'status:imap-sample0work': { running: true, error: null, at: NOW },
    'snapshot:imap-sample0work': syncingSnapshot()
  },
  done: {
    accounts: SAMPLE_ACCOUNTS,
    'ui:selectedAccount': 'imap-sample0home',
    'status:imap-sample0home': { running: false, error: null, at: NOW },
    'snapshot:imap-sample0home': doneSnapshot()
  },
  error: {
    accounts: SAMPLE_ACCOUNTS.slice(0, 1),
    'status:imap-sample0work': { running: false, error: { kind: 'auth', message: 'The server rejected the saved password. Remove the account and add it again.' }, at: NOW },
    'snapshot:imap-sample0work': { totals: { count: 0, sizeBytes: 0, unread: 0 }, progress: null, phase: 'idle', error: null, updatedAt: NOW, recent: [] }
  }
}

export const SETTINGS_STATES = {
  empty: { accounts: [] },
  accounts: { accounts: SAMPLE_ACCOUNTS },
  waiting: {
    accounts: SAMPLE_ACCOUNTS.slice(1),
    pending: { accountId: 'imap-sample0new', label: 'Work (sample)', state: 'waiting', url: 'http://127.0.0.1:53817/sample-nonce-not-real', message: null, at: NOW }
  },
  'pending-error': {
    accounts: SAMPLE_ACCOUNTS.slice(1),
    pending: { accountId: 'imap-sample0new', label: 'Work (sample)', state: 'error', url: null, message: 'The sign-in page was not completed in 5 minutes.', at: NOW }
  },
  // Filled by the harness: it submits a bad form and the real validator answers.
  'field-errors': { accounts: [] }
}
