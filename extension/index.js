/**
 * UI companion for the "claude-oauth" server plugin.
 *
 * All network work (PKCE login, token storage, refresh, the Anthropic proxy)
 * lives in the server plugin; this file lists the current ST user's Claude
 * accounts, drives the login handoff and wires SillyTavern's Claude source to
 * the plugin's loopback reverse proxy via ST's own proxy presets.
 *
 * Source strings are English and go through ST's `t` tag; translations ship in
 * i18n/<locale>.json and are registered by the `i18n` field in manifest.json.
 * `t` falls back to the English text, so an untranslated locale still works.
 */
import { extension_settings } from '../../../../extensions.js'
import { getRequestHeaders } from '../../../../../script.js'
import { t } from '../../../../i18n.js'
import { oai_settings } from '../../../../openai.js'
import { Popup } from '../../../../popup.js'

const PLUGIN_ID = 'claude-oauth'
const PLUGIN_API = `/api/plugins/${PLUGIN_ID}`
const MODULE = 'claude_oauth_controls'
/** ST reverse-proxy presets managed by this extension are named `claude-oauth/<account>`. */
const PRESET_PREFIX = 'claude-oauth/'

const defaultSettings = { autoConfigure: true }

/** Last /status payload; the account table and "configured" checks are derived from it. */
let lastStatus = null

function settings() {
  extension_settings[MODULE] = Object.assign({}, defaultSettings, extension_settings[MODULE] || {})
  return extension_settings[MODULE]
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]))
}

function setStatus(text, kind = 'info') {
  const el = document.getElementById('claude_oauth_status')
  if (!el) return
  el.textContent = text
  el.dataset.kind = kind
}

/**
 * Server-side failures carry a stable `code` (see lib/util.mjs `fail`). Look the
 * translation up by code rather than by message, so rewording the English text
 * server-side never silently drops a translation. Unknown codes fall back to
 * the server's English message, which is never empty.
 */
const SERVER_ERRORS = {
  not_logged_in: () => t`You are not logged in to SillyTavern.`,
  not_initialised: () => t`The Claude OAuth plugin is not running. Restart SillyTavern.`,
  invalid_account_name: () => t`Account names are 1-32 characters: letters, digits, "-" or "_".`,
  account_not_logged_in: () => t`This account has no credentials yet. Log in again.`,
  invalid_credentials: () => t`Claude returned incomplete credentials. Try logging in again.`,
  login_busy: () => t`Another login is already in progress on this server. Wait for it to finish or time out.`,
  login_other_account: () => t`A login for a different account is already in progress. Cancel it first.`,
  login_failed: () => t`Claude did not return an authorization URL.`,
  login_timeout: () => t`The login timed out. Start it again.`,
  login_cancelled: () => t`The login was cancelled.`,
  no_login_in_progress: () => t`No login is in progress.`,
  missing_code: () => t`Paste the full redirect URL (or the authorization code) first.`,
  manual_code_not_needed: () => t`Manual code entry is no longer needed.`,
  invalid_json: () => t`The plugin could not read the request.`,
}

/** Translated text for a failed request, falling back to whatever the server said. */
function reason(error) {
  return SERVER_ERRORS[error?.code]?.() ?? error?.message ?? String(error)
}

