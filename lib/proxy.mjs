import http from 'node:http';
import { readRawBody } from './util.mjs';

export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

/** Anthropic only accepts OAuth bearer tokens when these betas are declared. */
export const REQUIRED_BETA_HEADERS = ['claude-code-20250219', 'oauth-2025-04-20'];

/**
 * SillyTavern's Claude adapter unconditionally sends
 * `anthropic-beta: output-128k-2025-02-19,context-1m-2025-08-07`. The 1M beta
 * combined with an OAuth token is rejected with "This authentication style is
 * incompatible with the long context beta header", so it is stripped here.
 * Other betas are passed through.
 */
export const REJECTED_BETA_HEADERS = new Set(['context-1m-2025-08-07']);

const DROPPED_REQUEST_HEADERS = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
	'content-length',
	'host',
	// ST always sends x-api-key (proxy password); the bearer token replaces it.
	'x-api-key',
	'authorization',
]);

const DROPPED_RESPONSE_HEADERS = new Set([
	'connection',
	'keep-alive',
	'transfer-encoding',
	'content-encoding',
	'content-length',
]);

function firstHeader(value) {
	if (Array.isArray(value)) {
		return value[0];
	}
	return value;
}

/** ST sends the proxy password as `x-api-key`; accept a bearer token too for manual curl checks. */
function presentedSecret(headers) {
	const apiKey = firstHeader(headers['x-api-key']);
	if (apiKey) return apiKey;
	const auth = firstHeader(headers.authorization);
	if (typeof auth === 'string' && /^bearer\s+/i.test(auth)) {
		return auth.replace(/^bearer\s+/i, '').trim();
	}
	return undefined;
}

/** `/v1//messages` (ST with a root URL lacking `/v1`) and `/v1/messages/` both map to `/messages`. */
export function normaliseProxyPath(url) {
	const pathname = (url || '/').split('?')[0].replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
	return pathname.startsWith('/v1/') ? pathname.slice(3) : pathname;
}

export function mergeBetaHeaders(incoming) {
	const incomingValues = [];
	for (const raw of [].concat(incoming ?? [])) {
		for (const part of String(raw).split(',')) {
			const feature = part.trim();
			if (!feature || REJECTED_BETA_HEADERS.has(feature)) {
				continue;
			}
			if (!incomingValues.includes(feature)) {
				incomingValues.push(feature);
			}
		}
	}
	const extras = incomingValues.filter((feature) => !REQUIRED_BETA_HEADERS.includes(feature));
	return [...REQUIRED_BETA_HEADERS, ...extras];
}

/** Anthropic requires the Claude Code identity block to be the first system block for OAuth tokens. */
export function injectClaudeCodeIdentity(body) {
	if (!body || typeof body !== 'object') {
		return body;
	}

	const blocks = [];
	if (typeof body.system === 'string') {
		if (body.system.trim()) {
			blocks.push({ type: 'text', text: body.system });
		}
	} else if (Array.isArray(body.system)) {
		for (const block of body.system) {
			if (block) blocks.push(block);
		}
	}

	if (blocks[0]?.type === 'text' && blocks[0].text === CLAUDE_CODE_IDENTITY) {
		return body;
	}

	body.system = [{ type: 'text', text: CLAUDE_CODE_IDENTITY }, ...blocks];
	return body;
}

export function buildUpstreamHeaders(incomingHeaders, accessToken, config) {
	const headers = {
		accept: firstHeader(incomingHeaders.accept) || 'application/json',
		'content-type': firstHeader(incomingHeaders['content-type']) || 'application/json',
		'anthropic-version': firstHeader(incomingHeaders['anthropic-version']) || '2023-06-01',
		'anthropic-beta': mergeBetaHeaders(incomingHeaders['anthropic-beta']).join(','),
		authorization: `Bearer ${accessToken}`,
		'user-agent': `claude-cli/${config.claudeCodeVersion}`,
		'x-app': 'cli',
	};

	for (const [name, value] of Object.entries(incomingHeaders)) {
		const lower = name.toLowerCase();
		if (DROPPED_REQUEST_HEADERS.has(lower) || lower in headers) {
			continue;
		}
		if (lower.startsWith('anthropic-') || lower.startsWith('x-stainless')) {
			continue;
		}
		const single = firstHeader(value);
		if (typeof single === 'string' && single.length > 0) {
			headers[lower] = single;
		}
	}

	return headers;
}

