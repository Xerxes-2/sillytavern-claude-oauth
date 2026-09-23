import { CONFIG, proxyBaseUrl } from './lib/config.mjs';
import { createAnthropicOAuth } from './lib/pi-oauth.mjs';
import { createCredentialStore, loadProxySecret } from './lib/store.mjs';
import { createLoginManager } from './lib/login.mjs';
import { buildUpstreamHeaders, startProxyServer } from './lib/proxy.mjs';
import { readJsonBody, sendJson } from './lib/util.mjs';

export const info = {
	id: 'claude-oauth',
	name: 'Claude OAuth (Subscription)',
	description: 'Claude Pro/Max OAuth login for the built-in Claude chat completion source, powered by pi-ai.',
};

let proxy = null;
let login = null;
let store = null;
let piAi = { version: 'unknown', path: 'unknown' };
let proxySecret = null;
let started = false;

function log(message) {
	console.log(`[claude-oauth] ${message}`);
}

async function guard(response, handler) {
	try {
		await handler();
	} catch (error) {
		log(`Request failed: ${error.message}`);
		sendJson(response, 500, { ok: false, error: error.message });
	}
}

export async function init(router) {
	const oauth = await createAnthropicOAuth();
	piAi = { version: oauth.piAiVersion, path: oauth.piAiPath };

	proxySecret = await loadProxySecret(CONFIG);
	store = createCredentialStore({
		config: CONFIG,
		// pi-ai applies its own 30 s request timeout to the refresh call.
		refresh: (refreshToken) => oauth.refresh(refreshToken),
		log,
	});
	login = createLoginManager({ store, oauth, config: CONFIG, log });
	proxy = await startProxyServer({
		config: CONFIG,
		proxySecret,
		getAccessToken: () => store.getAccessToken(),
		log,
	});

	// Note: credentials are per-server, not per-ST-user. Any logged-in ST user
	// can reach these routes; document this for multi-user deployments.
	router.get('/status', async (_request, response) => guard(response, async () => {
		sendJson(response, 200, {
			ok: true,
			piAi: { ...piAi },
			proxyUrl: proxyBaseUrl(),
			proxySecret,
			credentials: await store.status(),
			login: login.status(),
			callbackPort: 53692,
		});
	}));

	router.post('/login', async (_request, response) => guard(response, async () => {
		const result = await login.start();
		sendJson(response, 200, { ok: true, ...result });
	}));

	router.post('/login/code', async (request, response) => guard(response, async () => {
		const body = await readJsonBody(request);
		const result = await login.submitCode(body.code ?? body.input ?? body.url);
		sendJson(response, result.ok ? 200 : 400, result);
	}));

	router.post('/login/cancel', async (_request, response) => guard(response, async () => {
		sendJson(response, 200, { ok: true, ...login.cancel() });
	}));

	router.post('/logout', async (_request, response) => guard(response, async () => {
		login.cancel();
		await store.clear();
		sendJson(response, 200, { ok: true });
	}));

	/** Cheap end-to-end check: does the stored token actually work upstream? */
	router.get('/verify', async (_request, response) => guard(response, async () => {
		const accessToken = await store.getAccessToken();
		const upstream = await fetch(`${CONFIG.anthropicBaseUrl}/models`, {
			headers: buildUpstreamHeaders({}, accessToken, CONFIG),
		});
		const text = await upstream.text();
		sendJson(response, upstream.ok ? 200 : 502, {
			ok: upstream.ok,
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
