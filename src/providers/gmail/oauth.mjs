// @ts-check
// Google sign-in for an installed app: authorization code with PKCE and a loopback
// redirect (https://developers.google.com/identity/protocols/oauth2/native-app).
// The loopback listener and the browser live in the sidecar (src/sidecar/loopback.mjs).
// Used by scripts/oauth-probe-google.mjs now, and by the Gmail provider in slice 1b.
import { assertSafeScopes } from '../../domain/safety.mjs'
import { GMAIL_SCOPES } from './scopes.mjs'

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

/**
 * @param {{ clientId: string, redirectUri: string, challenge: string, state: string }} options
 */
export function buildGoogleAuthUrl ({ clientId, redirectUri, challenge, state }) {
  const url = new URL(AUTH_ENDPOINT)
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GMAIL_SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    // A refresh token is only issued for offline access, and only on consent.
    access_type: 'offline',
    prompt: 'consent'
  }).toString()
  return url.toString()
}

/**
 * @param {URLSearchParams} query  The redirect's query string.
 * @param {string} expectedState
 * @returns {{ ok: true, code: string } | { ok: false, error: string }}
 */
export function parseAuthCallback (query, expectedState) {
  const error = query.get('error')
  if (error) return { ok: false, error }
  if (query.get('state') !== expectedState) return { ok: false, error: 'state-mismatch' }
  const code = query.get('code')
  return code ? { ok: true, code } : { ok: false, error: 'no-code' }
}

/**
 * Google's Desktop client type issues a client secret that, per Google, is not
 * treated as confidential for installed apps; it is still kept in secrets.
 * @param {{ clientId: string, clientSecret: string, code: string, verifier: string, redirectUri: string }} options
 */
export function googleTokenRequest ({ clientId, clientSecret, code, verifier, redirectUri }) {
  return {
    url: TOKEN_ENDPOINT,
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri
    }).toString()
  }
}

/**
 * @typedef {{ accessToken: string, refreshToken: string | null, expiresAt: number, scopes: string[] }} OAuthToken
 */

/**
 * @param {Record<string, unknown>} json
 * @param {number} nowMs
 * @returns {OAuthToken}
 */
export function parseTokenResponse (json, nowMs) {
  if (typeof json.access_token !== 'string') {
    throw new Error(`token request failed: ${String(json.error ?? 'no access_token')}`)
  }
  const scopes = typeof json.scope === 'string' ? json.scope.split(/\s+/).filter(Boolean) : []
  // Second lock: even if a consent screen granted more, a full-access token is not kept.
  assertSafeScopes(scopes)
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 0
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
    expiresAt: nowMs + expiresIn * 1000,
    scopes
  }
}
