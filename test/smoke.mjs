/**
 * Smoke test: no SillyTavern, no real Anthropic account.
 *
 * It runs the real plugin code against a stand-in Anthropic endpoint and checks
 * the parts that are easy to get wrong: OAuth header rewriting, Claude Code
 * identity injection, beta-header merging, credential refresh serialisation and
 * the interactive login handoff. No network access: pi-ai's token exchange
 * against platform.claude.com is stubbed locally.
 *
 * Usage: node test/smoke.mjs
 * Requires @earendil-works/pi-ai to be installed in the plugin directory.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PROXY_PORT = Number(process.env.SMOKE_PROXY_PORT || 45991);

let failures = 0;
let checks = 0;

function check(name, condition, detail = '') {
	checks++;
	if (condition) {
		console.log(`  ok   ${name}`);
		return;
	}
	failures++;
	console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
}

function createRouter() {
	const routes = new Map();
	return {
		routes,
		stack: [],
		get(route, handler) {
			routes.set(`GET ${route}`, handler);
		},
		post(route, handler) {
			routes.set(`POST ${route}`, handler);
		},
	};
}

function createResponse() {
	return {
		statusCode: 200,
		payload: undefined,
		status(code) {
			this.statusCode = code;
			return this;
		},
		json(payload) {
			this.payload = payload;
			return this;
		},
	};
}

async function callRoute(router, method, route, { body, headers } = {}) {
	const handler = router.routes.get(`${method} ${route}`);
	if (!handler) {
		throw new Error(`Route ${method} ${route} is not registered`);
	}
	// Stand in for express.json(): the plugin reads req.body when it is already an object.
	const request = { method, url: route, headers: headers ?? {}, body };
	const response = createResponse();
	await handler(request, response);
	return response;
}

function startEchoAnthropic() {
	const seen = { requests: [] };
	const server = http.createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) {
			chunks.push(chunk);
		}
		const raw = Buffer.concat(chunks).toString('utf8');
		seen.requests.push({
			path: request.url,
			method: request.method,
			headers: request.headers,
			body: raw ? JSON.parse(raw) : null,
		});

		if (request.url.endsWith('/models')) {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ data: [{ id: 'claude-sonnet-4-6' }] }));
			return;
		}

		response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
		response.write('event: message_start\ndata: {"type":"message_start"}\n\n');
		response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
	});

	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			seen.port = server.address().port;
			seen.server = server;
			resolve(seen);
		});
	});
}

async function postMessages(port, payload, headers = {}, urlPath = '/v1/messages') {
	const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'anthropic-version': '2023-06-01',
			// What ST staging sends unconditionally.
			'anthropic-beta': 'output-128k-2025-02-19,context-1m-2025-08-07',
			...headers,
		},
		body: JSON.stringify(payload),
	});
	const text = await response.text();
	return { status: response.status, text, contentType: response.headers.get('content-type') };
}

/**
 * Keep pi-ai's token exchange off the network: answer platform.claude.com
 * locally with the same shape Anthropic uses for a bad code.
 */
function stubAnthropicTokenEndpoint() {
	const original = globalThis.fetch;
	const seen = { calls: 0 };
	globalThis.fetch = async (input, init) => {
		const url = typeof input === 'string' ? input : input?.url ?? String(input);
		if (url.startsWith('https://platform.claude.com/v1/oauth/token')) {
			seen.calls++;
			seen.lastBody = init?.body ? JSON.parse(init.body) : null;
			return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'smoke' }), {
				status: 400,
				headers: { 'content-type': 'application/json' },
			});
		}
		return original(input, init);
	};
	return { seen, restore: () => { globalThis.fetch = original; } };
}

