# SillyTavern Claude OAuth（订阅登录）插件

用 Claude Pro/Max 订阅（Claude Code 的 OAuth 通道）驱动 SillyTavern 内置的 **Claude** chat completion 来源，不需要 Anthropic API key，也不需要安装 `claude` CLI 手动跑 `setup-token`。

认证部分**全部复用 `@earendil-works/pi-ai`**（Claude Code 的 client id、PKCE、token 交换、refresh、Claude Code 身份伪装头都是它现成的），本仓库只负责把它接到 SillyTavern 上。

支持**多账号**：每个 SillyTavern 用户可以登录任意多个 Claude 账号，各自隔离；每个账号对应一个 ST 代理预设，在 ST 的代理预设下拉里切换。

> ⚠️ 风险先读：按 pi-ai 自己的文档，订阅 OAuth 在第三方 harness 里走的是 **extra usage、按 token 计费**，不占套餐额度；Anthropic 此前也限制过这类用法（OpenClaw 事件）。账号风险自负，建议用小号。

---

## 目录结构

```text
sillytavern-claude-oauth/
├── index.mjs                     # 插件入口：init(router) / exit() / info
├── lib/
│   ├── config.mjs                # 端口与 upstream（全部可用环境变量覆盖）
│   ├── pi-oauth.mjs              # 薄适配层：pi-ai 的 anthropicProvider().auth.oauth（公开入口）
│   ├── accounts.mjs              # 每用户多账号：落盘、按代理密码查找、单飞（single-flight）刷新
│   ├── login.mjs                 # 交互式登录状态机（含手动粘贴回调 URL；按用户归属）
│   └── proxy.mjs                 # 127.0.0.1 上的 Anthropic 透传反代（需代理密码）
├── extension/claude-oauth-controls/   # 可选的界面扩展（账号列表/登录/切换来源）
└── test/smoke.mjs                # 70 项端到端自检，不需要真账号、不联网
```

## 安装

### 1. 服务端插件

```bash
cd /path/to/SillyTavern/plugins
git clone <this-repo> claude-oauth
cd claude-oauth
npm install                 # 只装 @earendil-works/pi-ai
```

`config.yaml` 里必须打开：

```yaml
enableServerPlugins: true
```

然后重启 SillyTavern。启动日志里应出现：

```text
[claude-oauth] Claude OAuth loopback proxy listening on http://127.0.0.1:45277
[claude-oauth] Reverse proxy URL for SillyTavern: http://127.0.0.1:45277/v1
[claude-oauth] pi-ai 0.86.1 (/path/to/plugins/claude-oauth/node_modules/@earendil-works/pi-ai)
```

### 2. 界面扩展（可选，但强烈建议）

```bash
cp -r extension/claude-oauth-controls /path/to/SillyTavern/data/default-user/extensions/
```

重启后在「扩展」面板里能看到 **Claude OAuth（订阅登录）**。

## 使用

1. 打开扩展面板，输入一个账号名（如 `main`）→ **用 Claude 订阅登录** → 浏览器会打开 `claude.ai` 授权页。
2. 登录后浏览器会跳到 `http://localhost:53692/callback?code=...&state=...`。
   - **Docker / 远程**：这个地址打不开是正常的（回调服务器在容器/服务器里）。把**地址栏里那条完整 URL** 复制，粘到插件面板的输入框，点「提交授权码」。
   - 如果已经 `-p 53692:53692` 把端口映射到容器，回调页会自己显示成功，不用粘贴。
3. 首个账号登录成功后会自动设为 Claude 来源（可在面板里关掉）。之后每个账号一行，点 **使用** 切换。
   切换是通过 ST 的「代理预设」保存的（名字 `claude-oauth/<账号名>`），刷新页面后仍然有效，也可以直接在 API 设置的代理预设下拉里切。
   手动配置的话：API = Chat Completion，来源 = Claude，反向代理 = `http://127.0.0.1:45277/v1`，**密码 = 该账号的代理密码**（面板里点「密码」复制，或看 `GET /api/plugins/claude-oauth/status`）。密码错了反代会返回 401。
4. 点 **验证** 确认能打通 Anthropic，再正常聊天。
5. 同一账号点 **重登** 可重新授权而不换代理密码（ST 里的预设不用动）。

