// @ts-check
// The one place that names what this plugin must never do: permanently delete mail.
//
// Every outgoing IMAP command, Gmail request and Graph request passes through one of
// these guards before it leaves the process. test/domain/safety.test.mjs also scans
// every shipped file and fails if any of them names these operations outside this
// file, so a new code path cannot route around the guard without a red test.

/** Scopes that would allow permanent deletion. Requesting one is refused. */
const FORBIDDEN_SCOPES = [
  // Full Gmail access: the only Gmail scope that allows messages.delete,
  // threads.delete and messages.batchDelete.
  'https://mail.google.com/'
]

/** @param {readonly string[]} scopes */
export function assertSafeScopes (scopes) {
  for (const scope of scopes) {
    if (FORBIDDEN_SCOPES.includes(scope.trim())) {
      throw new Error(`scope refused: ${scope} allows permanent deletion`)
    }
  }
}

/**
 * EXPUNGE and UID EXPUNGE permanently remove \Deleted messages from the selected
 * mailbox; CLOSE does the same as a side effect (RFC 9051 §6.4.1). They are allowed
 * only while the server's Trash folder is the selected mailbox.
 *
 * @param {string} command  The command line without its tag.
 * @param {{ selected: string | null, trash: string | null }} state
 */
export function assertSafeImapCommand (command, state) {
  const verb = command.trim().toUpperCase().replace(/^UID\s+/, '').split(/\s+/)[0]
  if (verb !== 'EXPUNGE' && verb !== 'CLOSE') return
  const inTrash = state.trash !== null && state.selected !== null && state.selected === state.trash
  if (!inTrash) {
    throw new Error(`IMAP command refused: ${verb} outside the Trash folder would permanently delete mail`)
  }
}

/**
 * @param {string} method
 * @param {string} path
 */
export function assertSafeGraphRequest (method, path) {
  if (method.toUpperCase() === 'DELETE') {
    throw new Error('Graph request refused: DELETE is never sent; trash is a move to Deleted Items')
  }
  if (/\/permanentdelete\b/i.test(path)) {
    throw new Error('Graph request refused: permanentDelete removes mail for good')
  }
}

/**
 * The gmail.modify scope already makes these impossible on Google's side; this is the
 * second lock.
 *
 * @param {string} method
 * @param {string} path
 */
export function assertSafeGmailRequest (method, path) {
  if (method.toUpperCase() === 'DELETE') {
    throw new Error('Gmail request refused: DELETE removes mail for good; use trash')
  }
  if (/\/batchDelete\b/i.test(path)) {
    throw new Error('Gmail request refused: batchDelete removes mail for good')
  }
}