async function main() {
	const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-oauth-smoke-'));
	const credentialsFile = path.join(dataDir, 'credentials.json');

	const echo = await startEchoAnthropic();
	process.env.CLAUDE_OAUTH_DATA_DIR = dataDir;
	process.env.CLAUDE_OAUTH_PROXY_PORT = String(PROXY_PORT);
	process.env.CLAUDE_OAUTH_ANTHROPIC_BASE_URL = `http://127.0.0.1:${echo.port}/v1`;

	// A syntactically valid (never used) OAuth credential so the proxy has a token.
	await fs.writeFile(credentialsFile, JSON.stringify({
		refresh: 'sk-ant-ort01-smoke',
		access: 'sk-ant-oat01-smoke-access',
		expires: Date.now() + 60 * 60 * 1000,
	}));

	const { createCredentialStore } = await import('../lib/store.mjs');
	const { mergeBetaHeaders, injectClaudeCodeIdentity, CLAUDE_CODE_IDENTITY } = await import('../lib/proxy.mjs');

	console.log('\n[1] beta-header + system-block rewriting');
	{
		const betas = mergeBetaHeaders('output-128k-2025-02-19,context-1m-2025-08-07');
		check('required betas present', betas.includes('claude-code-20250219') && betas.includes('oauth-2025-04-20'), betas.join(','));
		check('context-1m stripped', !betas.includes('context-1m-2025-08-07'), betas.join(','));
		check('ST beta preserved', betas.includes('output-128k-2025-02-19'), betas.join(','));

		const { normaliseProxyPath } = await import('../lib/proxy.mjs');
		check('path: /v1/messages', normaliseProxyPath('/v1/messages?x=1') === '/messages');
		check('path: //messages (ST with a root URL lacking /v1)', normaliseProxyPath('//messages') === '/messages');
		check('path: /v1//models/', normaliseProxyPath('/v1//models/') === '/models');

		const withString = injectClaudeCodeIdentity({ system: 'You are a helpful squirrel.' });
		check('string system becomes blocks', Array.isArray(withString.system) && withString.system.length === 2, JSON.stringify(withString.system));
		check('identity is first block', withString.system[0].text === CLAUDE_CODE_IDENTITY);

		const arraySystem = injectClaudeCodeIdentity({ system: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] });
		check('existing block options preserved', arraySystem.system[1].cache_control?.type === 'ephemeral');

		const idempotent = injectClaudeCodeIdentity({ system: [{ type: 'text', text: CLAUDE_CODE_IDENTITY }, { type: 'text', text: 'hi' }] });
		check('identity not duplicated', idempotent.system.length === 2, JSON.stringify(idempotent.system));
	}

	console.log('\n[2] proxy round trip against a stand-in Anthropic endpoint');
	{
		const plugin = await import('../index.mjs');
		const router = createRouter();
		await plugin.init(router);

		const status0 = await callRoute(router, 'GET', '/status');
		const proxySecret = status0.payload?.proxySecret;
		check('status exposes a generated proxy secret', typeof proxySecret === 'string' && proxySecret.length >= 24, String(proxySecret));
		const secretOnDisk = (await fs.readFile(path.join(dataDir, 'proxy-secret'), 'utf8')).trim();
		check('proxy secret persisted with mode 600', secretOnDisk === proxySecret && ((await fs.stat(path.join(dataDir, 'proxy-secret'))).mode & 0o777) === 0o600);

		const payload = {
			model: 'claude-sonnet-4-6',
			max_tokens: 64,
			stream: true,
			system: 'You are a helpful squirrel.',
			messages: [{ role: 'user', content: 'hi' }],
		};

		const unauthenticated = await postMessages(PROXY_PORT, payload, { 'x-api-key': 'wrong-password' });
		check('wrong proxy password is rejected with 401', unauthenticated.status === 401 && echo.requests.length === 0, `status=${unauthenticated.status}`);
		const missing = await postMessages(PROXY_PORT, payload);
		check('missing proxy password is rejected with 401', missing.status === 401 && echo.requests.length === 0, `status=${missing.status}`);

		const doubleSlash = await postMessages(PROXY_PORT, payload, { 'x-api-key': proxySecret }, '//messages');
		check('//messages (root URL without /v1) still proxied', doubleSlash.status === 200, `status=${doubleSlash.status}`);

		const result = await postMessages(PROXY_PORT, payload, { 'x-api-key': proxySecret });

		check('upstream stream reaches the caller', result.status === 200 && result.text.includes('message_stop'), `status=${result.status} body=${result.text.slice(0, 120)}`);
		check('content-type preserved', result.contentType?.includes('text/event-stream'), String(result.contentType));

		const upstream = echo.requests.at(-1);
		check('bearer auth instead of x-api-key', upstream.headers.authorization === 'Bearer sk-ant-oat01-smoke-access', String(upstream.headers.authorization));
		check('x-api-key dropped', upstream.headers['x-api-key'] === undefined, String(upstream.headers['x-api-key']));
		check('user-agent is claude-cli', /^claude-cli\//.test(upstream.headers['user-agent'] ?? ''), String(upstream.headers['user-agent']));
		check('x-app cli', upstream.headers['x-app'] === 'cli', String(upstream.headers['x-app']));
		check('anthropic-version kept', upstream.headers['anthropic-version'] === '2023-06-01', String(upstream.headers['anthropic-version']));
		const beta = upstream.headers['anthropic-beta'] ?? '';
		check('upstream beta header correct', beta.includes('claude-code-20250219') && beta.includes('oauth-2025-04-20') && !beta.includes('context-1m'), beta);
		check('identity injected before ST system prompt', upstream.body.system?.[0]?.text === CLAUDE_CODE_IDENTITY && upstream.body.system?.[1]?.text === 'You are a helpful squirrel.', JSON.stringify(upstream.body.system));
		check('messages untouched', upstream.body.messages?.[0]?.content === 'hi');

		console.log('\n[3] plugin routes');
		{
			const status = await callRoute(router, 'GET', '/status');
			check('status reports the stored credential', status.payload?.credentials?.loggedIn === true, JSON.stringify(status.payload));
				check('status reports the loaded pi-ai version and path', /^\d+\.\d+\.\d+/.test(String(status.payload?.piAi?.version)) && String(status.payload?.piAi?.path).includes('pi-ai'), JSON.stringify(status.payload?.piAi));

			const loginStart = await callRoute(router, 'POST', '/login');
			check('login returns a Claude authorization URL', String(loginStart.payload?.authUrl).startsWith('https://claude.ai/oauth/authorize'), String(loginStart.payload?.authUrl).slice(0, 80));
			check('login URL uses the Claude Code client + PKCE', String(loginStart.payload?.authUrl).includes('code_challenge=') && String(loginStart.payload?.authUrl).includes('redirect_uri=http%3A%2F%2Flocalhost%3A53692%2Fcallback'));

			const pending = await callRoute(router, 'GET', '/status');
			check('login is reported as pending', pending.payload?.login?.pending === true);

			const cancel = await callRoute(router, 'POST', '/login/cancel');
			check('cancel works', cancel.payload?.cancelled === true, JSON.stringify(cancel.payload));

			const verify = await callRoute(router, 'GET', '/verify');
			check('verify reaches upstream with the token', verify.payload?.ok === true, JSON.stringify(verify.payload).slice(0, 160));

			await plugin.exit();
		}
	}

	console.log('\n[4] pasted-redirect-URL handoff (the Docker / remote path)');
	{
		const plugin = await import('../index.mjs');
		const router = createRouter();
		await plugin.init(router);
		const stub = stubAnthropicTokenEndpoint();

		try {
			const started = await callRoute(router, 'POST', '/login');
			check('login can be started again', String(started.payload?.authUrl).startsWith('https://claude.ai/oauth/authorize'));
			const verifier = new URL(started.payload.authUrl).searchParams.get('state');

			// The pasted redirect URL must be parsed and reach pi-ai's exchange step.
			const redirect = `http://localhost:53692/callback?code=smoke-test-not-a-real-code&state=${verifier}`;
			const submitted = await callRoute(router, 'POST', '/login/code', { body: { code: redirect } });
			check('pasted redirect URL reaches the token exchange', submitted.payload?.ok === false && stub.seen.calls === 1, JSON.stringify(submitted.payload).slice(0, 200));
			check('exchange used the pasted code + PKCE verifier', stub.seen.lastBody?.code === 'smoke-test-not-a-real-code' && stub.seen.lastBody?.code_verifier === verifier, JSON.stringify(stub.seen.lastBody));
			check('exchange failure is surfaced to the caller', String(submitted.payload?.error).includes('invalid_grant'), String(submitted.payload?.error).slice(0, 160));

			const after = await callRoute(router, 'GET', '/status');
			check('pending login is cleared afterwards', after.payload?.login?.pending === false, JSON.stringify(after.payload?.login));

			const mismatched = await callRoute(router, 'POST', '/login');
			check('a third login can be started', Boolean(mismatched.payload?.authUrl));
			const bad = await callRoute(router, 'POST', '/login/code', { body: { code: 'http://localhost:53692/callback?code=x&state=not-the-verifier' } });
			check('state mismatch is rejected before any exchange', bad.payload?.ok === false && String(bad.payload?.error).includes('state mismatch') && stub.seen.calls === 1, JSON.stringify(bad.payload).slice(0, 160));
		} finally {
			stub.restore();
			await plugin.exit();
		}
	}

	console.log('\n[5] credential refresh is single-flight and persisted');
	{
		await fs.writeFile(credentialsFile, JSON.stringify({
			refresh: 'sk-ant-ort01-expired',
			access: 'sk-ant-oat01-expired',
			expires: Date.now() - 1000,
		}));

		let refreshCalls = 0;
		const store = createCredentialStore({
			config: { dataDir },
			refresh: async (refreshToken) => {
				refreshCalls++;
				check('refresh receives the stored refresh token', refreshToken === 'sk-ant-ort01-expired');
				await new Promise((resolve) => setTimeout(resolve, 30));
				return { refresh: 'sk-ant-ort01-rotated', access: 'sk-ant-oat01-fresh', expires: Date.now() + 3600_000 };
			},
		});

		const [first, second] = await Promise.all([store.getAccessToken(), store.getAccessToken()]);
		check('both callers get the fresh token', first === 'sk-ant-oat01-fresh' && second === 'sk-ant-oat01-fresh', `${first} / ${second}`);
		check('refresh ran exactly once (no double rotation)', refreshCalls === 1, `calls=${refreshCalls}`);

		const persisted = JSON.parse(await fs.readFile(credentialsFile, 'utf8'));
		check('rotated refresh token persisted', persisted.refresh === 'sk-ant-ort01-rotated', persisted.refresh);
	}

	console.log('\n[6] pi-ai public OAuth entry point + login cancellation');
	{
		const { createAnthropicOAuth } = await import('../lib/pi-oauth.mjs');
		const oauth = await createAnthropicOAuth();
		check('adapter reports pi-ai version', /^\d+\.\d+\.\d+/.test(oauth.piAiVersion), oauth.piAiVersion);

		// The adapter must go through Provider.auth.oauth, not a private dist path.
		const { anthropicProvider } = await import('@earendil-works/pi-ai/providers/anthropic');
		const pub = anthropicProvider().auth.oauth;
		check('pi-ai exposes anthropicProvider().auth.oauth', typeof pub.login === 'function' && typeof pub.refresh === 'function' && pub.isSubscription === true);

		const { createLoginManager } = await import('../lib/login.mjs');
		const saved = [];
		const login = createLoginManager({
			store: { save: async (c) => saved.push(c) },
			oauth,
			config: { loginTimeoutMs: 5000 },
		});
		const started = await login.start();
		check('login manager gets an auth URL', String(started.authUrl).startsWith('https://claude.ai/'));
		const cancelled = login.cancel();
		check('cancel reports cancelled', cancelled.cancelled === true);
		await new Promise((resolve) => setTimeout(resolve, 50));
		check('cancel clears the pending login', login.status().pending === false, JSON.stringify(login.status()));
		check('cancel does not save credentials', saved.length === 0);
		const again = await login.start();
		check('a new login can start after cancel', Boolean(again.authUrl));
		login.cancel();
		await new Promise((resolve) => setTimeout(resolve, 50));
	}

	echo.server.close();
	await fs.rm(dataDir, { recursive: true, force: true });

	console.log(`\n${checks - failures}/${checks} checks passed.`);
	if (failures > 0) {
		process.exitCode = 1;
	}
	process.exit(failures > 0 ? 1 : 0);
}

main().catch((error) => {
	console.error(`\nSmoke test crashed: ${error.stack || error.message}`);
	process.exit(1);
});
