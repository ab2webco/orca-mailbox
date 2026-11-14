// @ts-check
// gmail.modify: read metadata, trash, archive, label and mark read. It cannot delete
// permanently (messages.delete / threads.delete / batchDelete need the full-access
// scope, which src/domain/safety.mjs refuses). Sources are cited in README.md.
import { assertSafeScopes } from '../../domain/safety.mjs'

export const GMAIL_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/gmail.modify'
])

assertSafeScopes(GMAIL_SCOPES)
