// @ts-check
// The provider port. Every mail source (IMAP, Gmail API, Microsoft Graph) implements
// it; the sync runner, the record store and the panels only see what it returns,
// already mapped to the normalized MessageInput.
//
// Slice 3 adds the actions (trash, archive, label/move, markRead). They are not part
// of the port yet so nothing can call them before their guards exist.

/** @typedef {import('./sync-state.mjs').Folder} Folder */
/** @typedef {import('./message.mjs').MessageInput} MessageInput */
/** @typedef {import('./message.mjs').ProviderKind} ProviderKind */

/**
 * @typedef {object} SyncPage
 * @property {MessageInput[]} records
 * @property {unknown} cursor     Opaque; saved after the page and handed back next time.
 * @property {boolean} done       The folder has nothing more to fetch for now.
 * @property {number | null} total  Messages in the folder, when the provider knows.
 * @property {boolean} reset      Previous records of this folder are no longer valid.
 */

/**
 * @typedef {object} MailProvider
 * @property {ProviderKind} kind
 * @property {() => Promise<void>} connect
 * @property {() => Promise<Folder[]>} listFolders  Folders worth syncing.
 * @property {(folder: Folder, cursor: unknown, pageSize: number) => Promise<SyncPage>} syncPage
 * @property {() => Promise<void>} close
 */

export {}
