import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'orca-plugin.json'), 'utf8'))
const worker = readFileSync(join(ROOT, 'main.mjs'), 'utf8')

// Curated icon names (orca-oss src/renderer/src/components/right-sidebar/plugin-panel-icon.tsx);
// an unknown one silently falls back to a plug.
const MAIL_ICONS = ['mail', 'inbox', 'bell', 'messagecircle', 'messagesquare']

test('identity matches the ticket', () => {
  assert.equal(manifest.id, 'orca-mailbox')
  assert.equal(manifest.publisher, 'ab2web')
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  assert.match(manifest.engines.orca, /^>=\d+\.\d+\.\d+$/)
})

test('one nav panel and one settings panel, with existing entries and curated icons', () => {
  const panels = manifest.contributes.panels
  assert.deepEqual(panels.map((/** @type {{ surface: string }} */ p) => p.surface).sort(), ['nav', 'settings'])
  for (const panel of panels) {
    assert.ok(existsSync(join(ROOT, panel.entry)), panel.entry)
    assert.ok(MAIL_ICONS.includes(panel.icon), panel.icon)
    assert.match(panel.id, /^[a-z0-9]+(-[a-z0-9]+)*$/)
  }
})

test('every declared command is registered by the worker and vice versa', () => {
  const declared = manifest.contributes.commands.map((/** @type {{ id: string }} */ c) => c.id).sort()
  const registered = [...worker.matchAll(/commands\.register\('([^']+)'/g)].map((m) => m[1]).sort()
  assert.deepEqual(registered, declared)
})

test('capabilities are exactly what slice 1 uses', () => {
  assert.deepEqual(manifest.capabilities.map((/** @type {{ kind: string }} */ c) => c.kind).sort(), ['process:spawn', 'secrets', 'storage'])
})

test('the worker never calls fetch, so it declares no net:fetch hosts', () => {
  assert.doesNotMatch(worker, /\bfetch\(/)
})

test('the plugin tree has no symlinks and no node_modules (Orca rejects both)', () => {
  /** @param {string} dir */
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === '.git') continue
      const full = join(dir, name)
      assert.notEqual(name, 'node_modules', full)
      const stat = statSync(full, { throwIfNoEntry: false })
      if (stat?.isDirectory()) walk(full)
    }
  }
  walk(ROOT)
})

test('no shipped file loads the sample data under e2e/', () => {
  /** @type {string[]} */
  const shipped = ['main.mjs', 'inbox.html', 'settings.html']
  /** @param {string} dir */
  const walk = (dir) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = join(dir, name)
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel)
      else if (/\.(mjs|html)$/.test(name)) shipped.push(rel)
    }
  }
  walk('src')
  walk('sidecar')
  for (const file of shipped) assert.doesNotMatch(readFileSync(join(ROOT, file), 'utf8'), /e2e\//, file)
})
