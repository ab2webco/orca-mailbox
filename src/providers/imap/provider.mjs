// @ts-check
// The IMAP provider: any host on implicit TLS (993) with a username and a password
// or app password. Read-only in this slice: folders are opened with EXAMINE, which
// the server keeps read-only (RFC 9051 §6.3.3), so not even the \Seen flag changes.
import { openConnection, ImapError } from './client.mjs'
import { authCommand, toSequenceSet } from './commands.mjs'
import { quoteString } from './protocol.mjs'
import { folderFromList, envelopeToRecordInput, planImapPage } from './mapping.mjs'

/** @typedef {import('../../domain/provider.mjs').MailProvider} MailProvider */
/** @typedef {import('../../domain/sync-state.mjs').Folder} Folder */
/** @typedef {import('./mapping.mjs').ImapCursor} ImapCursor */

/**
 * @typedef {object} ImapAccount
 * @property {string} id
 * @property {string} host
 * @property {number} port
 * @property {string} username
 * @property {string[]} trashFallbacks  Trash folder names to try when the server has no SPECIAL-USE.
 */

const FETCH_ITEMS = '(UID FLAGS INTERNALDATE RFC822.SIZE ENVELOPE)'

/** @param {unknown} value @returns {value is ImapCursor} */
function isImapCursor (value) {
  if (typeof value !== 'object' || value === null) return false
  const c = /** @type {Record<string, unknown>} */ (value)
  return typeof c.uidValidity === 'number' && typeof c.top === 'number' && typeof c.bottom === 'number'
}

/**
 * @param {ImapAccount} account
 * @param {string} password
 * @param {{ timeoutMs?: number }} [options]
 * @returns {MailProvider}
 */
export function createImapProvider (account, password, options = {}) {
  /** @type {import('./client.mjs').ImapConnection | null} */
  let connection = null
  /** UID lists per folder, read once per session. */
  const uidCache = new Map()

  const conn = () => {
    if (!connection) throw new ImapError('not connected', { kind: 'protocol' })
    return connection
  }

  return {
    kind: 'imap',

    async connect () {
      connection = await openConnection({ host: account.host, port: account.port, timeoutMs: options.timeoutMs ?? 60000 })
      if (connection.capabilities.length === 0) await connection.run('CAPABILITY')
      await connection.run(authCommand(connection.capabilities, account.username, password))
      // Servers may advertise more after authentication.
      await connection.run('CAPABILITY')
    },

    async listFolders () {
      const responses = await conn().run('LIST "" "*"')
      /** @type {Folder[]} */
      const folders = []
      for (const r of responses) {
        if (r.kind !== 'list') continue
        const folder = folderFromList(r, account.trashFallbacks)
        // \All (Gmail's All Mail) repeats every other folder; counting it would double the totals.
        if (folder && folder.role !== 'all') folders.push(folder)
      }
      conn().setTrash(folders.find((f) => f.role === 'trash')?.id ?? null)
      return folders
    },

    async syncPage (folder, cursor, pageSize) {
      const c = conn()
      const examined = await c.run(`EXAMINE ${quoteString(folder.id)}`)
      c.markSelected(folder.id)
      let uidValidity = 0
      for (const r of examined) {
        const m = r.kind === 'untagged' ? /^UIDVALIDITY (\d+)/i.exec(r.code ?? '') : null
        if (m) uidValidity = Number(m[1])
      }
      let uids = uidCache.get(folder.id)
      if (!uids) {
        const found = await c.run('UID SEARCH ALL')
        uids = found.flatMap((r) => r.kind === 'search' ? r.numbers : [])
        uidCache.set(folder.id, uids)
      }
      const plan = planImapPage(isImapCursor(cursor) ? cursor : null, { uidValidity, uids, pageSize })
      let records = /** @type {import('../../domain/message.mjs').MessageInput[]} */ ([])
      if (plan.batch.length > 0) {
        const fetched = await c.run(`UID FETCH ${toSequenceSet(plan.batch)} ${FETCH_ITEMS}`)
        records = fetched.flatMap((r) => r.kind === 'fetch' && r.attributes.UID !== undefined
          ? [envelopeToRecordInput(r, { accountId: account.id, folder: folder.id, uidValidity })]
          : [])
      }
      return { records, cursor: plan.cursor, done: plan.done, total: uids.length, reset: plan.reset }
    },

    async close () {
      if (connection) await connection.logout()
      connection = null
    }
  }
}
