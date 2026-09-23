/**
 * ESLint flat config.
 *
 * Two source environments live in this repo and they are not interchangeable:
 * the plugin itself runs inside SillyTavern's Node process, while
 * `extension/index.js` is browser code loaded by ST's UI extension loader.
 * `vendor/` is generated third-party output and is never linted.
 *
 * ESLint 10 dropped core formatting rules, so the repo's house style (tabs,
 * single quotes, semicolons) is enforced through @stylistic.
 */

import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import globals from 'globals';

const houseStyle = {
	'@stylistic/indent': ['error', 'tab', { SwitchCase: 1 }],
	'@stylistic/quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: 'never' }],
	'@stylistic/semi': ['error', 'always'],
	'@stylistic/comma-dangle': ['error', 'always-multiline'],
	'@stylistic/no-trailing-spaces': 'error',
	'@stylistic/eol-last': ['error', 'always'],
	'@stylistic/space-before-blocks': 'error',
	'@stylistic/keyword-spacing': 'error',
	'@stylistic/arrow-spacing': 'error',
	'@stylistic/object-curly-spacing': ['error', 'always'],
};

const correctness = {
	// Credentials and tokens flow through this code: an accidental shadow or a
	// swallowed rejection is the kind of bug that leaks or corrupts them.
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
};

export default [
	{ ignores: ['node_modules/**', 'vendor/**'] },
	js.configs.recommended,
	{
		plugins: { '@stylistic': stylistic },
		rules: { ...houseStyle, ...correctness },
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
		// The smoke test deliberately reassigns globalThis.fetch to stub the token
		// endpoint, and logs its own results.
		files: ['test/**/*.mjs', 'scripts/**/*.mjs'],
		rules: { 'no-console': 'off' },
	},
];