function copyResponseHeaders(upstream) {
	const headers = {};
	for (const [name, value] of upstream.headers) {
		if (DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) {
			continue;
		}
		headers[name] = value;
	}
	return headers;
}

async function pipeBody(upstream, response) {
	if (!upstream.body) {
		response.end();
		return;
	}
	for await (const chunk of upstream.body) {
		response.write(chunk);
	}
	response.end();
}

/**
 * Local Anthropic-shaped reverse proxy used by SillyTavern's built-in "Claude"
 * chat completion source.
 *
 * It runs on its own loopback port rather than as a `/api/plugins/...` route on
 * purpose: SillyTavern's server-side fetch cannot satisfy the global CSRF
 * middleware, so posting ST's own backend through the plugin router would 403.
 *
 * Every request must carry an account secret as `x-api-key` (ST's "proxy
 * password"). `resolveAccount(secret)` picks the account; without a match the
 * request is rejected, so other local processes cannot spend a subscription.
 */
export async function startProxyServer({ config, resolveAccount, log = () => {} }) {
	const server = http.createServer(async (request, response) => {
		const path = normaliseProxyPath(request.url);
		const isMessages = request.method === 'POST' && path === '/messages';
		const isModels = request.method === 'GET' && path === '/models';

		if (path === '/health') {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ ok: true }));
			return;
		}

		if (!isMessages && !isModels) {
			response.writeHead(404, { 'content-type': 'application/json' });
			response.end(JSON.stringify({
				error: `Unsupported path ${request.method} ${path}`,
				hint: 'Point the SillyTavern Claude reverse proxy at this server root, e.g. http://127.0.0.1:45277/v1',
			}));
			return;
		}

		const account = resolveAccount(presentedSecret(request.headers));
		if (!account) {
			request.resume();
			response.writeHead(401, { 'content-type': 'application/json' });
			response.end(JSON.stringify({
				error: { type: 'authentication_error', message: 'Unknown Claude OAuth proxy password. Pick an account in the Claude OAuth extension panel and click "Use as Claude source", or copy that account\'s secret into the proxy password field.' },
			}));
			return;
		}

		const controller = new AbortController();
		response.on('close', () => {
			if (!response.writableEnded) {
				controller.abort();
			}
		});

		try {
			const accessToken = await account.getAccessToken();
			const headers = buildUpstreamHeaders(request.headers, accessToken, config);
			let body;

			if (isMessages) {
				const raw = await readRawBody(request, config.maxBodyBytes);
				let parsed;
				try {
					parsed = JSON.parse(raw.toString('utf8'));
				} catch {
					response.writeHead(400, { 'content-type': 'application/json' });
					response.end(JSON.stringify({ error: 'Request body is not valid JSON' }));
					return;
				}
				injectClaudeCodeIdentity(parsed);
				body = JSON.stringify(parsed);
			}

			const upstream = await fetch(`${config.anthropicBaseUrl}${isMessages ? '/messages' : '/models'}`, {
				method: isMessages ? 'POST' : 'GET',
				headers,
				body,
				signal: controller.signal,
			});

			response.writeHead(upstream.status, copyResponseHeaders(upstream));
			await pipeBody(upstream, response);
		} catch (error) {
			if (controller.signal.aborted) {
				log('Claude OAuth proxy: client aborted the request.');
				response.destroy();
				return;
			}
			log(`Claude OAuth proxy error (${account.label}): ${error.message}`);
			if (!response.headersSent) {
				response.writeHead(502, { 'content-type': 'application/json' });
			}
			response.end(JSON.stringify({ error: { type: 'claude_oauth_proxy_error', message: error.message } }));
		}
	});

	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(config.proxyPort, config.proxyHost, resolve);
	});

	const url = `http://${config.proxyHost}:${config.proxyPort}`;
	log(`Claude OAuth loopback proxy listening on ${url}`);

	return {
		url,
		server,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}
