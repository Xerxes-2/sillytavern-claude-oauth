/**
 * UI companion for the "claude-oauth" server plugin.
 *
 * All network work (PKCE login, token storage, refresh, the Anthropic proxy)
 * lives in the server plugin; this file only drives the login handoff and
 * wires SillyTavern's Claude source to the plugin's loopback reverse proxy.
 */
import { extension_settings } from '../../../extensions.js';
import { getRequestHeaders } from '../../../../script.js';
import { oai_settings } from '../../../openai.js';

const PLUGIN_ID = 'claude-oauth';
const PLUGIN_API = `/api/plugins/${PLUGIN_ID}`;
const MODULE = 'claude_oauth_controls';
/** Name of the ST reverse-proxy preset this extension manages. */
const PROXY_PRESET_NAME = 'claude-oauth';

const defaultSettings = { autoConfigure: true, proxyUrl: '', proxySecret: '' };

function settings() {
	extension_settings[MODULE] = Object.assign({}, defaultSettings, extension_settings[MODULE] || {});
	return extension_settings[MODULE];
}

function setStatus(text, kind = 'info') {
	const el = document.getElementById('claude_oauth_status');
	if (!el) return;
	el.textContent = text;
	el.dataset.kind = kind;
}

async function pluginFetch(path, options = {}) {
	const response = await fetch(`${PLUGIN_API}${path}`, {
		method: options.method || 'GET',
		headers: getRequestHeaders(),
		body: options.body ? JSON.stringify(options.body) : undefined,
	});
	const text = await response.text();
	let payload;
	try {
		payload = text ? JSON.parse(text) : {};
	} catch {
		payload = { error: text };
	}
	if (!response.ok) {
		throw new Error(payload?.error || `${response.status} ${response.statusText}`);
	}
	return payload;
}

function renderStatus(payload) {
	const parts = [];
	if (payload.proxyUrl) {
		settings().proxyUrl = payload.proxyUrl;
	}
	if (payload.proxySecret) {
		settings().proxySecret = payload.proxySecret;
	}
	if (!payload.credentials?.loggedIn) {
		parts.push('未登录');
	} else {
		const minutes = Math.round((payload.credentials.expiresIn || 0) / 60000);
		parts.push(`已登录（access token ${minutes > 0 ? `${minutes} 分钟后过期` : '已过期，将自动刷新'}）`);
	}
	if (payload.login?.pending) {
		parts.push('登录进行中');
	}
	parts.push(`代理: ${payload.proxyUrl}`);
	if (isConfigured()) {
		parts.push('Claude 来源已指向代理');
	} else if (payload.credentials?.loggedIn) {
		parts.push('尚未配置为 Claude 来源');
	}
	setStatus(parts.join(' · '), payload.credentials?.loggedIn ? 'ok' : 'warn');
	return payload;
}

async function refreshStatus() {
	try {
		renderStatus(await pluginFetch('/status'));
	} catch (error) {
		setStatus(`无法连接插件: ${error.message}（确认 enableServerPlugins: true 并已重启 SillyTavern）`, 'error');
	}
}

function showPasteBox(authUrl) {
	const box = document.getElementById('claude_oauth_paste_box');
	if (box) box.style.display = '';
	const link = document.getElementById('claude_oauth_auth_link');
	if (link) link.href = authUrl;
}

async function login() {
	try {
		setStatus('正在生成授权链接...');
		const payload = await pluginFetch('/login', { method: 'POST', body: {} });
		if (!payload.authUrl) throw new Error('插件没有返回授权地址');
		window.open(payload.authUrl, '_blank');
		showPasteBox(payload.authUrl);
		setStatus('已打开授权页面。登录后把浏览器地址栏里的完整 URL 粘到下面。');
	} catch (error) {
		setStatus(`登录失败: ${error.message}`, 'error');
	}
}

async function submitCode() {
	const input = document.getElementById('claude_oauth_code_input');
	const value = String(input?.value || '').trim();
	if (!value) {
		setStatus('请先粘贴授权后的完整回调 URL 或 code。', 'warn');
		return;
	}
	try {
		setStatus('正在用授权码换取 token...');
		const payload = await pluginFetch('/login/code', { method: 'POST', body: { code: value } });
		if (!payload.ok) throw new Error(payload.error || '交换 token 失败');
		if (input) input.value = '';
		const box = document.getElementById('claude_oauth_paste_box');
		if (box) box.style.display = 'none';
		setStatus('登录成功，凭据已保存。', 'ok');
		await refreshStatus();
	} catch (error) {
		setStatus(`登录失败: ${error.message}`, 'error');
	}
}

