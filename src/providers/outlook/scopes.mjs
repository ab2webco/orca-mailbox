// @ts-check
// Microsoft Graph delegated permissions. Mail.ReadWrite is the narrowest one that can
// move a message (trash = move to Deleted Items) and set isRead; Mail.Read cannot.
// Graph has no permission that moves mail without also allowing permanent deletion,
// so that lock lives in code (src/domain/safety.mjs). Sources are cited in README.md.
import { assertSafeScopes } from '../../domain/safety.mjs'

export const GRAPH_SCOPES = Object.freeze([
  'Mail.ReadWrite',
  'User.Read',
  'offline_access'
])

assertSafeScopes(GRAPH_SCOPES)
