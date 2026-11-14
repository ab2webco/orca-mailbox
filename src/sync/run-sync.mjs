// @ts-check
// Drives one account's sync: folder by folder, page by page, saving the cursor after
// every page so the next run resumes where this one stopped. All decisions live in
// the pure modules it calls (sync-state, backoff, the provider's page plan).
import { createMessageRecord } from '../domain/message.mjs'
import { startSync, nextFolder, applyPage, finishSync, failSync } from '../domain/sync-state.mjs'
import { withRetry } from '../domain/backoff.mjs'

/** @typedef {import('../domain/provider.mjs').MailProvider} MailProvider */
/** @typedef {import('../domain/sync-state.mjs').SyncState} SyncState */
/** @typedef {ReturnType<typeof import('./record-store.mjs').createRecordStore>} RecordStore */

/**
 * @param {object} options
 * @param {string} options.accountId
 * @param {MailProvider} options.provider
 * @param {RecordStore} options.store
 * @param {number} options.pageSize
 * @param {() => number} options.now
 * @param {(ms: number) => Promise<void>} options.sleep
 * @param {{ take: (units: number) => Promise<void> }} options.limiter  Paces page requests.
 * @param {(state: SyncState) => void} options.onPage
 * @param {() => boolean} options.shouldStop
 * @returns {Promise<SyncState>}
 */
export async function runSync ({ accountId, provider, store, pageSize, now, sleep, limiter, onPage, shouldStop }) {
  const retry = { maxAttempts: 5, baseMs: 1000, maxMs: 60000, random: Math.random, sleep }
  let connected = false
  const reconnect = async () => {
    if (connected) await provider.close().catch(() => {})
    await provider.connect()
    connected = true
  }

  /** @type {SyncState | null} */
  let state = null
  try {
    await withRetry(reconnect, retry)
    const folders = await withRetry(() => provider.listFolders(), retry)
    state = startSync(store.loadState(), accountId, folders, now())
    store.saveState(state)
    onPage(state)

    for (let folder = nextFolder(state); folder && !shouldStop(); folder = nextFolder(state)) {
      const current = folder
      const page = await withRetry(async () => {
        try {
          await limiter.take(1)
          return await provider.syncMetadata(current, current.cursor, pageSize)
        } catch (error) {
          // A dropped connection is retried on a fresh one.
          if (/** @type {{ retry?: boolean }} */ (error).retry) await reconnect().catch(() => {})
          throw error
        }
      }, retry)
      store.appendPage(current.id, page.records.map(createMessageRecord), page.reset)
      state = applyPage(state, current.id, { count: page.records.length, cursor: page.cursor, done: page.done, total: page.total })
      store.saveState(state)
      onPage(state)
    }
    if (!shouldStop()) {
      state = finishSync(state, now())
      store.saveState(state)
      store.compact()
    }
    return state
  } catch (error) {
    const message = String(/** @type {Error} */ (error)?.message ?? error)
    if (state) {
      state = failSync(state, message, now())
      store.saveState(state)
    }
    throw error
  } finally {
    if (connected) await provider.close().catch(() => {})
  }
}
