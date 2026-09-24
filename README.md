# SillyTavern Claude OAuth（订阅登录）插件

[English](README.en.md) · **简体中文**

用 Claude Pro/Max 订阅登录 SillyTavern 内置的 **Claude** 来源，不需要 Anthropic API key，也不需要装 `claude` CLI。

- 零依赖：`git clone` 完就能用，不用 `npm install`。
- 多账号：每个 ST 用户可以登录多个 Claude 账号，在代理预设下拉里切换。
- 面板里直接显示 5 小时 / 7 天额度。

> ⚠️ **风险先读**：订阅 OAuth 在第三方客户端里走的是 **extra usage、按 token 计费**，不占套餐额度；Anthropic 此前也限制过这类用法。账号风险自负，建议用小号。

## 安装

### 1. 服务端插件（必需）

```bash
cd /path/to/SillyTavern/plugins
git clone https://github.com/Xerxes-2/sillytavern-claude-oauth claude-oauth
```

在 SillyTavern 的 `config.yaml` 里打开：

```yaml
enableServerPlugins: true
```

重启 SillyTavern，日志里出现这行就说明装好了：

```text
[claude-oauth] Reverse proxy URL for SillyTavern: http://127.0.0.1:45277/v1
```

### 2. 界面扩展（强烈建议）

「扩展」→「安装扩展」，粘贴 `https://github.com/Xerxes-2/sillytavern-claude-oauth`。装好后扩展面板里会出现 **Claude OAuth（订阅登录）**。

面板只是个界面，第 1 步的服务端插件仍然要装，否则面板会提示无法连接插件。

## 使用

1. 在面板里输入一个账号名（如 `main`），点 **用 Claude 订阅登录**，浏览器会打开 claude.ai 授权页。
2. 授权后浏览器会跳到 `http://localhost:53692/callback?...`：
   - **本机运行**：页面会直接显示成功。
   - **Docker / 远程服务器**：这个页面打不开是正常的。把地址栏里的**完整 URL** 复制下来，粘到面板输入框，点「提交授权码」。（也可以把 53692 端口映射出来，就不用粘贴了。）
3. 第一个账号登录后会自动设为 Claude 来源。之后每个账号一行，点 **使用** 切换；也可以直接在 API 设置的代理预设下拉里选 `claude-oauth/<账号名>`。
4. 点 **验证** 确认连通，然后正常聊天。

其他操作：**重登** 重新授权但不改代理密码（ST 里的预设不用动）；**删除** 移除账号及本地凭据。

<details>
<summary>不用面板，手动配置</summary>

- API = Chat Completion，来源 = Claude
- 反向代理 = `http://127.0.0.1:45277/v1`
- 密码 = 该账号的代理密码（面板里点「密码」复制）

密码错了会返回 401。
</details>

## 额度显示

面板里每个账号显示最近一次回复带回的额度，如「5小时 34% · 7天 61%」：≥80% 变黄，被限流变红并显示哪个额度、多久重置。鼠标悬停可以看到精确百分比和重置时刻。

额度只在聊天时顺带更新，插件不会额外发请求。看到不认识的额度名（显示原始名字）欢迎开 issue。

## 排错

| 现象 | 解决 |
|---|---|
| 面板提示「无法连接插件」 | `config.yaml` 没开 `enableServerPlugins: true`，或没重启 ST |
| 授权后浏览器「无法访问 localhost:53692」 | Docker/远程的正常现象，把完整 URL 粘到面板里 |
| 「其他用户正在登录」 | 同一时刻整个服务器只能有一个人在登录，等对方完成或超时（15 分钟） |
| `This authentication style is incompatible with the long context beta header` | 请求没走插件：确认来源 = Claude，反向代理 = `http://127.0.0.1:45277/v1` |
| 401 `Unknown Claude OAuth proxy password` | ST 里的密码不属于任何账号（账号被删过？），在面板里对某个账号点「使用」 |
| 刷新页面后切换失效 | 检查 API 设置的代理预设下拉是否选中 `claude-oauth/<账号名>` |
| `Claude account "x" has no credentials` | 凭据文件损坏或被删，点「重登」 |
| `token refresh failed: invalid_grant` | 登录失效（改过密码、被风控等），重新登录 |
| 登录成功但请求 400/403 | 账号没开 extra usage，或被限制使用第三方客户端 |
| 启动报 `EADDRINUSE` 45277 | 用 `CLAUDE_OAUTH_PROXY_PORT` 换个端口，反向代理地址同步改 |

## 已知限制

- 登录回调端口固定为 **53692**，同一时刻整个服务器只能有一人在登录。
- ST 的 Claude 模型下拉是写死的，新模型要等 ST 更新。
- 界面目前只有简体中文和英文。
- 需要 Node ≥ 20.6。

## 配置

一般不用改。需要时通过环境变量设置：

| 变量 | 默认 | 用途 |
|---|---|---|
| `CLAUDE_OAUTH_PROXY_PORT` | `45277` | 反代端口 |
| `CLAUDE_OAUTH_PROXY_HOST` | `127.0.0.1` | 反代监听地址。**改成 `0.0.0.0` 会把你的订阅暴露给整个网络**，别动 |
| `CLAUDE_OAUTH_LOGIN_TIMEOUT_MS` | `900000` | 等待粘贴授权码的超时 |
| `CLAUDE_OAUTH_CLI_VERSION` | `2.1.281` | 伪装的 `claude-cli` 版本 |
| `PI_OAUTH_CALLBACK_HOST` | `127.0.0.1` | 登录回调监听地址 |

完整列表见 [`lib/config.mjs`](lib/config.mjs)。

账号凭据保存在 `<SillyTavern>/data/<用户>/claude-oauth/accounts/`，重装插件不会丢，ST 的用户备份也会带上。

## 致谢

认证流程来自 [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai)。

## 许可

[MIT](LICENSE)
