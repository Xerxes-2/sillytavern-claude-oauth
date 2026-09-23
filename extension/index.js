/**
 * UI companion for the "claude-oauth" server plugin.
 *
 * All network work (PKCE login, token storage, refresh, the Anthropic proxy)
 * lives in the server plugin; this file lists the current ST user's Claude
 * accounts, drives the login handoff and wires SillyTavern's Claude source to
 * the plugin's loopback reverse proxy via ST's own proxy presets.
 */
import { extension_settings } from '../../../../extensions.js';
import { getRequestHeaders } from '../../../../../script.js';
import { oai_settings } from '../../../../openai.js';
import { Popup } from '../../../../popup.js';

const PLUGIN_ID = 'claude-oauth';
const PLUGIN_API = `/api/plugins/${PLUGIN_ID}`;
const MODULE = 'claude_oauth_controls';
/** ST reverse-proxy presets managed by this extension are named `claude-oauth/<account>`. */
const PRESET_PREFIX = 'claude-oauth/';

const defaultSettings = { autoConfigure: true };

/** Last /status payload; the account table and "configured" checks are derived from it. */
let lastStatus = null;

function settings() {
	extension_settings[MODULE] = Object.assign({}, defaultSettings, extension_settings[MODULE] || {});
	return extension_settings[MODULE];
}

