export function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

export function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sendJson(response, statusCode, payload) {
	if (typeof response.status === 'function') {
		response.status(statusCode).json(payload);
		return;
	}
	// Minimal fallback so the plugin also runs under a bare node:http server.
	response.writeHead(statusCode, { 'content-type': 'application/json' });
	response.end(JSON.stringify(payload));
}

export async function readJsonBody(request) {
	if (request.body && typeof request.body === 'object') {
		return request.body;
	}
	if (!request.readable) {
		return {};
	}
	const chunks = [];
	for await (const chunk of request) {
		chunks.push(chunk);
	}
	const raw = Buffer.concat(chunks).toString('utf8');
	if (!raw.trim()) {
		return {};
	}
	try {
		return JSON.parse(raw);
	} catch {
		throw new Error('Request body is not valid JSON');
	}
}

/** Read a raw request body with a hard size limit (the proxy buffers JSON to rewrite `system`). */
export async function readRawBody(request, limitBytes = 128 * 1024 * 1024) {
	const chunks = [];
	let total = 0;
	for await (const chunk of request) {
		total += chunk.length;
		if (total > limitBytes) {
			throw new Error(`Request body exceeds ${limitBytes} bytes`);
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}
