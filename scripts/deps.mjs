// Where the harness dependencies live: outside the plugin tree (see setup.mjs).
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

export function depsDir () {
  return resolve(process.env.MAILBOX_DEPS ?? join(ROOT, '..', '.orca-mailbox-deps'))
}

/** @param {string} name */
export function requireDep (name) {
  return createRequire(join(depsDir(), 'package.json'))(name)
}
