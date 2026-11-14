#!/usr/bin/env node
// Builds contact sheets from e2e-results/shots/ so every screenshot can be looked at:
// per panel state, one sheet with the narrow widths (390, 320) and one with the wide
// ones (1440, 768), light and dark side by side, into e2e-results/sheets/.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, requireDep } from './deps.mjs'

const { chromium } = requireDep('playwright')
const SHOTS = join(ROOT, 'e2e-results', 'shots')
const OUT = join(ROOT, 'e2e-results', 'sheets')
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
const states = [...new Set(readdirSync(SHOTS).map((f) => f.replace(/-(light|dark)-\d+\.png$/, '')))]
const browser = await chromium.launch()
for (const state of states) {
  for (const [kind, widths, scale] of /** @type {const} */ ([['narrow', [390, 320], 1], ['wide', [1440, 768], 0.5]])) {
    const cells = ['light', 'dark'].flatMap((theme) => widths.map((w) =>
      `<figure><figcaption>${theme} ${w}</figcaption><img style="width:${w * scale}px" src="${pathToFileURL(join(SHOTS, `${state}-${theme}-${w}.png`)).href}"></figure>`))
    const page = await browser.newPage({ viewport: { width: 400, height: 400 } })
    // A file page, not setContent: about:blank may not load file:// images.
    const sheet = join(OUT, `${state}-${kind}.html`)
    writeFileSync(sheet, `<!doctype html><body style="margin:0;padding:8px;background:#888;font:12px sans-serif;display:flex;gap:8px;align-items:flex-start;width:max-content">${cells.join('')}</body>`)
    await page.goto(pathToFileURL(sheet).href, { waitUntil: 'load' })
    await page.screenshot({ path: join(OUT, `${state}-${kind}.png`), fullPage: true })
    await page.close()
    rmSync(sheet)
  }
}
await browser.close()
console.log(`${states.length * 2} sheets in ${OUT}`)
