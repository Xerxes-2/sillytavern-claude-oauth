/**
 * ESLint flat config.
 *
 * Formatting is not hand-tuned here: `js.configs.recommended` is ESLint's own
 * preset (ESLint 10 moved every formatting rule out of core) and
 * `stylistic.configs.recommended` supplies the layout rules. Whatever those
 * presets say is the house style; run `eslint --fix` rather than arguing.
 *
 * Two source environments live in this repo and they are not interchangeable:
 * the plugin itself runs inside SillyTavern's Node process, while
 * `extension/index.js` is browser code loaded by ST's UI extension loader.
 * `vendor/` is generated third-party output and is never linted.
 */

import js from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'
import globals from 'globals'

export default [
  { ignores: ['node_modules/**', 'vendor/**'] },
  js.configs.recommended,
  stylistic.configs.recommended,
  {
    rules: {
      // Credentials and tokens flow through this code: an accidental shadow or
      // a swallowed rejection is the kind of bug that leaks or corrupts them.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'all', caughtErrorsIgnorePattern: '^_' }],
      'no-shadow': 'error',
      'no-return-await': 'error',
      'require-atomic-updates': 'error',
      'no-promise-executor-return': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': ['error', 'properties'],
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-implicit-coercion': ['error', { allow: ['!!'] }],
    },
  },
  {
    // Plugin + tooling: Node, ESM.
    files: ['index.mjs', 'lib/**/*.mjs', 'scripts/**/*.mjs', 'test/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    // SillyTavern UI extension: browser, ESM, no Node globals.
    files: ['extension/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      // ST loads jQuery globally and extensions are expected to use it.
      globals: { ...globals.browser, $: 'readonly', jQuery: 'readonly' },
    },
  },
  {
    // The smoke test and the build script report progress on stdout.
    files: ['test/**/*.mjs', 'scripts/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },
]
