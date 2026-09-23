#!/usr/bin/env node
/**
 * Keeps the locale files in step with the UI source.
 *
 * SillyTavern's `t` tag builds its lookup key from the literal itself, with
 * every interpolation replaced by `${0}`, `${1}`, ... So a key is invalidated by
 * any edit to the English text — including reordering interpolations, which is
 * invisible in a diff. Translations then silently fall back to English, which
 * nobody notices in a locale they do not read.
 *
 * So: extract the keys from the source, compare against every locale listed in
 * manifest.json, and fail on drift.
 *
 *   node scripts/i18n-keys.mjs           # list the keys the UI needs
 *   node scripts/i18n-keys.mjs --check   # fail on missing or stale entries
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCES = ['extension/index.js']
/** Server files whose `fail(...)` codes can surface in the extension. */
const SERVER_SOURCES = ['index.mjs', 'lib/util.mjs', 'lib/accounts.mjs', 'lib/login.mjs']
/** Codes the proxy raises on its own port; no extension request ever sees them. */
const PROXY_ONLY_CODES = new Set(['body_too_large'])

/**
 * Scans for `` t`...` `` and returns the keys in ST's format.
 *
 * This is a small lexer rather than a regex because every cheaper approach gets
 * it wrong: this file's own JSDoc mentions the `` `t` `` tag (a false match),
 * regex literals contain quotes (`/[&<>"']/g`), and template literals nest
 * (`` `${a ? t`x` : b}` ``). Getting a key subtly wrong is worse than useless,
 * since the result is a silent fallback to English.
 *
 * @param {string} source
 * @returns {string[]}
 */
