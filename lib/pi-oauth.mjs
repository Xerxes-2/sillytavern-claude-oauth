/**
 * Adapter over pi-ai's Anthropic (Claude Pro/Max) OAuth flow.
 *
 * The flow itself is vendored, not installed: `vendor/anthropic-oauth.mjs` is an
 * esbuild bundle of pi-ai's `dist/auth/oauth/anthropic.js` (the module its
 * `anthropicProvider().auth.oauth` lazily loads). pi-ai hard-depends on openai,
 * @aws-sdk and @google/genai — ~85 MB that this code path never touches — so
 * bundling the reachable 15 KB keeps the plugin at zero runtime dependencies.
 * See scripts/build-vendor.mjs; `npm run vendor:check` guards freshness in CI.
 *
 * Everything hard still comes from pi-ai: Claude Code's client id, PKCE, the
 * authorization-code exchange, token refresh and the callback server.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const VENDOR_SPECIFIER = '../vendor/anthropic-oauth.mjs'
const vendorDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor')

/** Reports which pi-ai release the vendored bundle was cut from. */
function describeVendor() {
  const file = path.join(vendorDir, 'anthropic-oauth.mjs')
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(vendorDir, 'manifest.json'), 'utf8'))
    return { version: manifest.piAiVersion ?? 'unknown', path: file }
  }
  catch {
    return { version: 'unknown', path: file }
  }
}

function normalise(credentials) {
  if (!credentials || typeof credentials !== 'object') {
    throw new Error('pi-ai returned no OAuth credentials')
  }
  const { refresh, access, expires } = credentials
  if (!refresh || !access || !expires) {
    throw new Error(`pi-ai returned incomplete OAuth credentials: ${Object.keys(credentials).join(', ')}`)
  }
  // pi-ai tags credentials with type: "oauth"; keep our stored format version-agnostic.
  return { refresh, access, expires }
}

/**
 * @typedef {import('./accounts.mjs').Credentials} Credentials
 *
 * @typedef {object} AnthropicOAuth
 * @property {string} piAiVersion
 * @property {string} piAiPath
 * @property {(options: {
 *   signal?: AbortSignal,
 *   onAuthUrl: (url: string, instructions?: string) => void,
 *   onManualCode: (signal?: AbortSignal) => Promise<string>,
 *   onProgress?: (message: string) => void,
 * }) => Promise<Credentials>} login
 * @property {(refreshToken: string, signal?: AbortSignal) => Promise<Credentials>} refresh
 */

/** @returns {Promise<AnthropicOAuth>} */
export async function createAnthropicOAuth() {
  let module
  try {
    module = await import(VENDOR_SPECIFIER)
  }
  catch (error) {
    throw new Error([
      `Could not load the vendored Claude OAuth flow: ${error.message}`,
      'vendor/anthropic-oauth.mjs ships with the plugin; re-clone it, or rebuild with: npm install && npm run vendor',
    ].join('\n'), { cause: error })
  }

  const install = describeVendor()
  const oauth = module.anthropicOAuth
  if (typeof oauth?.login !== 'function' || typeof oauth?.refresh !== 'function') {
    throw new Error([
      `vendor/anthropic-oauth.mjs (pi-ai ${install.version}) does not export anthropicOAuth with login/refresh.`,
      `Exports seen: ${Object.keys(module).join(', ') || '(none)'}`,
      'Rebuild it with: npm run vendor',
    ].join('\n'))
  }

  return {
    piAiVersion: install.version,
    piAiPath: install.path,

    async login({ signal, onAuthUrl, onManualCode, onProgress }) {
      const credentials = await oauth.login({
        // pi-ai requires a real AbortSignal here (it calls addEventListener on it).
        signal: signal ?? new AbortController().signal,
        notify: (event) => {
          if (event?.type === 'auth_url') {
            onAuthUrl(event.url, event.instructions)
          }
          else if (event?.type === 'progress' && onProgress) {
            onProgress(event.message)
          }
        },
        prompt: async (prompt) => {
          if (prompt?.type === 'manual_code') {
            return onManualCode(prompt.signal)
          }
          throw new Error(`Unsupported Claude login prompt: ${prompt?.type}`)
        },
      })
      return normalise(credentials)
    },

    async refresh(refreshToken, signal) {
      const credentials = await oauth.refresh(
        { type: 'oauth', refresh: refreshToken, access: '', expires: 0 },
        signal ?? new AbortController().signal,
      )
      return normalise(credentials)
    },
  }
}
