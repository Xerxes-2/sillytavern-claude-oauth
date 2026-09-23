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
 * Only one login may be in flight at a time.
 */
export function createLoginManager({ store, oauth, config, log = () => {} }) {
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
			});
	}

	async function start() {
		if (pending) {
			return { authUrl: pending.authUrl, pending: true };
		}

		const state = {
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
				await store.save(credentials);
				log('Claude OAuth login completed.');
			} catch (error) {
				state.error = error.message || String(error);
				log(`Claude OAuth login failed: ${state.error}`);
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

		await Promise.race([authUrlReady.promise, delay(15000)]);

		if (!state.authUrl) {
			throw new Error(state.error || 'Claude OAuth login did not produce an authorization URL.');
		}
		return { authUrl: state.authUrl, pending: true };
	}

	async function submitCode(input) {
		const state = pending;
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
			return { ok: false, error: state.error };
		}
		return { ok: true };
	}

	/** Cancels whichever phase is running: waiting for the code, or exchanging it. */
	function cancel() {
		const state = pending;
		if (!state) {
			return { cancelled: false };
		}
		state.rejectCode?.(new Error('Claude login cancelled.'));
		state.abort.abort(new Error('Claude login cancelled.'));
		return { cancelled: true };
	}

	function status() {
		return {
			pending: Boolean(pending),
			authUrl: pending?.authUrl ?? null,
			startedAt: pending?.startedAt ?? null,
		};
	}

	return { start, submitCode, cancel, status };
}
