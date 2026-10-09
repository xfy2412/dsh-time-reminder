/**
 * Build the published runtime: transpile `src/**\/*.ts` to `lib/**\/*.js`.
 *
 * Uses Node's own TypeScript transform (`module.stripTypeScriptTypes` in transform
 * mode) instead of a compiler dependency, because the DSH loader starts plugins as
 * plain Node ESM: it does not install a TypeScript hook, so the package entry point
 * has to be JavaScript. Transform mode (not strip mode) is required because the
 * sources use TypeScript-only syntax such as `enum`-free but non-erasable forms.
 *
 * Relative `./x.ts` specifiers are rewritten to `./x.js` so the emitted JavaScript
 * resolves without any loader hook.
 *
 * @module dsh-time-reminder/scripts/build
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = path.join(root, 'src')
const outputDir = path.join(root, 'lib')

/** Every `.ts` file under one directory, recursively. */
function sources(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sources(full))
    else if (entry.name.endsWith('.ts')) found.push(full)
  }
  return found
}

rmSync(outputDir, { recursive: true, force: true })
let written = 0
for (const file of sources(sourceDir)) {
  const relative = path.relative(sourceDir, file).replace(/\.ts$/, '.js')
  const target = path.join(outputDir, relative)
  const transformed = stripTypeScriptTypes(readFileSync(file, 'utf8'), {
    mode: 'transform',
    sourceUrl: file,
  })
  // The emitted JavaScript must resolve its own imports; `.ts` specifiers would not.
  const rewritten = transformed.replace(/(from\s+['"])(\.\.?\/[^'"]+)\.ts(['"])/g, '$1$2.js$3')
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, rewritten)
  written += 1
}
const bytes = sources(outputDir).reduce((total, file) => total + statSync(file).size, 0)
process.stdout.write(`built ${written} module(s) into lib/ (${(bytes / 1024).toFixed(1)} KB)\n`)
