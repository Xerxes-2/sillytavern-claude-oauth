/**
 * Smoke test: no SillyTavern, no real Anthropic account.
 *
 * It runs the real plugin code against a stand-in Anthropic endpoint and checks
 * the parts that are easy to get wrong: OAuth header rewriting, Claude Code
 * identity injection, beta-header merging, per-user account isolation,
 * credential refresh serialisation and the interactive login handoff. No network access: pi-ai's token exchange
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
	const add = (method) => (route, handler) => routes.set(`${method} ${route}`, handler);
	return { routes, get: add('GET'), post: add('POST'), delete: add('DELETE') };
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

/** Match an express-style route pattern (`/accounts/:name/verify`) against a concrete path. */
function matchRoute(pattern, actual) {
	const p = pattern.split('/');
	const a = actual.split('/');
	if (p.length !== a.length) return null;
	const params = {};
	for (let i = 0; i < p.length; i++) {
		if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(a[i]);
		else if (p[i] !== a[i]) return null;
	}
	return params;
}

/** What SillyTavern's setUserDataMiddleware puts on the request. */
function stUser(handle) {
	return { profile: { handle }, directories: { root: path.join(globalThis.DATA_ROOT, handle) } };
}

async function callRoute(router, method, route, { body, headers, user = 'default-user' } = {}) {
	let handler;
	let params = {};
	for (const [key, candidate] of router.routes) {
		const [m, pattern] = key.split(' ');
		if (m !== method) continue;
		const matched = matchRoute(pattern, route);
		if (matched) {
			handler = candidate;
			params = matched;
			break;
		}
	}
	if (!handler) {
		throw new Error(`Route ${method} ${route} is not registered`);
	}
	// Stand in for express.json(): the plugin reads req.body when it is already an object.
	const request = { method, url: route, headers: headers ?? {}, body, params, user: user ? stUser(user) : undefined };
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

		response.writeHead(200, {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			// What Anthropic reports on subscription traffic (plus a made-up per-model bucket).
			'anthropic-ratelimit-unified-5h-utilization': '0.34',
			'anthropic-ratelimit-unified-5h-reset': '1800000000',
			'anthropic-ratelimit-unified-7d-utilization': '0.61',
			'anthropic-ratelimit-unified-7d-reset': '1800100000',
			'anthropic-ratelimit-unified-7d-fable-utilization': '0.05',
			'anthropic-ratelimit-unified-status': 'allowed',
		});
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
	const stub = { seen, succeedNext: null, restore: () => { globalThis.fetch = original; } };
	globalThis.fetch = async (input, init) => {
		const url = typeof input === 'string' ? input : input?.url ?? String(input);
		if (url.startsWith('https://platform.claude.com/v1/oauth/token')) {
			seen.calls++;
			seen.lastBody = init?.body ? JSON.parse(init.body) : null;
			if (stub.succeedNext) {
				const body = stub.succeedNext;
				stub.succeedNext = null;
				return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'smoke' }), {
				status: 400,
				headers: { 'content-type': 'application/json' },
			});
		}
		return original(input, init);
	};
	return stub;
}

