/**
 * Adapter over pi-ai's Anthropic (Claude Pro/Max) OAuth flow.
 *
 * pi-ai's supported entry point is `Provider.auth.oauth` (see its 0.80.8
 * changelog: "Use canonical Provider.auth.oauth methods instead"). The
 * `providers/*` subpath is a public export, and the Anthropic provider lazily
 * loads the OAuth implementation on first use, so importing it costs ~20 ms and
 * pulls in none of the request-serialisation code.
 *
 * Everything hard still comes from pi-ai: Claude Code's client id, PKCE, the
 * authorization-code exchange, token refresh and the callback server.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROVIDER_SPECIFIER = '@earendil-works/pi-ai/providers/anthropic';

/** Best-effort: walk up from the resolved provider file to pi-ai's package.json. */
function describeInstall() {
	let file;
	try {
		file = fileURLToPath(import.meta.resolve(PROVIDER_SPECIFIER));
	} catch {
		return { version: 'unknown', path: 'unknown' };
	}
	let dir = path.dirname(file);
	for (let i = 0; i < 6; i++) {
		const pkg = path.join(dir, 'package.json');
		if (fs.existsSync(pkg)) {
			try {
				const parsed = JSON.parse(fs.readFileSync(pkg, 'utf8'));
				if (parsed.name === '@earendil-works/pi-ai') {
					return { version: parsed.version ?? 'unknown', path: dir };
				}
			} catch {
				// keep walking
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return { version: 'unknown', path: file };
}

function normalise(credentials) {
	if (!credentials || typeof credentials !== 'object') {
		throw new Error('pi-ai returned no OAuth credentials');
	}
	const { refresh, access, expires } = credentials;
	if (!refresh || !access || !expires) {
		throw new Error(`pi-ai returned incomplete OAuth credentials: ${Object.keys(credentials).join(', ')}`);
	}
	// pi-ai tags credentials with type: "oauth"; keep our stored format version-agnostic.
	return { refresh, access, expires };
}

/**
 * @returns {Promise<{
 *   piAiVersion: string,
 *   piAiPath: string,
 *   login(options: {
 *     signal?: AbortSignal,
 *     onAuthUrl: (url: string, instructions?: string) => void,
 *     onManualCode: (signal?: AbortSignal) => Promise<string>,
 *     onProgress?: (message: string) => void,
 *   }): Promise<{refresh: string, access: string, expires: number}>,
 *   refresh(refreshToken: string, signal?: AbortSignal): Promise<{refresh: string, access: string, expires: number}>,
 * }>}
 */
export async function createAnthropicOAuth() {
	let module;
	try {
		module = await import(PROVIDER_SPECIFIER);
	} catch (error) {
		throw new Error([
			`Could not import ${PROVIDER_SPECIFIER}: ${error.message}`,
			'Install pi-ai inside the plugin directory (plugins/claude-oauth) with: npm install',
		].join('\n'));
	}

	const install = describeInstall();
	const oauth = module.anthropicProvider?.()?.auth?.oauth;
	if (typeof oauth?.login !== 'function' || typeof oauth?.refresh !== 'function') {
		throw new Error([
			`pi-ai ${install.version} does not expose anthropicProvider().auth.oauth with login/refresh.`,
			`Exports seen: ${Object.keys(module).join(', ') || '(none)'}`,
		].join('\n'));
	}

	return {
		piAiVersion: install.version,
		piAiPath: install.path,

		async login({ signal, onAuthUrl, onManualCode, onProgress }) {
			const credentials = await oauth.login({
				// pi-ai requires a real AbortSignal here (it calls addEventListener on it).
				signal: signal ?? new AbortController().signal,
				notify: (event) => {
					if (event?.type === 'auth_url') {
						onAuthUrl(event.url, event.instructions);
					} else if (event?.type === 'progress' && onProgress) {
						onProgress(event.message);
					}
				},
				prompt: async (prompt) => {
					if (prompt?.type === 'manual_code') {
						return await onManualCode(prompt.signal);
					}
					throw new Error(`Unsupported Claude login prompt: ${prompt?.type}`);
				},
			});
			return normalise(credentials);
		},

		async refresh(refreshToken, signal) {
			const credentials = await oauth.refresh(
				{ type: 'oauth', refresh: refreshToken, access: '', expires: 0 },
				signal ?? new AbortController().signal,
			);
			return normalise(credentials);
		},
	};
}