## 工作原理（为什么这么设计）

SillyTavern 的 Claude 适配器把请求发到 `反向代理URL + '/messages'`，并且**永远带** `x-api-key`、`anthropic-version` 和 `anthropic-beta: output-128k-2025-02-19,context-1m-2025-08-07`（staging 起无条件发送；OAuth 会因 1M beta 报 `This authentication style is incompatible with the long context beta header`）。所以反代必须：

| 动作 | 原因 |
|---|---|
| 用 `x-api-key` 找到对应账号（每账号一个随机密码），换成 `Authorization: Bearer <access>` | 密码即账号选择器，代理 URL 对所有账号相同；本机其他进程没密码就用不了 |
| 剥掉 `context-1m-2025-08-07`，补 `claude-code-20250219,oauth-2025-04-20`，其余 beta 透传 | Anthropic 要求 |
| 加 `user-agent: claude-cli/<ver>` 和 `x-app: cli` | 同上 |
| 在 `system` 数组最前面插入 `You are Claude Code, Anthropic's official CLI for Claude.` | OAuth 无此块会被拒 |
| access token 过期前自动 refresh（pi-ai 已把 `expires` 提前 5 分钟），且**每账号串行化** | Anthropic 会轮换 refresh token，并发双刷新会互相作废 |

反代跑在 **独立的 loopback 端口**、而不是注册成 `/api/plugins/...` 路由，也是有原因的：SillyTavern 的 `csrf-sync` 中间件在所有路由之前全局挂载，ST 自己的服务端 fetch 带不了 `x-csrf-token`，走插件路由会直接 403。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/plugins/claude-oauth/status` | 当前 ST 用户的账号列表（名字、代理密码、登录状态）、登录状态、代理地址、pi-ai 版本 |
| POST | `/api/plugins/claude-oauth/login` | `{ name }`：为该账号开始登录（已存在则重新授权、保留密码），返回 `authUrl` |
| POST | `/api/plugins/claude-oauth/login/code` | `{ code }`：粘贴的回调 URL 或授权码 |
| POST | `/api/plugins/claude-oauth/login/cancel` | 取消进行中的登录（等待粘贴或换 token 阶段都可取消） |
| DELETE | `/api/plugins/claude-oauth/accounts/:name` | 删除账号及本地凭据 |
| GET | `/api/plugins/claude-oauth/accounts/:name/verify` | 用该账号 token 请求 upstream `/v1/models` |
| POST | `http://127.0.0.1:45277/v1/messages` | 给 SillyTavern 用的 Anthropic 透传反代（需 `x-api-key: <账号代理密码>`） |
| GET | `http://127.0.0.1:45277/v1/models` | 同上 |
| GET | `http://127.0.0.1:45277/health` | 存活检查，无需密码 |

账号按 ST 用户存放，和 ST 自己的用户目录同一布局：

```text
<dataRoot>/<用户handle>/claude-oauth/accounts/<账号名>.json
{ "name", "secret", "createdAt", "credentials": { "refresh", "access", "expires" } }
```

`dataRoot` 取 ST 的 `--dataRoot`（默认 `<SillyTavern>/data`），文件权限 600，在插件目录之外，重装插件不会丢，ST 的用户备份也会带上。

**多用户模式**：插件路由用 `request.user`（ST 的 `setUserDataMiddleware` 设置）区分用户，A 看不到、也删不掉 B 的账号。反代不看 ST 用户，只看密码——密码本身是 32 字节随机值，谁拿到密码谁能用，和 ST 里其他反向代理密码一个道理。
一个限制：pi-ai 的回调端口 53692 是进程级独占的，所以**同一时刻整个服务器只能有一个人在登录**，其他人会看到「其他用户正在登录」。

## 环境变量

| 变量 | 默认 | 用途 |
|---|---|---|
| `CLAUDE_OAUTH_PROXY_PORT` | `45277` | 反代端口 |
| `CLAUDE_OAUTH_PROXY_HOST` | `127.0.0.1` | 反代监听地址 |
| `CLAUDE_OAUTH_MAX_BODY_BYTES` | `134217728` (128 MB) | `/messages` 请求体上限 |
| `CLAUDE_OAUTH_ANTHROPIC_BASE_URL` | `https://api.anthropic.com/v1` | upstream 地址（自检/网关用） |
| `CLAUDE_OAUTH_CLI_VERSION` | `2.1.251` | 伪装成哪个 `claude-cli` 版本 |
| `CLAUDE_OAUTH_LOGIN_TIMEOUT_MS` | `900000` | 等待粘贴授权码的超时 |
| `PI_OAUTH_CALLBACK_HOST` | `127.0.0.1` | pi-ai 读的回调监听地址（端口 53692 写死） |

