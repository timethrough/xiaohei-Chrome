const UI_KEY = 'browserops-v2-ui-state';
const defaultProfiles = () => [
  { id: 'env-001', number: 1, name: '1', browser: 'Google Chrome', language: 'zh-CN', proxy: 'Direct', tag: '主控', os: 'Windows', location: 'Local' },
  { id: 'env-002', number: 2, name: '2', browser: 'Google Chrome', language: 'en-US', proxy: 'Direct', tag: '工作组', os: 'Windows', location: 'Local' },
  { id: 'env-003', number: 3, name: '3', browser: 'Google Chrome', language: 'en-US', proxy: 'Direct', tag: '工作组', os: 'Windows', location: 'Local' },
  { id: 'env-004', number: 4, name: '4', browser: 'Google Chrome', language: 'en-US', proxy: '127.0.0.1:7890', tag: '代理', os: 'Windows', location: 'Local' }
];

function positiveProfileNumber(value) {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function normalizeProfileSettings(profile) {
  const value = profile && typeof profile === 'object' ? profile : {};
  const privacy = value.privacy && typeof value.privacy === 'object' ? value.privacy : {};
  const advanced = value.advanced && typeof value.advanced === 'object' ? value.advanced : {};
  const proxyMeta = value.proxyMeta && typeof value.proxyMeta === 'object' ? value.proxyMeta : {};
  const number = positiveProfileNumber(value.number);
  return {
    ...value,
    number,
    name: number ? String(number) : String(value.name || ''),
    browser: 'Google Chrome',
    os: String(value.os || 'Windows'),
    language: String(value.language || 'en-US'),
    userAgent: String(value.userAgent || ''),
    cookies: String(value.cookies || ''),
    note: String(value.note || ''),
    width: Number(value.width) >= 640 ? Number(value.width) : 1280,
    height: Number(value.height) >= 480 ? Number(value.height) : 820,
    proxyMeta: { ipChannel: String(proxyMeta.ipChannel || 'ip-api'), refreshUrl: String(proxyMeta.refreshUrl || '') },
    privacy: {
      webrtc: String(privacy.webrtc || 'proxy'), timezoneMode: String(privacy.timezoneMode || 'ip'), timezone: String(privacy.timezone || ''),
      geoMode: String(privacy.geoMode || 'ip'), latitude: privacy.latitude ?? '', longitude: privacy.longitude ?? '', accuracy: Number(privacy.accuracy) || 100,
      uiLanguage: String(privacy.uiLanguage || 'profile'), fontMode: String(privacy.fontMode || 'default'), fontSize: Number(privacy.fontSize) || 16,
      canvas: String(privacy.canvas || 'real'), webgl: String(privacy.webgl || 'real'), webgpu: String(privacy.webgpu || 'real'), audio: String(privacy.audio || 'real'),
      media: String(privacy.media || 'real'), clientRects: 'real', speech: String(privacy.speech || 'real'), dnt: Boolean(privacy.dnt)
    },
    advanced: {
      saveCookies: advanced.saveCookies !== false, savePasswords: Boolean(advanced.savePasswords), saveBookmarks: advanced.saveBookmarks !== false,
      saveLocalStorage: advanced.saveLocalStorage !== false, saveIndexedDB: advanced.saveIndexedDB !== false, saveHistory: advanced.saveHistory !== false,
      allowSignin: Boolean(advanced.allowSignin), restoreSession: Boolean(advanced.restoreSession), blockVideo: Boolean(advanced.blockVideo),
      blockImages: Boolean(advanced.blockImages), clearCacheOnStart: Boolean(advanced.clearCacheOnStart)
    }
  };
}

function profileRecordFromEngine(profile) {
  const value = profile && typeof profile === 'object' ? profile : {};
  const { running, pid, port, debuggerAddress, browserURL, executable, profileDirectory, extensionCount, loadedExtensions, assignedExtensions, cdpError, network, automation, ...record } = value;
  return normalizeProfileSettings(record);
}

function syncUiProfilesFromEngine() {
  ui.profiles = engineProfiles.map(profileRecordFromEngine);
  const maximum = ui.profiles.reduce((value, profile) => Math.max(value, positiveProfileNumber(profile.number)), 0);
  ui.nextProfileNumber = Math.max(positiveProfileNumber(ui.nextProfileNumber), maximum + 1, 1);
  save();
}

function loadUi() {
  try { const value = JSON.parse(localStorage.getItem(UI_KEY)); if (value && Array.isArray(value.profiles)) return value; } catch (_) {}
  return { profiles: defaultProfiles(), logs: [] };
}

function migrateProfileNumbers(profiles, savedNextNumber) {
  const used = new Set(); let cursor = 1;
  const migrated = profiles.map((profile) => {
    let number = positiveProfileNumber(profile?.number);
    if (!number || used.has(number)) { while (used.has(cursor)) cursor += 1; number = cursor; }
    used.add(number); cursor = Math.max(cursor, number + 1);
    return normalizeProfileSettings({ ...profile, number, name: String(number) });
  });
  const maximum = used.size ? Math.max(...used) : 0;
  return { profiles: migrated, nextProfileNumber: Math.max(positiveProfileNumber(savedNextNumber), maximum + 1, 1) };
}

const loadedUi = loadUi();
const migratedUi = migrateProfileNumbers(loadedUi.profiles, loadedUi.nextProfileNumber);
let ui = { ...loadedUi, ...migratedUi };
try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (_) {}

function displayProfileNumber(profile) {
  return String(positiveProfileNumber(profile?.number) || profile?.name || profile?.id || '');
}

function nextProfileNumber() {
  const maximum = ui.profiles.reduce((value, profile) => Math.max(value, positiveProfileNumber(profile.number)), 0);
  return Math.max(positiveProfileNumber(ui.nextProfileNumber), maximum + 1, 1);
}

function createInternalProfileId(number, usedIds = new Set(ui.profiles.map((profile) => profile.id))) {
  const base = 'env-' + String(number).padStart(3, '0'); if (!usedIds.has(base)) return base;
  let suffix = 2; while (usedIds.has(base + '-' + suffix)) suffix += 1; return base + '-' + suffix;
}

let engineProfiles = [];
let apiInfo = null;
let extensions = [];
let sessions = [];
let sessionsInitialized = false;
let preferredMasterId = null;
let syncHealth = { queueDepth: 0, coalesced: 0, dropped: 0, lastLatencyMs: 0, recovering: false };
let selectedProfiles = new Set();
let selectedSessions = new Set();
let currentExtension = null;
let syncState = { active: false, master: null, selected: [] };
const SYNC_SETTINGS_KEY = 'xiaohei-sync-settings-v13';
const DEFAULT_SYNC_SETTINGS = Object.freeze({ keyboard: true, click: true, scroll: true, track: true, delayClick: false, delayInput: false, inputMinMs: 300, inputMaxMs: 300, clickMinMs: 100, clickMaxMs: 300 });
function normalizeSyncSettings(value = {}) {
  const number = (name, fallback) => Math.max(0, Math.min(5000, Number(value[name] ?? fallback) || 0));
  const result = { ...DEFAULT_SYNC_SETTINGS, ...value };
  for (const name of ['keyboard', 'click', 'scroll', 'track', 'delayClick', 'delayInput']) result[name] = value[name] === undefined ? DEFAULT_SYNC_SETTINGS[name] : value[name] !== false;
  result.inputMinMs = number('inputMinMs', 300); result.inputMaxMs = Math.max(result.inputMinMs, number('inputMaxMs', result.inputMinMs));
  result.clickMinMs = number('clickMinMs', 100); result.clickMaxMs = Math.max(result.clickMinMs, number('clickMaxMs', result.clickMinMs));
  return result;
}
let syncSettings = (() => { try { return normalizeSyncSettings(JSON.parse(localStorage.getItem(SYNC_SETTINGS_KEY) || '{}')); } catch (_) { return { ...DEFAULT_SYNC_SETTINGS }; } })();
let pendingDeleteProfiles = [];
let editingProfileId = null;
let editorNetworkResult = null;
let toastTimer = null;
const PROFILE_PAGE_SIZES = [10, 20, 50, 100];
const PROFILE_PAGE_SIZE_KEY = 'xiaohei-profile-page-size-v1';
let profilePage = 1;
let profilePageSize = 10;
try {
  const savedProfilePageSize = Number(localStorage.getItem(PROFILE_PAGE_SIZE_KEY));
  if (PROFILE_PAGE_SIZES.includes(savedProfilePageSize)) profilePageSize = savedProfilePageSize;
} catch (_) {}

const SPECIFIED_TEXT_GROUPS_KEY = 'xiaohei-specified-text-groups-v1';
const SPECIFIED_TEXT_GROUP_LIMIT = 20;
let specifiedTextGroupSerial = 0;

function createSpecifiedTextGroup(index = 0) {
  specifiedTextGroupSerial += 1;
  return { id: 'text-group-' + Date.now().toString(36) + '-' + specifiedTextGroupSerial, mode: 'sequence', text: '', cursor: 0, index };
}

function normalizeSpecifiedTextGroups(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, SPECIFIED_TEXT_GROUP_LIMIT).map((group, index) => {
    const source = group && typeof group === 'object' ? group : {};
    const fallback = createSpecifiedTextGroup(index);
    const id = String(source.id || fallback.id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || fallback.id;
    return { id, mode: source.mode === 'random' ? 'random' : 'sequence', text: String(source.text || '').slice(0, 500000), cursor: Math.max(0, Number.parseInt(source.cursor, 10) || 0), index };
  });
}

function loadSpecifiedTextGroups() {
  try {
    const groups = normalizeSpecifiedTextGroups(JSON.parse(localStorage.getItem(SPECIFIED_TEXT_GROUPS_KEY) || '[]'));
    if (groups.length) return groups;
  } catch (_) {}
  return [createSpecifiedTextGroup(0)];
}

let specifiedTextGroups = loadSpecifiedTextGroups();

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const element = (tag, className, text) => { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; };
const save = () => localStorage.setItem(UI_KEY, JSON.stringify(ui));
function textDelayRange() { return syncSettings.delayInput ? [syncSettings.inputMinMs / 1000, syncSettings.inputMaxMs / 1000] : [0, 0]; }
function fillSyncSettingsForm() {
  const checks = { '#settings-sync-keyboard': 'keyboard', '#settings-sync-click': 'click', '#settings-sync-scroll': 'scroll', '#settings-sync-track': 'track', '#settings-delay-click': 'delayClick', '#settings-delay-input': 'delayInput' };
  for (const [selector, name] of Object.entries(checks)) { const input = $(selector); if (input) input.checked = Boolean(syncSettings[name]); }
  const values = { '#settings-input-min': 'inputMinMs', '#settings-input-max': 'inputMaxMs', '#settings-click-min': 'clickMinMs', '#settings-click-max': 'clickMaxMs' };
  for (const [selector, name] of Object.entries(values)) { const input = $(selector); if (input) input.value = syncSettings[name]; }
  if ($('#delay-input')) $('#delay-input').checked = syncSettings.delayInput;
  if ($('#delay-click')) $('#delay-click').checked = syncSettings.delayClick;
}
function syncSettingsFromForm() {
  return normalizeSyncSettings({ keyboard: $('#settings-sync-keyboard').checked, click: $('#settings-sync-click').checked, scroll: $('#settings-sync-scroll').checked, track: $('#settings-sync-track').checked, delayClick: $('#settings-delay-click').checked, delayInput: $('#settings-delay-input').checked, inputMinMs: $('#settings-input-min').value, inputMaxMs: $('#settings-input-max').value, clickMinMs: $('#settings-click-min').value, clickMaxMs: $('#settings-click-max').value });
}
async function applySyncSettings(value, announce = false) {
  syncSettings = normalizeSyncSettings(value); localStorage.setItem(SYNC_SETTINGS_KEY, JSON.stringify(syncSettings)); fillSyncSettingsForm();
  await window.ops.setSyncSettings(syncSettings);
  if (announce) toast('\u540c\u6b65\u8bbe\u7f6e\u5df2\u4fdd\u5b58\uff0c\u9f20\u6807\u548c\u952e\u76d8\u5f00\u5173\u5df2\u7acb\u5373\u751f\u6548');
}
const THEME_KEY = 'xiaohei-ui-theme-v1';
const THEME_NAMES = { classic: '经典蓝', sky: '天空蓝', mint: '薄荷绿', lemon: '柠檬黄', peach: '蜜桃橙', rose: '樱花粉', lavender: '薰衣紫', teal: '湖水青', coral: '珊瑚红', navy: '深海蓝', forest: '森林绿', mocha: '暖灰棕' };

function applyTheme(value, persist = true) {
  const theme = Object.hasOwn(THEME_NAMES, value) ? value : 'classic';
  document.documentElement.dataset.theme = theme;
  if (persist) { try { localStorage.setItem(THEME_KEY, theme); } catch (_) {} }
  const current = $('#theme-current'); if (current) current.textContent = THEME_NAMES[theme];
  $$('[data-theme-option]').forEach((button) => button.classList.toggle('active', button.dataset.themeOption === theme));
}

let savedTheme = 'classic';
try { savedTheme = localStorage.getItem(THEME_KEY) || 'classic'; } catch (_) {}
applyTheme(savedTheme, false);

function toast(message) { const value = $('#toast'); value.textContent = message; value.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => value.classList.remove('show'), 2400); }
function log(module, message) { ui.logs.unshift({ time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), module, message }); ui.logs = ui.logs.slice(0, 200); save(); renderLogs(); }
function initials(name) { return name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase(); }
function maskProxy(value) {
  const raw = String(value || '').trim(); if (!raw || /^(direct|offline|none)$/i.test(raw)) return 'Direct';
  try { const parsed = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? new URL(raw) : null; if (parsed) return parsed.protocol.replace(':', '').toUpperCase() + ' · ' + parsed.hostname + ':' + parsed.port + (parsed.username ? ' · 已认证' : ''); } catch (_) {}
  const parts = raw.split(':'); return parts.length >= 4 ? 'SOCKS5 · ' + parts[0] + ':' + parts[1] + ' · 已认证' : raw;
}
function countryFlag(code) { const value = String(code || '').toUpperCase(); return /^[A-Z]{2}$/.test(value) ? String.fromCodePoint(...[...value].map((char) => 127397 + char.charCodeAt(0))) : '🌐'; }
function countryName(code) { try { return new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(String(code || '').toUpperCase()) || code; } catch (_) { return code || '未知国家'; } }
function parseEditorProxy(value) {
  const raw = String(value || '').trim();
  if (!raw || /^(direct|offline|none)$/i.test(raw)) return { mode: 'direct', type: 'socks5', host: '', port: '', username: '', password: '' };
  try {
    const parsed = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? new URL(raw) : null;
    if (parsed) return { mode: 'custom', type: parsed.protocol.replace(':', '').toLowerCase(), host: parsed.hostname, port: parsed.port, username: decodeURIComponent(parsed.username || ''), password: decodeURIComponent(parsed.password || '') };
  } catch (_) {}
  const parts = raw.split(':');
  return { mode: 'custom', type: parts.length >= 4 ? 'socks5' : 'http', host: parts[0] || '', port: parts[1] || '', username: parts[2] || '', password: parts.slice(3).join(':') };
}

