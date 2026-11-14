import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pkceChallenge, createPkcePair } from '../../src/oauth/pkce.mjs'
import { buildGoogleAuthUrl, parseAuthCallback, googleTokenRequest, parseTokenResponse } from '../../src/providers/gmail/oauth.mjs'

test('the PKCE S256 challenge matches the RFC 7636 appendix B example', () => {
  assert.equal(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
})

test('a fresh PKCE verifier is 43+ url-safe characters and pairs with its challenge', () => {
  const pair = createPkcePair()
  assert.match(pair.verifier, /^[A-Za-z0-9_-]{43,128}$/)
  assert.equal(pair.challenge, pkceChallenge(pair.verifier))
})

test('the Google auth URL asks for gmail.modify only, offline, with PKCE and state', () => {
  const url = new URL(buildGoogleAuthUrl({ clientId: 'cid.apps.googleusercontent.com', redirectUri: 'http://127.0.0.1:5000/abc', challenge: 'ch', state: 'st' }))
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.modify')
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('code_challenge'), 'ch')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('state'), 'st')
  assert.equal(url.searchParams.get('access_type'), 'offline')
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:5000/abc')
})

test('the callback yields the code only when the state matches', () => {
  assert.deepEqual(parseAuthCallback(new URLSearchParams('code=c1&state=st'), 'st'), { ok: true, code: 'c1' })
  assert.deepEqual(parseAuthCallback(new URLSearchParams('code=c1&state=other'), 'st'), { ok: false, error: 'state-mismatch' })
  assert.deepEqual(parseAuthCallback(new URLSearchParams('error=access_denied&state=st'), 'st'), { ok: false, error: 'access_denied' })
  assert.deepEqual(parseAuthCallback(new URLSearchParams('state=st'), 'st'), { ok: false, error: 'no-code' })
})

test('the token request carries the verifier and the exact redirect URI', () => {
  const request = googleTokenRequest({ clientId: 'cid', clientSecret: 'sec', code: 'c1', verifier: 'v', redirectUri: 'http://127.0.0.1:5000/abc' })
  assert.equal(request.url, 'https://oauth2.googleapis.com/token')
  const body = new URLSearchParams(request.body)
  assert.equal(body.get('grant_type'), 'authorization_code')
  assert.equal(body.get('code_verifier'), 'v')
  assert.equal(body.get('redirect_uri'), 'http://127.0.0.1:5000/abc')
})

test('a token response is read into an expiry time and its granted scopes', () => {
  const token = parseTokenResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3599, scope: 'https://www.googleapis.com/auth/gmail.modify', token_type: 'Bearer' }, 1000)
  assert.deepEqual(token, { accessToken: 'at', refreshToken: 'rt', expiresAt: 1000 + 3599000, scopes: ['https://www.googleapis.com/auth/gmail.modify'] })
})

test('a token that grants the full-access scope is refused', () => {
  assert.throws(() => parseTokenResponse({ access_token: 'at', expires_in: 10, scope: 'https://mail.google.com/' }, 0), /refused/)
})

test('a token response without an access token is an error', () => {
  assert.throws(() => parseTokenResponse({ error: 'invalid_grant' }, 0), /invalid_grant/)
})
