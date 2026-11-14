#!/usr/bin/env node
// Installs the verification harness (typecheck and screenshots) in a sibling
// directory, ../.orca-mailbox-deps, never inside the plugin tree: Orca hashes every
// file under the plugin root, rejects symlinks (node_modules/.bin is full of them)
// and caps the tree at 2,000 files and 50 MB. MAILBOX_DEPS overrides the location.
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { depsDir } from './deps.mjs'

const dir = depsDir()
mkdirSync(dir, { recursive: true })
copyFileSync(new URL('./deps.package.json', import.meta.url), join(dir, 'package.json'))
const install = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit' })
if (install.status !== 0) process.exit(install.status ?? 1)
if (process.argv.includes('--browsers')) {
  const browsers = spawnSync(join(dir, 'node_modules', '.bin', 'playwright'), ['install', 'chromium'], { stdio: 'inherit' })
  process.exit(browsers.status ?? 1)
}