## 自检

不需要真账号、不联网（pi-ai 的 token 交换请求被本地 stub 掉），用一个假 Anthropic 端点跑真实插件代码：

```bash
npm test        # 或 node test/smoke.mjs
```

覆盖：beta 头合并与剥离、路径归一化、Claude Code 身份块注入（含幂等、`cache_control` 保留）、代理密码→账号解析（401、跨账号路由）、反代透传与 SSE 流、`x-api-key` 剥离、插件路由与跨用户隔离、粘贴回调 URL 的交接（含 PKCE verifier 与 state 校验、成功后建账号、重登保留密码）、每账号 refresh 单飞与轮换持久化、登录取消与互斥。当前 pi-ai **0.86.1** 下 70/70 通过。

## 已知限制

- **pi-ai 入口**：走的是 pi-ai 文档化的 `anthropicProvider().auth.oauth`（`@earendil-works/pi-ai/providers/anthropic`，0.80.8 起的规范入口；`./oauth` 子路径只剩类型）。这个接口 `login({signal, notify, prompt})` / `refresh(credential, signal)` 变了插件才会坏，升级 pi-ai 后跑一次 `npm test` 即可确认。
- **回调端口写死 53692**（只有监听地址能用 `PI_OAUTH_CALLBACK_HOST` 改），所以 Docker/远程场景必须用粘贴 URL 的方式，或者把 53692 映射出来。
- **不要用 pi-ai 的 anthropic provider 转发请求**：它会把 pi 的 `Context` 重新序列化成 Anthropic 参数，而 SillyTavern 发过来的本来就是 Anthropic 原生格式，来回转换会丢 stop sequences / thinking / tools 细节。本插件只用它的 OAuth 模块。
- pi-ai 官方要求 Node ≥ 22.19（插件自身代码在 Node 20.6+ 可跑，因为它用到了 `import.meta.resolve`）。
- SillyTavern 的 Claude 模型下拉框是硬编码的；新模型出来需要等 ST 更新，或扩展里自己注入选项。
- 依赖体积：`npm install @earendil-works/pi-ai` 会一并装 aws-sdk / openai / google-genai 等（因为它在 `dependencies` 里）。想瘦身可以用 esbuild 只打 `oauth` 路径成单文件并 `--external:node:*`（本仓库未内置该流程，因为装依赖的方式最不容易出错）。

## 排错

| 现象 | 原因 |
|---|---|
| `无法连接插件` | `enableServerPlugins: true` 没开，或没重启 |
| `Claude account "x" has no credentials` | 该账号凭据文件损坏或被删，点「重登」 |
| `This authentication style is incompatible with the long context beta header` | 请求没走插件反代（确认来源 = Claude，反向代理 = `http://127.0.0.1:45277/v1`） |
| 授权后浏览器报「无法访问 localhost:53692」 | Docker/远程的正常现象，粘贴完整 URL 即可 |
| 反代返回 401 `Unknown Claude OAuth proxy password` | ST 里的代理密码不属于任何账号（账号被删过？）；在面板里对某个账号点「使用」 |
| 「使用」后刷新页面就失效 | 检查 API 设置里代理预设下拉是否选中 `claude-oauth/<账号名>`；预设是 ST 自己保存的 |
| 「其他用户正在登录」 | 回调端口 53692 进程级独占，等对方完成或超时（默认 15 分钟） |
| `Claude OAuth token refresh failed: invalid_grant` | refresh token 失效（换过密码/账号被风控/并发刷新过），重新登录 |
| 登录成功但请求 400/403 | 账号没有开启 extra usage，或该账号被限制第三方 harness |
| `EADDRINUSE` 45277 | 换个 `CLAUDE_OAUTH_PROXY_PORT`，并同步改反向代理 URL |
