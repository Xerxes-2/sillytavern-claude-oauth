import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { credentialsFile, proxySecretFile } from './config.mjs';

/**
 * Refresh this long before the stored `expires`. pi-ai already subtracts five
 * minutes from Anthropic's `expires_in` when it computes `expires`, so this only
 * needs to cover the time between the check and the upstream call.
 */
const EXPIRY_SKEW_MS = 30 * 1000;

async function writePrivate(file, content) {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	await fs.writeFile(tmp, content, { mode: 0o600 });
	await fs.rename(tmp, file);
}

/**
 * Shared secret SillyTavern sends as the proxy password. Without it every
 * local process could spend the subscription through the loopback proxy.
 * Generated once, persisted next to the credentials.
 */
export async function loadProxySecret(config) {
	if (config.proxySecret) {
		return config.proxySecret;
	}
	const file = proxySecretFile(config);
	try {
		const existing = (await fs.readFile(file, 'utf8')).trim();
		if (existing) return existing;
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
	}
	const secret = crypto.randomBytes(24).toString('base64url');
	await writePrivate(file, `${secret}\n`);
	return secret;
}

/**
 * Credential store with a single-flight refresh.
 *
 * Anthropic rotates refresh tokens: a second concurrent refresh with a stale
 * refresh token invalidates the account, so all refreshes must be serialised
 * and the rotated token must be persisted before the access token is used.
 */
export function createCredentialStore({ config, refresh, log = () => {} }) {
	const file = credentialsFile(config);
	let credentials = null;
	let loaded = false;
	let inflight = null;

	async function readFromDisk() {
		try {
			const raw = await fs.readFile(file, 'utf8');
			const parsed = JSON.parse(raw);
			if (parsed?.refresh && parsed?.access && parsed?.expires) {
				return { refresh: parsed.refresh, access: parsed.access, expires: parsed.expires };
			}
			log(`Ignoring malformed credentials file at ${file}`);
			return null;
		} catch (error) {
			if (error.code !== 'ENOENT') {
				log(`Could not read credentials file: ${error.message}`);
			}
			return null;
		}
	}

	async function save(next) {
		credentials = next;
		loaded = true;
		await writePrivate(file, `${JSON.stringify(next, null, '\t')}\n`);
		return next;
	}

	async function current() {
		if (!loaded) {
			credentials = await readFromDisk();
			loaded = true;
		}
		return credentials;
	}

	return {
		file,

		async status() {
			const creds = await current();
			if (!creds) {
				return { loggedIn: false };
			}
			return { loggedIn: true, expiresAt: creds.expires, expiresIn: creds.expires - Date.now() };
		},

		async save(creds) {
			await save(creds);
			log('Claude OAuth credentials saved.');
		},

		async clear() {
			credentials = null;
			loaded = true;
			await fs.rm(file, { force: true });
		},

		/** @returns {Promise<string>} a valid access token, refreshing it first when needed. */
		async getAccessToken() {
			const creds = await current();
			if (!creds) {
				throw new Error('Claude OAuth is not configured. Run the login in the plugin panel first.');
			}
			if (creds.expires - EXPIRY_SKEW_MS > Date.now()) {
				return creds.access;
			}
			if (!inflight) {
				log('Claude OAuth access token expired, refreshing...');
				inflight = (async () => {
					const next = await refresh(creds.refresh);
					return await save(next);
				})().finally(() => {
					inflight = null;
				});
			}
			try {
				const next = await inflight;
				return next.access;
			} catch (error) {
				throw new Error(`Claude OAuth token refresh failed: ${error.message}`);
			}
		},
	};
}
