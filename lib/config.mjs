import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * SillyTavern publishes its resolved `--dataRoot` as `globalThis.DATA_ROOT`
 * before loading plugins. Per-user data (including this plugin's accounts)
 * lives under `<DATA_ROOT>/<user handle>/`, the same layout ST's own
 * `getUserDirectories()` uses. Falls back to the default layout
 * (`<SillyTavern>/data`) when running outside ST (tests).
 */
export function dataRoot() {
	if (typeof globalThis.DATA_ROOT === 'string' && globalThis.DATA_ROOT) {
		return globalThis.DATA_ROOT;
	}
	return path.resolve(pluginDir, '..', '..', 'data');
}

/**
 * Everything is env-overridable so the plugin can be tested (or relocated)
 * without touching code. Defaults assume the plugin lives at
 * `<SillyTavern>/plugins/claude-oauth`.
 */
export const CONFIG = {
	pluginDir,

	/** Loopback reverse proxy that SillyTavern points its Claude source at. */
	proxyHost: process.env.CLAUDE_OAUTH_PROXY_HOST || '127.0.0.1',
	proxyPort: Number(process.env.CLAUDE_OAUTH_PROXY_PORT || 45277),

	/** Upstream Anthropic API (overridable for tests / alternative gateways). */
	anthropicBaseUrl: (process.env.CLAUDE_OAUTH_ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1').replace(/\/+$/, ''),

	/** Sent as `user-agent: claude-cli/<version>`; OAuth requests are rejected without CLI-shaped headers. */
	claudeCodeVersion: process.env.CLAUDE_OAUTH_CLI_VERSION || '2.1.251',

	/** How long a started login may wait for the pasted redirect URL before giving up. */
	loginTimeoutMs: Number(process.env.CLAUDE_OAUTH_LOGIN_TIMEOUT_MS || 15 * 60 * 1000),

	/** Upper bound for a buffered /messages body (ST itself allows 500 MB; image-heavy chats get large). */
	maxBodyBytes: Number(process.env.CLAUDE_OAUTH_MAX_BODY_BYTES || 128 * 1024 * 1024),
};

export function proxyBaseUrl(config = CONFIG) {
	return `http://${config.proxyHost}:${config.proxyPort}/v1`;
}
