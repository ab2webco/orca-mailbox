import { test } from 'node:test'
import assert from 'node:assert/strict'
import { escapeHtml, parseFormBody, checkLoopbackRequest, openCommandFor, renderPasswordPage } from '../../src/sidecar/loopback.mjs'

test('escapeHtml neutralizes markup', () => {
  assert.equal(escapeHtml('<b a="1">&\'</b>'), '&lt;b a=&quot;1&quot;&gt;&amp;&#39;&lt;/b&gt;')
})

test('parseFormBody reads url-encoded fields, including + as space', () => {
  assert.deepEqual(parseFormBody('password=p%26ss+w%C3%B6rd&nonce=abc'), { password: 'p&ss wörd', nonce: 'abc' })
})

test('a loopback request must target our host, port and secret path', () => {
  const expected = { port: 50111, nonce: 'n0nce' }
  assert.equal(checkLoopbackRequest({ host: '127.0.0.1:50111', url: '/n0nce' }, expected), 'ok')
  assert.equal(checkLoopbackRequest({ host: '127.0.0.1:50111', url: '/n0nce?code=1' }, expected), 'ok')
  assert.equal(checkLoopbackRequest({ host: 'evil.example:50111', url: '/n0nce' }, expected), 'bad-host')
  assert.equal(checkLoopbackRequest({ host: '127.0.0.1:50111', url: '/other' }, expected), 'not-found')
  assert.equal(checkLoopbackRequest({ host: undefined, url: '/n0nce' }, expected), 'bad-host')
})

test('openCommandFor picks the platform opener and passes the URL as one argument', () => {
  assert.deepEqual(openCommandFor('darwin', 'http://127.0.0.1:1/x'), { cmd: 'open', args: ['http://127.0.0.1:1/x'] })
  assert.deepEqual(openCommandFor('linux', 'http://127.0.0.1:1/x'), { cmd: 'xdg-open', args: ['http://127.0.0.1:1/x'] })
  assert.deepEqual(openCommandFor('win32', 'http://127.0.0.1:1/x'), { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', 'http://127.0.0.1:1/x'] })
})

test('the password page names the account, escapes it and posts back to the secret path', () => {
  const html = renderPasswordPage({ label: '<Work>', username: 'me@example.com', host: 'mail.example.com', action: '/n0nce', error: 'Wrong "password"' })
  assert.match(html, /&lt;Work&gt;/)
  assert.match(html, /me@example\.com/)
  assert.match(html, /action="\/n0nce"/)
  assert.match(html, /type="password"/)
  assert.match(html, /Wrong &quot;password&quot;/)
  assert.doesNotMatch(html, /<Work>/)
})
