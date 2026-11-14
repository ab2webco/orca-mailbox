#!/usr/bin/env node
// Type-checks the JavaScript (JSDoc types, strict mode) with TypeScript from the
// harness directory. Run `npm run setup` once first.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { depsDir, ROOT } from './deps.mjs'

const tsc = join(depsDir(), 'node_modules', 'typescript', 'bin', 'tsc')
if (!existsSync(tsc)) {
  console.error(`TypeScript not found in ${depsDir()}. Run: npm run setup`)
  process.exit(1)
}
const result = spawnSync(process.execPath, [tsc, '-p', join(ROOT, 'tsconfig.json'), '--typeRoots', join(depsDir(), 'node_modules', '@types')], { stdio: 'inherit' })
process.exit(result.status ?? 1)
