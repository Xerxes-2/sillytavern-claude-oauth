import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * SillyTavern publishes its resolved `--dataRoot` as `globalThis.DATA_ROOT`
 * before loading plugins. Fall back to the default layout
 * (`<SillyTavern>/data`) when running outside ST (tests).
 */
function defaultDataDir() {
	const root = typeof globalThis.DATA_ROOT === 'string' && globalThis.DATA_ROOT
		? globalThis.DATA_ROOT
		: path.resolve(pluginDir, '..', '..', 'data');
	return path.join(root, 'claude-oauth');
}

/**
 * Everything is env-overridable so the plugin can be tested (or relocated)
 * without touching code. Defaults assume the plugin lives at
 * `<SillyTavern>/plugins/claude-oauth`.
 */
export const CONFIG = {
	pluginDir,

	/** Credentials live outside the plugin dir so plugin reinstalls never touch them. */
	dataDir: process.env.CLAUDE_OAUTH_DATA_DIR || defaultDataDir(),

	/** Loopback reverse proxy that SillyTavern points its Claude source at. */
	proxyHost: process.env.CLAUDE_OAUTH_PROXY_HOST || '127.0.0.1',
	proxyPort: Number(process.env.CLAUDE_OAUTH_PROXY_PORT || 45277),

	/**
	 * Shared secret SillyTavern must send as the proxy password (`x-api-key`).
	 * Generated once and stored in `dataDir` unless overridden here.
	 */
	proxySecret: process.env.CLAUDE_OAUTH_PROXY_SECRET || null,

	/** Upstream Anthropic API (overridable for tests / alternative gateways). */
	anthropicBaseUrl: (process.env.CLAUDE_OAUTH_ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1').replace(/\/+$/, ''),

	/** Sent as `user-agent: claude-cli/<version>`; OAuth requests are rejected without CLI-shaped headers. */
	claudeCodeVersion: process.env.CLAUDE_OAUTH_CLI_VERSION || '2.1.251',

	/** How long a started login may wait for the pasted redirect URL before giving up. */
	loginTimeoutMs: Number(process.env.CLAUDE_OAUTH_LOGIN_TIMEOUT_MS || 15 * 60 * 1000),

	/** Upper bound for a buffered /messages body (ST itself allows 500 MB; image-heavy chats get large). */
	maxBodyBytes: Number(process.env.CLAUDE_OAUTH_MAX_BODY_BYTES || 128 * 1024 * 1024),
};

export function credentialsFile(config = CONFIG) {
	return path.join(config.dataDir, 'credentials.json');
}

export function proxySecretFile(config = CONFIG) {
	return path.join(config.dataDir, 'proxy-secret');
}

export function proxyBaseUrl(config = CONFIG) {
	return `http://${config.proxyHost}:${config.proxyPort}/v1`;
}
