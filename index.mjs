import { CONFIG, dataRoot, proxyBaseUrl } from './lib/config.mjs';
import { createAnthropicOAuth } from './lib/pi-oauth.mjs';
import { createAccountRegistry, validateAccountName } from './lib/accounts.mjs';
import { createLoginManager } from './lib/login.mjs';
import { buildUpstreamHeaders, startProxyServer } from './lib/proxy.mjs';
import { readJsonBody, sendJson } from './lib/util.mjs';

export const info = {
	id: 'claude-oauth',
	name: 'Claude OAuth (Subscription)',
	description: 'Claude Pro/Max OAuth login for the built-in Claude chat completion source, powered by pi-ai. Multiple accounts per SillyTavern user.',
};

let proxy = null;
let login = null;
let accounts = null;
let piAi = { version: 'unknown', path: 'unknown' };
let started = false;

function log(message) {
	console.log(`[claude-oauth] ${message}`);
}

/**
 * SillyTavern's `setUserDataMiddleware` runs before plugin routers and sets
 * `request.user` (the default user when accounts are disabled). Everything
 * this plugin stores is scoped to that handle.
 */
function userHandle(request) {
	const handle = request.user?.profile?.handle;
	if (typeof handle !== 'string' || !handle) {
		throw Object.assign(new Error('Not logged in to SillyTavern.'), { statusCode: 401 });
	}
	return handle;
}

async function guard(response, handler) {
	try {
		await handler();
	} catch (error) {
		const statusCode = error.statusCode ?? 500;
		if (statusCode >= 500) {
			log(`Request failed: ${error.message}`);
		}
		sendJson(response, statusCode, { ok: false, error: error.message });
	}
}

function badRequest(message) {
	return Object.assign(new Error(message), { statusCode: 400 });
}

export async function init(router) {
	const oauth = await createAnthropicOAuth();
	piAi = { version: oauth.piAiVersion, path: oauth.piAiPath };

	accounts = createAccountRegistry({
		dataRoot: dataRoot(),
		// pi-ai applies its own 30 s request timeout to the refresh call.
		refresh: (refreshToken) => oauth.refresh(refreshToken),
		log,
	});
	await accounts.scan();

	login = createLoginManager({
		oauth,
		config: CONFIG,
		onSuccess: ({ owner, name, credentials }) => accounts.upsert(owner, name, credentials),
		log,
	});

	proxy = await startProxyServer({
		config: CONFIG,
		resolveAccount: (secret) => accounts.resolveBySecret(secret),
		log,
	});

	router.get('/status', async (request, response) => guard(response, async () => {
		const handle = userHandle(request);
		const list = await accounts.list(handle);
		sendJson(response, 200, {
			ok: true,
			piAi: { ...piAi },
			proxyUrl: proxyBaseUrl(),
			callbackPort: 53692,
			accounts: list.map((account) => account.status()),
			login: login.status(handle),
		});
	}));

	/** Start (or re-run) the login for an account. Existing accounts keep their secret. */
	router.post('/login', async (request, response) => guard(response, async () => {
		const handle = userHandle(request);
		const body = await readJsonBody(request);
		let name;
		try {
			name = validateAccountName(body.name);
		} catch (error) {
			throw badRequest(error.message);
		}
		const result = await login.start({ owner: handle, name });
		sendJson(response, 200, { ok: true, ...result });
	}));

	router.post('/login/code', async (request, response) => guard(response, async () => {
		const handle = userHandle(request);
		const body = await readJsonBody(request);
		const result = await login.submitCode(handle, body.code ?? body.input ?? body.url);
		sendJson(response, result.ok ? 200 : 400, result);
	}));

	router.post('/login/cancel', async (request, response) => guard(response, async () => {
		sendJson(response, 200, { ok: true, ...login.cancel(userHandle(request)) });
	}));

	router.delete('/accounts/:name', async (request, response) => guard(response, async () => {
		const handle = userHandle(request);
		const name = validateAccountName(request.params?.name);
		const pending = login.status(handle);
		if (pending.pending && pending.name === name) {
			login.cancel(handle);
		}
		const removed = await accounts.remove(handle, name);
		sendJson(response, removed ? 200 : 404, { ok: removed, name });
	}));

	/** Cheap end-to-end check: does the stored token actually work upstream? */
	router.get('/accounts/:name/verify', async (request, response) => guard(response, async () => {
		const handle = userHandle(request);
		const name = validateAccountName(request.params?.name);
		const account = await accounts.get(handle, name);
		if (!account) {
			sendJson(response, 404, { ok: false, error: `No account named "${name}".` });
			return;
		}
		const accessToken = await account.getAccessToken();
		const upstream = await fetch(`${CONFIG.anthropicBaseUrl}/models`, {
			headers: buildUpstreamHeaders({}, accessToken, CONFIG),
		});
		const text = await upstream.text();
		sendJson(response, upstream.ok ? 200 : 502, {
			ok: upstream.ok,
			name,
			status: upstream.status,
			body: text.slice(0, 500),
		});
	}));

	if (!started) {
		started = true;
		log(`Reverse proxy URL for SillyTavern: ${proxyBaseUrl()}`);
		log(`pi-ai ${piAi.version} (${piAi.path})`);
	}
}

export async function exit() {
	if (proxy) {
		await proxy.close();
		proxy = null;
	}
	started = false;
}