function editorSet(id, value) { const field = $(id); if (field) field.value = value ?? ''; }
function editorCheck(id, value) { const field = $(id); if (field) field.checked = Boolean(value); }
function editorSelectedNetwork() { return document.querySelector('input[name="editor-network"]:checked')?.value || 'direct'; }

function serializeEditorProxy(strict = true) {
  if (editorSelectedNetwork() === 'direct') return 'Direct';
  const protocol = $('#editor-proxy-type').value; const host = $('#editor-proxy-host').value.trim(); const port = Number($('#editor-proxy-port').value);
  const username = $('#editor-proxy-user').value; const password = $('#editor-proxy-password').value;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    if (strict) throw new Error('请填写有效的代理主机和端口');
    return protocol.toUpperCase() + ' · 待完善';
  }
  if ((username && !password) || (!username && password)) {
    if (strict) throw new Error('代理账号和密码必须同时填写');
    return protocol + '://' + host + ':' + port;
  }
  const auth = username ? encodeURIComponent(username) + ':' + encodeURIComponent(password) + '@' : '';
  return protocol + '://' + auth + host + ':' + port;
}

function editorResolution() {
  const selected = $('#editor-resolution').value;
  if (selected !== 'custom') { const [width, height] = selected.split('x').map(Number); return { width, height }; }
  const width = Number($('#editor-width').value); const height = Number($('#editor-height').value);
  if (!Number.isInteger(width) || width < 640 || width > 7680 || !Number.isInteger(height) || height < 480 || height > 4320) throw new Error('请填写有效的窗口宽度和高度');
  return { width, height };
}

function editorCookies() {
  const raw = $('#editor-cookies').value.trim(); if (!raw) return '';
  let values; try { values = JSON.parse(raw); } catch (_) { throw new Error('Cookie JSON 格式错误'); }
  if (!Array.isArray(values) || values.some((item) => !item || typeof item !== 'object' || typeof item.name !== 'string' || typeof item.value !== 'string')) throw new Error('Cookie 必须是包含 name 和 value 的 JSON 数组');
  return JSON.stringify(values);
}

function editorDraft(strict = true) {
  const current = ui.profiles.find((item) => item.id === editingProfileId) || {};
  let resolution = { width: Number($('#editor-width').value) || current.width || 1280, height: Number($('#editor-height').value) || current.height || 820 };
  if (strict) resolution = editorResolution(); else if ($('#editor-resolution').value !== 'custom') { const values = $('#editor-resolution').value.split('x').map(Number); resolution = { width: values[0], height: values[1] }; }
  const privacy = {
    webrtc: $('#editor-webrtc').value, timezoneMode: $('#editor-timezone-mode').value, timezone: $('#editor-timezone').value.trim(), geoMode: $('#editor-geo-mode').value,
    latitude: $('#editor-latitude').value, longitude: $('#editor-longitude').value, accuracy: Number($('#editor-accuracy').value) || 100,
    uiLanguage: $('#editor-ui-language').value, fontMode: $('#editor-font-mode').value, fontSize: Number($('#editor-font-size').value) || 16,
    canvas: $('#editor-canvas').value, webgl: $('#editor-webgl').value, webgpu: $('#editor-webgpu').value, audio: $('#editor-audio').value, media: $('#editor-media').value,
    clientRects: 'real', speech: $('#editor-speech').value, dnt: $('#editor-dnt').checked
  };
  if (strict && privacy.timezoneMode === 'custom' && privacy.timezone) { try { new Intl.DateTimeFormat('en-US', { timeZone: privacy.timezone }).format(); } catch (_) { throw new Error('自定义时区无效，请使用 Asia/Shanghai 这类 IANA 时区名称'); } }
  if (strict && privacy.geoMode === 'custom') {
    const latitude = Number(privacy.latitude); const longitude = Number(privacy.longitude);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new Error('自定义地理位置经纬度无效');
    privacy.latitude = latitude; privacy.longitude = longitude;
  }
  return normalizeProfileSettings({
    ...current,
    ...(editorNetworkResult ? {
      exitIp: editorNetworkResult.ip,
      exitCountryCode: editorNetworkResult.countryCode,
      exitTimezone: editorNetworkResult.timezone || '',
      exitLatitude: editorNetworkResult.latitude,
      exitLongitude: editorNetworkResult.longitude,
      exitCheckedAt: editorNetworkResult.checkedAt
    } : {}),
    id: editingProfileId, number: current.number, name: displayProfileNumber(current), browser: 'Google Chrome', os: $('#editor-os').value,
    userAgent: $('#editor-user-agent').value.trim(), cookies: strict ? editorCookies() : $('#editor-cookies').value.trim(), language: $('#editor-language').value,
    tag: $('#editor-tag').value.trim(), note: $('#editor-note').value.trim(), proxy: serializeEditorProxy(strict), width: resolution.width, height: resolution.height,
    proxyMeta: { ipChannel: $('#editor-ip-channel').value, refreshUrl: $('#editor-refresh-url').value.trim() }, privacy,
    advanced: {
      saveCookies: $('#editor-save-cookies').checked, savePasswords: $('#editor-save-passwords').checked, saveBookmarks: $('#editor-save-bookmarks').checked,
      saveLocalStorage: $('#editor-save-local-storage').checked, saveIndexedDB: $('#editor-save-indexeddb').checked, saveHistory: $('#editor-save-history').checked,
      allowSignin: $('#editor-allow-signin').checked, restoreSession: $('#editor-restore-session').checked, blockVideo: $('#editor-block-video').checked,
      blockImages: $('#editor-block-images').checked, clearCacheOnStart: $('#editor-clear-cache').checked
    }
  });
}

function updateEditorVisibility() {
  const direct = editorSelectedNetwork() === 'direct'; $('#editor-proxy-fields').classList.toggle('disabled', direct);
  $('#editor-timezone').hidden = $('#editor-timezone-mode').value !== 'custom';
  $('.geo-custom').hidden = $('#editor-geo-mode').value !== 'custom';
  const customResolution = $('#editor-resolution').value === 'custom'; $('#editor-width').hidden = !customResolution; $('#editor-height').hidden = !customResolution;
  $('#editor-font-size').hidden = $('#editor-font-mode').value !== 'custom';
}

