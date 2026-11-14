#!/usr/bin/env node
// Photographs both panels in every state at 1440, 768, 390 and 320 px, light and dark,
// into e2e-results/shots/. Fails if any page scrolls sideways.
//
// The real panel lives in a sandboxed iframe and talks to the host by postMessage.
// Here it loads as a top-level page, so window.parent is the window itself, and a
// small stand-in for the host answers the same messages from a storage map. The
// storage values are SAMPLE DATA (e2e/fixtures/sample-mailbox.mjs).
//
// Run `npm run setup -- --browsers` once for Playwright.
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, requireDep } from './deps.mjs'
import { INBOX_STATES, SETTINGS_STATES, NOW } from '../e2e/fixtures/sample-mailbox.mjs'
import { validateImapInput } from '../src/worker/accounts.mjs'
import { renderPasswordPage, renderMessagePage } from '../src/sidecar/loopback.mjs'

// The pages the sidecar serves on 127.0.0.1 in the system browser, rendered by the
// real functions with sample account details.
const SAMPLE_VIEW = { label: 'Work (sample)', username: 'team@example.com', host: 'mail.example.com', action: '/sample-nonce' }
const LOOPBACK_PAGES = {
  password: renderPasswordPage({ ...SAMPLE_VIEW, error: null }),
  'password-rejected': renderPasswordPage({ ...SAMPLE_VIEW, error: 'The server rejected this password. Check it, or use an app password.' }),
  connected: renderMessagePage('Connected', 'Found 12 folders. You can close this tab and go back to Orca.')
}

const { chromium } = requireDep('playwright')
const OUT = process.env.MAILBOX_SHOTS ?? join(ROOT, 'e2e-results', 'shots')
const WIDTHS = [1440, 768, 390, 320]

// The design tokens Orca injects into panels (orca-oss src/shared/plugins/plugin-panel-shell.ts).
const TOKENS = {
  dark: {
    '--background': '#0a0a0a', '--foreground': '#fafafa', '--card': '#171717',
    '--primary': '#e5e5e5', '--primary-foreground': '#171717',
    '--muted': '#262626', '--muted-foreground': '#a1a1a1',
    '--destructive': '#ff6568', '--border': 'rgb(255 255 255 / 0.07)', '--input': 'rgb(255 255 255 / 0.15)',
    '--radius': '0.625rem'
  },
  light: {
    '--background': '#fff', '--foreground': '#0a0a0a', '--card': '#fff',
    '--primary': '#171717', '--primary-foreground': '#fafafa',
    '--muted': '#f5f5f5', '--muted-foreground': '#737373',
    '--destructive': '#e40014', '--border': '#e5e5e5', '--input': '#e5e5e5',
    '--radius': '0.625rem'
  }
}

/**
 * The page globals the harness adds.
 * @typedef {Window & { __storage: Record<string, unknown>, harnessRunCommand: (request: unknown) => Promise<Record<string, unknown>> }} HarnessWindow
 */

/** Answers the panel's bridge calls from window.__storage, like the host would. */
function hostStandIn () {
  const w = /** @type {HarnessWindow} */ (window)
  window.addEventListener('message', async (event) => {
    const d = event.data
    if (!d || d.type !== 'orca-panel-action') return
    const store = w.__storage
    let value = null
    if (d.action === 'storage.get') value = { value: store[d.params.key] ?? null }
    if (d.action === 'storage.set') { store[d.params.key] = d.params.value; value = { ok: true } }
    if (d.action === 'panel.runCommand') {
      const updates = await w.harnessRunCommand(store.request ?? null)
      Object.assign(store, updates)
      value = { ran: true }
    }
    window.postMessage({ type: 'orca-panel-action-result', requestId: d.requestId, ok: true, value }, '*')
  })
}

/**
 * The worker's answer to an add-imap request, using the real validator.
 * @param {{ id: string, action: string, payload: Record<string, unknown> } | null} request
 */
function workerStandIn (request) {
  if (!request || request.action !== 'add-imap') return {}
  const checked = validateImapInput(request.payload)
  return checked.ok ? {} : { requestResult: { requestId: request.id, ok: false, message: 'Check the highlighted fields.', errors: checked.errors, at: Date.now() } }
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch()
/** @type {string[]} */
const overflow = []
let count = 0
try {
  for (const [panel, states] of /** @type {const} */ ([['inbox.html', INBOX_STATES], ['settings.html', SETTINGS_STATES]])) {
    for (const [stateName, storage] of Object.entries(states)) {
      for (const theme of /** @type {const} */ (['light', 'dark'])) {
        for (const width of WIDTHS) {
          const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme, locale: 'en-US', timezoneId: 'America/Bogota' })
          await page.clock.setFixedTime(new Date(NOW))
          await page.exposeFunction('harnessRunCommand', workerStandIn)
          await page.addInitScript((seed) => { /** @type {HarnessWindow} */ (window).__storage = seed }, JSON.parse(JSON.stringify(storage)))
          await page.addInitScript(hostStandIn)
          await page.goto(pathToFileURL(join(ROOT, panel)).href)
          await page.addStyleTag({ content: `:root{${Object.entries(TOKENS[theme]).map(([k, v]) => `${k}:${v}`).join(';')}}` })
          if (stateName === 'field-errors') {
            await page.fill('#host', 'not a host')
            await page.fill('#port', '0')
            await page.click('#submit')
          }
          await page.waitForTimeout(stateName === 'field-errors' ? 1200 : 300)
          const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
          const name = `${panel.replace('.html', '')}-${stateName}-${theme}-${width}.png`
          if (wide) overflow.push(name)
          await page.screenshot({ path: join(OUT, name), fullPage: true })
          count += 1
          await page.close()
        }
      }
    }
  }
  for (const [stateName, html] of Object.entries(LOOPBACK_PAGES)) {
    for (const theme of /** @type {const} */ (['light', 'dark'])) {
      for (const width of WIDTHS) {
        const page = await browser.newPage({ viewport: { width, height: 700 }, colorScheme: theme, locale: 'en-US' })
        await page.setContent(html)
        const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
        const name = `loopback-${stateName}-${theme}-${width}.png`
        if (wide) overflow.push(name)
        await page.screenshot({ path: join(OUT, name), fullPage: true })
        count += 1
        await page.close()
      }
    }
  }
} finally {
  await browser.close()
}
console.log(`${count} screenshots in ${OUT}`)
if (overflow.length > 0) {
  console.error(`Horizontal overflow in: ${overflow.join(', ')}`)
  process.exit(1)
}