function extractKeys(source) {
  const keys = []
  /** Preceding meaningful character, to tell division from a regex literal. */
  let previous = ''

  /**
   * Reads a template literal body starting after its opening backtick.
   * @param {number} start
   * @param {boolean} collect Whether this template is the argument of a `t` tag.
   * @returns {number} Index of the closing backtick.
   */
  function readTemplate(start, collect) {
    let key = ''
    let placeholders = 0
    let i = start
    for (; i < source.length; i++) {
      const c = source[i]
      if (c === '\\') {
        key += source[i + 1]
        i++
        continue
      }
      if (c === '`') break
      if (c === '$' && source[i + 1] === '{') {
        // Expressions may contain further t`` tags, so scan them as code.
        i = scan(i + 2, '}')
        key += `\${${placeholders++}}`
        continue
      }
      key += c
    }
    if (collect) keys.push(key)
    return i
  }

  /**
   * Scans code until `stop` at nesting level zero (or end of input).
   * @param {number} start
   * @param {string} [stop]
   * @returns {number} Index of the stop character.
   */
  function scan(start, stop) {
    let depth = 0
    let i = start
    for (; i < source.length; i++) {
      const c = source[i]
      const next = source[i + 1]

      if (stop && c === stop && depth === 0) return i
      if (c === '{') depth++
      else if (c === '}') depth--

      if (c === '/' && next === '/') {
        while (i < source.length && source[i] !== '\n') i++
        continue
      }
      if (c === '/' && next === '*') {
        i = source.indexOf('*/', i + 2) + 1
        continue
      }
      if (c === '/' && /^[(,=:[!&|?+\-*%~^{};\n]$/.test(previous || '\n')) {
        // Regex literal: skip it, honouring escapes and character classes.
        let inClass = false
        for (i++; i < source.length; i++) {
          if (source[i] === '\\') i++
          else if (source[i] === '[') inClass = true
          else if (source[i] === ']') inClass = false
          else if (source[i] === '/' && !inClass) break
        }
        previous = '/'
        continue
      }
      if (c === '\'' || c === '"') {
        for (i++; i < source.length; i++) {
          if (source[i] === '\\') i++
          else if (source[i] === c) break
        }
        previous = c
        continue
      }
      if (c === '`') {
        // A tag is an identifier immediately before the backtick; `t` inside a
        // comment or string never reaches here.
        const tagged = previous === 't' && !/[\w$.]/.test(source[i - 2] ?? '')
        i = readTemplate(i + 1, tagged)
        previous = '`'
        continue
      }
      if (!/\s/.test(c)) previous = c
    }
    return i
  }

  scan(0)
  return keys
}

/**
 * Cross-checks server error codes against the extension's translation table.
 *
 * A code with no entry falls back to the server's English message, which is a
 * silent regression in every other locale; an entry for a code nothing raises
 * is dead weight left behind by a rename.
 *
 * @returns {Promise<string[]>} Problems found, empty when in step.
 */
async function checkErrorCodes() {
  const raised = new Set()
  for (const file of SERVER_SOURCES) {
    const source = await fs.readFile(path.join(root, file), 'utf8')
    for (const match of source.matchAll(/\bfail\(\s*'([a-z0-9_]+)'/g)) {
      if (!PROXY_ONLY_CODES.has(match[1])) raised.add(match[1])
    }
  }

  const ui = await fs.readFile(path.join(root, 'extension/index.js'), 'utf8')
  const table = ui.match(/const SERVER_ERRORS = \{([\s\S]*?)\n\}/)
  if (!table) return ['extension/index.js: could not find the SERVER_ERRORS table']
  const handled = new Set([...table[1].matchAll(/^\s*([a-z0-9_]+):/gm)].map(m => m[1]))

  return [
    ...[...raised].filter(code => !handled.has(code))
      .map(code => `SERVER_ERRORS has no entry for the server code ${JSON.stringify(code)}`),
    ...[...handled].filter(code => !raised.has(code))
      .map(code => `SERVER_ERRORS entry ${JSON.stringify(code)} is not raised by any server file`),
  ]
}

async function main() {
  const check = process.argv.includes('--check')
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'))

  /** @type {Set<string>} */
  const needed = new Set()
  for (const file of SOURCES) {
    for (const key of extractKeys(await fs.readFile(path.join(root, file), 'utf8'))) {
      needed.add(key)
    }
  }

  if (!check) {
    for (const key of [...needed].sort()) console.log(key)
    console.log(`\n${needed.size} keys in ${SOURCES.join(', ')}`)
    return
  }

  const locales = Object.entries(manifest.i18n ?? {})
  if (locales.length === 0) {
    console.error('i18n-keys: manifest.json has no "i18n" locales to check')
    process.exit(1)
  }

  let failed = false
  for (const [locale, relative] of locales) {
    const file = path.join(root, relative)
    /** @type {Record<string, string>} */
    let data
    try {
      data = JSON.parse(await fs.readFile(file, 'utf8'))
    }
    catch (error) {
      console.error(`i18n-keys: cannot read ${relative} for ${locale}: ${error.message}`)
      failed = true
      continue
    }
    const missing = [...needed].filter(key => !Object.hasOwn(data, key))
    const stale = Object.keys(data).filter(key => !needed.has(key))
    const untranslated = Object.entries(data).filter(([key, value]) => key === value).map(([key]) => key)
    /**
     * A translation that drops `${0}` silently swallows the account name (or
     * URL, or error) it was supposed to carry, and looks fine in review.
     */
    const placeholders = str => [...String(str).matchAll(/\$\{(\d+)\}/g)].map(m => m[1]).sort().join(',')
    const mangled = Object.entries(data)
      .filter(([key, value]) => needed.has(key) && placeholders(key) !== placeholders(value))
      .map(([key]) => key)

    if (missing.length || stale.length || untranslated.length || mangled.length) {
      failed = true
      console.error(`\n${locale} (${relative}):`)
      for (const key of missing) console.error(`  missing      ${JSON.stringify(key)}`)
      for (const key of stale) console.error(`  not in source ${JSON.stringify(key)}`)
      for (const key of untranslated) console.error(`  untranslated ${JSON.stringify(key)}`)
      for (const key of mangled) console.error(`  placeholders differ ${JSON.stringify(key)} -> ${JSON.stringify(data[key])}`)
    }
    else {
      console.log(`i18n-keys: ${locale} is complete (${needed.size} keys)`)
    }
  }

  const codeProblems = await checkErrorCodes()
  if (codeProblems.length > 0) {
    failed = true
    console.error('\nserver error codes:')
    for (const problem of codeProblems) console.error(`  ${problem}`)
  }
  else {
    console.log('i18n-keys: every server error code has a translation')
  }

  if (failed) {
    console.error('\ni18n-keys: locale files are out of step with the UI. Run: node scripts/i18n-keys.mjs')
    process.exit(1)
  }
}

await main()
