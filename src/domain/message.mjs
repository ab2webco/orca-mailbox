// @ts-check
// The normalized message record. Grouping, filters and the panels only ever read
// this shape; provider specifics stop at the provider's mapper.

/** @typedef {'imap' | 'gmail' | 'outlook'} ProviderKind */
export const PROVIDERS = /** @type {const} */ (['imap', 'gmail', 'outlook'])

/** @typedef {{ name: string, address: string }} Address */

/**
 * What a provider mapper hands over.
 * @typedef {object} MessageInput
 * @property {string} accountId
 * @property {ProviderKind} provider
 * @property {string} id         Provider-stable id (IMAP: folder:uidvalidity:uid).
 * @property {string | null} threadId
 * @property {string} folder     IMAP mailbox, Gmail primary label, Graph folder name.
 * @property {Address | null} from
 * @property {Address[]} to
 * @property {string} subject
 * @property {string} date       ISO 8601 or anything Date.parse accepts.
 * @property {string[]} flags    IMAP system flags, or 'read' for Graph.
 * @property {string[]} labels   Gmail label ids; empty elsewhere.
 * @property {number} sizeBytes
 * @property {string} snippet
 */

/**
 * @typedef {MessageInput & { key: string, dateMs: number, unread: boolean }} MessageRecord
 */

/**
 * @param {string[]} flags
 * @param {string[]} labels
 * @param {ProviderKind} provider
 */
function isUnread (flags, labels, provider) {
  if (provider === 'gmail') return labels.includes('UNREAD')
  if (provider === 'outlook') return !flags.includes('read')
  return !flags.includes('\\Seen')
}

/**
 * @param {MessageInput} input
 * @returns {MessageRecord}
 */
export function createMessageRecord (input) {
  if (typeof input.accountId !== 'string' || input.accountId === '') {
    throw new TypeError('message record needs an accountId')
  }
  if (!PROVIDERS.includes(input.provider)) {
    throw new TypeError(`message record has an unknown provider: ${String(input.provider)}`)
  }
  if (typeof input.id !== 'string' || input.id === '') {
    throw new TypeError('message record needs an id')
  }
  const parsed = Date.parse(input.date)
  const sizeBytes = Number.isFinite(input.sizeBytes) && input.sizeBytes > 0
    ? Math.floor(input.sizeBytes)
    : 0
  return {
    ...input,
    sizeBytes,
    key: `${input.accountId}/${input.id}`,
    dateMs: Number.isFinite(parsed) ? parsed : 0,
    unread: isUnread(input.flags, input.labels, input.provider)
  }
}

/** @typedef {{ count: number, sizeBytes: number, unread: number }} Totals */

/**
 * @param {Iterable<MessageRecord>} records
 * @returns {{ overall: Totals, byAccount: Record<string, Totals> }}
 */
export function summarize (records) {
  /** @type {Totals} */
  const overall = { count: 0, sizeBytes: 0, unread: 0 }
  /** @type {Record<string, Totals>} */
  const byAccount = {}
  for (const record of records) {
    const bucket = byAccount[record.accountId] ??= { count: 0, sizeBytes: 0, unread: 0 }
    for (const totals of [overall, bucket]) {
      totals.count += 1
      totals.sizeBytes += record.sizeBytes
      if (record.unread) totals.unread += 1
    }
  }
  return { overall, byAccount }
}

/**
 * @param {Iterable<MessageRecord>} records
 * @param {number} limit
 * @returns {MessageRecord[]}
 */
export function recentFirst (records, limit) {
  return [...records].sort((a, b) => b.dateMs - a.dateMs).slice(0, limit)
}
