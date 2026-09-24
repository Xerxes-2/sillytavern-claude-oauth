# SillyTavern Claude OAuth (subscription login) plugin

**English** · [简体中文](README.md)

Use your Claude Pro/Max subscription with SillyTavern's built-in **Claude** source. No Anthropic API key, no `claude` CLI.

- Zero dependencies: `git clone` and you're done, no `npm install`.
- Multiple accounts: every ST user can log in several Claude accounts and switch between them from the proxy preset dropdown.
- 5-hour / 7-day quota shown right in the panel.

> ⚠️ **Read this first**: subscription OAuth used from a third-party client bills as **extra usage, per token**, not against your plan, and Anthropic has restricted this kind of use before. Use at your own risk; a throwaway account is the sensible choice.

## Installation

### 1. Server plugin (required)

```bash
cd /path/to/SillyTavern/plugins
git clone https://github.com/Xerxes-2/sillytavern-claude-oauth claude-oauth
```

Enable server plugins in SillyTavern's `config.yaml`:

```yaml
enableServerPlugins: true
```

Restart SillyTavern. This line in the log means it worked:

```text
[claude-oauth] Reverse proxy URL for SillyTavern: http://127.0.0.1:45277/v1
```

### 2. UI extension (strongly recommended)

Extensions → Install extension, paste `https://github.com/Xerxes-2/sillytavern-claude-oauth`. **Claude OAuth (subscription login)** then shows up in the Extensions panel.

The panel is only a UI: you still need the server plugin from step 1, otherwise the panel reports that it cannot reach the plugin.

## Usage

1. Type an account name in the panel (e.g. `main`) and press **Log in with a Claude subscription**. Your browser opens the claude.ai authorization page.
2. After authorizing, the browser lands on `http://localhost:53692/callback?...`:
   - **Running locally**: the page shows success on its own.
   - **Docker / remote server**: the page failing to load is expected. Copy the **full URL** from the address bar, paste it into the panel and press "Submit code". (Or map port 53692 out and skip the paste.)
3. The first account you log in becomes the Claude source automatically. After that each account gets a row; press **Use** to switch, or pick `claude-oauth/<account>` from the proxy preset dropdown in API settings.
4. Press **Verify** to check the connection, then chat as usual.

Also: **Re-login** re-authorizes without changing the proxy password (your ST preset keeps working); **Delete** removes the account and its local credentials.

<details>
<summary>Manual setup without the panel</summary>

- API = Chat Completion, source = Claude
- Reverse proxy = `http://127.0.0.1:45277/v1`
- Password = that account's proxy password (press "Password" in the panel to copy it)

A wrong password returns 401.
</details>

## Quota display

Each account in the panel shows the quota reported by its most recent reply, e.g. "5 hours 34% · 7 days 61%": yellow at ≥80%, red when rate limited, with which bucket and when it resets. Hover a chip for the exact percentage and the reset time.

Quota only updates as you chat; the plugin never makes extra requests for it. If you see a bucket shown under an unfamiliar raw name, please open an issue.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Panel says "Cannot reach the plugin" | `enableServerPlugins: true` is missing from `config.yaml`, or ST was not restarted |
| Browser cannot reach `localhost:53692` after authorizing | Expected on Docker/remote; paste the full URL into the panel |
| "Another user is logging in" | Only one person per server can be logging in at a time; wait for them to finish or time out (15 minutes) |
| `This authentication style is incompatible with the long context beta header` | The request bypassed the plugin: check source = Claude, reverse proxy = `http://127.0.0.1:45277/v1` |
| 401 `Unknown Claude OAuth proxy password` | The password in ST belongs to no account (deleted account?); press "Use" on an account in the panel |
| Switching is lost after a page reload | Check that the proxy preset dropdown in API settings has `claude-oauth/<account>` selected |
| `Claude account "x" has no credentials` | The credential file is corrupt or gone; press "Re-login" |
| `token refresh failed: invalid_grant` | The login is dead (password change, account flagged, …); log in again |
| Login works but requests return 400/403 | The account has no extra usage enabled, or is barred from third-party clients |
| `EADDRINUSE` on 45277 at startup | Pick another port with `CLAUDE_OAUTH_PROXY_PORT` and update the reverse proxy URL |

## Known limitations

- The login callback port is fixed at **53692**, so only one person per server can be logging in at a time.
- SillyTavern's Claude model dropdown is hard-coded; new models need an ST update.
- The UI ships in English and Simplified Chinese only.
- Requires Node ≥ 20.6.

## Configuration

You normally don't need any. If you do, set environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_OAUTH_PROXY_PORT` | `45277` | Proxy port |
| `CLAUDE_OAUTH_PROXY_HOST` | `127.0.0.1` | Proxy bind address. **`0.0.0.0` exposes your subscription to the whole network** — leave it alone |
| `CLAUDE_OAUTH_LOGIN_TIMEOUT_MS` | `900000` | How long to wait for a pasted authorization code |
| `CLAUDE_OAUTH_CLI_VERSION` | `2.1.281` | Which `claude-cli` version to present as |
| `PI_OAUTH_CALLBACK_HOST` | `127.0.0.1` | Login callback bind address |

Full list in [`lib/config.mjs`](lib/config.mjs).

Account credentials live in `<SillyTavern>/data/<user>/claude-oauth/accounts/`, so reinstalling the plugin keeps them and ST's user backups include them.

## Credits

The authentication flow comes from [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai).

## License

[MIT](LICENSE)
