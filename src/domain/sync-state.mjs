// @ts-check
// Sync progress as pure state transitions. The worker persists this object after
// every page, so an interrupted sync resumes from the last saved cursor, and a later
// run starts from the cursors of the finished one and only fetches new mail.
//
// Cursors are opaque here: each provider decides what its cursor holds.

/** @typedef {'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'all'} FolderRole */
/** @typedef {{ id: string, name: string, role: FolderRole | null }} Folder */

/**
 * @typedef {Folder & { cursor: unknown, done: boolean, fetched: number, total: number | null }} FolderSync
 */

/**
 * @typedef {object} SyncState
 * @property {string} accountId
 * @property {'syncing' | 'done' | 'error'} phase
 * @property {FolderSync[]} folders
 * @property {number} startedAt
 * @property {number | null} finishedAt
 * @property {string | null} error
 */

/** @typedef {{ count: number, cursor: unknown, done: boolean, total: number | null }} PageResult */

/**
 * @param {SyncState | null} previous
 * @param {string} accountId
 * @param {Folder[]} folders
 * @param {number} nowMs
 * @returns {SyncState}
 */
export function startSync (previous, accountId, folders, nowMs) {
  const known = new Map(
    previous && previous.accountId === accountId
      ? previous.folders.map((f) => [f.id, f])
      : []
  )
  return {
    accountId,
    phase: 'syncing',
    startedAt: nowMs,
    finishedAt: null,
    error: null,
    folders: folders.map((folder) => {
      const before = known.get(folder.id)
      return {
        ...folder,
        cursor: before ? before.cursor : null,
        fetched: before ? before.fetched : 0,
        total: before ? before.total : null,
        done: false
      }
    })
  }
}

/**
 * @param {SyncState} state
 * @returns {FolderSync | null}
 */
export function nextFolder (state) {
  return state.folders.find((f) => !f.done) ?? null
}

/**
 * @param {SyncState} state
 * @param {string} folderId
 * @param {PageResult} page
 * @returns {SyncState}
 */
export function applyPage (state, folderId, page) {
  if (!state.folders.some((f) => f.id === folderId)) {
    throw new Error(`sync state has no folder ${folderId}`)
  }
  return {
    ...state,
    folders: state.folders.map((f) => f.id !== folderId
      ? f
      : {
          ...f,
          cursor: page.cursor,
          fetched: f.fetched + page.count,
          total: page.total ?? f.total,
          done: page.done
        })
  }
}

/**
 * @param {SyncState} state
 * @param {number} nowMs
 * @returns {SyncState}
 */
export function finishSync (state, nowMs) {
  return { ...state, phase: 'done', finishedAt: nowMs, error: null }
}

/**
 * @param {SyncState} state
 * @param {string} message
 * @param {number} nowMs
 * @returns {SyncState}
 */
export function failSync (state, message, nowMs) {
  return { ...state, phase: 'error', finishedAt: nowMs, error: message }
}

/**
 * @param {SyncState} state
 * @returns {{ fetched: number, total: number, foldersDone: number, foldersTotal: number, ratio: number | null }}
 */
export function progressOf (state) {
  let fetched = 0
  let total = 0
  let foldersDone = 0
  for (const f of state.folders) {
    fetched += f.fetched
    total += f.total ?? 0
    if (f.done) foldersDone += 1
  }
  return {
    fetched,
    total,
    foldersDone,
    foldersTotal: state.folders.length,
    ratio: total > 0 ? Math.min(1, fetched / total) : null
  }
}
