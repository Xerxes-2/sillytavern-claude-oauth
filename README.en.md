# SillyTavern Claude OAuth (subscription login) plugin

**English** · [简体中文](README.md)

Drives SillyTavern's built-in **Claude** chat completion source with a Claude Pro/Max subscription (Claude Code's OAuth channel). No Anthropic API key, and no installing the `claude` CLI to run `setup-token` by hand.

All of the authentication is **pi-ai's** (`@earendil-works/pi-ai`): Claude Code's client id, PKCE, the token exchange, refresh, and the Claude Code identity headers all come from it. This repo only wires it into SillyTavern. pi-ai's OAuth flow ships as a ~15 KB bundle inside the repo, so **the plugin has zero runtime dependencies — there is no `npm install` step**.

**Multiple accounts** are supported: every SillyTavern user can log in as many Claude accounts as they like, isolated from each other, each with its own ST proxy preset to switch between.

> ⚠️ Read this first: per pi-ai's own documentation, subscription OAuth used from a third-party harness bills as **extra usage, per token** rather than against your plan, and Anthropic has restricted this kind of use before (the OpenClaw incident). Use at your own risk; a throwaway account is the sensible choice.

---

## Layout

```text
sillytavern-claude-oauth/
├── index.mjs                     # Plugin entry: init(router) / exit() / info
├── lib/
│   ├── config.mjs                # Ports and upstream (all overridable by env vars)
│   ├── pi-oauth.mjs              # Thin adapter over the vendored pi-ai OAuth flow
│   ├── accounts.mjs              # Accounts per user: storage, lookup by proxy password, single-flight refresh
│   ├── login.mjs                 # Interactive login state machine (incl. pasted callback URL; owned per user)
│   └── proxy.mjs                 # Anthropic passthrough reverse proxy on 127.0.0.1 (proxy password required)
├── vendor/anthropic-oauth.mjs    # pi-ai's Anthropic OAuth flow (esbuild bundle, ~15 KB, ships with the repo)
├── scripts/
│   ├── build-vendor.mjs          # Regenerates vendor/, with a --check verification mode
│   └── i18n-keys.mjs             # Extracts UI translation keys, with --check for locale drift
├── manifest.json                 # UI extension manifest (the same repo installs as an ST extension)
├── extension/
│   ├── index.js                  # UI extension: account list, login, source switching (English source strings)
│   └── i18n/zh-cn.json           # Simplified Chinese locale
└── test/smoke.mjs                # 91 end-to-end self-checks: no real account, no network, no dependencies
```

## Installation

### 1. Server plugin

```bash
cd /path/to/SillyTavern/plugins
git clone https://github.com/Xerxes-2/sillytavern-claude-oauth claude-oauth
```

**There is no step two, and no `npm install`.** The plugin has no runtime dependencies: the OAuth flow is already bundled into `vendor/` (see "Why vendor" below).

`config.yaml` must enable:

```yaml
enableServerPlugins: true
```

Then restart SillyTavern. The startup log should show:

```text
[claude-oauth] Claude OAuth loopback proxy listening on http://127.0.0.1:45277
[claude-oauth] Reverse proxy URL for SillyTavern: http://127.0.0.1:45277/v1
[claude-oauth] pi-ai 0.86.1 (/path/to/plugins/claude-oauth/vendor/anthropic-oauth.mjs)
```

### 2. UI extension (optional, but strongly recommended)

In SillyTavern, go to Extensions → Install extension and paste the repo URL (`https://github.com/Xerxes-2/sillytavern-claude-oauth`); global or per-user both work. The `manifest.json` at the repo root is the extension manifest.

Once installed you will see **Claude OAuth (subscription login)** in the Extensions panel. Note the extension is only a panel: **the server plugin still has to be installed separately per step 1**, otherwise the panel will report that it cannot reach the plugin.

## Usage

1. Open the extension panel, type an account name (e.g. `main`) → **Log in with a Claude subscription** → your browser opens the `claude.ai` authorization page.
2. After logging in the browser is redirected to `http://localhost:53692/callback?code=...&state=...`.
   - **Docker / remote**: that address failing to load is expected (the callback server lives inside the container or on the server). Copy **the entire URL from the address bar**, paste it into the panel, and press "Submit code".
   - If you already mapped the port with `-p 53692:53692`, the callback page completes on its own and nothing needs pasting.
3. The first account that logs in is set as the Claude source automatically (can be turned off in the panel). After that each account gets a row; press **Use** to switch.
   Switching is persisted through ST's own *proxy presets* (named `claude-oauth/<account>`), so it survives a page reload and can also be changed from the proxy preset dropdown in API settings.
   To configure it by hand: API = Chat Completion, source = Claude, reverse proxy = `http://127.0.0.1:45277/v1`, **password = that account's proxy password** (press "Password" in the panel to copy it, or read `GET /api/plugins/claude-oauth/status`). A wrong password makes the proxy return 401.
