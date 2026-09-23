import { CONFIG, dataRoot, proxyBaseUrl } from './lib/config.mjs'
import { createAnthropicOAuth } from './lib/pi-oauth.mjs'
import { createAccountRegistry, validateAccountName } from './lib/accounts.mjs'
import { createLoginManager } from './lib/login.mjs'
import { buildUpstreamHeaders, startProxyServer } from './lib/proxy.mjs'
import { fail, readJsonBody, sendJson } from './lib/util.mjs'

export const info = {
  id: 'claude-oauth',
  name: 'Claude OAuth (Subscription)',
  description: 'Claude Pro/Max OAuth login for the built-in Claude chat completion source, powered by pi-ai. Multiple accounts per SillyTavern user.',
}

/**
 * The running services, or null before init()/after exit(). Kept as one object
 * so routes can never see a half-started plugin (proxy up, registry not yet).
 *
 * @type {{
 *   accounts: ReturnType<typeof createAccountRegistry>,
 *   login: ReturnType<typeof createLoginManager>,
 *   proxy: Awaited<ReturnType<typeof startProxyServer>>,
 * } | null}
 */
let running = null
let piAi = { version: 'unknown', path: 'unknown' }
/**
 * In-flight or completed startup; also the "are we running?" flag.
 * @type {Promise<void>|null}
 */
let startup = null

/** Routes are only reachable after init(), but a stale router would 503 instead of TypeError. */
function services() {
  if (!running) {
    throw fail('not_initialised', 'Claude OAuth plugin is not initialised.', 503)
  }
  return running
}

function log(message) {
  console.log(`[claude-oauth] ${message}`)
}

/**
 * SillyTavern's `setUserDataMiddleware` runs before plugin routers and sets
 * `request.user` (the default user when accounts are disabled). Everything
 * this plugin stores is scoped to that handle.
 */
function userHandle(request) {
  const handle = request.user?.profile?.handle
  if (typeof handle !== 'string' || !handle) {
    throw fail('not_logged_in', 'Not logged in to SillyTavern.', 401)
  }
  return handle
}

async function guard(response, handler) {
  try {
    await handler()
  }
  catch (error) {
    const statusCode = error.statusCode ?? 500
    if (statusCode >= 500) {
      log(`Request failed: ${error.message}`)
    }
    // `code` lets the extension show a translated message; `error` stays
    // English so it is still readable when a code has no translation.
    sendJson(response, statusCode, { ok: false, code: error.code, error: error.message })
  }
}

async function startServices() {
  const oauth = await createAnthropicOAuth()
  piAi = { version: oauth.piAiVersion, path: oauth.piAiPath }

  const accounts = createAccountRegistry({
    dataRoot: dataRoot(),
    // pi-ai applies its own 30 s request timeout to the refresh call.
    refresh: refreshToken => oauth.refresh(refreshToken),
    log,
  })
  await accounts.scan()

  const login = createLoginManager({
    oauth,
    config: CONFIG,
    onSuccess: ({ owner, name, credentials }) => accounts.upsert(owner, name, credentials),
    log,
  })

  const proxy = await startProxyServer({
    config: CONFIG,
    resolveAccount: secret => accounts.resolveBySecret(secret),
    log,
  })

  running = { accounts, login, proxy }

  log(`Reverse proxy URL for SillyTavern: ${proxyBaseUrl()}`)
  log(`pi-ai ${piAi.version} (${piAi.path})`)
}

function registerRoutes(router) {
  router.get('/status', async (request, response) => guard(response, async () => {
    const { accounts, login } = services()
    const handle = userHandle(request)
    const list = await accounts.list(handle)
    sendJson(response, 200, {
      ok: true,
      piAi: { ...piAi },
      proxyUrl: proxyBaseUrl(),
      callbackPort: 53692,
      accounts: list.map(account => account.status()),
      login: login.status(handle),
    })
  }))

  /** Start (or re-run) the login for an account. Existing accounts keep their secret. */
  router.post('/login', async (request, response) => guard(response, async () => {
    const { login } = services()
    const handle = userHandle(request)
    const body = await readJsonBody(request)
    const name = validateAccountName(body.name)
    const result = await login.start({ owner: handle, name })
    sendJson(response, 200, { ok: true, ...result })
  }))

  router.post('/login/code', async (request, response) => guard(response, async () => {
    const { login } = services()
    const handle = userHandle(request)
    const body = await readJsonBody(request)
    const result = await login.submitCode(handle, body.code ?? body.input ?? body.url)
    sendJson(response, result.ok ? 200 : 400, result)
  }))

  router.post('/login/cancel', async (request, response) => guard(response, async () => {
    sendJson(response, 200, { ok: true, ...services().login.cancel(userHandle(request)) })
  }))

  router.delete('/accounts/:name', async (request, response) => guard(response, async () => {
    const { accounts, login } = services()
    const handle = userHandle(request)
    const name = validateAccountName(request.params?.name)
    const pending = login.status(handle)
    if (pending.pending && pending.name === name) {
      login.cancel(handle)
    }
    const removed = await accounts.remove(handle, name)
    sendJson(response, removed ? 200 : 404, { ok: removed, name })
  }))

  /** Cheap end-to-end check: does the stored token actually work upstream? */
  router.get('/accounts/:name/verify', async (request, response) => guard(response, async () => {
    const { accounts } = services()
    const handle = userHandle(request)
    const name = validateAccountName(request.params?.name)
    const account = await accounts.get(handle, name)
    if (!account) {
      sendJson(response, 404, { ok: false, error: `No account named "${name}".` })
      return
    }
    const accessToken = await account.getAccessToken()
    const upstream = await fetch(`${CONFIG.anthropicBaseUrl}/models`, {
      headers: buildUpstreamHeaders({}, accessToken, CONFIG),
    })
    const text = await upstream.text()
    sendJson(response, upstream.ok ? 200 : 502, {
      ok: upstream.ok,
      name,
      status: upstream.status,
      body: text.slice(0, 500),
    })
  }))
}

/**
 * Idempotent: the services (proxy port, account registry, login manager) are
 * process-wide singletons, so a second `init()` — a hot reload, or ST loading
 * the plugin twice — must reuse them instead of racing for the proxy port.
 * Routes are still registered on whichever router is handed in.
 */
export async function init(router) {
  if (!startup) {
    // Memoising the promise (not a boolean) also dedupes concurrent init() calls:
    // both await the same startup instead of racing to bind the proxy port.
    startup = startServices().catch(async (error) => {
      startup = null
      await exit()
      throw error
    })
  }
  await startup
  registerRoutes(router)
}

export async function exit() {
  const current = running
  running = null
  startup = null
  // Aborts a pending login (and clears its timeout) so nothing keeps the loop alive.
  current?.login.shutdown()
  if (current) {
    await current.proxy.close()
  }
}
