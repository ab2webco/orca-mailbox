#!/usr/bin/env node
// Live proof of the Google sign-in path the plugin uses: loopback redirect + PKCE,
// run with Orca's own Node the way the sidecar runs. Tokens are used once and thrown
// away; nothing is printed but counts, scopes and lifetimes.
//
// Full proof (needs the owner's OAuth client, see README "Google Cloud setup"):
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
//   /usr/bin/env -u NODE_OPTIONS ELECTRON_RUN_AS_NODE=1 /Applications/Orca.app/Contents/MacOS/Orca scripts/oauth-probe-google.mjs
//
// Dry run (no client, no browser): checks the loopback server, the redirect handling
// and that Google's authorization endpoint answers the request it is sent.
//   ... Orca scripts/oauth-probe-google.mjs --dry-run
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createPkcePair } from '../src/oauth/pkce.mjs'
import { buildGoogleAuthUrl, parseAuthCallback, googleTokenRequest, parseTokenResponse } from '../src/providers/gmail/oauth.mjs'
import { startLoopbackServer, renderMessagePage, openCommandFor } from '../src/sidecar/loopback.mjs'

const dryRun = process.argv.includes('--dry-run')
const clientId = process.env.GOOGLE_CLIENT_ID ?? (dryRun ? 'dry-run-not-a-client.apps.googleusercontent.com' : '')
const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? ''
if (!clientId) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or pass --dry-run.')
  process.exit(2)
}

const pkce = createPkcePair()
const state = randomBytes(16).toString('base64url')
/** @type {(code: string) => void} */
let gotCode = () => {}
/** @type {(error: Error) => void} */
let failed = () => {}
const codePromise = /** @type {Promise<string>} */ (new Promise((resolve, reject) => { gotCode = resolve; failed = reject }))

const server = await startLoopbackServer(async (req) => {
  const result = parseAuthCallback(req.query, state)
  if (!result.ok) {
    failed(new Error(`sign-in did not complete: ${result.error}`))
    return { status: 400, html: renderMessagePage('Sign-in failed', result.error) }
  }
  gotCode(result.code)
  return { status: 200, html: renderMessagePage('Signed in', 'You can close this tab.') }
})
const authUrl = buildGoogleAuthUrl({ clientId, redirectUri: server.url, challenge: pkce.challenge, state })
/** @type {Record<string, unknown>} */
const report = { runtime: process.versions.electron ? `Orca/Electron ${process.versions.electron}, node ${process.versions.node}` : `node ${process.versions.node}`, redirectUri: server.url.replace(/\/[^/]+$/, '/<nonce>') }

try {
  if (dryRun) {
    const google = await fetch(authUrl, { redirect: 'manual' })
    // Google answers an unknown client with a redirect to its error page; the reason
    // travels base64-encoded in the authError parameter.
    const location = google.headers.get('location') ?? ''
    const authError = location ? new URL(location).searchParams.get('authError') : null
    const reason = authError ? Buffer.from(authError, 'base64').toString('latin1') : await google.text()
    report.googleAuthEndpoint = { status: google.status, redirectsTo: location ? new URL(location).pathname : null, invalidClient: /invalid_client/.test(reason) }
    const loop = await fetch(`${server.url}?code=dry-run-code&state=${state}`)
    report.loopbackCallback = { status: loop.status }
    report.codeReceived = (await codePromise) === 'dry-run-code'
  } else {
    const opener = openCommandFor(process.platform, authUrl)
    spawn(opener.cmd, opener.args, { stdio: 'ignore', detached: true }).unref()
    console.error('Complete the Google sign-in in your browser…')
    const code = await codePromise
    const request = googleTokenRequest({ clientId, clientSecret, code, verifier: pkce.verifier, redirectUri: server.url })
    const tokenResponse = await fetch(request.url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: request.body })
    const token = parseTokenResponse(await tokenResponse.json(), Date.now())
    report.grantedScopes = token.scopes
    report.accessTokenLifetimeSeconds = Math.round((token.expiresAt - Date.now()) / 1000)
    report.refreshTokenIssued = token.refreshToken !== null
    const profile = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${token.accessToken}` } })
    const profileJson = /** @type {{ messagesTotal?: number, threadsTotal?: number }} */ (await profile.json())
    report.gmailProfile = { status: profile.status, messagesTotal: profileJson.messagesTotal ?? null, threadsTotal: profileJson.threadsTotal ?? null }
  }
  console.log(JSON.stringify(report, null, 2))
} finally {
  server.close()
}
