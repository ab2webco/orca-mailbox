// Structural checks on the two panels. A panel whose script does not parse renders
// empty with no visible error (orca-wa-inbox docs/ESCRIBIR-UN-PLUGIN.md §7), and the
// iframe cannot load relative files or reach the network, so all of that is checked here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'

const PANELS = ['inbox.html', 'settings.html']

/** @param {string} name */
const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')

for (const name of PANELS) {
  test(`${name}: every inline script parses`, () => {
    const scripts = [...read(name).matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
    assert.ok(scripts.length > 0)
    for (const source of scripts) assert.doesNotThrow(() => new Script(source, { filename: name }))
  })

  test(`${name}: everything is inline and nothing reaches the network`, () => {
    const html = read(name)
    assert.doesNotMatch(html, /<script[^>]+src=/)
    assert.doesNotMatch(html, /<link[^>]+href=/)
    assert.doesNotMatch(html, /\bfetch\(|XMLHttpRequest|WebSocket/)
  })

  test(`${name}: talks to the host only through allowed panel actions`, () => {
    const html = read(name)
    const actions = [...html.matchAll(/call\('([a-zA-Z.]+)'/g)].map((m) => m[1])
    assert.ok(actions.length > 0)
    for (const action of actions) assert.ok(['storage.get', 'storage.set', 'panel.runCommand'].includes(action), action)
  })

  test(`${name}: never asks for or shows a password`, () => {
    assert.doesNotMatch(read(name), /type="password"|secrets\./)
  })

  test(`${name}: untrusted text is never written as HTML`, () => {
    assert.doesNotMatch(read(name), /innerHTML\s*=(?!\s*'')/)
  })

  test(`${name}: theme comes from the host tokens`, () => {
    const html = read(name)
    for (const token of ['--background', '--foreground', '--border', '--muted-foreground']) assert.match(html, new RegExp(`var\\(${token}`))
  })
}

test('the panels only run commands the manifest declares', () => {
  const manifest = JSON.parse(read('orca-plugin.json'))
  const declared = manifest.contributes.commands.map((/** @type {{ id: string }} */ c) => c.id)
  for (const name of PANELS) {
    for (const m of read(name).matchAll(/commandId: '([^']+)'/g)) assert.ok(declared.includes(m[1]), m[1])
  }
})