async function pluginFetch(path, options = {}) {
  const response = await fetch(`${PLUGIN_API}${path}`, {
    method: options.method || 'GET',
    headers: getRequestHeaders(),
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const text = await response.text()
  let payload
  try {
    payload = text ? JSON.parse(text) : {}
  }
  catch {
    payload = { error: text }
  }
  if (!response.ok) {
    const error = new Error(payload?.error || `${response.status} ${response.statusText}`)
    error.code = payload?.code
    throw error
  }
  return payload
}

/** Which of our accounts is ST's Claude source currently pointed at, if any. */
function activeAccountName() {
  if (!lastStatus || oai_settings.chat_completion_source !== 'claude') return null
  if (oai_settings.reverse_proxy !== lastStatus.proxyUrl) return null
  return lastStatus.accounts.find(a => a.secret === oai_settings.proxy_password)?.name ?? null
}

function describeAccount(account) {
  if (!account.loggedIn) return t`Not logged in`
  const minutes = Math.round((account.expiresIn || 0) / 60000)
  return minutes > 0 ? t`Logged in, token refreshes in ${minutes} min` : t`Logged in, token refresh due`
}

function formatReset(resetsAt) {
  if (!resetsAt) return ''
  const minutes = Math.max(0, Math.round((resetsAt - Date.now()) / 60000))
  if (minutes < 60) return t`resets in ${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) {
    const rest = minutes % 60
    return t`resets in ${hours} h ${rest} min`
  }
  const days = Math.round(hours / 24)
  return t`resets in ${days} d`
}

/**
 * Friendly labels for the quota buckets Anthropic reports. Anything not listed
 * (per-model weekly buckets whose header names are undocumented) is shown
 * under its raw name so it is still visible.
 *
 * These are functions, not constants: `t` must run after ST has loaded the
 * locale data, which happens later than this module's evaluation.
 */
const BUCKET_LABELS = {
  '5h': () => t`5 hours`,
  '7d': () => t`7 days`,
  '7d_oi': () => t`Fable week`, // "overage included": the Fable bucket, observed on Max
  '7d_opus': () => t`Opus week`,
  '7d_sonnet': () => t`Sonnet week`,
  'overage': () => t`Overage`,
}
const BUCKET_ORDER = ['5h', '7d', '7d_oi', '7d_opus', '7d_sonnet', 'overage']
const CLAIM_LABELS = {
  five_hour: () => t`5 hours`,
  seven_day: () => t`7 days`,
  seven_day_opus: () => t`Opus week`,
  seven_day_sonnet: () => t`Sonnet week`,
  seven_day_overage_included: () => t`Fable week`,
  overage: () => t`Overage`,
}

/**
 * Wall-clock time of a reset, so "resets in 7 h" can be checked against a
 * calendar without doing the arithmetic. Dates and times use the browser's
 * locale: `t` translates wording, never number formats.
 */
function formatResetClock(resetsAt) {
  const date = new Date(resetsAt)
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)
  const days = Math.floor((date.getTime() - midnight.getTime()) / 86400000)
  if (days === 0) return t`today ${time}`
  if (days === 1) return t`tomorrow ${time}`
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/**
 * Hover text for a chip. The chip itself only has room for a rounded
 * percentage, so the tooltip carries what a user actually wants when the
 * number looks bad: which bucket this is, the exact fill, and when it frees up
 * (both as a countdown and as a clock time). Buckets with no `-reset` header
 * get the first two lines only.
 */
function usageTooltip(bucket, window) {
  const label = BUCKET_LABELS[bucket]?.() ?? bucket
  const exact = (window.utilization * 100).toFixed(1).replace(/\.0$/, '')
  const lines = [label === bucket ? bucket : `${label} (${bucket})`, t`Used ${exact}%`]
  if (window.resetsAt) lines.push(formatReset(window.resetsAt), formatResetClock(window.resetsAt))
  return lines.join('\n')
}

/** One quota chip, coloured by how close the bucket is to full. */
function usageChip(bucket, window) {
  const pct = Math.round(window.utilization * 100)
  const kind = pct >= 100 ? 'error' : pct >= 80 ? 'warn' : 'ok'
  const label = BUCKET_LABELS[bucket]?.() ?? bucket
  return `<span class="claude-oauth-usage" data-kind="${kind}" title="${escapeHtml(usageTooltip(bucket, window))}">${escapeHtml(label)} ${pct}%</span>`
}

/** Quota line for an account; empty until the account has served a request since restart. */
function renderUsage(usage) {
  if (!usage) return `<small class="claude-oauth-usage-none">${escapeHtml(t`Quota: shown after the first message`)}</small>`
  const names = Object.keys(usage.buckets ?? {}).sort((a, b) => {
    const ia = BUCKET_ORDER.indexOf(a)
    const ib = BUCKET_ORDER.indexOf(b)
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b)
  })
  const chips = names.map(name => usageChip(name, usage.buckets[name]))
  if (usage.status === 'rejected') {
    const which = usage.limitedBy ? (CLAIM_LABELS[usage.limitedBy]?.() ?? usage.limitedBy) : ''
    const reset = formatReset(usage.resetsAt ?? usage.buckets?.['5h']?.resetsAt ?? usage.buckets?.['7d']?.resetsAt)
    const label = which ? t`Rate limited (${which})` : t`Rate limited`
    chips.push(`<span class="claude-oauth-usage" data-kind="error">${escapeHtml(reset ? `${label}, ${reset}` : label)}</span>`)
  }
  const age = Math.round((Date.now() - usage.observedAt) / 60000)
  const freshness = age < 1 ? t`just now` : t`${age} min ago`
  return `<small>${escapeHtml(t`Quota:`)} ${chips.join(' ')} <span class="claude-oauth-usage-age">${escapeHtml(freshness)}</span></small>`
}

function renderAccounts() {
  const table = document.getElementById('claude_oauth_accounts')
  if (!table || !lastStatus) return
  const active = activeAccountName()
  if (lastStatus.accounts.length === 0) {
    table.innerHTML = `<div class="claude-oauth-empty">${escapeHtml(t`No accounts yet. Enter a name below and log in.`)}</div>`
    return
  }
  table.innerHTML = lastStatus.accounts.map((account) => {
    const name = escapeHtml(account.name)
    const isActive = account.name === active
    const badge = isActive ? ` <span class="claude-oauth-badge">${escapeHtml(t`active source`)}</span>` : ''
    return `
      <div class="claude-oauth-account${isActive ? ' active' : ''}" data-name="${name}">
        <div class="claude-oauth-account-info">
          <b>${name}</b>${badge}
          <small>${escapeHtml(describeAccount(account))}</small>
          ${renderUsage(account.usage)}
        </div>
        <div class="claude-oauth-account-actions">
          <div class="menu_button" data-action="use" title="${escapeHtml(t`Point the Claude source at this account`)}">${escapeHtml(t`Use`)}</div>
          <div class="menu_button" data-action="verify" title="${escapeHtml(t`Request /v1/models with this token`)}">${escapeHtml(t`Verify`)}</div>
          <div class="menu_button" data-action="relogin" title="${escapeHtml(t`Authorize again, keeping the proxy password`)}">${escapeHtml(t`Re-login`)}</div>
          <div class="menu_button" data-action="secret" title="${escapeHtml(t`Copy the proxy password (for manual setup)`)}">${escapeHtml(t`Password`)}</div>
          <div class="menu_button" data-action="delete" title="${escapeHtml(t`Delete the account and its local credentials`)}">${escapeHtml(t`Delete`)}</div>
        </div>
      </div>`
  }).join('')
}

function renderStatus(payload) {
  lastStatus = payload
  const count = payload.accounts.length
  const proxyUrl = payload.proxyUrl
  const parts = [t`${count} accounts`, t`Proxy: ${proxyUrl}`]
  const active = activeAccountName()
  if (active) {
    parts.push(t`Claude source → ${active}`)
  }
  else if (payload.accounts.some(a => a.loggedIn)) {
    parts.push(t`Claude source is not pointed at any account`)
  }
  if (payload.login?.pending) {
    const name = payload.login.name
    parts.push(t`Logging in ${name}`)
    showPasteBox(payload.login.authUrl, name)
  }
  else if (payload.login?.busy) {
    parts.push(t`Another user is logging in (the callback port is exclusive)`)
  }
  setStatus(parts.join(' · '), active ? 'ok' : 'warn')
  renderAccounts()
}

async function refreshStatus() {
  try {
    renderStatus(await pluginFetch('/status'))
  }
  catch (error) {
    const why = reason(error)
    setStatus(t`Cannot reach the plugin: ${why} (check that enableServerPlugins is true and restart SillyTavern)`, 'error')
  }
}

function showPasteBox(authUrl, name) {
  const box = document.getElementById('claude_oauth_paste_box')
  if (box) box.style.display = ''
  const link = document.getElementById('claude_oauth_auth_link')
  if (link) link.href = authUrl
  const label = document.getElementById('claude_oauth_paste_name')
  if (label) label.textContent = name
}

function hidePasteBox() {
  const box = document.getElementById('claude_oauth_paste_box')
  if (box) box.style.display = 'none'
  const input = document.getElementById('claude_oauth_code_input')
  if (input) input.value = ''
}

async function login(name) {
  try {
    setStatus(t`Building an authorization link for ${name}...`)
    const payload = await pluginFetch('/login', { method: 'POST', body: { name } })
    if (!payload.authUrl) throw new Error(t`The plugin did not return an authorization URL.`)
    window.open(payload.authUrl, '_blank')
    showPasteBox(payload.authUrl, name)
    setStatus(t`Authorization page opened for ${name}. After logging in, paste the full URL from the address bar below.`)
  }
  catch (error) {
    const why = reason(error)
    setStatus(t`Login failed: ${why}`, 'error')
  }
}

async function addAccount() {
  const input = document.getElementById('claude_oauth_new_name')
  const name = String(input?.value || '').trim()
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(name)) {
    setStatus(t`Account names are 1-32 characters: letters, digits, "-" or "_".`, 'warn')
    return
  }
  await login(name)
}

async function submitCode() {
  const input = document.getElementById('claude_oauth_code_input')
  const value = String(input?.value || '').trim()
  if (!value) {
    setStatus(t`Paste the full redirect URL (or the authorization code) first.`, 'warn')
    return
  }
  try {
    setStatus(t`Exchanging the authorization code for a token...`)
    const payload = await pluginFetch('/login/code', { method: 'POST', body: { code: value } })
    if (!payload.ok) throw new Error(payload.error || t`Token exchange failed.`)
    hidePasteBox()
    const nameInput = document.getElementById('claude_oauth_new_name')
    if (nameInput) nameInput.value = ''
    await refreshStatus()
    if (settings().autoConfigure && !activeAccountName()) {
      useAccount(payload.name)
    }
    else {
      const name = payload.name
      setStatus(t`Account ${name} logged in.`, 'ok')
    }
  }
  catch (error) {
    const why = reason(error)
    setStatus(t`Login failed: ${why}`, 'error')
  }
}

async function cancelLogin() {
  try {
    await pluginFetch('/login/cancel', { method: 'POST', body: {} })
    hidePasteBox()
    await refreshStatus()
  }
  catch (error) {
    const why = reason(error)
    setStatus(t`Could not cancel: ${why}`, 'error')
  }
}

async function verify(name) {
  try {
    setStatus(t`Requesting /v1/models with the token of ${name}...`)
    const payload = await pluginFetch(`/accounts/${encodeURIComponent(name)}/verify`)
    const status = payload.status
    if (payload.ok) {
      setStatus(t`${name}: token works (HTTP ${status})`, 'ok')
    }
    else {
      const body = String(payload.body).slice(0, 200)
      setStatus(t`${name}: token rejected (HTTP ${status}): ${body}`, 'error')
    }
  }
  catch (error) {
    const why = reason(error)
    setStatus(t`Verification failed: ${why}`, 'error')
  }
}

async function removeAccount(name) {
  const confirmed = await Popup.show.confirm(
    t`Delete Claude account`,
    t`Delete account "${name}" and its local credentials? The matching proxy preset in SillyTavern is not removed automatically.`,
  )
  if (!confirmed) return
  try {
    await pluginFetch(`/accounts/${encodeURIComponent(name)}`, { method: 'DELETE' })
    await refreshStatus()
    setStatus(t`Account ${name} deleted.`, 'ok')
  }
  catch (error) {
    const why = reason(error)
    setStatus(t`Delete failed: ${why}`, 'error')
  }
}

async function copySecret(name) {
  const account = lastStatus?.accounts.find(a => a.name === name)
  if (!account) return
  const proxyUrl = lastStatus.proxyUrl
  try {
    await navigator.clipboard.writeText(account.secret)
    setStatus(t`Copied the proxy password of ${name}. Manual setup: reverse proxy = ${proxyUrl}, password = clipboard contents.`, 'ok')
  }
  catch {
    await Popup.show.text(
      t`Proxy password for ${name}`,
      `<code>${escapeHtml(account.secret)}</code><br><br>${escapeHtml(t`Reverse proxy URL:`)} <code>${escapeHtml(proxyUrl)}</code>`,
    )
  }
}

/**
 * Point ST's Claude source at one account.
 *
 * Writing `oai_settings.reverse_proxy` directly does not survive a reload: on
 * load ST re-applies the selected *proxy preset* over those fields. So this
 * goes through the same UI path as a user saving a preset ("Save Proxy"),
 * which persists it in `proxies[]` / `selected_proxy`. One preset per account
 * (`claude-oauth/<name>`) means switching accounts later is just picking a
 * different preset in ST's own dropdown.
 */
function useAccount(name) {
  try {
    const account = lastStatus?.accounts.find(a => a.name === name)
    if (!account || !lastStatus.proxyUrl) throw new Error(t`No account data yet — press "Refresh" once.`)

    if ($('#main_api').val() !== 'openai') {
      $('#main_api').val('openai').trigger('change')
    }
    if ($('#chat_completion_source').val() !== 'claude') {
      $('#chat_completion_source').val('claude').trigger('change')
    }

    $('#openai_reverse_proxy_name').val(`${PRESET_PREFIX}${name}`)
    $('#openai_reverse_proxy').val(lastStatus.proxyUrl).trigger('input')
    $('#openai_proxy_access_key').val(account.secret).trigger('input')
    $('#save_proxy').trigger('click')

    if (activeAccountName() !== name) {
      throw new Error(t`SillyTavern did not accept the proxy settings (its UI may have changed). Fill in the reverse proxy URL and password manually.`)
    }
    renderAccounts()
    const preset = `${PRESET_PREFIX}${name}`
    setStatus(t`Claude source now points at ${name} (proxy preset "${preset}").`, 'ok')
  }
  catch (error) {
    const why = reason(error)
    setStatus(t`Setup failed: ${why}`, 'error')
  }
}

function onAccountAction(event) {
  const button = event.target.closest('[data-action]')
  if (!button) return
  const name = button.closest('[data-name]')?.dataset.name
  if (!name) return
  switch (button.dataset.action) {
    case 'use': return useAccount(name)
    case 'verify': return verify(name)
    case 'relogin': return login(name)
    case 'secret': return copySecret(name)
    case 'delete': return removeAccount(name)
    default: return undefined
  }
}

function buildPanel() {
  const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings')
  if (!container) return
  const callbackPort = '53692'
  const html = `
    <div class="claude-oauth-settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>${escapeHtml(t`Claude OAuth (subscription login)`)}</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <div id="claude_oauth_status" class="claude-oauth-status">${escapeHtml(t`Not checked`)}</div>
          <div id="claude_oauth_accounts" class="claude-oauth-accounts"></div>
          <div class="claude-oauth-add">
            <input id="claude_oauth_new_name" class="text_pole" type="text" placeholder="${escapeHtml(t`New account name, e.g. work`)}" maxlength="32" />
            <div id="claude_oauth_add" class="menu_button">${escapeHtml(t`Log in with a Claude subscription`)}</div>
            <div id="claude_oauth_check" class="menu_button">${escapeHtml(t`Refresh`)}</div>
          </div>
          <label class="checkbox_label" for="claude_oauth_autoconfigure">
            <input id="claude_oauth_autoconfigure" type="checkbox" />
            <span>${escapeHtml(t`Use the first account as the Claude source once it logs in`)}</span>
          </label>
          <small>
            ${escapeHtml(t`Each account gets a SillyTavern proxy preset named claude-oauth/<account>, so you can switch accounts from the proxy preset dropdown in API settings.`)}
            ${escapeHtml(t`Manual setup: API = Chat Completion, source = Claude, reverse proxy = the proxy URL above, password = that account's proxy password.`)}
          </small>
          <div id="claude_oauth_paste_box" class="claude-oauth-paste" style="display:none">
            <small>
              ${escapeHtml(t`Logging in account`)} <b id="claude_oauth_paste_name"></b>.
              ${escapeHtml(t`The browser will fail to reach localhost:${callbackPort} (normal on Docker or a remote server). Copy the whole URL from the address bar and paste it here. If port ${callbackPort} is mapped into the container, the callback page completes on its own and nothing needs pasting.`)}
            </small>
            <a id="claude_oauth_auth_link" href="#" target="_blank" rel="noopener">${escapeHtml(t`Reopen the authorization page`)}</a>
            <textarea id="claude_oauth_code_input" rows="3" placeholder="http://localhost:53692/callback?code=...&state=..."></textarea>
            <div class="claude-oauth-buttons">
              <div id="claude_oauth_submit" class="menu_button">${escapeHtml(t`Submit code`)}</div>
              <div id="claude_oauth_cancel" class="menu_button">${escapeHtml(t`Cancel login`)}</div>
            </div>
          </div>
        </div>
      </div>
    </div>`
  container.insertAdjacentHTML('beforeend', html)

  const autoconfigure = document.getElementById('claude_oauth_autoconfigure')
  autoconfigure.checked = settings().autoConfigure
  autoconfigure.addEventListener('change', () => {
    settings().autoConfigure = autoconfigure.checked
  })

  document.getElementById('claude_oauth_accounts').addEventListener('click', onAccountAction)
  document.getElementById('claude_oauth_add').addEventListener('click', addAccount)
  document.getElementById('claude_oauth_new_name').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') addAccount()
  })
  document.getElementById('claude_oauth_check').addEventListener('click', refreshStatus)
  document.getElementById('claude_oauth_submit').addEventListener('click', submitCode)
  document.getElementById('claude_oauth_cancel').addEventListener('click', cancelLogin)

  // Re-render the "current source" badge when the user switches proxy preset / source in ST.
  $(document).on('change', '#openai_proxy_preset, #chat_completion_source, #main_api', () => renderAccounts())
}

jQuery(async () => {
  settings()
  buildPanel()
  await refreshStatus()
})
