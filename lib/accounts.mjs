/**
 * Account registry: many Claude accounts per SillyTavern user.
 *
 * Layout mirrors SillyTavern's own per-user directories:
 *
 *   <DATA_ROOT>/<handle>/claude-oauth/accounts/<name>.json
 *   { name, secret, createdAt, credentials: { refresh, access, expires } }
 *
 * Every account gets its own random `secret`. SillyTavern sends it as the
 * "proxy password" (`x-api-key`), and the loopback proxy resolves the account
 * from the secret alone, so the proxy URL is the same for everyone and the
 * ST user handle never appears in a URL.
 *
 * Token refresh is single-flight per account: Anthropic rotates refresh
 * tokens, so a second concurrent refresh with a stale token would invalidate
 * the account. The rotated token is persisted before the access token is used.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

/**
 * Refresh this long before the stored `expires`. pi-ai already subtracts five
 * minutes from Anthropic's `expires_in` when it computes `expires`, so this only
 * needs to cover the time between the check and the upstream call.
 */
const EXPIRY_SKEW_MS = 30 * 1000;

export function validateAccountName(name) {
	const value = String(name ?? '').trim();
	if (!NAME_RE.test(value)) {
		throw new Error('Account name must be 1-32 characters: letters, digits, "-" or "_".');
	}
	return value;
}

export function accountsDir(dataRoot, handle) {
	return path.join(dataRoot, handle, 'claude-oauth', 'accounts');
}

async function writePrivate(file, content) {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	await fs.writeFile(tmp, content, { mode: 0o600 });
	await fs.rename(tmp, file);
}

function validCredentials(value) {
	return Boolean(value?.refresh && value?.access && value?.expires);
}

export function createAccountRegistry({ dataRoot, refresh, log = () => {} }) {
	/** @type {Map<string, Account>} secret -> account */
	const bySecret = new Map();
	/** @type {Map<string, Account>} `${handle}/${name}` -> account */
	const byKey = new Map();

	function key(handle, name) {
		return `${handle}/${name}`;
	}

	function makeAccount({ handle, name, secret, createdAt, credentials, file }) {
		let inflight = null;
		/** Last quota snapshot seen on an upstream response. Memory only; it is stale after a restart anyway. */
		let usage = null;

		const account = {
			handle,
			name,
			secret,
			createdAt,
			file,
			credentials,
			label: key(handle, name),

			status() {
				if (!validCredentials(account.credentials)) {
					return { name, secret, createdAt, loggedIn: false, usage };
				}
				const { expires } = account.credentials;
				return { name, secret, createdAt, loggedIn: true, expiresAt: expires, expiresIn: expires - Date.now(), usage };
			},

			recordUsage(next) {
				usage = next;
			},

			async save(next) {
				if (!validCredentials(next)) {
					throw new Error('Refusing to save incomplete OAuth credentials.');
				}
				account.credentials = { refresh: next.refresh, access: next.access, expires: next.expires };
				await writePrivate(file, `${JSON.stringify({
					name,
					secret,
					createdAt,
					credentials: account.credentials,
				}, null, '\t')}\n`);
			},

			/** @returns {Promise<string>} a valid access token, refreshing it first when needed. */
			async getAccessToken() {
				const creds = account.credentials;
				if (!validCredentials(creds)) {
					throw new Error(`Claude account "${name}" has no credentials. Log in again from the plugin panel.`);
				}
				if (creds.expires - EXPIRY_SKEW_MS > Date.now()) {
					return creds.access;
				}
				if (!inflight) {
					log(`Access token for ${account.label} expired, refreshing...`);
					inflight = (async () => {
						const next = await refresh(creds.refresh);
						await account.save(next);
						return next;
					})().finally(() => {
						inflight = null;
					});
				}
				try {
					return (await inflight).access;
				} catch (error) {
					throw new Error(`Claude OAuth token refresh failed for ${account.label}: ${error.message}`);
				}
			},
		};
		return account;
	}

	function register(account) {
		byKey.set(account.label, account);
		bySecret.set(account.secret, account);
	}

	function unregister(account) {
		byKey.delete(account.label);
		bySecret.delete(account.secret);
	}

	async function loadFile(handle, file) {
		const name = path.basename(file, '.json');
		if (byKey.has(key(handle, name))) {
			return byKey.get(key(handle, name));
		}
		let parsed;
		try {
			parsed = JSON.parse(await fs.readFile(file, 'utf8'));
		} catch (error) {
			log(`Ignoring unreadable account file ${file}: ${error.message}`);
			return null;
		}
		if (!NAME_RE.test(name) || parsed?.name !== name || typeof parsed?.secret !== 'string' || !parsed.secret) {
			log(`Ignoring malformed account file ${file}`);
			return null;
		}
		const account = makeAccount({
			handle,
			name,
			secret: parsed.secret,
			createdAt: Number(parsed.createdAt) || 0,
			credentials: validCredentials(parsed.credentials) ? parsed.credentials : null,
			file,
		});
		register(account);
		return account;
	}

	async function loadUser(handle) {
		const dir = accountsDir(dataRoot, handle);
		let entries;
		try {
			entries = await fs.readdir(dir);
		} catch (error) {
			if (error.code === 'ENOENT') return;
			throw error;
		}
		for (const entry of entries) {
			if (entry.endsWith('.json')) {
				await loadFile(handle, path.join(dir, entry));
			}
		}
	}

	return {
		/** Load every user's accounts so the proxy works right after a restart. */
		async scan() {
			let entries;
			try {
				entries = await fs.readdir(dataRoot, { withFileTypes: true });
			} catch (error) {
				if (error.code === 'ENOENT') return;
				throw error;
			}
			for (const entry of entries) {
				if (entry.isDirectory() && !entry.name.startsWith('_')) {
					await loadUser(entry.name);
				}
			}
		},

		/** @returns {Promise<Account[]>} */
		async list(handle) {
			await loadUser(handle);
			return [...byKey.values()]
				.filter((account) => account.handle === handle)
				.sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
		},

		async get(handle, name) {
			await loadUser(handle);
			return byKey.get(key(handle, name)) ?? null;
		},

		/**
		 * Create the account, or replace its credentials when it already exists.
		 * Re-login keeps the secret so ST's saved proxy preset keeps working.
		 */
		async upsert(handle, name, credentials) {
			await loadUser(handle);
			let account = byKey.get(key(handle, name));
			if (!account) {
				account = makeAccount({
					handle,
					name,
					secret: crypto.randomBytes(24).toString('base64url'),
					createdAt: Date.now(),
					credentials: null,
					file: path.join(accountsDir(dataRoot, handle), `${name}.json`),
				});
				register(account);
			}
			await account.save(credentials);
			return account;
		},

		async remove(handle, name) {
			const account = await this.get(handle, name);
			if (!account) {
				return false;
			}
			unregister(account);
			await fs.rm(account.file, { force: true });
			return true;
		},

		/** Proxy lookup: the secret alone identifies the account. */
		resolveBySecret(secret) {
			if (typeof secret !== 'string' || !secret) return null;
			for (const [candidate, account] of bySecret) {
				const a = Buffer.from(candidate);
				const b = Buffer.from(secret);
				if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
					return account;
				}
			}
			return null;
		},
	};
}

/**
 * @typedef {object} Account
 * @property {string} handle
 * @property {string} name
 * @property {string} secret
 * @property {number} createdAt
 * @property {string} label
 * @property {() => object} status
 * @property {(creds: object) => Promise<void>} save
 * @property {() => Promise<string>} getAccessToken
 */
