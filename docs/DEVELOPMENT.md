# Development notes

Maintenance checklist. Design rationale lives in the comments at the top of each `lib/*.mjs`.

## Commands

```bash
pnpm install        # dev dependencies only: eslint / typescript / esbuild / pi-ai
pnpm run check      # lint + typecheck + vendor:check + i18n:check + self-checks (= CI)
```

| Command | What it does |
|---|---|
| `pnpm run lint` | ESLint (`js.configs.recommended` + `@stylistic/recommended`); settle style with `--fix` |
| `pnpm run typecheck` | `tsc --noEmit` over JSDoc. Skips `extension/` (ST internals), `test/`, `vendor/` |
| `pnpm run vendor` / `vendor:check` | Rebuild / verify the vendored OAuth bundle |
| `pnpm run i18n` / `i18n:check` | List UI translation keys / verify locales and error codes |
| `pnpm test` | Self-checks (`test/smoke.mjs`) |

The plugin has no runtime dependencies; `node test/smoke.mjs` also runs without `node_modules`, which is what users get.

## Self-checks

`test/smoke.mjs` runs the real plugin against a fake Anthropic endpoint with pi-ai's token exchange stubbed: no account, no network. It covers header rewriting, password → account routing, streaming, cross-user isolation, the pasted-callback login, single-flight refresh, login cancellation / mutual exclusion, body limits, and `init()` / `exit()`. It also checks the vendored bundle against `vendor/manifest.json` and pi-ai's public `anthropicProvider().auth.oauth` (skipped without `node_modules`).

## Routine maintenance

**Bump pi-ai:** change the pin in `package.json` → `pnpm install` → `pnpm run vendor` → `pnpm run check`.

**Bump the claude-cli version:** when Anthropic answers with `claude_code_version_too_old`, update the default in `lib/config.mjs` to the current `@anthropic-ai/claude-code` version.

## i18n

UI source strings are English, wrapped in ST's `t` tag; translations are `extension/i18n/<locale>.json`, registered under `i18n` in `manifest.json`. Server errors go through `fail(code, message)` in `lib/util.mjs`; the extension translates by `code` and falls back to the English `message`, so logs stay English.

`i18n:check` fails on missing keys, dead keys, untranslated (identical-to-English) strings, and `fail()` codes without a translation. After changing UI text, run it and fix `zh-cn.json`.

## CI

`.github/workflows/ci.yml`: lint + typecheck + `vendor:check` + `i18n:check` on Node 24; self-checks on Node 20 / 22 / 24; self-checks without `node_modules`.

## Git blame

Formatting-only commits are listed in `.git-blame-ignore-revs`:

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```