function renderEditorSummary() {
  if (!editingProfileId) return;
  const draft = editorDraft(false); const privacy = draft.privacy; const summary = $('#editor-summary'); summary.replaceChildren();
  const labels = {
    webrtc: { proxy: '仅代理连接', disabled: '禁用非代理 UDP', real: '真实网络' }, timezoneMode: { ip: '基于出口 IP', real: '系统真实', custom: privacy.timezone || '自定义' },
    geoMode: { ip: '基于出口 IP', disabled: '禁止访问', custom: '自定义坐标' }, canvas: { real: '真实', blocked: '禁止读取' }, webgl: { real: '真实', blocked: '禁用' },
    audio: { real: '真实', muted: '静音输出' }, media: { real: '按网站询问', blocked: '禁止访问' }, speech: { real: '真实', blocked: '禁用' }
  };
  const values = [
    ['浏览器', 'Google Chrome'], ['User-Agent', draft.userAgent || 'Chrome 默认'], ['代理', maskProxy(draft.proxy)], ['WebRTC', labels.webrtc[privacy.webrtc]],
    ['时区', labels.timezoneMode[privacy.timezoneMode]], ['地理位置', labels.geoMode[privacy.geoMode]], ['语言', draft.language], ['界面语言', privacy.uiLanguage === 'profile' ? '跟随语言' : privacy.uiLanguage],
    ['分辨率', draft.width + ' × ' + draft.height], ['字体', privacy.fontMode === 'custom' ? privacy.fontSize + 'px' : '默认'], ['Canvas', labels.canvas[privacy.canvas]],
    ['WebGL', labels.webgl[privacy.webgl]], ['WebGPU', privacy.webgpu === 'blocked' ? '禁用' : '真实'], ['AudioContext', labels.audio[privacy.audio]], ['媒体设备', labels.media[privacy.media]], ['ClientRects', '真实'],
    ['SpeechVoices', labels.speech[privacy.speech]], ['CPU', (navigator.hardwareConcurrency || '未知') + ' 核'], ['RAM', navigator.deviceMemory ? navigator.deviceMemory + ' GB' : '由系统管理'], ['Do Not Track', privacy.dnt ? '启用' : '默认']
  ];
  for (const [name, value] of values) { const row = document.createElement('div'); row.append(element('dt', '', name), element('dd', '', value || '默认')); summary.append(row); }
  const auditTarget = $('#editor-audit');
  if (auditTarget && window.EnvironmentAudit) {
    const report = window.EnvironmentAudit.build(draft, { systemTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    auditTarget.replaceChildren();
    const head = element('div', 'audit-head');
    head.append(element('strong', '', 'V15 环境一致性检查'), element('span', report.status, report.warnings ? `${report.warnings} 项需确认` : '配置一致'));
    auditTarget.append(head);
    for (const check of report.checks) {
      const row = element('div', `audit-row ${check.state}`);
      const body = element('div'); body.append(element('strong', '', check.label), element('small', '', check.detail));
      row.append(element('i', '', ''), body); auditTarget.append(row);
    }
  }
}

function setEditorTab(tab) {
  $$('[data-editor-tab]').forEach((button) => button.classList.toggle('active', button.dataset.editorTab === tab));
  $$('[data-editor-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.editorPanel === tab));
}

function openProfileEditor(id) {
  const profile = normalizeProfileSettings(ui.profiles.find((item) => item.id === id)); if (!profile?.id) return;
  editorNetworkResult = profile.exitIp ? { ip: profile.exitIp, countryCode: profile.exitCountryCode, timezone: profile.exitTimezone, latitude: profile.exitLatitude, longitude: profile.exitLongitude, checkedAt: profile.exitCheckedAt } : null;
  editingProfileId = profile.id; editorSet('#editor-id', profile.id); $('#editor-profile-id').textContent = displayProfileNumber(profile); editorSet('#editor-name', displayProfileNumber(profile)); editorSet('#editor-browser', 'Google Chrome'); editorSet('#editor-os', profile.os);
  editorSet('#editor-user-agent', profile.userAgent); editorSet('#editor-cookies', (() => { if (!profile.cookies) return ''; try { return JSON.stringify(JSON.parse(profile.cookies), null, 2); } catch (_) { return profile.cookies; } })()); editorSet('#editor-language', profile.language); editorSet('#editor-tag', profile.tag); editorSet('#editor-note', profile.note);
  const proxy = parseEditorProxy(profile.proxy); const mode = document.querySelector('input[name="editor-network"][value="' + proxy.mode + '"]'); if (mode) mode.checked = true;
  editorSet('#editor-proxy-type', ['http', 'https', 'socks5'].includes(proxy.type) ? proxy.type : 'socks5'); editorSet('#editor-proxy-host', proxy.host); editorSet('#editor-proxy-port', proxy.port); editorSet('#editor-proxy-user', proxy.username); editorSet('#editor-proxy-password', proxy.password);
  editorSet('#editor-ip-channel', profile.proxyMeta.ipChannel); editorSet('#editor-refresh-url', profile.proxyMeta.refreshUrl); $('#editor-proxy-result').className = 'proxy-test-result'; $('#editor-proxy-result').textContent = profile.exitIp ? '上次出口：' + profile.exitIp + ' · ' + countryName(profile.exitCountryCode) : '尚未检测';
  const privacy = profile.privacy; editorSet('#editor-webrtc', privacy.webrtc); editorSet('#editor-timezone-mode', privacy.timezoneMode); editorSet('#editor-timezone', privacy.timezone); editorSet('#editor-geo-mode', privacy.geoMode); editorSet('#editor-latitude', privacy.latitude); editorSet('#editor-longitude', privacy.longitude); editorSet('#editor-accuracy', privacy.accuracy);
  editorSet('#editor-ui-language', privacy.uiLanguage); const resolution = [profile.width + 'x' + profile.height, '1280x820', '1366x768', '1440x900', '1920x1080'].includes(profile.width + 'x' + profile.height) ? profile.width + 'x' + profile.height : 'custom'; editorSet('#editor-resolution', resolution); editorSet('#editor-width', profile.width); editorSet('#editor-height', profile.height);
  editorSet('#editor-font-mode', privacy.fontMode); editorSet('#editor-font-size', privacy.fontSize); editorSet('#editor-canvas', privacy.canvas); editorSet('#editor-webgl', privacy.webgl); editorSet('#editor-webgpu', privacy.webgpu); editorSet('#editor-audio', privacy.audio); editorSet('#editor-media', privacy.media); editorSet('#editor-speech', privacy.speech); editorCheck('#editor-dnt', privacy.dnt);
  const advanced = profile.advanced; for (const [id, value] of [['#editor-save-cookies', advanced.saveCookies], ['#editor-save-passwords', advanced.savePasswords], ['#editor-save-bookmarks', advanced.saveBookmarks], ['#editor-save-local-storage', advanced.saveLocalStorage], ['#editor-save-indexeddb', advanced.saveIndexedDB], ['#editor-save-history', advanced.saveHistory], ['#editor-allow-signin', advanced.allowSignin], ['#editor-restore-session', advanced.restoreSession], ['#editor-block-video', advanced.blockVideo], ['#editor-block-images', advanced.blockImages], ['#editor-clear-cache', advanced.clearCacheOnStart]]) editorCheck(id, value);
  setEditorTab('basic'); updateEditorVisibility(); renderEditorSummary(); switchView('profile-editor');
}

async function testEditorProxy() {
  const output = $('#editor-proxy-result');
  try {
    const draft = editorDraft(true); if (/^Direct$/i.test(draft.proxy)) throw new Error('本地直连无需代理检测');
    output.className = 'proxy-test-result'; output.textContent = '正在检测代理出口...'; const result = await window.ops.testProfileProxy(draft);
    editorNetworkResult = result;
    output.className = 'proxy-test-result success'; output.textContent = '连接成功 · ' + result.ip + ' · ' + countryFlag(result.countryCode) + ' ' + countryName(result.countryCode);
  } catch (error) { output.className = 'proxy-test-result error'; output.textContent = '检测失败 · ' + error.message; }
}

function useSystemEditorDefaults() {
  editorSet('#editor-user-agent', ''); editorSet('#editor-timezone-mode', 'real'); editorSet('#editor-timezone', Intl.DateTimeFormat().resolvedOptions().timeZone || ''); editorSet('#editor-geo-mode', 'disabled'); editorSet('#editor-ui-language', 'system');
  editorSet('#editor-resolution', 'custom'); editorSet('#editor-width', Math.max(640, screen.availWidth || 1280)); editorSet('#editor-height', Math.max(480, screen.availHeight || 820));
  editorSet('#editor-webrtc', 'real'); editorSet('#editor-canvas', 'real'); editorSet('#editor-webgl', 'real'); editorSet('#editor-webgpu', 'real'); editorSet('#editor-audio', 'real'); editorSet('#editor-media', 'real'); editorSet('#editor-speech', 'real');
  updateEditorVisibility(); renderEditorSummary(); toast('已读取本机安全默认值');
}
function profileEngine(id) { return engineProfiles.find((item) => item.id === id) || { running: false, assignedExtensions: [] }; }

const viewMeta = {
  profiles: ['环境管理', '真实 Chrome / Edge 独立用户目录'],
  'profile-editor': ['编辑浏览器环境', '独立 Chrome 环境的网络、隐私和启动设置'],
  extensions: ['应用中心', '批量分配本地 Chrome 扩展'],
  sync: ['窗口同步', '窗口、文本和标签页的 CDP 批量管理'],
  api: ['API & MCP', '本地接口、自动化框架、MCP 与 AI Skill'],
  logs: ['操作日志', '本地引擎执行记录'],
  system: ['本地设置', '运行时与能力状态']
};

function switchView(view) {
  $$('.nav').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  $$('.view').forEach((section) => section.classList.toggle('active', section.id === `view-${view}`));
  $('#page-title').textContent = viewMeta[view][0]; $('#page-subtitle').textContent = viewMeta[view][1];
  if (view === 'sync') refreshSessions(); if (view === 'extensions') refreshExtensions(); if (view === 'api') refreshApiInfo();
}

function renderProfiles() {
  const filter = $('#profile-search').value.trim().toLowerCase();
  const table = $('#profile-table'); table.replaceChildren();
  const filtered = ui.profiles.filter((profile) => [profile.id, displayProfileNumber(profile), profile.browser, profile.proxy, profile.tag].join(' ').toLowerCase().includes(filter));
  const totalPages = Math.max(1, Math.ceil(filtered.length / profilePageSize));
  profilePage = Math.min(Math.max(1, profilePage), totalPages);
  const pageStart = (profilePage - 1) * profilePageSize;
  const visible = filtered.slice(pageStart, pageStart + profilePageSize);
  for (const profile of visible) {
    const info = profileEngine(profile.id); const row = document.createElement('tr');
    const selectCell = document.createElement('td'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selectedProfiles.has(profile.id); checkbox.dataset.profileSelect = profile.id; selectCell.append(checkbox);
    const idCell = element('td', '', displayProfileNumber(profile));
    const nameCell = document.createElement('td'); const identity = element('div', 'profile-name'); identity.append(element('div', 'avatar', displayProfileNumber(profile))); const copy = element('div'); copy.append(element('strong', '', displayProfileNumber(profile)), element('small', '', profile.tag || '未分组')); identity.append(copy); nameCell.append(identity);
    const browserCell = element('td', '', profile.browser);
    const proxyCell = element('td', '', maskProxy(profile.proxy));
    const networkCell = document.createElement('td'); const network = info.network || (profile.exitIp ? { ip: profile.exitIp, countryCode: profile.exitCountryCode, checkedAt: profile.exitCheckedAt } : null);
    const networkInfo = element('div', 'network-info');
    if (network?.ip) networkInfo.append(element('strong', '', network.ip), element('small', '', countryFlag(network.countryCode) + ' ' + countryName(network.countryCode)));
    else networkInfo.append(element('span', 'network-pending', /^(direct|offline|none)$/i.test(String(profile.proxy || 'Direct')) ? '本地网络' : '尚未检测'));
    if (!/^(direct|offline|none)$/i.test(String(profile.proxy || 'Direct'))) { const inspect = element('button', 'network-check', network?.ip ? '重新检测' : '检测'); inspect.dataset.proxyCheck = profile.id; networkInfo.append(inspect); }
    networkCell.append(networkInfo);
    const extensionCell = element('td', '', String(info.assignedExtensions?.length || 0));
    const statusCell = document.createElement('td'); statusCell.append(element('span', `status ${info.running ? 'running' : ''}`, info.running ? `运行中 · ${info.port || ''}` : '已停止'));
    const actionCell = document.createElement('td'); const actions = element('div', 'actions');
    const toggle = element('button', 'mini', info.running ? '停止' : '启动'); toggle.dataset.action = info.running ? 'stop' : 'start'; toggle.dataset.id = profile.id;
    const sync = element('button', 'mini blue', '同步选择'); sync.dataset.action = 'select-sync'; sync.dataset.id = profile.id; sync.disabled = !info.running;
    const edit = element('button', 'mini edit', '编辑'); edit.dataset.action = 'edit'; edit.dataset.id = profile.id;
    actions.append(toggle, sync, edit); actionCell.append(actions);
    row.append(selectCell, idCell, nameCell, browserCell, proxyCell, networkCell, extensionCell, statusCell, actionCell); table.append(row);
  }
  $('#profile-empty').hidden = filtered.length !== 0;
  $('#profile-total').textContent = String(filtered.length);
  $('#profile-page').value = String(profilePage);
  $('#profile-page').max = String(totalPages);
  $('#profile-pages').textContent = String(totalPages);
  $('#profile-page-size').value = String(profilePageSize);
  $('#profile-prev').disabled = profilePage <= 1;
  $('#profile-next').disabled = profilePage >= totalPages;
  const pageIds = visible.map((profile) => profile.id);
  const selectedOnPage = pageIds.filter((id) => selectedProfiles.has(id)).length;
  const selectAll = $('#select-all-profiles');
  selectAll.checked = pageIds.length > 0 && selectedOnPage === pageIds.length;
  selectAll.indeterminate = selectedOnPage > 0 && selectedOnPage < pageIds.length;
}

function visibleProfilePageIds() {
  const filter = $('#profile-search').value.trim().toLowerCase();
  const filtered = ui.profiles.filter((profile) => [profile.id, displayProfileNumber(profile), profile.browser, profile.proxy, profile.tag].join(' ').toLowerCase().includes(filter));
  const totalPages = Math.max(1, Math.ceil(filtered.length / profilePageSize));
  const page = Math.min(Math.max(1, profilePage), totalPages);
  const pageStart = (page - 1) * profilePageSize;
  return filtered.slice(pageStart, pageStart + profilePageSize).map((profile) => profile.id);
}

async function refreshStatus(syncUi = false) {
  engineProfiles = await window.ops.profileStatus();
  if (syncUi) syncUiProfilesFromEngine();
  renderProfiles();
}

async function startProfile(id) {
  const profile = ui.profiles.find((item) => item.id === id); if (!profile) return;
  try { const result = await window.ops.startProfile(profile); log('Browser', `${profile.name} 已启动 · ${result.browser} · CDP ${result.port || 'pending'}`); toast(`${profile.name} 已真实启动`); await refreshStatus(); await refreshSessions(); }
  catch (error) { log('Error', error.message); toast(`启动失败：${error.message}`); }
}

async function stopProfile(id) {
  try { await window.ops.stopProfile(id); const profile = ui.profiles.find((item) => item.id === id); log('Browser', `${profile?.name || id} 已停止`); await refreshStatus(); await refreshSessions(); }
  catch (error) { log('Error', error.message); toast(`停止失败：${error.message}`); }
}

async function checkProfileProxy(id) {
  const profile = ui.profiles.find((item) => item.id === id); if (!profile) return;
  try {
    toast('正在通过环境 ' + displayProfileNumber(profile) + ' 的代理检测出口 IP...');
    const result = await window.ops.checkProfileProxy(profile);
    profile.exitIp = result.ip; profile.exitCountryCode = result.countryCode; profile.exitTimezone = result.timezone || ''; profile.exitLatitude = result.latitude; profile.exitLongitude = result.longitude; profile.exitCheckedAt = result.checkedAt; save();
    const number = displayProfileNumber(profile); await refreshStatus(); renderProfiles(); log('Proxy', '环境 ' + number + ' 出口检测成功 · ' + result.ip + ' · ' + countryName(result.countryCode)); toast('环境 ' + number + ' 出口：' + result.ip + ' · ' + countryName(result.countryCode));
  } catch (error) { log('Proxy', '环境 ' + displayProfileNumber(profile) + ' 检测失败 · ' + error.message); toast('代理检测失败：' + error.message); }
}

function extensionIcon(name) { return name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase(); }
function renderExtensions() {
  const query = $('#extension-search').value.trim().toLowerCase(); const grid = $('#extension-grid'); grid.replaceChildren();
  const visible = extensions.filter((item) => [item.name, item.description, item.version].join(' ').toLowerCase().includes(query));
  for (const extension of visible) {
    const card = element('article', 'extension-card'); const top = element('div', 'extension-top');
    const toggleLabel = element('label', 'extension-toggle'); const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = extension.enabledAll; toggle.dataset.extensionToggle = extension.id;
    toggle.indeterminate = !extension.enabledAll && Number(extension.assignedProfiles) > 0;
    toggleLabel.title = extension.enabledAll ? '全部环境已启用' : toggle.indeterminate ? '部分环境已启用' : '全部环境已停用';
    toggleLabel.append(toggle, element('span', 'extension-toggle-slider')); top.append(element('div', 'extension-icon', extensionIcon(extension.name)), toggleLabel);
    card.append(top, element('h3', '', extension.name), element('p', '', extension.description || 'Local unpacked Chrome extension'));
    const meta = element('div', 'extension-meta'); meta.append(element('span', '', `v${extension.version} · MV${extension.manifestVersion} · ${extension.source || (extension.builtIn ? '内置' : '本地')}`), element('span', '', `已启用 ${extension.assignedProfiles}/${ui.profiles.length}`)); card.append(meta);
    const actions = element('div', 'card-actions'); const assign = element('button', 'primary', '批量分配'); assign.dataset.extensionAssign = extension.id; actions.append(assign);
    if (!extension.builtIn) { const remove = element('button', 'outline', '移除'); remove.dataset.extensionRemove = extension.id; actions.append(remove); }
    card.append(actions); grid.append(card);
  }
  $('#extension-empty').hidden = visible.length !== 0;
}

async function refreshExtensions() { extensions = await window.ops.extensionList(); renderExtensions(); }

function openAssign(id) {
  currentExtension = extensions.find((item) => item.id === id); if (!currentExtension) return;
  $('#assign-extension-name').textContent = `${currentExtension.name} · 运行中的环境需重启后生效`;
  const list = $('#assign-profile-list'); list.replaceChildren();
  const assigned = new Set(currentExtension.assignedProfileIds || []);
  for (const profile of ui.profiles) { const label = element('label', 'assign-item'); const input = document.createElement('input'); input.type = 'checkbox'; input.value = profile.id; input.checked = assigned.has(profile.id); label.append(input, element('span', '', '环境 ' + displayProfileNumber(profile))); list.append(label); }
  $('#assign-dialog').showModal();
}

async function applyAssignment(enabled) {
  const ids = $$('#assign-profile-list input:checked').map((input) => input.value); if (!ids.length) return toast('请先选择环境');
  const result = await window.ops.assignExtension(currentExtension.id, ids, enabled); $('#assign-dialog').close(); await refreshExtensions(); await refreshStatus();
  log('Extension', `${currentExtension.name} ${enabled ? '添加到' : '移出'} ${ids.length} 个环境`);
  toast(result.restartRequired?.length ? `已保存；${result.restartRequired.length} 个运行环境需重启` : '批量分配已生效');
}

function orderedSelectedSessionIds() {
  const ids = [...selectedSessions];
  if (!preferredMasterId || !selectedSessions.has(preferredMasterId)) preferredMasterId = ids[0] || null;
  return preferredMasterId ? [preferredMasterId, ...ids.filter((id) => id !== preferredMasterId)] : ids;
}

function populateSyncGroups() {
  const select = $('#sync-group'); const current = select.value || 'all'; const groups = [...new Set(sessions.map((item) => String(item.profile?.tag || '未分组')))].sort();
  select.replaceChildren(); const all = document.createElement('option'); all.value = 'all'; all.textContent = '全部分组'; select.append(all);
  for (const group of groups) { const option = document.createElement('option'); option.value = group; option.textContent = group; select.append(option); }
  select.value = [...select.options].some((option) => option.value === current) ? current : 'all';
}

function renderSessions() {
  populateSyncGroups(); const group = $('#sync-group').value || 'all'; const visible = group === 'all' ? sessions : sessions.filter((item) => String(item.profile?.tag || '未分组') === group);
  const table = $('#session-table'); table.replaceChildren();
  for (const value of visible) {
    const selected = selectedSessions.has(value.id);
    const role = syncState.active && syncState.master === value.id ? '主控窗口' : syncState.active && syncState.selected.includes(value.id) ? '被控窗口' : selected && preferredMasterId === value.id ? '预设主控' : selected ? '已选择' : '待同步';
    const row = document.createElement('tr');
    if (selected) row.classList.add('selected-row');
    if ((syncState.active && syncState.master === value.id) || (!syncState.active && preferredMasterId === value.id && selected)) row.classList.add('master-row');
    const selectCell = document.createElement('td'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selected; checkbox.disabled = syncState.active; checkbox.dataset.sessionSelect = value.id; selectCell.append(checkbox);
    const statusCell = document.createElement('td'); statusCell.append(element('span', 'sync-role', role));
    const actionCell = document.createElement('td'); actionCell.className = 'sync-actions';
    const master = element('button', 'sync-show', preferredMasterId === value.id ? '主控' : '设为主控'); master.dataset.masterSelect = value.id; master.disabled = syncState.active || !selected;
    const show = element('button', 'sync-show', '显示窗口'); show.dataset.showWindow = value.id; actionCell.append(master, show);
    const number = displayProfileNumber(value.profile || { id: value.id });
    row.append(selectCell, element('td', '', number), element('td', '', number), element('td', '', value.browser), element('td', '', String(value.tabs.length)), statusCell, actionCell); table.append(row);
  }
  $('#session-empty').style.display = visible.length ? 'none' : 'block';
  $('#selected-count').textContent = '已选 ' + selectedSessions.size;
  $('#sync-selected').textContent = '已选择 ' + selectedSessions.size + ' 列';
  const allBox = $('#select-all-sessions'); allBox.checked = visible.length > 0 && visible.every((item) => selectedSessions.has(item.id)); allBox.indeterminate = visible.some((item) => selectedSessions.has(item.id)) && !allBox.checked;
  renderSyncState(); renderTabInventory();
}

function renderSyncState() {
  $('#start-sync').hidden = syncState.active;
  $('#stop-sync').hidden = !syncState.active;
  $('#restart-sync').disabled = selectedSessions.size < 2;
  $('#select-all-sessions').disabled = syncState.active; $('#sync-group').disabled = syncState.active;
  const health = $('#sync-health');
  if (!syncState.active) { health.className = 'sync-health idle'; health.textContent = '同步未启动'; }
  else if (syncHealth.recovering) { health.className = 'sync-health warning'; health.textContent = '正在恢复输入桥'; }
  else if (syncHealth.queueDepth > 24 || syncHealth.lastLatencyMs > 800) { health.className = 'sync-health warning'; health.textContent = `同步繁忙 · 队列 ${syncHealth.queueDepth}`; }
  else { health.className = 'sync-health healthy'; health.textContent = `同步正常 · ${syncHealth.lastLatencyMs || 0}ms`; }
}

function pushSyncSelection() {
  if (syncState.active) return renderSyncState();
  const ids = orderedSelectedSessionIds(); syncState.selected = ids;
  window.ops.setSyncSelection(ids).catch((error) => log('Error', error.message));
  renderSyncState();
}

function renderTabInventory() {
  const target = $('#tab-inventory'); target.replaceChildren();
  for (const value of sessions.filter((item) => selectedSessions.has(item.id))) { const group = element('div', 'tab-group'); group.append(element('strong', '', '环境 ' + displayProfileNumber(value.profile || { id: value.id }) + ' · ' + value.tabs.length + ' tabs')); for (const tab of value.tabs.slice(0, 6)) group.append(element('span', '', `${tab.title || 'Untitled'} — ${tab.url}`)); target.append(group); }
}

async function refreshSessions() {
  try {
    const previous = new Set(selectedSessions); sessions = await window.ops.syncSessions(); const live = new Set(sessions.map((item) => item.id));
    if (syncState.active) selectedSessions = new Set((syncState.selected || []).filter((id) => live.has(id)));
    else if (!sessionsInitialized) selectedSessions = new Set(sessions.map((item) => item.id));
    else selectedSessions = new Set([...previous].filter((id) => live.has(id)));
    sessionsInitialized = true; if (!selectedSessions.has(preferredMasterId)) preferredMasterId = orderedSelectedSessionIds()[0] || null;
    if (!syncState.active) pushSyncSelection(); renderSessions();
  } catch (error) { log('CDP', error.message); }
}
function selectedSessionIds(minimum = 1) { const ids = orderedSelectedSessionIds(); if (ids.length < minimum) throw new Error(`请至少选择 ${minimum} 个运行环境`); return ids; }
function specifiedTextItems(value) {
  return String(value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function distributeSpecifiedTexts(items, count, mode = 'sequence', cursor = 0, random = Math.random) {
  const values = Array.isArray(items) ? items.map((item) => String(item)).filter((item) => item.length > 0) : [];
  const amount = Math.max(0, Number.parseInt(count, 10) || 0);
  if (!values.length || !amount) return { texts: [], nextCursor: Math.max(0, Number.parseInt(cursor, 10) || 0) };
  if (mode === 'random') {
    return {
      texts: Array.from({ length: amount }, () => values[Math.min(values.length - 1, Math.max(0, Math.floor(Number(random()) * values.length)))]),
      nextCursor: Math.max(0, Number.parseInt(cursor, 10) || 0)
    };
  }
  const start = ((Number.parseInt(cursor, 10) || 0) % values.length + values.length) % values.length;
  return { texts: Array.from({ length: amount }, (_unused, index) => values[(start + index) % values.length]), nextCursor: (start + amount) % values.length };
}

function saveSpecifiedTextGroups() {
  try {
    localStorage.setItem(SPECIFIED_TEXT_GROUPS_KEY, JSON.stringify(specifiedTextGroups.map(({ id, mode, text, cursor }) => ({ id, mode, text, cursor }))));
  } catch (_) {}
}

function renderSpecifiedTextGroups() {
  const target = $('#specified-text-groups'); if (!target) return;
  target.replaceChildren();
  specifiedTextGroups.forEach((group, index) => {
    const card = element('article', 'specified-text-group'); card.dataset.specifiedGroup = group.id;
    const head = element('div', 'specified-text-group-head');
    head.append(element('strong', '', '\u6587\u672c\u7ec4' + (index + 1)));
    const remove = element('button', 'specified-text-remove', '\u5220\u9664'); remove.type = 'button'; remove.dataset.specifiedRemove = group.id; remove.hidden = specifiedTextGroups.length <= 1; head.append(remove);
    const modes = element('div', 'specified-text-modes');
    for (const [value, labelText] of [['sequence', '\u987a\u5e8f\u8f93\u5165'], ['random', '\u968f\u673a\u8f93\u5165']]) {
      const label = document.createElement('label'); const input = document.createElement('input');
      input.type = 'radio'; input.name = 'specified-mode-' + group.id; input.value = value; input.checked = group.mode === value; input.dataset.specifiedMode = group.id;
      label.append(input, document.createTextNode(labelText)); modes.append(label);
    }
    const textarea = document.createElement('textarea'); textarea.value = group.text; textarea.dataset.specifiedText = group.id; textarea.placeholder = '\u6bcf\u884c\u4e00\u6761\u6587\u672c\uff0c\u8f93\u5165\u65f6\u6309\u73af\u5883\u5206\u914d';
    const foot = element('div', 'specified-text-group-foot');
    const count = element('span', 'specified-text-count', specifiedTextItems(group.text).length + ' \u6761\u6587\u672c'); count.dataset.specifiedCount = group.id;
    const send = element('button', 'specified-text-send', '\u8f93\u5165 (Shift+F1)'); send.type = 'button'; send.dataset.specifiedSend = group.id;
    foot.append(count, send); card.append(head, modes, textarea, foot); target.append(card);
  });
}

function specifiedTextSessionIds() {
  return selectedSessionIds().sort((left, right) => {
    const leftSession = sessions.find((item) => item.id === left);
    const rightSession = sessions.find((item) => item.id === right);
    const leftNumber = String(displayProfileNumber(leftSession?.profile || { id: left }));
    const rightNumber = String(displayProfileNumber(rightSession?.profile || { id: right }));
    return leftNumber.localeCompare(rightNumber, 'zh-CN', { numeric: true, sensitivity: 'base' }) || String(left).localeCompare(String(right));
  });
}

function specifiedTextFailureLabel(id) {
  const session = sessions.find((item) => item.id === id);
  return displayProfileNumber(session?.profile || { id });
}

async function sendSpecifiedTextGroup(id) {
  const group = specifiedTextGroups.find((item) => item.id === id); if (!group) return;
  let ids;
  try { ids = specifiedTextSessionIds(); } catch (error) { return toast(error.message); }
  const items = specifiedTextItems(group.text); if (!items.length) return toast('\u8bf7\u5148\u5728\u6587\u672c\u7ec4\u4e2d\u6bcf\u884c\u586b\u5199\u4e00\u6761\u6587\u672c');
  const assignment = distributeSpecifiedTexts(items, ids.length, group.mode, group.cursor);
  const [delayMin, delayMax] = textDelayRange();
  const button = document.querySelector('[data-specified-send="' + id + '"]'); if (button) button.disabled = true;
  try {
    const label = group.mode === 'random' ? '\u968f\u673a\u6307\u5b9a\u6587\u672c' : '\u987a\u5e8f\u6307\u5b9a\u6587\u672c';
    const result = await window.ops.batchTextAction(ids, assignment.texts, delayMin, delayMax);
    log('Sync', label + ' \u00b7 ' + JSON.stringify(result));
    if (!result?.success) {
      const failed = (result?.failures || []).map((item) => specifiedTextFailureLabel(item.id));
      const suffix = failed.length ? '\uff1b\u8bf7\u5148\u5728\u73af\u5883 ' + failed.join('\u3001') + ' \u4e2d\u70b9\u51fb\u4f60\u8981\u8f93\u5165\u7684\u4f4d\u7f6e' : '';
      return toast('\u6307\u5b9a\u6587\u672c\u4ec5\u5199\u5165 ' + (result?.profiles?.length || 0) + '/' + ids.length + ' \u4e2a\u73af\u5883' + suffix);
    }
    if (group.mode === 'sequence') { group.cursor = assignment.nextCursor; saveSpecifiedTextGroups(); }
    toast(label + '\u5b8c\u6210\uff1a' + result.profiles.length + '/' + ids.length + ' \u4e2a\u73af\u5883\u5df2\u5b9e\u9645\u5199\u5165');
  } catch (error) { log('Error', error.message); toast(error.message); }
  finally { if (button) button.disabled = false; }
}
function normalizeUrl(value) { const raw = String(value || '').trim(); if (!raw) return 'about:blank'; if (/^(https?:\/\/|about:)/i.test(raw)) return raw; return `https://${raw}`; }

function normalizedProxyType(value) { return /^https?$/i.test(String(value || '')) ? 'http' : 'socks5'; }
function normalizeProxy(value, selectedType = 'socks5') {
  let raw = String(value || '').trim(); if (!raw || /^(direct|offline|none)$/i.test(raw)) return 'Direct';
  raw = raw.replace(/^sock(?:s)?5s?:\/\//i, 'socks5://');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
  const parts = raw.split(':'); if (![2, 4].includes(parts.length) && parts.length < 4) throw new Error('\u4ee3\u7406\u683c\u5f0f\u5e94\u4e3a IP:\u7aef\u53e3 \u6216 IP:\u7aef\u53e3:\u7528\u6237\u540d:\u5bc6\u7801');
  const host = parts[0]; const port = Number(parts[1]); if (!/^[a-zA-Z0-9._-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('\u4ee3\u7406 IP \u6216\u7aef\u53e3\u65e0\u6548');
  const protocol = normalizedProxyType(selectedType);
  if (parts.length === 2) return protocol + '://' + host + ':' + port;
  const username = parts[2]; const password = parts.slice(3).join(':'); if (!username || !password) throw new Error('\u4ee3\u7406\u7528\u6237\u540d\u548c\u5bc6\u7801\u4e0d\u80fd\u4e3a\u7a7a');
  return protocol + '://' + encodeURIComponent(username) + ':' + encodeURIComponent(password) + '@' + host + ':' + port;
}
function proxyLines(textareaId, typeId) { return $(textareaId).value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).map((item) => normalizeProxy(item, $(typeId).value)); }
async function verifyProxyAssignments(profiles, proxies) {
  if (profiles.length !== proxies.length) throw new Error('\u4ee3\u7406\u6570\u91cf\u5fc5\u987b\u4e0e\u73af\u5883\u6570\u91cf\u4e00\u81f4\uff0c\u786e\u4fdd\u6bcf\u4e2a\u73af\u5883\u7ed1\u5b9a\u81ea\u5df1\u7684\u4ee3\u7406');
  const results = [];
  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index]; toast('\u6b63\u5728\u68c0\u6d4b\u4ee3\u7406 ' + (index + 1) + '/' + profiles.length + '\uff08\u73af\u5883 ' + displayProfileNumber(profile) + '\uff09...');
    try { results.push(await window.ops.testProfileProxy({ ...profile, proxy: proxies[index] })); }
    catch (error) { throw new Error('\u73af\u5883 ' + displayProfileNumber(profile) + ' \u4ee3\u7406\u4e0d\u53ef\u7528\uff1a' + error.message); }
  }
  return results;
}
function installProxyTypeControl(textareaId, selectId) {
  const textarea = $(textareaId); if (!textarea || $(selectId)) return;
  const label = document.createElement('label'); label.className = 'proxy-type-field'; label.dataset.proxyFor = textarea.id; label.textContent = '\u4ee3\u7406\u7c7b\u578b\uff08\u672a\u586b\u5199\u524d\u7f00\u65f6\u4f7f\u7528\uff09';
  const select = document.createElement('select'); select.id = selectId;
  for (const [value, text] of [['socks5', 'SOCKS5'], ['http', 'HTTP']]) { const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option); }
  label.append(select);
  const note = element('p', 'store-note', '\u53ef\u76f4\u63a5\u8f93\u5165 IP:\u7aef\u53e3:\u7528\u6237\u540d:\u5bc6\u7801\uff1b\u68c0\u6d4b\u6210\u529f\u540e\u624d\u4f1a\u5199\u5165\u73af\u5883\u3002'); note.dataset.proxyFor = textarea.id;
  const field = textarea.closest('label') || textarea; field.before(label, note);
}
installProxyTypeControl('#batch-add-proxies', 'batch-add-proxy-type');
installProxyTypeControl('#batch-proxy-list', 'batch-update-proxy-type');
function installBatchUpdateNetworkMode() {
  const textarea = $('#batch-proxy-list'); const form = $('#batch-update-form'); if (!textarea || !form || $('#batch-update-network-mode')) return;
  const label = document.createElement('label'); label.textContent = '\u7f51\u7edc\u6a21\u5f0f';
  const select = document.createElement('select'); select.id = 'batch-update-network-mode';
  for (const [value, text] of [['proxy', '\u5bfc\u5165\u4ee3\u7406\uff08\u6bcf\u4e2a\u73af\u5883\u4e00\u4e2a IP\uff09'], ['direct', '\u672c\u5730\u76f4\u8fde\uff08\u4e0d\u4f7f\u7528\u4ee3\u7406\uff09']]) { const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option); }
  label.append(select); form.querySelector('[data-proxy-for="batch-proxy-list"]').before(label);
  const update = () => {
    const direct = select.value === 'direct'; textarea.disabled = direct; textarea.closest('label').hidden = direct;
    form.querySelectorAll('[data-proxy-for="batch-proxy-list"]').forEach((item) => { item.hidden = direct; });
    const submit = form.querySelector('button.primary[value="default"]'); if (submit) submit.textContent = direct ? '\u5e94\u7528\u672c\u5730\u76f4\u8fde' : '\u68c0\u6d4b\u5e76\u5e94\u7528\u4ee3\u7406';
  };
  select.addEventListener('change', update); update();
}
installBatchUpdateNetworkMode();
renderSpecifiedTextGroups();

async function runSyncAction(label, action) {
  try {
    const result = await action(); log('Sync', label + ' · ' + JSON.stringify(result));
    if (result?.success === false) {
      const failures = Array.isArray(result.failures) ? result.failures : [];
      const failed = failures.map((item) => specifiedTextFailureLabel(item.id)).join('、');
      toast(label + '仅完成 ' + (result.profiles?.length || 0) + ' 个环境' + (failed ? '；失败环境：' + failed : ''));
      await refreshSessions(); return result;
    }
    toast(label + '完成'); await refreshSessions(); return result;
  }
  catch (error) { log('Error', error.message); toast(error.message); return null; }
}

function renderLogs() { const target = $('#log-list'); target.replaceChildren(); for (const item of ui.logs) { const row = element('div', 'log-row'); row.append(element('span', '', item.time), element('span', '', item.module), element('span', '', item.message)); target.append(row); } }

$('#theme-trigger').addEventListener('click', (event) => {
  event.stopPropagation();
  const popover = $('#theme-popover'); const open = popover.hidden;
  popover.hidden = !open; $('#theme-trigger').setAttribute('aria-expanded', String(open));
});

document.addEventListener('click', async (event) => {
  const themeOption = event.target.closest('[data-theme-option]');
  if (themeOption) { applyTheme(themeOption.dataset.themeOption); $('#theme-popover').hidden = true; $('#theme-trigger').setAttribute('aria-expanded', 'false'); }
  else if (!event.target.closest('#theme-picker')) { $('#theme-popover').hidden = true; $('#theme-trigger').setAttribute('aria-expanded', 'false'); }
  const nav = event.target.closest('[data-view]'); if (nav) switchView(nav.dataset.view);
  const action = event.target.closest('[data-action]'); if (action?.dataset.action === 'start') startProfile(action.dataset.id); if (action?.dataset.action === 'stop') stopProfile(action.dataset.id); if (action?.dataset.action === 'edit') openProfileEditor(action.dataset.id); if (action?.dataset.action === 'select-sync') { selectedSessions.add(action.dataset.id); pushSyncSelection(); switchView('sync'); }
  const assign = event.target.closest('[data-extension-assign]'); if (assign) openAssign(assign.dataset.extensionAssign);
  const remove = event.target.closest('[data-extension-remove]'); if (remove) { try { await window.ops.removeExtension(remove.dataset.extensionRemove); await refreshExtensions(); } catch (error) { toast(error.message); } }
  const windowButton = event.target.closest('[data-window]'); if (windowButton) runSyncAction('窗口操作', () => window.ops.windowAction(selectedSessionIds(), windowButton.dataset.window));
  const masterSelect = event.target.closest('[data-master-select]'); if (masterSelect && !syncState.active && selectedSessions.has(masterSelect.dataset.masterSelect)) { preferredMasterId = masterSelect.dataset.masterSelect; pushSyncSelection(); renderSessions(); }
  const showWindow = event.target.closest('[data-show-window]'); if (showWindow) runSyncAction('\u663e\u793a\u7a97\u53e3', () => window.ops.windowAction([showWindow.dataset.showWindow], 'normal'));
  const proxyCheck = event.target.closest('[data-proxy-check]'); if (proxyCheck) checkProfileProxy(proxyCheck.dataset.proxyCheck);
  const consoleButton = event.target.closest('[data-console]'); if (consoleButton) { $$('.console-tabs button').forEach((button) => button.classList.toggle('active', button === consoleButton)); $$('.console-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `console-${consoleButton.dataset.console}`)); }
});

document.addEventListener('change', async (event) => {
  if (event.target.dataset.extensionToggle) {
    const input = event.target; input.disabled = true;
    try { toast(input.checked ? '正在批量启用扩展并重启运行环境...' : '正在批量停用扩展并重启运行环境...'); const result = await window.ops.toggleExtensionAll(input.dataset.extensionToggle, input.checked); await refreshExtensions(); await refreshStatus(); await refreshSessions(); toast(`已${input.checked ? '启用' : '停用'}，影响 ${result.affected} 个环境，重启 ${result.restarted} 个`); }
    catch (error) { input.checked = !input.checked; toast(error.message); } finally { input.disabled = false; }
  }
  if (event.target.dataset.profileSelect) { event.target.checked ? selectedProfiles.add(event.target.dataset.profileSelect) : selectedProfiles.delete(event.target.dataset.profileSelect); }
  if (event.target.dataset.sessionSelect && !syncState.active) { event.target.checked ? selectedSessions.add(event.target.dataset.sessionSelect) : selectedSessions.delete(event.target.dataset.sessionSelect); if (!selectedSessions.has(preferredMasterId)) preferredMasterId = [...selectedSessions][0] || null; pushSyncSelection(); renderSessions(); }
});

$('#select-all-profiles').addEventListener('change', (event) => { for (const id of visibleProfilePageIds()) event.target.checked ? selectedProfiles.add(id) : selectedProfiles.delete(id); renderProfiles(); });
$('#select-all-sessions').addEventListener('change', (event) => { if (syncState.active) return; const group = $('#sync-group').value || 'all'; const visible = group === 'all' ? sessions : sessions.filter((item) => String(item.profile?.tag || '未分组') === group); for (const item of visible) event.target.checked ? selectedSessions.add(item.id) : selectedSessions.delete(item.id); if (!selectedSessions.has(preferredMasterId)) preferredMasterId = [...selectedSessions][0] || null; pushSyncSelection(); renderSessions(); });
$('#sync-group').addEventListener('change', () => { if (syncState.active) return; const group = $('#sync-group').value || 'all'; const values = group === 'all' ? sessions : sessions.filter((item) => String(item.profile?.tag || '未分组') === group); selectedSessions = new Set(values.map((item) => item.id)); preferredMasterId = values[0]?.id || null; pushSyncSelection(); renderSessions(); });
$('#profile-search').addEventListener('input', () => { profilePage = 1; renderProfiles(); }); $('#extension-search').addEventListener('input', renderExtensions);
$('#profile-page-size').addEventListener('change', (event) => { const value = Number(event.target.value); profilePageSize = PROFILE_PAGE_SIZES.includes(value) ? value : 10; profilePage = 1; try { localStorage.setItem(PROFILE_PAGE_SIZE_KEY, String(profilePageSize)); } catch (_) {} renderProfiles(); });
$('#profile-prev').addEventListener('click', () => { profilePage = Math.max(1, profilePage - 1); renderProfiles(); });
$('#profile-next').addEventListener('click', () => { profilePage += 1; renderProfiles(); });
$('#profile-page').addEventListener('change', (event) => { profilePage = Math.max(1, Number.parseInt(event.target.value, 10) || 1); renderProfiles(); });
function openCreateProfileDialog() {
  const number = nextProfileNumber(); const form = $('#profile-form'); form.elements.name.value = String(number); form.elements.name.readOnly = true; $('#profile-dialog').showModal();
}
$('#create-profile').addEventListener('click', openCreateProfileDialog); $('#quick-create').addEventListener('click', openCreateProfileDialog);
$('#profile-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (event.submitter?.value === 'cancel') return $('#profile-dialog').close();
  const form = event.currentTarget; const data = new FormData(form); const number = nextProfileNumber(); const previousNext = ui.nextProfileNumber;
  const profile = { id: createInternalProfileId(number), number, name: String(number), browser: data.get('browser'), language: data.get('language'), proxy: String(data.get('proxy') || 'Direct'), tag: String(data.get('tag') || 'Default'), os: 'Windows', location: 'Local' };
  ui.profiles.push(profile); ui.nextProfileNumber = number + 1; save();
  try {
    await window.ops.syncProfiles(ui.profiles); $('#profile-dialog').close(); form.reset(); await refreshStatus(); log('Profile', '创建环境 ' + number);
  } catch (error) {
    ui.profiles = ui.profiles.filter((item) => item.id !== profile.id); ui.nextProfileNumber = previousNext; save(); toast('创建失败：' + error.message);
  }
});

$$('[data-editor-tab]').forEach((button) => button.addEventListener('click', () => setEditorTab(button.dataset.editorTab)));
$('#editor-back').addEventListener('click', () => { editingProfileId = null; editorNetworkResult = null; switchView('profiles'); });
$('#editor-cancel').addEventListener('click', () => { editingProfileId = null; editorNetworkResult = null; switchView('profiles'); });
$('#editor-test-proxy').addEventListener('click', testEditorProxy);
$('#editor-system-defaults').addEventListener('click', useSystemEditorDefaults);
const editorProxySelector = '#editor-proxy-type,#editor-proxy-host,#editor-proxy-port,#editor-proxy-user,#editor-proxy-password,input[name="editor-network"]';
const onEditorFormChange = (event) => {
  if (event.target.matches(editorProxySelector)) {
    editorNetworkResult = null;
    $('#editor-proxy-result').className = 'proxy-test-result';
    $('#editor-proxy-result').textContent = editorSelectedNetwork() === 'direct' ? '本地直连' : '设置已更改，请重新检测';
  }
  updateEditorVisibility(); renderEditorSummary();
};
$('#profile-editor-form').addEventListener('input', onEditorFormChange);
$('#profile-editor-form').addEventListener('change', onEditorFormChange);
$('#profile-editor-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const index = ui.profiles.findIndex((item) => item.id === editingProfileId); if (index < 0) return toast('环境不存在');
  try {
    const previous = ui.profiles[index]; const draft = editorDraft(true); if (!draft.name) throw new Error('环境名称不能为空');
    if (draft.proxy !== previous.proxy && !editorNetworkResult) { delete draft.exitIp; delete draft.exitCountryCode; delete draft.exitTimezone; delete draft.exitLatitude; delete draft.exitLongitude; delete draft.exitCheckedAt; }
    ui.profiles[index] = draft; save(); engineProfiles = await window.ops.syncProfiles(ui.profiles); renderProfiles();
    const running = profileEngine(draft.id).running; log('Profile', '已更新环境 ' + displayProfileNumber(draft)); editingProfileId = null; editorNetworkResult = null; switchView('profiles'); toast(running ? '设置已保存，请重启该环境后生效' : '环境设置已保存');
  } catch (error) { toast('保存失败：' + error.message); }
});

$('#batch-add').addEventListener('click', () => { $('#batch-add-start').value = String(nextProfileNumber()); $('#batch-add-dialog').showModal(); });
$('#batch-add-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (event.submitter?.value === 'cancel') return $('#batch-add-dialog').close();
  const count = Number.parseInt($('#batch-add-count').value, 10); const start = nextProfileNumber(); const previousNext = ui.nextProfileNumber;
  const language = $('#batch-add-language').value; const tag = $('#batch-add-tag').value.trim() || '批量创建';
  let proxies;
  try { proxies = proxyLines('#batch-add-proxies', '#batch-add-proxy-type'); } catch (error) { return toast('\u4ee3\u7406\u683c\u5f0f\u9519\u8bef\uff1a' + error.message); }
  if (!Number.isInteger(count) || count < 1 || count > 200) return toast('新增数量必须为 1-200');
  if (proxies.length && proxies.length !== count) return toast('\u4ee3\u7406\u6570\u91cf\u5fc5\u987b\u7b49\u4e8e\u65b0\u589e\u73af\u5883\u6570\u91cf\uff0c\u6bcf\u4e2a\u73af\u5883\u5bf9\u5e94\u4e00\u6761\u4ee3\u7406');
  const used = new Set(ui.profiles.map((item) => item.id)); const created = [];
  while (created.length < count) {
    const number = start + created.length; const id = createInternalProfileId(number, used); used.add(id);
    created.push({ id, number, name: String(number), browser: 'Google Chrome', language, proxy: proxies.length ? proxies[created.length] : 'Direct', tag, os: 'Windows', location: 'Local' });
  }
  try {
    const verified = proxies.length ? await verifyProxyAssignments(created, proxies) : [];
    created.forEach((profile, index) => {
      const result = verified[index]; if (!result) return;
      profile.exitIp = result.ip; profile.exitCountryCode = result.countryCode; profile.exitTimezone = result.timezone || ''; profile.exitLatitude = result.latitude; profile.exitLongitude = result.longitude; profile.exitCheckedAt = result.checkedAt;
    });
    ui.profiles.push(...created); ui.nextProfileNumber = start + created.length; save(); engineProfiles = await window.ops.syncProfiles(ui.profiles);
    selectedProfiles = new Set(created.map((item) => item.id)); $('#select-all-profiles').checked = false; $('#batch-add-dialog').close(); $('#batch-add-proxies').value = '';
    await refreshStatus(); await refreshExtensions(); renderProfiles(); log('Batch', '批量新增 ' + created.length + ' 个环境'); toast('已批量创建 ' + created.length + ' 个环境');
  } catch (error) {
    ui.profiles = ui.profiles.filter((item) => !created.some((createdItem) => createdItem.id === item.id)); ui.nextProfileNumber = previousNext; save(); toast('批量新增失败：' + error.message);
  }
});
$('#delete-selected').addEventListener('click', async () => {
  pendingDeleteProfiles = ui.profiles.filter((item) => selectedProfiles.has(item.id)).map((item) => item.id);
  if (!pendingDeleteProfiles.length) return toast('请先勾选要删除的环境');
  try {
    const status = await window.ops.profileStatus(); const running = status.filter((item) => item.running && pendingDeleteProfiles.includes(item.id)).length;
    $('#batch-delete-summary').textContent = '已选择 ' + pendingDeleteProfiles.length + ' 个环境，其中 ' + running + ' 个正在运行。'; $('#batch-delete-dialog').showModal();
  } catch (error) { toast(error.message); }
});
$('#batch-delete-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (event.submitter?.value === 'cancel') { pendingDeleteProfiles = []; return $('#batch-delete-dialog').close(); }
  const ids = [...pendingDeleteProfiles]; if (!ids.length) return $('#batch-delete-dialog').close();
  const submitter = event.submitter; if (submitter) submitter.disabled = true;
  try {
    const result = await window.ops.deleteProfiles(ids, $('#batch-delete-data').checked);
    ui.profiles = ui.profiles.filter((item) => !ids.includes(item.id)); for (const id of ids) { selectedProfiles.delete(id); selectedSessions.delete(id); }
    pendingDeleteProfiles = []; save(); $('#select-all-profiles').checked = false; $('#batch-delete-dialog').close();
    await refreshStatus(); await refreshSessions(); await refreshExtensions(); renderProfiles(); log('Batch', '批量删除 ' + result.deleted + ' 个环境'); toast('已删除 ' + result.deleted + ' 个环境');
  } catch (error) { toast('批量删除失败：' + error.message); } finally { if (submitter) submitter.disabled = false; }
});
$('#start-selected').addEventListener('click', async () => { if (!selectedProfiles.size) return toast('请先选择环境'); for (const id of selectedProfiles) await startProfile(id); });
$('#stop-selected').addEventListener('click', async () => { if (!selectedProfiles.size) return toast('请先选择环境'); for (const id of selectedProfiles) await stopProfile(id); });
$('#add-extension').addEventListener('click', () => $('#add-app-dialog').showModal());
$('#close-add-app').addEventListener('click', () => $('#add-app-dialog').close());
$('#cancel-add-app').addEventListener('click', () => $('#add-app-dialog').close());
$('#choose-extension-folder').addEventListener('click', async () => {
  try {
    const result = await window.ops.addExtensionFolder();
    if (!result.canceled) { await refreshExtensions(); await refreshStatus(); await refreshSessions(); $('#add-app-dialog').close(); log('Extension', `添加 ${result.extension.name}，默认分配 ${result.assigned || 0} 个环境，重启 ${result.restarted || 0} 个`); toast(`已添加 ${result.extension.name}，默认启用 ${result.assigned || 0}/${ui.profiles.length}`); }
  } catch (error) { toast(error.message); }
});
$('#add-store-submit').addEventListener('click', async () => {
  const url = $('#chrome-store-url').value.trim();
  if (!url) return toast('请输入 Chrome 应用商店 URL');
  const all = $('#store-assign-all').checked; const ids = all ? ui.profiles.map((item) => item.id) : [];
  try {
    toast('正在从 Chrome 应用商店获取扩展...');
    const result = await window.ops.addExtensionStore(url, ids, all);
    await refreshExtensions(); await refreshStatus(); await refreshSessions();
    $('#add-app-dialog').close(); $('#chrome-store-url').value = '';
    log('Extension', '商店添加 ' + result.extension.name + ', 分配 ' + result.assigned + ', 重启 ' + result.restarted);
    toast('已添加 ' + result.extension.name + '，分配 ' + result.assigned + ' 个环境');
  } catch (error) { toast('商店添加失败：' + error.message); }
});
$('#refresh-extensions').addEventListener('click', refreshExtensions); $('#assign-extension').addEventListener('click', (event) => { event.preventDefault(); applyAssignment(true); }); $('#unassign-extension').addEventListener('click', (event) => { event.preventDefault(); applyAssignment(false); });
$('#refresh-sessions').addEventListener('click', refreshSessions);
$('#start-sync').addEventListener('click', () => runSyncAction('\u542f\u52a8\u540c\u6b65', () => window.ops.startSync(selectedSessionIds(2))));
$('#stop-sync').addEventListener('click', () => runSyncAction('\u505c\u6b62\u540c\u6b65', () => window.ops.stopSync()));
$('#restart-sync').addEventListener('click', () => runSyncAction('\u91cd\u542f\u540c\u6b65', () => window.ops.restartSync()));
async function sendSameText() { const [delayMin, delayMax] = textDelayRange(); return runSyncAction('\u6587\u672c\u8f93\u5165', () => window.ops.textAction(selectedSessionIds(), 'insert', $('#sync-text').value, delayMin, delayMax)); }
async function sendRandomNumbers() {
  let ids; try { ids = specifiedTextSessionIds(); } catch (error) { return toast(error.message); }
  let min = Number($('#random-number-min').value), max = Number($('#random-number-max').value); if (!Number.isFinite(min) || !Number.isFinite(max)) return toast('\u8bf7\u8f93\u5165\u6709\u6548\u7684\u6570\u5b57\u8303\u56f4'); if (max < min) [min, max] = [max, min];
  const decimals = Math.max((String($('#random-number-min').value).split('.')[1] || '').length, (String($('#random-number-max').value).split('.')[1] || '').length);
  const texts = ids.map(() => (min + Math.random() * (max - min)).toFixed(Math.min(8, decimals)));
  const [delayMin, delayMax] = textDelayRange(); return runSyncAction('\u968f\u673a\u6570\u5b57\u8f93\u5165', () => window.ops.batchTextAction(ids, texts, delayMin, delayMax));
}
$('#send-text').addEventListener('click', sendSameText);
$('#send-random-number').addEventListener('click', sendRandomNumbers);
$('#sync-settings-button').addEventListener('click', () => { fillSyncSettingsForm(); $('#sync-settings-dialog').showModal(); });
$('#sync-settings-form').addEventListener('submit', async (event) => { if (event.submitter?.value === 'cancel') return; event.preventDefault(); await applySyncSettings(syncSettingsFromForm(), true); $('#sync-settings-dialog').close(); });
$('#delay-input').addEventListener('change', () => applySyncSettings({ ...syncSettings, delayInput: $('#delay-input').checked }));
$('#delay-click').addEventListener('change', () => applySyncSettings({ ...syncSettings, delayClick: $('#delay-click').checked }));
$('#clear-text').addEventListener('click', () => runSyncAction('清空内容', () => window.ops.textAction(selectedSessionIds(), 'clear', '', 0, 0)));
$('#add-specified-text-group').addEventListener('click', () => {
  if (specifiedTextGroups.length >= SPECIFIED_TEXT_GROUP_LIMIT) return toast('\u6700\u591a\u6dfb\u52a0 ' + SPECIFIED_TEXT_GROUP_LIMIT + ' \u4e2a\u6587\u672c\u7ec4');
  specifiedTextGroups.push(createSpecifiedTextGroup(specifiedTextGroups.length)); saveSpecifiedTextGroups(); renderSpecifiedTextGroups();
});
$('#specified-text-groups').addEventListener('input', (event) => {
  const id = event.target.dataset.specifiedText; if (!id) return;
  const group = specifiedTextGroups.find((item) => item.id === id); if (!group) return;
  group.text = event.target.value.slice(0, 500000); group.cursor = Math.min(group.cursor, Math.max(0, specifiedTextItems(group.text).length - 1)); saveSpecifiedTextGroups();
  const counter = document.querySelector('[data-specified-count="' + id + '"]'); if (counter) counter.textContent = specifiedTextItems(group.text).length + ' \u6761\u6587\u672c';
});
$('#specified-text-groups').addEventListener('change', (event) => {
  const id = event.target.dataset.specifiedMode; if (!id) return;
  const group = specifiedTextGroups.find((item) => item.id === id); if (!group) return;
  group.mode = event.target.value === 'random' ? 'random' : 'sequence'; group.cursor = 0; saveSpecifiedTextGroups();
});
$('#specified-text-groups').addEventListener('click', (event) => {
  const send = event.target.closest('[data-specified-send]'); if (send) return sendSpecifiedTextGroup(send.dataset.specifiedSend);
  const remove = event.target.closest('[data-specified-remove]'); if (!remove || specifiedTextGroups.length <= 1) return;
  specifiedTextGroups = specifiedTextGroups.filter((item) => item.id !== remove.dataset.specifiedRemove); saveSpecifiedTextGroups(); renderSpecifiedTextGroups();
});
$('#new-tab').addEventListener('click', () => runSyncAction('新建标签页', () => window.ops.tabAction(selectedSessionIds(), 'new', { url: normalizeUrl($('#tab-url').value) })));
$('#navigate-tab').addEventListener('click', () => runSyncAction('批量导航', () => window.ops.tabAction(selectedSessionIds(), 'navigate', { url: normalizeUrl($('#tab-url').value) })));
$('#reload-tab').addEventListener('click', () => runSyncAction('刷新标签页', () => window.ops.tabAction(selectedSessionIds(), 'reload', {})));
$('#close-tab').addEventListener('click', () => runSyncAction('关闭标签页', () => window.ops.tabAction(selectedSessionIds(), 'close', {})));
$('#sync-tabs').addEventListener('click', () => runSyncAction('同步标签页', () => window.ops.tabAction(selectedSessionIds(2), 'sync', {})));
$('#clear-logs').addEventListener('click', () => { ui.logs = []; save(); renderLogs(); });
$('#choose-profile-storage').addEventListener('click', chooseProfileStorage);
$('#reset-profile-storage').addEventListener('click', resetProfileStorage);
$('#open-profile-storage').addEventListener('click', async () => { try { await window.ops.openProfileStorage(); } catch (error) { toast(error.message); log('Error', error.message); } });

async function copyIntegrationValue(value, successMessage) {
  if (!value) return toast('没有可复制的内容');
  await window.ops.copyText(String(value));
  toast(successMessage || '已复制');
}

function renderApiInfo(info) {
  apiInfo = info || null;
  if (!apiInfo) return;
  const running = Boolean(apiInfo.running);
  $('#api-enabled').checked = Boolean(apiInfo.enabled);
  $('#api-status-dot').classList.toggle('running', running);
  $('#api-status-dot').classList.toggle('failed', Boolean(apiInfo.enabled && !running));
  $('#api-status-text').textContent = running ? '接口运行中' : apiInfo.enabled ? '接口启动失败' : '接口已停用';
  $('#api-security-summary').textContent = apiInfo.lastError ? apiInfo.lastError : '仅本机 · 强制 Key · 每分钟限流';
  $('#api-url').textContent = apiInfo.url || '';
  $('#api-key').value = apiInfo.apiKey || '';
  $('#mcp-config').textContent = apiInfo.mcpConfig || '';
  $('#skill-path').textContent = apiInfo.skillPath || '';
  $('#skill-install-agents').textContent = apiInfo.installCommands?.agents || '';
  $('#skill-install-openclaw').textContent = apiInfo.installCommands?.openclaw || '';
  $('#skill-install-hermes').textContent = apiInfo.installCommands?.hermes || '';
}

async function refreshApiInfo() {
  try { renderApiInfo(await window.ops.getApiInfo()); }
  catch (error) { $('#api-status-text').textContent = '接口信息读取失败'; $('#api-security-summary').textContent = error.message; }
}

$('#api-enabled').addEventListener('change', async (event) => {
  const input = event.currentTarget; input.disabled = true;
  try { renderApiInfo(await window.ops.setApiEnabled(input.checked)); toast(input.checked ? 'Local API 已启用' : 'Local API 已停用'); }
  catch (error) { input.checked = !input.checked; toast('切换接口失败：' + error.message); }
  finally { input.disabled = false; }
});
$('#copy-api-url').addEventListener('click', () => copyIntegrationValue(apiInfo?.url, '接口地址已复制'));
$('#copy-api-key').addEventListener('click', () => copyIntegrationValue(apiInfo?.apiKey, 'API Key 已复制，请勿上传或分享'));
$('#toggle-api-key').addEventListener('click', () => {
  const field = $('#api-key'); const visible = field.type === 'text'; field.type = visible ? 'password' : 'text'; $('#toggle-api-key').textContent = visible ? '显示' : '隐藏';
});
$('#reset-api-key').addEventListener('click', async () => {
  if (!window.confirm('重置后，旧 Key 会立即失效。确定继续吗？')) return;
  try { renderApiInfo(await window.ops.resetApiKey()); toast('API Key 已重置'); }
  catch (error) { toast('重置失败：' + error.message); }
});
$('#copy-mcp-config').addEventListener('click', () => copyIntegrationValue(apiInfo?.mcpConfig, 'MCP 配置已复制'));
$('#copy-skill-path').addEventListener('click', () => copyIntegrationValue(apiInfo?.skillPath, 'Skill 路径已复制'));
$('#copy-skill-install-agents').addEventListener('click', () => copyIntegrationValue(apiInfo?.installCommands?.agents, '通用 Skill 安装命令已复制'));
$('#copy-skill-install-openclaw').addEventListener('click', () => copyIntegrationValue(apiInfo?.installCommands?.openclaw, 'OpenClaw 安装命令已复制'));
$('#copy-skill-install-hermes').addEventListener('click', () => copyIntegrationValue(apiInfo?.installCommands?.hermes, 'Hermes 安装命令已复制'));
$('#open-skill-folder').addEventListener('click', async () => { try { await window.ops.openSkillFolder(); } catch (error) { toast(error.message); } });
$$('[data-automation-tab]').forEach((button) => button.addEventListener('click', () => {
  $$('[data-automation-tab]').forEach((item) => item.classList.toggle('active', item === button));
  $$('.api-code').forEach((panel) => panel.classList.toggle('active', panel.id === 'automation-' + button.dataset.automationTab));
}));

window.ops.onEvent(async (value) => {
  if (value.type === 'profiles') { await refreshStatus(true); await refreshSessions(); await refreshExtensions(); }
  if (value.type === 'api-settings' && value.info) renderApiInfo(value.info);
  if (value.type === 'status') { await refreshStatus(); await refreshSessions(); }
  if (value.type === 'extensions') await refreshExtensions();
  if (value.type === 'storage-settings') updateProfileStorageDisplay(value.profileRoot);
  if (value.type === 'sync-settings' && value.settings) { syncSettings = normalizeSyncSettings(value.settings); fillSyncSettingsForm(); }
  if (value.type === 'text-shortcut') {
    if (value.action === 'random-number') sendRandomNumbers();
    else if (value.action === 'same-text') sendSameText();
    else if (value.action === 'specified-text' && specifiedTextGroups[0]) sendSpecifiedTextGroup(specifiedTextGroups[0].id);
  }
  if (value.type === 'sync-state') {
    syncState = { active: value.active, master: value.master, selected: value.selected || [] };
    if (value.active) { preferredMasterId = value.master; selectedSessions = new Set(value.selected || []); syncHealth.recovering = false; }
    else syncHealth = { queueDepth: 0, coalesced: 0, dropped: 0, lastLatencyMs: 0, recovering: false };
    renderSessions(); log('Sync', value.active ? '同步已启动' : '同步已停止');
  }
  if (value.type === 'sync-health') { syncHealth = { ...syncHealth, ...value, recovering: false }; renderSyncState(); }
  if (value.type === 'sync-recovering') { syncHealth.recovering = true; renderSyncState(); log('Sync', `输入桥自动恢复，第 ${value.attempt} 次`); }
  if (value.type === 'native-input' && value.active) { syncHealth.recovering = false; renderSyncState(); }
  if (value.type === 'sync-error') { toast(value.message); log('Error', value.message); }
  if (value.type === 'sync-disconnected') { toast(value.message); log('Sync', value.message); }
});

window.ops.onEvent((value) => { if (value.type === 'proxy-error') { const profile = ui.profiles.find((item) => item.id === value.id); const message = '\u73af\u5883 ' + displayProfileNumber(profile || { id: value.id }) + '\uff1a' + value.message; toast(message); log('Proxy', message); } });

function updateProfileStorageDisplay(profileRoot) {
  const value = String(profileRoot || '');
  const current = $('#profile-storage-path'); if (current) current.textContent = value;
  const runtimeValue = document.querySelector('[data-runtime-key="Profile root"]'); if (runtimeValue) runtimeValue.textContent = value;
}

function renderRuntimeInfo(info) {
  const runtime = $('#runtime-info'); runtime.replaceChildren();
  for (const [key, value] of [['App', info.appVersion], ['Electron', info.electron], ['Chromium', info.chrome], ['Profile root', info.profileRoot]]) {
    const row = document.createElement('div'); const output = element('dd', '', value); output.dataset.runtimeKey = key;
    row.append(element('dt', '', key), output); runtime.append(row);
  }
  updateProfileStorageDisplay(info.profileRoot);
}

async function chooseProfileStorage() {
  const button = $('#choose-profile-storage'); button.disabled = true;
  try {
    const result = await window.ops.chooseProfileStorage(); if (result.canceled) return;
    updateProfileStorageDisplay(result.profileRoot); log('System', '\u73af\u5883\u6570\u636e\u4f4d\u7f6e\u5df2\u66f4\u6539\u4e3a ' + result.profileRoot); toast('\u73af\u5883\u6570\u636e\u4f4d\u7f6e\u5df2\u66f4\u6539\uff0c\u4e0b\u6b21\u542f\u52a8\u73af\u5883\u65f6\u751f\u6548');
  } catch (error) { toast(error.message); log('Error', error.message); } finally { button.disabled = false; }
}

async function resetProfileStorage() {
  const button = $('#reset-profile-storage'); button.disabled = true;
  try {
    const result = await window.ops.resetProfileStorage(); updateProfileStorageDisplay(result.profileRoot); log('System', '\u73af\u5883\u6570\u636e\u4f4d\u7f6e\u5df2\u6062\u590d\u9ed8\u8ba4'); toast('\u5df2\u6062\u590d\u9ed8\u8ba4\u6570\u636e\u4f4d\u7f6e');
  } catch (error) { toast(error.message); log('Error', error.message); } finally { button.disabled = false; }
}
async function initialize() {
  const info = await window.ops.getInfo(); $('#browser-summary').textContent = info.browsers.map((item) => item.name).join(' · ') || '未找到浏览器';
  renderRuntimeInfo(info);
  syncState = await window.ops.getSyncState(); preferredMasterId = syncState.master || null; if (syncState.active) selectedSessions = new Set(syncState.selected || []);
  await applySyncSettings(syncSettings); fillSyncSettingsForm();
  ui.profiles = ui.profiles.map((item) => ({ ...item, browser: 'Google Chrome' })); save();
  engineProfiles = await window.ops.syncProfiles(ui.profiles); syncUiProfilesFromEngine(); await refreshExtensions(); await refreshSessions(); await refreshApiInfo(); renderProfiles(); renderLogs(); log('System', `V15 引擎启动 · ${info.browsers.length} 个浏览器可用`);
}
initialize().catch((error) => { log('Error', error.message); toast(error.message); });


function parseCsvLine(line) {
  const values = []; let current = ''; let quoted = false;
  for (let index = 0; index < line.length; index += 1) { const char = line[index]; if (char === '"' && line[index + 1] === '"') { current += '"'; index += 1; } else if (char === '"') quoted = !quoted; else if (char === ',' && !quoted) { values.push(current.trim()); current = ''; } else current += char; }
  values.push(current.trim()); return values;
}

function parseImportedProfiles(text, extension) {
  if (extension === 'json') { const values = JSON.parse(text); if (!Array.isArray(values)) throw new Error('\u5bfc\u5165 JSON \u5fc5\u987b\u662f\u6570\u7ec4'); return values; }
  const lines = text.split(/\r?\n/).filter((line) => line.trim()); if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map((item) => item.toLowerCase());
  return lines.slice(1).map((line, row) => { const values = parseCsvLine(line); const item = Object.fromEntries(headers.map((key, index) => [key, values[index] || ''])); return { id: item.id || 'env-import-' + Date.now().toString(36) + '-' + row, name: item.name || item.id || 'Imported ' + (row + 1), browser: item.browser || 'Google Chrome', language: item.language || 'en-US', proxy: item.proxy || item.ip || 'Direct', proxyType: item.proxytype || '', exitIp: item.ip || '', exitCountryCode: item.countrycode || '', tag: item.tag || item.group || 'Imported', os: 'Windows', location: item.location || 'Local' }; });
}

$('#batch-import').addEventListener('click', () => $('#batch-import-file').click());
$('#batch-import-file').addEventListener('change', async (event) => {
  const file = event.target.files[0]; if (!file) return;
  const previousLength = ui.profiles.length; const previousNext = ui.nextProfileNumber;
  try {
    const extension = file.name.toLowerCase().endsWith('.json') ? 'json' : 'csv'; const imported = parseImportedProfiles(await file.text(), extension);
    const start = nextProfileNumber(); const used = new Set(ui.profiles.map((item) => item.id));
    const normalized = imported.map((item, index) => { const number = start + index; const id = createInternalProfileId(number, used); used.add(id); return { id, number, name: String(number), browser: 'Google Chrome', language: String(item.language || 'en-US'), proxy: String(item.proxy || item.ip || 'Direct'), proxyType: String(item.proxyType || item.proxytype || ''), exitIp: String(item.exitIp || item.ip || ''), exitCountryCode: String(item.exitCountryCode || item.countrycode || ''), tag: String(item.tag || item.group || 'Imported'), os: 'Windows', location: String(item.location || 'Local') }; });
    ui.profiles.push(...normalized); ui.nextProfileNumber = start + normalized.length; save(); engineProfiles = await window.ops.syncProfiles(ui.profiles); renderProfiles(); log('Import', '\u6279\u91cf\u5bfc\u5165 ' + normalized.length + ' \u4e2a\u73af\u5883'); toast('\u5df2\u5bfc\u5165 ' + normalized.length + ' \u4e2a\u73af\u5883');
  } catch (error) { ui.profiles = ui.profiles.slice(0, previousLength); ui.nextProfileNumber = previousNext; save(); toast('\u5bfc\u5165\u5931\u8d25\uff1a' + error.message); }
  event.target.value = '';
});

$('#batch-update').addEventListener('click', () => { if (!selectedProfiles.size) return toast('\u8bf7\u5148\u9009\u62e9\u73af\u5883'); $('#batch-update-dialog').showModal(); });
$('#batch-update-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (event.submitter?.value === 'cancel') return $('#batch-update-dialog').close();
  const ids = ui.profiles.filter((profile) => selectedProfiles.has(profile.id)).map((profile) => profile.id);
  const profiles = ids.map((id) => ui.profiles.find((profile) => profile.id === id));
  const direct = $('#batch-update-network-mode').value === 'direct'; let proxies; let verified;
  if (direct) { proxies = profiles.map(() => 'Direct'); verified = profiles.map(() => null); }
  else {
    try { proxies = proxyLines('#batch-proxy-list', '#batch-update-proxy-type'); }
    catch (error) { return toast('\u4ee3\u7406\u683c\u5f0f\u9519\u8bef\uff1a' + error.message); }
    if (proxies.length !== profiles.length) return toast('\u4ee3\u7406\u6570\u91cf\u5fc5\u987b\u4e0e\u6240\u9009\u73af\u5883\u6570\u91cf\u4e00\u81f4');
    try { verified = await verifyProxyAssignments(profiles, proxies); }
    catch (error) { log('Proxy', '\u6279\u91cf\u66f4\u65b0\u9884\u68c0\u5931\u8d25 \u00b7 ' + error.message); toast('\u4ee3\u7406\u68c0\u6d4b\u5931\u8d25\uff0c\u73af\u5883\u672a\u66f4\u65b0\uff1a' + error.message); return; }
  }
  const status = await window.ops.profileStatus(); const runningBefore = new Set(status.filter((item) => item.running && ids.includes(item.id)).map((item) => item.id));
  if ($('#restart-running').checked) for (const id of runningBefore) await window.ops.stopProfile(id);
  profiles.forEach((profile, index) => {
    profile.proxy = proxies[index]; const result = verified[index];
    if (result) { profile.exitIp = result.ip; profile.exitCountryCode = result.countryCode; profile.exitTimezone = result.timezone || ''; profile.exitLatitude = result.latitude; profile.exitLongitude = result.longitude; profile.exitCheckedAt = result.checkedAt; }
    else { delete profile.exitIp; delete profile.exitCountryCode; delete profile.exitTimezone; delete profile.exitLatitude; delete profile.exitLongitude; delete profile.exitCheckedAt; }
  });
  save(); engineProfiles = await window.ops.syncProfiles(ui.profiles);
  if ($('#restart-running').checked) for (const id of runningBefore) { const profile = ui.profiles.find((item) => item.id === id); if (profile) await window.ops.startProfile(profile); }
  $('#batch-update-dialog').close(); $('#batch-proxy-list').value = ''; await refreshStatus(); await refreshSessions(); renderProfiles();
  const modeText = direct ? '\u672c\u5730\u76f4\u8fde' : '\u5df2\u9a8c\u8bc1\u4ee3\u7406'; log('Batch', '\u6279\u91cf\u66f4\u65b0 ' + ids.length + ' \u4e2a\u73af\u5883 \u00b7 ' + modeText); toast('\u5df2\u5c06 ' + ids.length + ' \u4e2a\u73af\u5883\u66f4\u65b0\u4e3a' + modeText);
});