async function main() {
	const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-oauth-smoke-'));
	globalThis.DATA_ROOT = dataRoot;
	const accountFile = (handle, name) => path.join(dataRoot, handle, 'claude-oauth', 'accounts', `${name}.json`);
	const writeAccount = async (handle, name, secret, credentials) => {
		await fs.mkdir(path.dirname(accountFile(handle, name)), { recursive: true });
		await fs.writeFile(accountFile(handle, name), JSON.stringify({ name, secret, createdAt: Date.now(), credentials }));
	};

	const echo = await startEchoAnthropic();
	process.env.CLAUDE_OAUTH_PROXY_PORT = String(PROXY_PORT);
	process.env.CLAUDE_OAUTH_ANTHROPIC_BASE_URL = `http://127.0.0.1:${echo.port}/v1`;

	// Pre-existing accounts on disk (as if created before a restart), for two ST users.
	await writeAccount('default-user', 'main', 'secret-default-main', {
		refresh: 'sk-ant-ort01-smoke',
		access: 'sk-ant-oat01-smoke-access',
		expires: Date.now() + 60 * 60 * 1000,
	});
	await writeAccount('alice', 'work', 'secret-alice-work', {
		refresh: 'sk-ant-ort01-alice',
		access: 'sk-ant-oat01-alice-access',
		expires: Date.now() + 60 * 60 * 1000,
	});

	const { createAccountRegistry, validateAccountName } = await import('../lib/accounts.mjs');
	const { mergeBetaHeaders, injectClaudeCodeIdentity, CLAUDE_CODE_IDENTITY, normaliseProxyPath } = await import('../lib/proxy.mjs');

	console.log('\n[1] beta-header + system-block rewriting');
	{
		const betas = mergeBetaHeaders('output-128k-2025-02-19,context-1m-2025-08-07');
		check('required betas present', betas.includes('claude-code-20250219') && betas.includes('oauth-2025-04-20'), betas.join(','));
		check('context-1m stripped', !betas.includes('context-1m-2025-08-07'), betas.join(','));
		check('ST beta preserved', betas.includes('output-128k-2025-02-19'), betas.join(','));

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

		let threw = false;
		try { validateAccountName('../etc'); } catch { threw = true; }
		check('account names are restricted to a safe charset', threw && validateAccountName(' Work_1 ') === 'Work_1');
	}

	console.log('\n[2] proxy round trip against a stand-in Anthropic endpoint');
	{
		const plugin = await import('../index.mjs');
		const router = createRouter();
		await plugin.init(router);

		const status0 = await callRoute(router, 'GET', '/status');
		check('status lists the on-disk account with its secret', status0.payload?.accounts?.length === 1 && status0.payload.accounts[0].name === 'main' && status0.payload.accounts[0].secret === 'secret-default-main' && status0.payload.accounts[0].loggedIn === true, JSON.stringify(status0.payload?.accounts));
		const statusAlice = await callRoute(router, 'GET', '/status', { user: 'alice' });
		check('another ST user sees only their own accounts', statusAlice.payload?.accounts?.length === 1 && statusAlice.payload.accounts[0].name === 'work', JSON.stringify(statusAlice.payload?.accounts));
		const noUser = await callRoute(router, 'GET', '/status', { user: null });
		check('routes require an ST user', noUser.statusCode === 401, `status=${noUser.statusCode}`);

		const payload = {
			model: 'claude-sonnet-4-6',
			max_tokens: 64,
			stream: true,
			system: 'You are a helpful squirrel.',
			messages: [{ role: 'user', content: 'hi' }],
		};

		const unauthenticated = await postMessages(PROXY_PORT, payload, { 'x-api-key': 'wrong-password' });
		check('unknown proxy password is rejected with 401', unauthenticated.status === 401 && echo.requests.length === 0, `status=${unauthenticated.status}`);
		const missing = await postMessages(PROXY_PORT, payload);
		check('missing proxy password is rejected with 401', missing.status === 401 && echo.requests.length === 0, `status=${missing.status}`);

		const doubleSlash = await postMessages(PROXY_PORT, payload, { 'x-api-key': 'secret-default-main' }, '//messages');
		check('//messages (root URL without /v1) still proxied', doubleSlash.status === 200, `status=${doubleSlash.status}`);

		const result = await postMessages(PROXY_PORT, payload, { 'x-api-key': 'secret-default-main' });

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

		{
			const { parseUsageHeaders } = await import('../lib/proxy.mjs');
			check('no ratelimit headers -> null usage', parseUsageHeaders(new Headers({ 'content-type': 'x' })) === null);
			const rejected = parseUsageHeaders(new Headers({
				'anthropic-ratelimit-unified-status': 'rejected',
				'anthropic-ratelimit-unified-representative-claim': 'seven_day_opus',
				'anthropic-ratelimit-unified-reset': '1800000000',
			}));
			check('rejection headers parsed', rejected?.status === 'rejected' && rejected.limitedBy === 'seven_day_opus' && rejected.resetsAt === 1800000000000, JSON.stringify(rejected));

			const usage = (await callRoute(router, 'GET', '/status')).payload.accounts.find((a) => a.name === 'main')?.usage;
			check('usage from upstream headers lands in /status', usage?.buckets?.['5h']?.utilization === 0.34 && usage.buckets['5h'].resetsAt === 1800000000000 && usage.buckets['7d']?.utilization === 0.61 && usage.status === 'allowed', JSON.stringify(usage));
			check('unknown per-model bucket is kept under its raw name', usage?.buckets?.['7d-fable']?.utilization === 0.05 && usage.buckets['7d-fable'].resetsAt === null, JSON.stringify(usage?.buckets));
			const idle = (await callRoute(router, 'GET', '/status', { user: 'alice' })).payload.accounts.find((a) => a.name === 'work');
			check('accounts that never served a request report usage: null', idle !== undefined && idle.usage === null, JSON.stringify(idle));
		}

		// Secret selects the account: alice's secret must use alice's token.
		await postMessages(PROXY_PORT, payload, { 'x-api-key': 'secret-alice-work' });
		check('a different secret routes to that account\'s token', echo.requests.at(-1).headers.authorization === 'Bearer sk-ant-oat01-alice-access', String(echo.requests.at(-1).headers.authorization));

		console.log('\n[3] plugin routes');
		{
			const status = await callRoute(router, 'GET', '/status');
			check('status reports the loaded pi-ai version and path', /^\d+\.\d+\.\d+/.test(String(status.payload?.piAi?.version)) && String(status.payload?.piAi?.path).includes('pi-ai'), JSON.stringify(status.payload?.piAi));

			const badName = await callRoute(router, 'POST', '/login', { body: { name: 'no spaces' } });
			check('login rejects invalid account names', badName.statusCode === 400, JSON.stringify(badName.payload));

			const loginStart = await callRoute(router, 'POST', '/login', { body: { name: 'second' } });
			check('login returns a Claude authorization URL', String(loginStart.payload?.authUrl).startsWith('https://claude.ai/oauth/authorize'), String(loginStart.payload?.authUrl).slice(0, 80));
			check('login URL uses the Claude Code client + PKCE', String(loginStart.payload?.authUrl).includes('code_challenge=') && String(loginStart.payload?.authUrl).includes('redirect_uri=http%3A%2F%2Flocalhost%3A53692%2Fcallback'));

			const pending = await callRoute(router, 'GET', '/status');
			check('login is reported as pending for its owner', pending.payload?.login?.pending === true && pending.payload.login.name === 'second', JSON.stringify(pending.payload?.login));
			const pendingAlice = await callRoute(router, 'GET', '/status', { user: 'alice' });
			check('other users see it as busy, not pending', pendingAlice.payload?.login?.pending === false && pendingAlice.payload.login.busy === true, JSON.stringify(pendingAlice.payload?.login));
			const aliceStart = await callRoute(router, 'POST', '/login', { body: { name: 'x' }, user: 'alice' });
			check('other users cannot start a login meanwhile', aliceStart.statusCode === 500 && String(aliceStart.payload?.error).includes('Another Claude login'), JSON.stringify(aliceStart.payload));
			const aliceCancel = await callRoute(router, 'POST', '/login/cancel', { user: 'alice' });
			check('other users cannot cancel it', aliceCancel.statusCode !== 200 || aliceCancel.payload?.cancelled !== true, JSON.stringify(aliceCancel.payload));

			const cancel = await callRoute(router, 'POST', '/login/cancel');
			check('owner can cancel', cancel.payload?.cancelled === true, JSON.stringify(cancel.payload));

			const verify = await callRoute(router, 'GET', '/accounts/main/verify');
			check('verify reaches upstream with the account token', verify.payload?.ok === true && echo.requests.at(-1).headers.authorization === 'Bearer sk-ant-oat01-smoke-access', JSON.stringify(verify.payload).slice(0, 160));
			const verifyOther = await callRoute(router, 'GET', '/accounts/work/verify');
			check('verify cannot reach another user\'s account', verifyOther.statusCode === 404, `status=${verifyOther.statusCode}`);

			const removeOther = await callRoute(router, 'DELETE', '/accounts/main', { user: 'alice' });
			check('delete cannot reach another user\'s account', removeOther.statusCode === 404, `status=${removeOther.statusCode}`);
			const removed = await callRoute(router, 'DELETE', '/accounts/main');
			check('owner can delete an account', removed.payload?.ok === true, JSON.stringify(removed.payload));
			let gone = false;
			try { await fs.access(accountFile('default-user', 'main')); } catch { gone = true; }
			check('deleted account file is removed', gone);
			const afterDelete = await postMessages(PROXY_PORT, payload, { 'x-api-key': 'secret-default-main' });
			check('deleted account\'s secret stops working immediately', afterDelete.status === 401, `status=${afterDelete.status}`);

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
			const started = await callRoute(router, 'POST', '/login', { body: { name: 'pasted' } });
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
			check('failed login creates no account', !after.payload.accounts.some((a) => a.name === 'pasted'), JSON.stringify(after.payload.accounts));

			const again = await callRoute(router, 'POST', '/login', { body: { name: 'pasted' } });
			check('a third login can be started', Boolean(again.payload?.authUrl));
			const bad = await callRoute(router, 'POST', '/login/code', { body: { code: 'http://localhost:53692/callback?code=x&state=not-the-verifier' } });
			check('state mismatch is rejected before any exchange', bad.payload?.ok === false && String(bad.payload?.error).includes('state mismatch') && stub.seen.calls === 1, JSON.stringify(bad.payload).slice(0, 160));

			// A successful exchange must create the account with a fresh secret.
			stub.succeedNext = { access_token: 'sk-ant-oat01-new', refresh_token: 'sk-ant-ort01-new', expires_in: 3600 };
			const third = await callRoute(router, 'POST', '/login', { body: { name: 'pasted' } });
			const verifier3 = new URL(third.payload.authUrl).searchParams.get('state');
			const ok = await callRoute(router, 'POST', '/login/code', { body: { code: `http://localhost:53692/callback?code=good&state=${verifier3}` } });
			check('successful exchange reports the account name', ok.payload?.ok === true && ok.payload.name === 'pasted', JSON.stringify(ok.payload));
			const created = (await callRoute(router, 'GET', '/status')).payload.accounts.find((a) => a.name === 'pasted');
			check('new account is listed with a generated secret', created?.loggedIn === true && typeof created.secret === 'string' && created.secret.length >= 24, JSON.stringify(created));
			const onDisk = JSON.parse(await fs.readFile(accountFile('default-user', 'pasted'), 'utf8'));
			check('new account persisted with mode 600', onDisk.credentials.refresh === 'sk-ant-ort01-new' && ((await fs.stat(accountFile('default-user', 'pasted'))).mode & 0o777) === 0o600, JSON.stringify(onDisk));
			await postMessages(PROXY_PORT, { model: 'm', max_tokens: 1, messages: [] }, { 'x-api-key': created.secret });
			check('new account\'s secret works on the proxy right away', echo.requests.at(-1).headers.authorization === 'Bearer sk-ant-oat01-new', String(echo.requests.at(-1).headers.authorization));

			// Re-login keeps the secret (so the saved ST proxy preset keeps working).
			stub.succeedNext = { access_token: 'sk-ant-oat01-newer', refresh_token: 'sk-ant-ort01-newer', expires_in: 3600 };
			const fourth = await callRoute(router, 'POST', '/login', { body: { name: 'pasted' } });
			const verifier4 = new URL(fourth.payload.authUrl).searchParams.get('state');
			await callRoute(router, 'POST', '/login/code', { body: { code: `http://localhost:53692/callback?code=good&state=${verifier4}` } });
			const relogged = (await callRoute(router, 'GET', '/status')).payload.accounts.find((a) => a.name === 'pasted');
			check('re-login keeps the account secret', relogged?.secret === created.secret, `${relogged?.secret} vs ${created.secret}`);
			await postMessages(PROXY_PORT, { model: 'm', max_tokens: 1, messages: [] }, { 'x-api-key': created.secret });
			check('re-login replaces the token', echo.requests.at(-1).headers.authorization === 'Bearer sk-ant-oat01-newer', String(echo.requests.at(-1).headers.authorization));
		} finally {
			stub.restore();
			await plugin.exit();
		}
	}

	console.log('\n[5] credential refresh is single-flight and persisted per account');
	{
		await writeAccount('bob', 'old', 'secret-bob-old', {
			refresh: 'sk-ant-ort01-expired',
			access: 'sk-ant-oat01-expired',
			expires: Date.now() - 1000,
		});

		let refreshCalls = 0;
		const registry = createAccountRegistry({
			dataRoot,
			refresh: async (refreshToken) => {
				refreshCalls++;
				check('refresh receives the stored refresh token', refreshToken === 'sk-ant-ort01-expired');
				await new Promise((resolve) => setTimeout(resolve, 30));
				return { refresh: 'sk-ant-ort01-rotated', access: 'sk-ant-oat01-fresh', expires: Date.now() + 3600_000 };
			},
		});
		await registry.scan();
		const account = registry.resolveBySecret('secret-bob-old');
		check('scan picks up every user\'s accounts', account?.label === 'bob/old' && registry.resolveBySecret('secret-alice-work')?.label === 'alice/work');

		const [first, second] = await Promise.all([account.getAccessToken(), account.getAccessToken()]);
		check('both callers get the fresh token', first === 'sk-ant-oat01-fresh' && second === 'sk-ant-oat01-fresh', `${first} / ${second}`);
		check('refresh ran exactly once (no double rotation)', refreshCalls === 1, `calls=${refreshCalls}`);

		const persisted = JSON.parse(await fs.readFile(accountFile('bob', 'old'), 'utf8'));
		check('rotated refresh token persisted', persisted.credentials.refresh === 'sk-ant-ort01-rotated' && persisted.secret === 'secret-bob-old', JSON.stringify(persisted));
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
			oauth,
			config: { loginTimeoutMs: 5000 },
			onSuccess: async (result) => saved.push(result),
		});
		const started = await login.start({ owner: 'u', name: 'a' });
		check('login manager gets an auth URL', String(started.authUrl).startsWith('https://claude.ai/'));
		let rejected = false;
		try { await login.start({ owner: 'u', name: 'b' }); } catch { rejected = true; }
		check('same owner cannot start a login for a different account meanwhile', rejected);
		const cancelled = login.cancel('u');
		check('cancel reports cancelled', cancelled.cancelled === true && cancelled.name === 'a');
		await new Promise((resolve) => setTimeout(resolve, 50));
		check('cancel clears the pending login', login.status('u').pending === false, JSON.stringify(login.status('u')));
		check('cancel does not save credentials', saved.length === 0);
		const again = await login.start({ owner: 'u', name: 'a' });
		check('a new login can start after cancel', Boolean(again.authUrl));
		login.cancel('u');
		await new Promise((resolve) => setTimeout(resolve, 50));
	}

	echo.server.close();
	await fs.rm(dataRoot, { recursive: true, force: true });

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