function escapeHtml(value) {
	return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
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

/** Which of our accounts is ST's Claude source currently pointed at, if any. */
function activeAccountName() {
	if (!lastStatus || oai_settings.chat_completion_source !== 'claude') return null;
	if (oai_settings.reverse_proxy !== lastStatus.proxyUrl) return null;
	return lastStatus.accounts.find((a) => a.secret === oai_settings.proxy_password)?.name ?? null;
}

function describeAccount(account) {
	if (!account.loggedIn) return '未登录';
	const minutes = Math.round((account.expiresIn || 0) / 60000);
	return minutes > 0 ? `已登录，token ${minutes} 分钟后刷新` : '已登录，token 待刷新';
}

function formatReset(resetsAt) {
	if (!resetsAt) return '';
	const minutes = Math.max(0, Math.round((resetsAt - Date.now()) / 60000));
	if (minutes < 60) return `${minutes} 分钟后重置`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours} 小时 ${minutes % 60} 分后重置`;
	return `${Math.round(hours / 24)} 天后重置`;
}

/**
 * Friendly labels for the quota buckets Anthropic reports. Anything not listed
 * (per-model weekly buckets whose header names are undocumented) is shown
 * under its raw name so it is still visible.
 */
const BUCKET_LABELS = {
	'5h': '5小时',
	'7d': '7天',
	'overage': '额外用量',
	'7d-opus': 'Opus周',
	'7d-sonnet': 'Sonnet周',
	'7d-overage-included': 'Fable周',
};
const BUCKET_ORDER = ['5h', '7d', '7d-overage-included', '7d-opus', '7d-sonnet', 'overage'];
const CLAIM_LABELS = {
	five_hour: '5小时',
	seven_day: '7天',
	seven_day_opus: 'Opus周',
	seven_day_sonnet: 'Sonnet周',
	seven_day_overage_included: 'Fable周',
	overage: '额外用量',
};

/** One quota chip, coloured by how close the bucket is to full. */
function usageChip(bucket, window) {
	const pct = Math.round(window.utilization * 100);
	const kind = pct >= 100 ? 'error' : pct >= 80 ? 'warn' : 'ok';
	const label = BUCKET_LABELS[bucket] ?? bucket;
	return `<span class="claude-oauth-usage" data-kind="${kind}" title="${escapeHtml(`${bucket}: ${formatReset(window.resetsAt)}`)}">${escapeHtml(label)} ${pct}%</span>`;
}

/** Quota line for an account; empty until the account has served a request since restart. */
function renderUsage(usage) {
	if (!usage) return '<small class="claude-oauth-usage-none">额度：发送一条消息后显示</small>';
	const names = Object.keys(usage.buckets ?? {}).sort((a, b) => {
		const ia = BUCKET_ORDER.indexOf(a);
		const ib = BUCKET_ORDER.indexOf(b);
		return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
	});
	const chips = names.map((name) => usageChip(name, usage.buckets[name]));
	if (usage.status === 'rejected') {
		const which = usage.limitedBy ? (CLAIM_LABELS[usage.limitedBy] ?? usage.limitedBy) : '';
		const reset = formatReset(usage.resetsAt ?? usage.buckets?.['5h']?.resetsAt ?? usage.buckets?.['7d']?.resetsAt);
		chips.push(`<span class="claude-oauth-usage" data-kind="error">已限流${which ? `（${escapeHtml(which)}）` : ''}${reset ? `，${escapeHtml(reset)}` : ''}</span>`);
	}
	const age = Math.round((Date.now() - usage.observedAt) / 60000);
	return `<small>额度：${chips.join(' ')} <span class="claude-oauth-usage-age">${age < 1 ? '刚刚' : `${age} 分钟前`}</span></small>`;
}

function renderAccounts() {
	const table = document.getElementById('claude_oauth_accounts');
	if (!table || !lastStatus) return;
	const active = activeAccountName();
	if (lastStatus.accounts.length === 0) {
		table.innerHTML = '<div class="claude-oauth-empty">还没有账号。在下面输入一个名字并登录。</div>';
		return;
	}
	table.innerHTML = lastStatus.accounts.map((account) => {
		const name = escapeHtml(account.name);
		const isActive = account.name === active;
		return `
			<div class="claude-oauth-account${isActive ? ' active' : ''}" data-name="${name}">
				<div class="claude-oauth-account-info">
					<b>${name}</b>${isActive ? ' <span class="claude-oauth-badge">当前来源</span>' : ''}
					<small>${escapeHtml(describeAccount(account))}</small>
					${renderUsage(account.usage)}
				</div>
				<div class="claude-oauth-account-actions">
					<div class="menu_button" data-action="use" title="把 Claude 来源指向这个账号">使用</div>
					<div class="menu_button" data-action="verify" title="用 token 请求 /v1/models">验证</div>
					<div class="menu_button" data-action="relogin" title="重新授权，保留代理密码">重登</div>
					<div class="menu_button" data-action="secret" title="复制代理密码（手动配置用）">密码</div>
					<div class="menu_button" data-action="delete" title="删除账号和本地凭据">删除</div>
				</div>
			</div>`;
	}).join('');
}

function renderStatus(payload) {
	lastStatus = payload;
	const parts = [`${payload.accounts.length} 个账号`, `代理: ${payload.proxyUrl}`];
	const active = activeAccountName();
	if (active) {
		parts.push(`Claude 来源 → ${active}`);
	} else if (payload.accounts.some((a) => a.loggedIn)) {
		parts.push('Claude 来源尚未指向任何账号');
	}
	if (payload.login?.pending) {
		parts.push(`正在登录 ${payload.login.name}`);
		showPasteBox(payload.login.authUrl, payload.login.name);
	} else if (payload.login?.busy) {
		parts.push('其他用户正在登录（回调端口独占）');
	}
	setStatus(parts.join(' · '), active ? 'ok' : 'warn');
	renderAccounts();
}

async function refreshStatus() {
	try {
		renderStatus(await pluginFetch('/status'));
	} catch (error) {
		setStatus(`无法连接插件: ${error.message}（确认 enableServerPlugins: true 并已重启 SillyTavern）`, 'error');
	}
}

function showPasteBox(authUrl, name) {
	const box = document.getElementById('claude_oauth_paste_box');
	if (box) box.style.display = '';
	const link = document.getElementById('claude_oauth_auth_link');
	if (link) link.href = authUrl;
	const label = document.getElementById('claude_oauth_paste_name');
	if (label) label.textContent = name;
}

function hidePasteBox() {
	const box = document.getElementById('claude_oauth_paste_box');
	if (box) box.style.display = 'none';
	const input = document.getElementById('claude_oauth_code_input');
	if (input) input.value = '';
}

async function login(name) {
	try {
		setStatus(`正在为 ${name} 生成授权链接...`);
		const payload = await pluginFetch('/login', { method: 'POST', body: { name } });
		if (!payload.authUrl) throw new Error('插件没有返回授权地址');
		window.open(payload.authUrl, '_blank');
		showPasteBox(payload.authUrl, name);
		setStatus(`已打开授权页面（账号 ${name}）。登录后把浏览器地址栏里的完整 URL 粘到下面。`);
	} catch (error) {
		setStatus(`登录失败: ${error.message}`, 'error');
	}
}

async function addAccount() {
	const input = document.getElementById('claude_oauth_new_name');
	const name = String(input?.value || '').trim();
	if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(name)) {
		setStatus('账号名 1-32 位，只能用字母、数字、"-"、"_"。', 'warn');
		return;
	}
	await login(name);
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
		hidePasteBox();
		const nameInput = document.getElementById('claude_oauth_new_name');
		if (nameInput) nameInput.value = '';
		await refreshStatus();
		if (settings().autoConfigure && !activeAccountName()) {
			useAccount(payload.name);
		} else {
			setStatus(`账号 ${payload.name} 登录成功。`, 'ok');
		}
	} catch (error) {
		setStatus(`登录失败: ${error.message}`, 'error');
	}
}

async function cancelLogin() {
	try {
		await pluginFetch('/login/cancel', { method: 'POST', body: {} });
		hidePasteBox();
		await refreshStatus();
	} catch (error) {
		setStatus(`取消失败: ${error.message}`, 'error');
	}
}

async function verify(name) {
	try {
		setStatus(`正在用 ${name} 的 token 请求 /v1/models ...`);
		const payload = await pluginFetch(`/accounts/${encodeURIComponent(name)}/verify`);
		setStatus(payload.ok ? `${name}: token 可用（HTTP ${payload.status}）` : `${name}: token 不可用（HTTP ${payload.status}）: ${String(payload.body).slice(0, 200)}`, payload.ok ? 'ok' : 'error');
	} catch (error) {
		setStatus(`验证失败: ${error.message}`, 'error');
	}
}

async function removeAccount(name) {
	const confirmed = await Popup.show.confirm('删除 Claude 账号', `删除账号 "${name}" 及其本地凭据？ST 里对应的代理预设不会自动删除。`);
	if (!confirmed) return;
	try {
		await pluginFetch(`/accounts/${encodeURIComponent(name)}`, { method: 'DELETE' });
		await refreshStatus();
		setStatus(`已删除账号 ${name}。`, 'ok');
	} catch (error) {
		setStatus(`删除失败: ${error.message}`, 'error');
	}
}

async function copySecret(name) {
	const account = lastStatus?.accounts.find((a) => a.name === name);
	if (!account) return;
	try {
		await navigator.clipboard.writeText(account.secret);
		setStatus(`已复制 ${name} 的代理密码。手动配置：反向代理 = ${lastStatus.proxyUrl}，密码 = 剪贴板内容。`, 'ok');
	} catch {
		await Popup.show.text(`${name} 的代理密码`, `<code>${escapeHtml(account.secret)}</code><br><br>反向代理 URL：<code>${escapeHtml(lastStatus.proxyUrl)}</code>`);
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
		const account = lastStatus?.accounts.find((a) => a.name === name);
		if (!account || !lastStatus.proxyUrl) throw new Error('拿不到账号信息，先点一次"刷新"');

		if ($('#main_api').val() !== 'openai') {
			$('#main_api').val('openai').trigger('change');
		}
		if ($('#chat_completion_source').val() !== 'claude') {
			$('#chat_completion_source').val('claude').trigger('change');
		}

		$('#openai_reverse_proxy_name').val(`${PRESET_PREFIX}${name}`);
		$('#openai_reverse_proxy').val(lastStatus.proxyUrl).trigger('input');
		$('#openai_proxy_access_key').val(account.secret).trigger('input');
		$('#save_proxy').trigger('click');

		if (activeAccountName() !== name) {
			throw new Error('SillyTavern 没有接受代理设置（界面结构可能已变化），请手动填写反向代理 URL 和密码。');
		}
		renderAccounts();
		setStatus(`Claude 来源已指向账号 ${name}（代理预设 "${PRESET_PREFIX}${name}"）。`, 'ok');
	} catch (error) {
		setStatus(`配置失败: ${error.message}`, 'error');
	}
}

function onAccountAction(event) {
	const button = event.target.closest('[data-action]');
	if (!button) return;
	const name = button.closest('[data-name]')?.dataset.name;
	if (!name) return;
	switch (button.dataset.action) {
		case 'use': return useAccount(name);
		case 'verify': return verify(name);
		case 'relogin': return login(name);
		case 'secret': return copySecret(name);
		case 'delete': return removeAccount(name);
		default: return undefined;
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
					<div id="claude_oauth_accounts" class="claude-oauth-accounts"></div>
					<div class="claude-oauth-add">
						<input id="claude_oauth_new_name" class="text_pole" type="text" placeholder="新账号名，如 work" maxlength="32" />
						<div id="claude_oauth_add" class="menu_button">用 Claude 订阅登录</div>
						<div id="claude_oauth_check" class="menu_button">刷新</div>
					</div>
					<label class="checkbox_label" for="claude_oauth_autoconfigure">
						<input id="claude_oauth_autoconfigure" type="checkbox" />
						<span>首个账号登录成功后自动设为 Claude 来源</span>
					</label>
					<small>
						每个账号对应一个 ST 代理预设 <code>claude-oauth/&lt;账号名&gt;</code>，之后可直接在 API 设置的代理预设下拉里切换。
						手动配置：API = Chat Completion，来源 = Claude，反向代理 = 上面的代理地址，密码 = 该账号的代理密码。
					</small>
					<div id="claude_oauth_paste_box" class="claude-oauth-paste" style="display:none">
						<small>
							正在登录账号 <b id="claude_oauth_paste_name"></b>。浏览器跳到 <code>localhost:53692</code> 会报"无法访问"（Docker/远程正常现象）。
							把地址栏里那条完整 URL 复制过来；如果已经把 53692 端口映射到容器，回调页会自己完成，不用粘贴。
						</small>
						<a id="claude_oauth_auth_link" href="#" target="_blank" rel="noopener">重新打开授权页面</a>
						<textarea id="claude_oauth_code_input" rows="3" placeholder="http://localhost:53692/callback?code=...&state=..."></textarea>
						<div class="claude-oauth-buttons">
							<div id="claude_oauth_submit" class="menu_button">提交授权码</div>
							<div id="claude_oauth_cancel" class="menu_button">取消登录</div>
						</div>
					</div>
				</div>
			</div>
		</div>`;
	container.insertAdjacentHTML('beforeend', html);

	const autoconfigure = document.getElementById('claude_oauth_autoconfigure');
	autoconfigure.checked = settings().autoConfigure;
	autoconfigure.addEventListener('change', () => {
		settings().autoConfigure = autoconfigure.checked;
	});

	document.getElementById('claude_oauth_accounts').addEventListener('click', onAccountAction);
	document.getElementById('claude_oauth_add').addEventListener('click', addAccount);
	document.getElementById('claude_oauth_new_name').addEventListener('keydown', (event) => {
		if (event.key === 'Enter') addAccount();
	});
	document.getElementById('claude_oauth_check').addEventListener('click', refreshStatus);
	document.getElementById('claude_oauth_submit').addEventListener('click', submitCode);
	document.getElementById('claude_oauth_cancel').addEventListener('click', cancelLogin);

	// Re-render the "current source" badge when the user switches proxy preset / source in ST.
	$(document).on('change', '#openai_proxy_preset, #chat_completion_source, #main_api', () => renderAccounts());
}

jQuery(async () => {
	settings();
	buildPanel();
	await refreshStatus();
});
