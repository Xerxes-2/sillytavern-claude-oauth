#!/usr/bin/env node
/**
 * Bundles pi-ai's Anthropic OAuth flow into `vendor/anthropic-oauth.mjs`.
 *
 * Why vendor at all: pi-ai depends on openai, @aws-sdk, @google/genai and
 * protobufjs as *hard* dependencies (~85 MB installed), none of which the OAuth
 * code path ever loads. Bundling the reachable 15 KB lets the plugin ship with
 * zero runtime dependencies, so users only clone the repo.
 *
 * Why this entry point: `dist/auth/oauth/anthropic.js` is the module that
 * `anthropicProvider().auth.oauth` lazily loads (see `dist/auth/oauth/load.js`),
 * and it is self-contained — no third-party imports at all. It is an internal
 * path, which is exactly why `--check` runs in CI: if a pi-ai upgrade moves or
 * reshapes it, the build fails loudly instead of the plugin breaking at login.
 *
 *   node scripts/build-vendor.mjs          # regenerate the bundle
 *   node scripts/build-vendor.mjs --check  # verify it matches the pinned pi-ai
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PI_AI = '@earendil-works/pi-ai';
/** Relative to pi-ai's package root. */
const ENTRY = 'dist/auth/oauth/anthropic.js';
/** The named export the plugin consumes; asserted below so a rename can't slip through. */
const REQUIRED_EXPORTS = ['anthropicOAuth'];

const OUTPUT = path.join(root, 'vendor', 'anthropic-oauth.mjs');
const MANIFEST = path.join(root, 'vendor', 'manifest.json');

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
	console.error(`build-vendor: ${message}`);
	process.exit(1);
}

/** The pinned version is the single source of truth; the bundle must match it. */
async function pinnedPiAiVersion() {
	const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
	const pinned = pkg.devDependencies?.[PI_AI];
	if (!pinned) fail(`${PI_AI} is not listed in devDependencies of package.json`);
	if (!/^\d+\.\d+\.\d+$/.test(pinned)) {
		fail(`${PI_AI} must be pinned to an exact version in devDependencies, found "${pinned}"`);
	}
	return pinned;
}

/** Walks up from pi-ai's main entry: its `exports` map hides `./package.json`. */
async function findPackageJson(fromFile) {
	let dir = path.dirname(fromFile);
	for (let depth = 0; depth < 8; depth++) {
		const candidate = path.join(dir, 'package.json');
		try {
			const parsed = JSON.parse(await fs.readFile(candidate, 'utf8'));
			if (parsed.name === PI_AI) return { pkgPath: candidate, pkg: parsed };
		} catch {
			// keep walking
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

async function locatePiAi(pinned) {
	let mainEntry;
	try {
		// import.meta.resolve, not require.resolve: pi-ai is ESM-only and its
		// exports map has no "require" condition.
		mainEntry = fileURLToPath(import.meta.resolve(PI_AI));
	} catch {
		fail(`cannot resolve ${PI_AI}. Run the dev install first (pnpm install / npm install).`);
	}
	const found = await findPackageJson(mainEntry);
	if (!found) fail(`resolved ${PI_AI} to ${mainEntry} but found no package.json above it`);
	const { pkgPath, pkg } = found;
	if (pkg.version !== pinned) {
		fail(`installed ${PI_AI} is ${pkg.version} but package.json pins ${pinned}. Reinstall before bundling.`);
	}
	const dir = path.dirname(pkgPath);
	const entry = path.join(dir, ENTRY);
	try {
		await fs.access(entry);
	} catch {
		fail([
			`${PI_AI} ${pkg.version} has no ${ENTRY}.`,
			'The OAuth flow moved: re-check dist/auth/oauth/load.js and update ENTRY in this script.',
		].join('\n'));
	}
	return { dir, entry, version: pkg.version };
}

async function bundle(source) {
	let esbuild;
	try {
		esbuild = await import('esbuild');
	} catch {
		fail('esbuild is not installed. Run the dev install first (pnpm install / npm install).');
	}
	const result = await esbuild.build({
		entryPoints: [source.entry],
		bundle: true,
		write: false,
		format: 'esm',
		platform: 'node',
		target: 'node20',
		// Keep upstream @license/@preserve blocks: this is third-party MIT code.
		legalComments: 'inline',
		metafile: true,
		logLevel: 'silent',
	});

	// A third-party import would mean the flow stopped being self-contained and
	// the "zero runtime dependencies" promise silently broke.
	const foreign = new Set();
	for (const input of Object.keys(result.metafile.inputs)) {
		const match = input.match(/node_modules\/(?:\.pnpm\/)?(@[^/]+[/+][^/]+|[^/@][^/]*)/);
		if (match && !match[1].includes('pi-ai')) foreign.add(match[1]);
	}
	if (foreign.size > 0) {
		fail(`the bundle pulled in third-party packages: ${[...foreign].join(', ')}`);
	}

	const code = result.outputFiles[0].text;
	for (const name of REQUIRED_EXPORTS) {
		if (!new RegExp(`\\b${name}\\b`).test(code)) {
			fail(`bundle does not contain the expected export "${name}"`);
		}
	}
	return { code, esbuildVersion: esbuild.version };
}

function header({ version, esbuildVersion }) {
	return [
		'// @generated by scripts/build-vendor.mjs — DO NOT EDIT.',
		'// @ts-nocheck -- third-party bundle, not our code to type.',
		'//',
		`// Source: ${PI_AI}@${version} (MIT), ${ENTRY}`,
		`// Bundled with esbuild ${esbuildVersion}.`,
		'//',
		'// Regenerate with: npm run vendor    Verify with: npm run vendor:check',
		'',
	].join('\n');
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

async function main() {
	const check = process.argv.includes('--check');
	const pinned = await pinnedPiAiVersion();
	const source = await locatePiAi(pinned);
	const { code, esbuildVersion } = await bundle(source);

	const contents = `${header({ version: source.version, esbuildVersion })}${code}`;
	const manifest = {
		source: `${PI_AI}@${source.version}`,
		piAiVersion: source.version,
		entry: ENTRY,
		exports: REQUIRED_EXPORTS,
		esbuild: esbuildVersion,
		bytes: Buffer.byteLength(contents),
		sha256: sha256(contents),
	};

	if (!check) {
		await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
		await fs.writeFile(OUTPUT, contents);
		await fs.writeFile(MANIFEST, `${JSON.stringify(manifest, null, '\t')}\n`);
		console.log(`build-vendor: wrote ${path.relative(root, OUTPUT)} (${(manifest.bytes / 1024).toFixed(1)} KB) from ${manifest.source}`);
		return;
	}

	let onDisk;
	try {
		onDisk = await fs.readFile(OUTPUT, 'utf8');
	} catch {
		fail(`${path.relative(root, OUTPUT)} is missing. Run: npm run vendor`);
	}
	const recorded = JSON.parse(await fs.readFile(MANIFEST, 'utf8'));
	if (sha256(onDisk) !== recorded.sha256) {
		fail(`${path.relative(root, OUTPUT)} does not match vendor/manifest.json (edited by hand?). Run: npm run vendor`);
	}
	if (recorded.esbuild !== esbuildVersion) {
		fail(`vendor was built with esbuild ${recorded.esbuild} but ${esbuildVersion} is installed. Pin esbuild or run: npm run vendor`);
	}
	if (onDisk !== contents) {
		fail(`vendor is stale for ${PI_AI}@${source.version}. Run: npm run vendor`);
	}
	console.log(`build-vendor: vendor is up to date with ${manifest.source} (${manifest.sha256.slice(0, 12)})`);
}

await main();
