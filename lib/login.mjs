import { deferred, delay } from './util.mjs';

/**
 * Owns the interactive part of the login flow.
 *
 * pi-ai runs a callback server on a hard-coded 127.0.0.1:53692 and, in
 * parallel, offers a "manual code" step. That matters for Docker and remote
 * setups where the browser cannot reach the container: the URL the browser
 * lands on is unreachable, but it still carries `code` + `state` in the query
 * string, so the user pastes it back into the UI and pi-ai parses it.
 *
 * Because of that fixed port only one login may be in flight per process.
 * Each login is tagged with an `owner` (the ST user handle) and the target
 * account `name`; other owners see it as "busy", not as their own login.
 */
/**
 * @typedef {object} LoginState
 * @property {string} owner
 * @property {string} name
 * @property {string|null} authUrl
 * @property {((code: string) => void)|null} resolveCode
 * @property {((error: Error) => void)|null} rejectCode
 * @property {ReturnType<typeof setTimeout>|null} timer
 * @property {string|null} error
 * @property {number} startedAt
 * @property {AbortController} abort
 * @property {Promise<void>} [promise]
 */

/**
 * @param {{
 *   oauth: import('./pi-oauth.mjs').AnthropicOAuth,
 *   config: { loginTimeoutMs: number },
 *   onSuccess: (result: {
 *     owner: string,
 *     name: string,
 *     credentials: import('./accounts.mjs').Credentials,
 *   }) => Promise<unknown>,
 *   log?: (message: string) => void,
 * }} options
 */
export function createLoginManager({ oauth, config, onSuccess, log = () => {} }) {
	/** @type {LoginState|null} The one login this server allows at a time. */
	let pending = null;

	/**
	 * The "paste the redirect URL" side channel. pi-ai aborts `signal` when its
	 * callback server receives the code first; settle the promise then so it
	 * does not dangle until the timeout.
	 */
	function manualCodeChannel(state) {
		return (signal) =>
			new Promise((resolve, reject) => {
				const settle = () => {
					if (state.timer) clearTimeout(state.timer);
					state.timer = null;
					state.resolveCode = null;
					state.rejectCode = null;
					signal?.removeEventListener('abort', onAbort);
				};
				const onAbort = () => state.rejectCode?.(new Error('Manual code entry no longer needed.'));
				state.resolveCode = (value) => {
					settle();
					resolve(value);
				};
				state.rejectCode = (error) => {
					settle();
					reject(error);
				};
				if (signal?.aborted) {
					onAbort();
					return;
				}
				signal?.addEventListener('abort', onAbort, { once: true });
				state.timer = setTimeout(() => {
					state.rejectCode?.(new Error('Claude login timed out. Start the login again.'));
				}, config.loginTimeoutMs);
				// A 15-minute pending login must not keep SillyTavern's process alive on exit.
				state.timer.unref?.();
			});
	}

	function own(owner) {
		if (!pending) {
			return null;
		}
		if (pending.owner !== owner) {
			throw new Error('Another Claude login is in progress on this server. Wait for it to finish or time out.');
		}
		return pending;
	}

	async function start({ owner, name }) {
		const existing = own(owner);
		if (existing) {
			if (existing.name !== name) {
				throw new Error(`A login for account "${existing.name}" is already in progress. Cancel it first.`);
			}
			return { authUrl: existing.authUrl, name, pending: true };
		}

		/** @type {LoginState} */
		const state = {
			owner,
			name,
			authUrl: null,
			resolveCode: null,
			rejectCode: null,
			timer: null,
			error: null,
			startedAt: Date.now(),
			abort: new AbortController(),
		};
		pending = state;
		const authUrlReady = deferred();

		state.promise = (async () => {
			try {
				const credentials = await oauth.login({
					signal: state.abort.signal,
					onAuthUrl: (url) => {
						state.authUrl = url;
						authUrlReady.resolve();
					},
					onManualCode: manualCodeChannel(state),
					onProgress: (message) => log(message),
				});
				await onSuccess({ owner, name, credentials });
				log(`Claude OAuth login completed for ${owner}/${name}.`);
			} catch (error) {
				// pi-ai appends "; stack=..." to exchange errors; keep the useful part for the UI.
				// eslint-disable-next-line require-atomic-updates -- `state` is this login's own const, not shared mutable state.
				state.error = (error.message || String(error)).replace(/;\s*stack=[\s\S]*$/, '');
				log(`Claude OAuth login failed for ${owner}/${name}: ${state.error}`);
				authUrlReady.resolve();
			} finally {
				if (state.timer) clearTimeout(state.timer);
				state.timer = null;
				state.resolveCode = null;
				state.rejectCode = null;
				if (pending === state) {
					pending = null;
				}
			}
		})();

		await Promise.race([authUrlReady.promise, delay(15000, { unref: true })]);

		if (!state.authUrl) {
			throw new Error(state.error || 'Claude OAuth login did not produce an authorization URL.');
		}
		return { authUrl: state.authUrl, name, pending: true };
	}

	async function submitCode(owner, input) {
		const state = own(owner);
		if (!state?.resolveCode) {
			throw new Error('No Claude login is in progress.');
		}
		const value = String(input || '').trim();
		if (!value) {
			throw new Error('Paste the full redirect URL (or the authorization code) first.');
		}
		state.resolveCode(value);
		await state.promise;
		if (state.error) {
			return { ok: false, name: state.name, error: state.error };
		}
		return { ok: true, name: state.name };
	}

	/** Cancels whichever phase is running: waiting for the code, or exchanging it. */
	function cancel(owner) {
		const state = own(owner);
		if (!state) {
			return { cancelled: false };
		}
		state.rejectCode?.(new Error('Claude login cancelled.'));
		state.abort.abort(new Error('Claude login cancelled.'));
		return { cancelled: true, name: state.name };
	}

	function status(owner) {
		if (!pending) {
			return { pending: false, busy: false };
		}
		if (pending.owner !== owner) {
			return { pending: false, busy: true };
		}
		return {
			pending: true,
			busy: false,
			name: pending.name,
			authUrl: pending.authUrl,
			startedAt: pending.startedAt,
		};
	}

	/** Owner-agnostic cancel for plugin shutdown; `cancel()` refuses other owners' logins. */
	function shutdown() {
		if (!pending) {
			return { cancelled: false };
		}
		const state = pending;
		const error = new Error('SillyTavern is shutting down.');
		state.rejectCode?.(error);
		state.abort.abort(error);
		if (state.timer) clearTimeout(state.timer);
		state.timer = null;
		pending = null;
		return { cancelled: true, name: state.name };
	}

	return { start, submitCode, cancel, status, shutdown };
}
