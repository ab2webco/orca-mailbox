// @ts-check
// PKCE (RFC 7636) with the S256 method, for the loopback OAuth flow.
import { createHash, randomBytes } from 'node:crypto'

/** @param {string} verifier */
export function pkceChallenge (verifier) {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

export function createPkcePair () {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: pkceChallenge(verifier) }
}