4. Press **Verify** to confirm the path to Anthropic works, then chat normally.
5. Pressing **Re-login** on an account re-authorizes it without changing its proxy password, so the ST preset can stay as it is.

## How it works (and why)

SillyTavern's Claude adapter posts to `<reverse proxy URL> + '/messages'` and **always** sends `x-api-key`, `anthropic-version` and `anthropic-beta: output-128k-2025-02-19,context-1m-2025-08-07` (unconditional since staging; OAuth rejects the 1M beta with `This authentication style is incompatible with the long context beta header`). So the reverse proxy has to:

| What | Why |
|---|---|
| Resolve the account from `x-api-key` (one random password per account) and swap it for `Authorization: Bearer <access>` | The password *is* the account selector, so the proxy URL is identical for everyone; other local processes without the password cannot use it |
| Strip `context-1m-2025-08-07`, add `claude-code-20250219,oauth-2025-04-20`, pass other betas through | Anthropic requires it |
| Add `user-agent: claude-cli/<ver>` and `x-app: cli` | Same |
| Prepend `You are Claude Code, Anthropic's official CLI for Claude.` to the `system` array | OAuth rejects requests without that block |
| Refresh the access token before it expires (pi-ai already reports `expires` 5 minutes early), **serialized per account** | Anthropic rotates refresh tokens; two concurrent refreshes invalidate each other |

The proxy runs on **its own loopback port** instead of being registered as an `/api/plugins/...` route for a reason: SillyTavern mounts the `csrf-sync` middleware globally, ahead of all routes, and ST's own server-side fetch cannot supply `x-csrf-token`, so a plugin route would simply 403.

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/plugins/claude-oauth/status` | Accounts of the current ST user (name, proxy password, login state), login state, proxy URL, pi-ai version, plus the quota (`usage`) each account saw on its last response |
| POST | `/api/plugins/claude-oauth/login` | `{ name }`: start a login for that account (re-authorizes an existing one, keeping its password); returns `authUrl` |
| POST | `/api/plugins/claude-oauth/login/code` | `{ code }`: the pasted callback URL or authorization code |
| POST | `/api/plugins/claude-oauth/login/cancel` | Cancel the login in progress (works while waiting for a paste and during the token exchange) |
| DELETE | `/api/plugins/claude-oauth/accounts/:name` | Delete an account and its local credentials |
| GET | `/api/plugins/claude-oauth/accounts/:name/verify` | Request upstream `/v1/models` with that account's token |
| POST | `http://127.0.0.1:45277/v1/messages` | The Anthropic passthrough proxy SillyTavern talks to (needs `x-api-key: <account proxy password>`) |
| GET | `http://127.0.0.1:45277/v1/models` | Same |
| GET | `http://127.0.0.1:45277/health` | Liveness check, no password needed |

Accounts are stored per ST user, in the same layout ST uses for its own user data:

```text
<dataRoot>/<user handle>/claude-oauth/accounts/<account>.json
{ "name", "secret", "createdAt", "credentials": { "refresh", "access", "expires" } }
```

`dataRoot` follows ST's `--dataRoot` (default `<SillyTavern>/data`). Files are mode 600 and live outside the plugin directory, so reinstalling the plugin does not lose them and ST's user backups include them.

