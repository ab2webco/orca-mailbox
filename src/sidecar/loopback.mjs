// @ts-check
// A one-shot HTTP server on 127.0.0.1, opened in the system browser. Two uses:
//  - the IMAP password form: the password goes from the browser straight to the
//    sidecar, never through the panel or host storage (the panel can only write
//    host storage, which is a plain file; secrets are worker-only);
//  - the OAuth redirect (loopback flow with PKCE) for Gmail and Outlook.
// Runs in the sidecar: the plugin worker cannot load node:http.
import http from 'node:http'
import { randomBytes } from 'node:crypto'

/** @param {string} text */
export function escapeHtml (text) {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}

/**
 * @param {string} body  application/x-www-form-urlencoded
 * @returns {Record<string, string>}
 */
export function parseFormBody (body) {
  return Object.fromEntries(new URLSearchParams(body))
}

/**
 * Only our own origin and our secret path are served: another page in the browser
 * cannot guess the path, and a DNS-rebinding page fails the Host check.
 *
 * @param {{ host: string | undefined, url: string | undefined }} request
 * @param {{ port: number, nonce: string }} expected
 * @returns {'ok' | 'bad-host' | 'not-found'}
 */
export function checkLoopbackRequest (request, expected) {
  if (request.host !== `127.0.0.1:${expected.port}`) return 'bad-host'
  const path = (request.url ?? '').split('?')[0]
  return path === `/${expected.nonce}` ? 'ok' : 'not-found'
}

/**
 * @param {NodeJS.Platform} platform
 * @param {string} url
 * @returns {{ cmd: string, args: string[] }}
 */
export function openCommandFor (platform, url) {
  if (platform === 'darwin') return { cmd: 'open', args: [url] }
  if (platform === 'win32') return { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }
  return { cmd: 'xdg-open', args: [url] }
}

const PAGE_STYLE = `
  :root { color-scheme: light dark; --bg: #fafafa; --fg: #171717; --muted: #525252; --border: #d4d4d4; --accent: #171717; --accent-fg: #fafafa; --danger: #b91c1c; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0a0a0a; --fg: #fafafa; --muted: #a3a3a3; --border: #404040; --accent: #e5e5e5; --accent-fg: #171717; --danger: #f87171; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; padding: 16px; }
  main { width: 100%; max-width: 380px; border: 1px solid var(--border); border-radius: 10px; padding: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p { margin: 0 0 16px; color: var(--muted); overflow-wrap: anywhere; }
  label { display: block; font-weight: 600; margin-bottom: 6px; }
  input { width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: var(--fg); font: inherit; }
  button { margin-top: 16px; width: 100%; padding: 10px; border: 0; border-radius: 6px; background: var(--accent); color: var(--accent-fg); font: inherit; font-weight: 600; cursor: pointer; }
  .error { color: var(--danger); margin: 12px 0 0; }
`

/**
 * @param {{ label: string, username: string, host: string, action: string, error: string | null }} view
 */
export function renderPasswordPage ({ label, username, host, action, error }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mail Inbox: sign in</title><style>${PAGE_STYLE}</style></head><body><main>
<h1>${escapeHtml(label)}</h1>
<p>${escapeHtml(username)} on ${escapeHtml(host)}</p>
<form method="post" action="${escapeHtml(action)}">
<label for="password">Password or app password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Connect</button>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
</form></main></body></html>`
}

/** @param {string} title @param {string} message */
export function renderMessagePage (title, message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mail Inbox</title><style>${PAGE_STYLE}</style></head><body><main>
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`
}

/**
 * @typedef {{ method: string, url: string, query: URLSearchParams, body: Record<string, string> }} LoopbackRequest
 * @typedef {{ status: number, html: string }} LoopbackReply
 */

/**
 * @param {(request: LoopbackRequest) => Promise<LoopbackReply>} handle
 * @returns {Promise<{ port: number, nonce: string, url: string, close: () => void }>}
 */
export function startLoopbackServer (handle) {
  const nonce = randomBytes(18).toString('base64url')
  return new Promise((resolve, reject) => {
    let port = 0
    const server = http.createServer((req, res) => {
      /** @param {LoopbackReply} reply */
      const send = (reply) => {
        res.writeHead(reply.status, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
          'Referrer-Policy': 'no-referrer'
        })
        res.end(reply.html)
      }
      const verdict = checkLoopbackRequest({ host: req.headers.host, url: req.url }, { port, nonce })
      if (verdict !== 'ok') {
        send({ status: verdict === 'bad-host' ? 421 : 404, html: renderMessagePage('Not found', 'This address is not served.') })
        return
      }
      let raw = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => {
        raw += chunk
        if (raw.length > 16384) req.destroy()
      })
      req.on('end', () => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
        handle({ method: req.method ?? 'GET', url: url.pathname, query: url.searchParams, body: req.method === 'POST' ? parseFormBody(raw) : {} })
          .then(send, (error) => send({ status: 500, html: renderMessagePage('Something went wrong', String(error?.message ?? error)) }))
      })
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      port = typeof address === 'object' && address ? address.port : 0
      resolve({ port, nonce, url: `http://127.0.0.1:${port}/${nonce}`, close: () => server.close() })
    })
  })
}
