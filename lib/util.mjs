export function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * `unref: true` keeps a pending delay from holding the event loop open, which
 * matters for the long login timeouts: SillyTavern must be able to exit while
 * a login is still waiting for a pasted code.
 */
export function delay(ms, { unref = false } = {}) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (unref) timer.unref?.()
  })
}

/**
 * Builds an error that survives the trip to the UI.
 *
 * `message` stays English: it is what lands in the server log and what the
 * extension falls back to. `code` is the stable identifier the extension
 * translates, so rewording a message never silently drops its translation.
 *
 * @param {string} code Stable lower_snake_case identifier.
 * @param {string} message English text, also the UI fallback.
 * @param {number} [statusCode] HTTP status; client mistakes dominate, so 400.
 */
export function fail(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode })
}

export function sendJson(response, statusCode, payload) {
  if (typeof response.status === 'function') {
    response.status(statusCode).json(payload)
    return
  }
  // Minimal fallback so the plugin also runs under a bare node:http server.
  response.writeHead(statusCode, { 'content-type': 'application/json' })
  response.end(JSON.stringify(payload))
}

export async function readJsonBody(request) {
  if (request.body && typeof request.body === 'object') {
    return request.body
  }
  if (!request.readable) {
    return {}
  }
  const chunks = []
  for await (const chunk of request) {
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw.trim()) {
    return {}
  }
  try {
    return JSON.parse(raw)
  }
  catch {
    throw fail('invalid_json', 'Request body is not valid JSON')
  }
}

/** Read a raw request body with a hard size limit (the proxy buffers JSON to rewrite `system`). */
export async function readRawBody(request, limitBytes = 128 * 1024 * 1024) {
  const chunks = []
  let total = 0
  /**
   * Bailing out of a plain `for await` over a request destroys the socket, so
   * the caller's error response would never reach the client. `destroyOnReturn:
   * false` leaves the stream alive long enough to answer 413; Node then dumps
   * the unread remainder itself once the response finishes.
   */
  const source = typeof request.iterator === 'function'
    ? request.iterator({ destroyOnReturn: false })
    : request
  for await (const chunk of source) {
    total += chunk.length
    if (total > limitBytes) {
      request.pause?.()
      throw fail('body_too_large', `Request body exceeds ${limitBytes} bytes`, 413)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