**Multi-user mode**: plugin routes identify the user through `request.user` (set by ST's `setUserDataMiddleware`), so user A can neither see nor delete user B's accounts. The proxy does not look at ST users at all, only at the password — which is a 32-byte random value, so whoever holds it can use it, exactly like any other reverse proxy password in ST.
One limitation: pi-ai's callback port 53692 is process-wide, so **only one person on the whole server can be logging in at a time**; everyone else sees "Another user is logging in".

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_OAUTH_PROXY_PORT` | `45277` | Proxy port |
| `CLAUDE_OAUTH_PROXY_HOST` | `127.0.0.1` | Proxy bind address. **Setting `0.0.0.0` exposes your subscription to the whole network**, with the account password as the only defence — do not change it unless you know exactly what you are doing |
| `CLAUDE_OAUTH_MAX_BODY_BYTES` | `134217728` (128 MB) | `/messages` request body limit; over it the proxy answers 413 |
| `CLAUDE_OAUTH_SHUTDOWN_GRACE_MS` | `2000` | How long shutdown waits for in-flight replies before forcing connections closed |
| `CLAUDE_OAUTH_ANTHROPIC_BASE_URL` | `https://api.anthropic.com/v1` | Upstream address (used by the self-checks and by gateways) |
| `CLAUDE_OAUTH_CLI_VERSION` | `2.1.280` | Which `claude-cli` version to present as |
| `CLAUDE_OAUTH_LOGIN_TIMEOUT_MS` | `900000` | How long to wait for a pasted authorization code |
| `PI_OAUTH_CALLBACK_HOST` | `127.0.0.1` | Callback bind address read by pi-ai (the port 53692 is hard-coded) |

## Self-checks

No real account and no network (pi-ai's token exchange is stubbed locally); real plugin code runs against a fake Anthropic endpoint:

```bash
node test/smoke.mjs         # runs with zero dependencies
```

With the dev dependencies installed you can run the full set:

```bash
pnpm install                # dev only: eslint / typescript / esbuild / pi-ai
pnpm run check              # lint + typecheck + vendor freshness + i18n + self-checks
```

Coverage: quota header parsing (including unknown buckets and the rate-limit reason), beta header merging and stripping, path normalization, Claude Code identity block injection (idempotent, preserving `cache_control`), proxy password → account resolution (401, cross-account routing), passthrough and SSE streaming, `x-api-key` stripping, plugin routes and cross-user isolation, the pasted-callback-URL handoff (PKCE verifier and state validation, account creation on success, re-login keeping the password), per-account single-flight refresh with rotation persisted, login cancellation and mutual exclusion, oversized bodies answered with 413 while the connection stays reusable, invalid account names answered with 400, a 4 MB streamed response with no truncation, `init()` idempotency and `exit()` releasing the port. It also verifies the vendored bundle matches the SHA256 in `vendor/manifest.json` and that its surface has not drifted from pi-ai's public `anthropicProvider().auth.oauth` entry (skipped automatically in a zero-dependency install). 91/91 pass against pi-ai **0.86.1**.

## Why vendor (why there are no runtime dependencies)

pi-ai lists `openai`, `@aws-sdk/client-bedrock-runtime`, `@google/genai` and `protobufjs` as hard `dependencies` — about 85 MB installed — and this plugin's code path never touches a line of them (measured: the OAuth flow is entirely self-contained; it does not even need `@anthropic-ai/sdk`).

So `scripts/build-vendor.mjs` uses esbuild to bundle pi-ai's Anthropic OAuth flow into `vendor/anthropic-oauth.mjs` (~15 KB, no third-party imports) and ships it with the repo:

- **For users**: `git clone` and you are done, no `npm install`, and the supply-chain surface shrinks from 85 MB to a single file.
- **The authentication is still pi-ai's**: client id, PKCE, token exchange, refresh and the callback server are not reimplemented here.
- **Upgrading pi-ai**: change the pin in `package.json` → `pnpm install` → `pnpm run vendor` → `pnpm run check`.
- **Drift protection**: `pnpm run vendor:check` rebuilds and compares byte for byte against the checked-in file while verifying the pi-ai and esbuild versions; the build fails outright if any third-party package appears in the bundle. The self-checks additionally compare the bundle's surface against pi-ai's public `anthropicProvider().auth.oauth`.

## Development

| Command | What it does |
|---|---|
| `pnpm run lint` | ESLint flat config. Formatting follows the presets: `js.configs.recommended` (ESLint 10 moved formatting rules out of core) + `@stylistic/recommended` — 2-space indent, no semicolons, stroustrup braces. Disagreements end at `--fix`, not at hand-tuned rules |
| `pnpm run typecheck` | `tsc --noEmit` with `checkJs`: type checking from the existing JSDoc, no compilation and no TypeScript migration |
| `pnpm run vendor` / `pnpm run vendor:check` | Rebuild / verify the vendored bundle |
| `pnpm run i18n` / `pnpm run i18n:check` | List the translation keys the UI needs / verify locales and error codes have not drifted |
| `pnpm test` | 91 self-checks |
| `pnpm run check` | All of the above |

Type checking covers the shipped code and the scripts only: `extension/` imports ST internals that do not resolve in this repo, `test/` stubs are deliberately loose objects, and `vendor/` is third-party output.

Pure formatting commits are listed in `.git-blame-ignore-revs`. Run `git config blame.ignoreRevsFile .git-blame-ignore-revs` once per clone and `git blame` will skip them (GitHub applies it automatically).

CI (`.github/workflows/ci.yml`) runs three jobs: lint + typecheck + vendor:check + i18n:check on Node 24; the self-checks on Node 20/22/24; and one job that runs the self-checks **with no node_modules at all**, which is what users actually get.

## Interface language (i18n)

The UI uses SillyTavern's own i18n: **source strings are English**, wrapped in ST's `t` template tag, and translations live in `extension/i18n/<locale>.json`, registered through the `i18n` field of `manifest.json`. ST falls back to the English source when a translation is missing, so a gap shows up as English text rather than a blank.

`zh-cn` ships with the repo (the plugin's original Chinese wording, reused sentence for sentence). Adding a language takes two steps:

```bash
node scripts/i18n-keys.mjs > keys.txt     # list every key the UI needs
# write extension/i18n/<locale>.json, then register it under "i18n" in manifest.json
node scripts/i18n-keys.mjs --check        # verify: nothing missing, nothing stale, nothing untranslated
```

Server-side errors are a separate path: `fail(code, message)` in `lib/util.mjs` attaches a stable `code` (e.g. `login_busy`) to every user-visible error, and responses carry `{ ok, code, error }`. The extension looks translations up by `code` and falls back to the server's English `message`, so **logs stay English** (searchable) while the UI is in the user's language.

`i18n:check` is a hard gate in CI. It verifies three things at once: no key is missing from a locale, no dead key survives a source edit, nothing is "translated" to its own English text — plus that every server `fail()` code has a translation in the extension, so renaming or adding an error code without a translation turns the build red.

## Known limitations

- **pi-ai entry point**: the bundle is cut from `dist/auth/oauth/anthropic.js`, the module `anthropicProvider().auth.oauth` actually lazy-loads (see pi-ai's `dist/auth/oauth/load.js`). That is an internal path, which is exactly why `vendor:check` in CI and the surface comparison in the self-checks are hard gates: if pi-ai moves or reshapes it, the build goes red instead of a user's login exploding.
- **The callback port 53692 is hard-coded** (only its bind address is configurable, via `PI_OAUTH_CALLBACK_HOST`), so Docker and remote setups must use the paste-the-URL path or map 53692 out.
- **Do not use pi-ai's anthropic provider to forward requests**: it re-serializes pi's `Context` into Anthropic parameters, and what SillyTavern sends is already native Anthropic format, so a round trip loses stop sequences / thinking / tool details. This plugin only uses its OAuth module.
- Requires Node ≥ 20.6 at runtime (`import.meta.resolve` is only used by the build script; pi-ai itself asks for Node ≥ 22.19, but the vendored OAuth flow only uses `node:http`, `node:crypto` and `fetch`).
- Only `zh-cn` ships as a locale; every other language falls back to the English source strings (PRs welcome).
- SillyTavern's Claude model dropdown is hard-coded, so a new model needs an ST update or an option injected by an extension.

## Troubleshooting

| Symptom | Cause |
|---|---|
| "Cannot reach the plugin" | `enableServerPlugins: true` is not set, or SillyTavern was not restarted |
| `Claude account "x" has no credentials` | That account's credential file is corrupt or was deleted; press "Re-login" |
| `This authentication style is incompatible with the long context beta header` | The request did not go through the plugin's proxy (check source = Claude, reverse proxy = `http://127.0.0.1:45277/v1`) |
| Browser cannot reach `localhost:53692` after authorizing | Expected on Docker/remote; paste the full URL instead |
| Proxy returns 401 `Unknown Claude OAuth proxy password` | The proxy password in ST belongs to no account (deleted account?); press "Use" on an account in the panel |
| "Use" stops working after a page reload | Check that the proxy preset dropdown in API settings has `claude-oauth/<account>` selected; the preset is saved by ST itself |
| "Another user is logging in" | The callback port 53692 is process-wide; wait for them to finish or time out (15 minutes by default) |
| `Claude OAuth token refresh failed: invalid_grant` | The refresh token is dead (password change, account flagged, or a concurrent refresh); log in again |
| Login succeeds but requests return 400/403 | The account has no extra usage enabled, or it is restricted from third-party harnesses |
| `EADDRINUSE` on 45277 | Pick another `CLAUDE_OAUTH_PROXY_PORT` and update the reverse proxy URL to match |

## Quota display

Anthropic attaches `anthropic-ratelimit-unified-<bucket>-utilization` / `-reset` headers to every `/messages` response (5h, 7d, overage, plus per-model weekly buckets such as Opus / Sonnet / Fable). The proxy keeps the most recent values in memory (never on disk), `/status` reports `usage` per account, and the panel shows it as "5 hours 34% · 7 days 61%" — yellow at ≥80%, red when rate limited (`status: rejected`), with which bucket and when it resets.

Hovering a quota chip shows the full bucket name, the exact percentage, the countdown to its reset and the local clock time of that reset (e.g. "today 21:30").

No extra requests are made, and the undocumented `/api/oauth/usage` endpoint is left alone (its 429s are brutal). Anthropic does not document the per-model bucket header names and has changed them, so the plugin collects every `-utilization` header; the panel gives localized labels to the buckets it knows (`5h`, `7d`, `7d_oi` = the Fable week) and shows unknown ones under their raw name — please open an issue if you see one.