async function verify() {
	try {
		setStatus('正在用当前 token 请求 /v1/models ...');
		const payload = await pluginFetch('/verify');
		setStatus(payload.ok ? `Token 可用（HTTP ${payload.status}）` : `Token 不可用（HTTP ${payload.status}）: ${String(payload.body).slice(0, 200)}`, payload.ok ? 'ok' : 'error');
	} catch (error) {
		setStatus(`验证失败: ${error.message}`, 'error');
	}
}

async function logout() {
	try {
		await pluginFetch('/logout', { method: 'POST', body: {} });
		setStatus('已登出，本地凭据已删除。', 'ok');
	} catch (error) {
		setStatus(`登出失败: ${error.message}`, 'error');
	}
}

function isConfigured() {
	const { proxyUrl, proxySecret } = settings();
	return Boolean(proxyUrl)
		&& oai_settings.chat_completion_source === 'claude'
		&& oai_settings.reverse_proxy === proxyUrl
		&& oai_settings.proxy_password === proxySecret;
}

/**
 * Point ST's Claude source at the plugin proxy.
 *
 * Writing `oai_settings.reverse_proxy` directly does not survive a reload: on
 * load ST re-applies the selected *proxy preset* over those fields. So this
 * goes through the same UI path as a user saving a preset ("Save Proxy"),
 * which persists it in `proxies[]` / `selected_proxy`.
 */
function autoConfigure() {
	try {
		const { proxyUrl, proxySecret } = settings();
		if (!proxyUrl || !proxySecret) throw new Error('拿不到代理地址，先点一次"检查状态"');

		if ($('#main_api').val() !== 'openai') {
			$('#main_api').val('openai').trigger('change');
		}
		if ($('#chat_completion_source').val() !== 'claude') {
			$('#chat_completion_source').val('claude').trigger('change');
		}

		$('#openai_reverse_proxy_name').val(PROXY_PRESET_NAME);
		$('#openai_reverse_proxy').val(proxyUrl).trigger('input');
		$('#openai_proxy_access_key').val(proxySecret).trigger('input');
		$('#save_proxy').trigger('click');

		if (!isConfigured()) {
			throw new Error('SillyTavern 没有接受代理设置（界面结构可能已变化），请手动填写反向代理 URL 和密码。');
		}
		setStatus(`已把 Claude 来源指向 ${proxyUrl}（代理预设 "${PROXY_PRESET_NAME}"）。`, 'ok');
	} catch (error) {
		setStatus(`自动配置失败: ${error.message}`, 'error');
	}
}

function buildPanel() {
	const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
	if (!container) return;
	const html = `
		<div class="claude-oauth-settings">
			<div class="inline-drawer">
				<div class="inline-drawer-toggle inline-drawer-header">
					<b>Claude OAuth（订阅登录）</b>
					<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
				</div>
				<div class="inline-drawer-content">
					<div id="claude_oauth_status" class="claude-oauth-status">未检查</div>
					<div class="claude-oauth-buttons">
						<div id="claude_oauth_login" class="menu_button">使用 Claude 订阅登录</div>
						<div id="claude_oauth_check" class="menu_button">检查状态</div>
						<div id="claude_oauth_verify" class="menu_button">验证 Token</div>
						<div id="claude_oauth_logout" class="menu_button">登出</div>
						<div id="claude_oauth_autoconfig" class="menu_button">自动配置为 Claude 来源</div>
					</div>
					<small>
						手动配置：API = Chat Completion，来源 = Claude，反向代理 = 上面的代理地址，密码 = 插件生成的 proxySecret（见 <code>/api/plugins/claude-oauth/status</code>）。
					</small>
					<div id="claude_oauth_paste_box" class="claude-oauth-paste" style="display:none">
						<small>
							浏览器跳到 <code>localhost:53692</code> 会报"无法访问"（Docker/远程正常现象）。
							把地址栏里那条完整 URL 复制过来；如果已经把 53692 端口映射到容器，回调页会自己完成，不用粘贴。
						</small>
						<a id="claude_oauth_auth_link" href="#" target="_blank" rel="noopener">重新打开授权页面</a>
						<textarea id="claude_oauth_code_input" rows="3" placeholder="http://localhost:53692/callback?code=...&state=..."></textarea>
						<div id="claude_oauth_submit" class="menu_button">提交授权码</div>
					</div>
				</div>
			</div>
		</div>`;
	container.insertAdjacentHTML('beforeend', html);

	document.getElementById('claude_oauth_login').addEventListener('click', login);
	document.getElementById('claude_oauth_check').addEventListener('click', refreshStatus);
	document.getElementById('claude_oauth_verify').addEventListener('click', verify);
	document.getElementById('claude_oauth_logout').addEventListener('click', logout);
	document.getElementById('claude_oauth_submit').addEventListener('click', submitCode);
	document.getElementById('claude_oauth_autoconfig').addEventListener('click', autoConfigure);
}

jQuery(async () => {
	settings();
	buildPanel();
	await refreshStatus();
});
