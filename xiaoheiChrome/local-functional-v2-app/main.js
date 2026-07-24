const { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, screen, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { spawn } = require('child_process');
const cdp = require('./cdp');
const { BrowserEngine } = require('./engine');
const { LiveSyncController } = require('./live-sync-v5');
const { LocalApiServer } = require('./local-api');

// Keep the existing profile directory while presenting the new product name.
app.setName('小黑多开器');
app.setPath('userData', path.join(app.getPath('appData'), 'browserops-local-sync'));

const defaultProfileDataRoot = path.join(app.getPath('userData'), 'browser-profiles-v2');
const localSettingsFile = path.join(app.getPath('userData'), 'browserops-local-settings.json');
const apiSettingsFile = path.join(app.getPath('userData'), 'xiaohei-local-api.json');

function normalizeProfileDataRoot(value) {
  const raw = String(value || '').trim();
  return path.resolve(raw || defaultProfileDataRoot);
}

async function loadLocalSettings() {
  try {
    const saved = JSON.parse(await fsp.readFile(localSettingsFile, 'utf8'));
    return { profileDataRoot: normalizeProfileDataRoot(saved.profileDataRoot) };
  } catch (_) { return { profileDataRoot: defaultProfileDataRoot }; }
}

async function saveLocalSettings(value) {
  await fsp.mkdir(path.dirname(localSettingsFile), { recursive: true });
  const temporary = localSettingsFile + '.tmp';
  await fsp.writeFile(temporary, JSON.stringify({ version: 1, profileDataRoot: value.profileDataRoot }, null, 2), 'utf8');
  await fsp.rm(localSettingsFile, { force: true });
  await fsp.rename(temporary, localSettingsFile);
}

async function updateProfileDataRoot(value) {
  if (!engine) throw new Error('Browser engine is not ready');
  if (engine.running.size) throw new Error('\u8bf7\u5148\u505c\u6b62\u6240\u6709\u73af\u5883\uff0c\u518d\u4fee\u6539\u6570\u636e\u4fdd\u5b58\u4f4d\u7f6e');
  const profileDataRoot = normalizeProfileDataRoot(value);
  await fsp.mkdir(profileDataRoot, { recursive: true });
  engine.setProfileDataRoot(profileDataRoot);
  await saveLocalSettings({ profileDataRoot });
  emit({ type: 'storage-settings', profileRoot: profileDataRoot });
  return { success: true, profileRoot: profileDataRoot, defaultProfileRoot: defaultProfileDataRoot };
}

let engine;
let liveSync;
let localApi;
let quitting = false;
let syncSelection = [];
let syncState = { active: false, master: null, selected: [] };
const windows = new Set();
let mainWindow = null;
let shortcutBridge = null;
let shortcutFallbackRegistered = false;
let shortcutActionInFlight = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sanitizeIds(value) {
  if (!Array.isArray(value) || value.length > 200) throw new Error('Invalid profile selection');
  return [...new Set(value.map((id) => String(id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)).filter(Boolean))];
}

function emit(value) {
  for (const win of windows) if (!win.isDestroyed()) win.webContents.send('engine:event', value);
}

async function tile(ids, cascade = false) {
  const entries = engine.runningWithCdp(sanitizeIds(ids));
  if (!entries.length) throw new Error('No selected browser has a CDP session');
  const work = screen.getPrimaryDisplay().workArea;
  if (cascade) {
    const width = Math.max(760, work.width - 220); const height = Math.max(560, work.height - 180);
    await Promise.all(entries.map(({ item }, index) => cdp.setWindowBounds(item.port, { left: work.x + index * 38, top: work.y + index * 34, width, height })));
  } else {
    const cols = Math.ceil(Math.sqrt(entries.length)); const rows = Math.ceil(entries.length / cols);
    const width = Math.floor(work.width / cols); const height = Math.floor(work.height / rows);
    await Promise.all(entries.map(({ item }, index) => cdp.setWindowBounds(item.port, { left: work.x + (index % cols) * width, top: work.y + Math.floor(index / cols) * height, width, height })));
  }
  return { success: true, count: entries.length };
}

function isEnvironmentStartUrl(value) {
  return /browserops-start\.html/i.test(String(value || ''));
}

function environmentStartUrl(entry) {
  const root = entry?.item?.root || entry?.root;
  return root ? 'file:///' + path.join(root, 'browserops-start.html').replace(/\\/g, '/') : null;
}

async function syncTabsFromMaster(ids) {
  const entries = engine.runningWithCdp(sanitizeIds(ids));
  if (entries.length < 2) throw new Error('Select at least two running browser environments');
  const masterTabs = (await cdp.tabs(entries[0].item.port)).filter((tab) => !tab.url.startsWith('chrome://') && !tab.url.startsWith('edge://'));
  const urls = masterTabs.map((tab) => tab.url).filter(Boolean).slice(0, 20);
  for (const slave of entries.slice(1)) {
    const existing = (await cdp.tabs(slave.item.port)).filter((tab) => !tab.url.startsWith('chrome://') && !tab.url.startsWith('edge://'));
    for (let index = 0; index < urls.length; index += 1) {
      const targetUrl = isEnvironmentStartUrl(urls[index]) ? (environmentStartUrl(slave) || urls[index]) : urls[index];
      if (existing[index]) await cdp.call(existing[index].webSocketDebuggerUrl, 'Page.navigate', { url: targetUrl }).catch(() => cdp.navigate(slave.item.port, targetUrl));
      else await cdp.newTab(slave.item.port, targetUrl);
    }
  }
  return { success: true, master: entries[0].id, slaves: entries.length - 1, tabCount: urls.length };
}

function syncSnapshot() { return { ...syncState, selected: [...syncState.selected] }; }

function handleLiveSyncEvent(value) {
  emit(value);
  if ((value.type === 'sync-disconnected' || (value.type === 'live-sync' && value.active === false)) && syncState.active) {
    syncState = { active: false, master: null, selected: [...syncSelection] };
    emit({ type: 'sync-state', ...syncSnapshot(), reason: value.type });
  }
}

async function beginSync(ids = syncSelection) {
  let selected = sanitizeIds(ids);
  if (selected.length < 2) selected = engine.runningWithCdp([...engine.running.keys()]).map((entry) => entry.id);
  if (selected.length < 2) throw new Error('\u8bf7\u81f3\u5c11\u9009\u62e9\u4e24\u4e2a\u8fd0\u884c\u4e2d\u7684\u6d4f\u89c8\u5668\u73af\u5883');
  syncSelection = selected;
  await tile(selected, false);
  const tabs = await syncTabsFromMaster(selected);
  await liveSync.start(selected);
  syncState = { active: true, master: selected[0], selected };
  emit({ type: 'sync-state', ...syncSnapshot() });
  return { success: true, ...tabs, state: syncSnapshot() };
}

function endSync() {
  liveSync?.stop();
  syncState = { active: false, master: null, selected: [...syncSelection] };
  emit({ type: 'sync-state', ...syncSnapshot() });
  return { success: true, state: syncSnapshot() };
}

async function restartSync() {
  endSync();
  return beginSync(syncSelection);
}

async function runShortcut(action) {
  if (shortcutActionInFlight) return;
  shortcutActionInFlight = true;
  emit({ type: 'shortcut-triggered', action });
  try {
    if (action === 'start') await beginSync(syncSelection);
    else if (action === 'stop') endSync();
    else await restartSync();
  } catch (error) {
    emit({ type: 'sync-error', action, message: error.message });
  } finally { shortcutActionInFlight = false; }
}

function registerShortcutFallback() {
  if (shortcutFallbackRegistered) return;
  shortcutFallbackRegistered = true;
  const shortcuts = [
    ['Control+Alt+A', 'start'],
    ['Control+Alt+S', 'start'],
    ['Control+Alt+D', 'stop'],
    ['Control+Alt+R', 'restart'],
  ];
  const registered = shortcuts.map(([accelerator, action]) => ({
    accelerator,
    registered: globalShortcut.register(accelerator, () => runShortcut(action)),
  }));
  emit({ type: 'shortcut-status', mode: 'electron-fallback', registered });
}

function registerTextShortcuts() {
  const shortcuts = [
    ['Control+Alt+F', 'random-number'],
    ['Control+Q', 'same-text'],
    ['Shift+F1', 'specified-text'],
  ];
  const registered = shortcuts.map(([accelerator, action]) => ({ accelerator, registered: globalShortcut.register(accelerator, () => emit({ type: 'text-shortcut', action })) }));
  emit({ type: 'text-shortcut-status', registered });
}

function startShortcutBridge() {
  const executable = path.join(__dirname, 'native-sync-hotkeys.exe');
  if (process.platform !== 'win32' || !fs.existsSync(executable)) {
    registerShortcutFallback();
    return;
  }
  const child = spawn(executable, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  shortcutBridge = child;
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output += chunk;
    const lines = output.split(/\r?\n/); output = lines.pop() || '';
    for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
      if (line === 'READY') emit({ type: 'shortcut-status', mode: 'windows-hook', active: true, accelerators: ['Ctrl+Alt+A', 'Ctrl+Alt+S', 'Ctrl+Alt+D', 'Ctrl+Alt+R'] });
      else if (line === 'start' || line === 'stop' || line === 'restart') runShortcut(line);
    }
  });
  let errorOutput = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { errorOutput = (errorOutput + chunk).slice(-1000); });
  child.once('error', (error) => {
    if (shortcutBridge !== child) return;
    shortcutBridge = null;
    emit({ type: 'sync-error', action: 'shortcut-bridge', message: error.message });
    if (!quitting) registerShortcutFallback();
  });
  child.once('exit', (code) => {
    if (shortcutBridge !== child) return;
    shortcutBridge = null;
    if (!quitting) {
      emit({ type: 'sync-error', action: 'shortcut-bridge', message: errorOutput.trim() || ('Windows shortcut bridge exited: ' + code) });
      registerShortcutFallback();
    }
  });
}

function stopShortcutBridge() {
  const child = shortcutBridge;
  shortcutBridge = null;
  if (child && !child.killed) { try { child.kill(); } catch (_) {} }
  globalShortcut.unregisterAll();
  shortcutFallbackRegistered = false;
}
async function fetchStorePackage(url, proxyValue = null) {
  const initial = new URL(url);
  if (initial.protocol !== 'https:' || initial.hostname !== 'clients2.google.com') throw new Error('Chrome 商店下载地址无效');
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 180000);
  try {
    const storeSession = session.fromPartition('persist:browserops-extension-store');
    if (proxyValue === 'system') await storeSession.setProxy({ mode: 'system' });
    else if (proxyValue) await storeSession.setProxy({ mode: 'fixed_servers', proxyRules: proxyValue });
    else await storeSession.setProxy({ mode: 'direct' });
    const response = await storeSession.fetch(url, { redirect: 'follow', signal: controller.signal, headers: { 'user-agent': 'Mozilla/5.0 BrowserOpsLocal/3.0' } });
    const finalUrl = new URL(String(response.url || url));
    if (finalUrl.protocol !== 'https:' || !['clients2.google.com', 'clients2.googleusercontent.com'].includes(finalUrl.hostname)) throw new Error('Chrome 商店返回了不受信任的下载地址');
    if (!response.ok) throw new Error('Chrome 商店下载失败（HTTP ' + response.status + '）');
    const declared = Number(response.headers.get('content-length') || 0); if (declared > 120 * 1024 * 1024) throw new Error('扩展包超过 120 MB 限制');
    const buffer = Buffer.from(await response.arrayBuffer()); if (buffer.length > 120 * 1024 * 1024) throw new Error('扩展包超过 120 MB 限制');
    return buffer;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('连接 Chrome 应用商店超时，请检查系统代理/VPN，或先给任一目标环境配置可访问 Google 的代理');
    throw error;
  } finally { clearTimeout(timer); }
}

function apiIntegrationInfo() {
  if (!localApi) throw new Error('Local API is not ready');
  const api = localApi.info();
  const skillPath = path.join(__dirname, 'skills', 'xiaohei-browser');
  const config = {
    mcpServers: {
      'xiaohei-local-api': {
        command: process.execPath,
        args: [path.join(__dirname, 'mcp-server.js')],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          XIAOHEI_API_SETTINGS: api.settingsFile
        }
      }
    }
  };
  const installCommands = {
    agents: 'npx skills add timethrough/xiaohei-Chrome --skill xiaohei-browser -g',
    openclaw: 'npx skills add timethrough/xiaohei-Chrome --skill xiaohei-browser -g -a openclaw',
    hermes: 'Copy-Item -Recurse -Force "' + skillPath + '" "$HOME\\.hermes\\skills\\xiaohei-browser"'
  };
  return { ...api, skillPath, installCommands, mcpConfig: JSON.stringify(config, null, 2) };
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1180,
    minHeight: 720,
    title: '小黑多开器',
    icon: path.join(__dirname, 'assets', 'logo.png'),
    backgroundColor: '#f5f7fb',
    show: false,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  mainWindow = win;
  windows.add(win);
  win.on('closed', () => { windows.delete(win); if (mainWindow === win) mainWindow = null; });
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    win.show();
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await win.loadFile('index.html');
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith('file:') || details.url.startsWith('data:') || details.url.startsWith('devtools:');
    callback({ cancel: !allowed });
  });
  const localSettings = await loadLocalSettings();
  await fsp.mkdir(localSettings.profileDataRoot, { recursive: true });
  engine = new BrowserEngine(app, { profileDataRoot: localSettings.profileDataRoot });
  liveSync = new LiveSyncController(engine, handleLiveSyncEvent);
  await engine.init(path.join(__dirname, 'bundled-extension'));
  engine.on((value) => emit(value));
  localApi = new LocalApiServer({ engine, settingsFile: apiSettingsFile, version: app.getVersion() });
  await localApi.init();
  startShortcutBridge();
  registerTextShortcuts();

  ipcMain.handle('system:info', () => ({ appVersion: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, browsers: engine.candidates(), profileRoot: engine.getProfileDataRoot(), defaultProfileRoot: defaultProfileDataRoot }));
  ipcMain.handle('system:get-storage', () => ({ profileRoot: engine.getProfileDataRoot(), defaultProfileRoot: defaultProfileDataRoot, running: engine.running.size }));
  ipcMain.handle('system:choose-storage', async () => {
    if (engine.running.size) throw new Error('\u8bf7\u5148\u505c\u6b62\u6240\u6709\u73af\u5883\uff0c\u518d\u4fee\u6539\u6570\u636e\u4fdd\u5b58\u4f4d\u7f6e');
    const options = { title: '\u9009\u62e9\u73af\u5883\u6570\u636e\u4fdd\u5b58\u76ee\u5f55', defaultPath: engine.getProfileDataRoot(), properties: ['openDirectory', 'createDirectory', 'promptToCreate'] };
    const result = mainWindow && !mainWindow.isDestroyed() ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return { canceled: true, profileRoot: engine.getProfileDataRoot(), defaultProfileRoot: defaultProfileDataRoot };
    return { canceled: false, ...(await updateProfileDataRoot(result.filePaths[0])) };
  });
  ipcMain.handle('system:reset-storage', () => updateProfileDataRoot(defaultProfileDataRoot));
  ipcMain.handle('system:open-storage', async () => {
    const profileRoot = engine.getProfileDataRoot(); await fsp.mkdir(profileRoot, { recursive: true });
    const message = await shell.openPath(profileRoot); if (message) throw new Error(message);
    return { success: true, profileRoot };
  });
  ipcMain.handle('system:copy-text', (_event, value) => {
    const text = String(value || '').slice(0, 2_000_000);
    clipboard.writeText(text);
    return { success: true, length: text.length };
  });
  ipcMain.handle('api:info', () => apiIntegrationInfo());
  ipcMain.handle('api:reset-key', async () => {
    await localApi.resetKey();
    const info = apiIntegrationInfo();
    emit({ type: 'api-settings', info });
    return info;
  });
  ipcMain.handle('api:set-enabled', async (_event, enabled) => {
    await localApi.setEnabled(Boolean(enabled));
    const info = apiIntegrationInfo();
    emit({ type: 'api-settings', info });
    return info;
  });
  ipcMain.handle('api:open-skill', async () => {
    const skillPath = path.join(__dirname, 'skills', 'xiaohei-browser');
    const message = await shell.openPath(skillPath);
    if (message) throw new Error(message);
    return { success: true, skillPath };
  });
  ipcMain.handle('profiles:sync', (_event, profiles) => engine.syncProfiles(profiles));
  ipcMain.handle('profiles:delete', async (_event, payload) => {
    const ids = sanitizeIds(payload?.ids || []);
    if (syncState.active && syncState.selected.some((id) => ids.includes(id))) endSync();
    syncSelection = syncSelection.filter((id) => !ids.includes(id));
    syncState = { ...syncState, selected: syncState.selected.filter((id) => !ids.includes(id)) };
    emit({ type: 'sync-state', ...syncSnapshot() });
    return engine.deleteProfiles(ids, payload?.deleteData !== false);
  });
  ipcMain.handle('profiles:start', (_event, profile) => engine.start(profile));
  ipcMain.handle('profiles:stop', (_event, id) => engine.stop(id));
  ipcMain.handle('profiles:status', () => engine.status());
  ipcMain.handle('profiles:test-proxy', (_event, profile) => engine.testProxy(profile));
  ipcMain.handle('profiles:check-proxy', (_event, profile) => engine.checkProxy(profile));

  ipcMain.handle('extensions:list', () => engine.listExtensions());
  ipcMain.handle('extensions:add-folder', async () => {
    const result = await dialog.showOpenDialog({ title: '选择已解压的 Chrome 扩展目录', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const extension = await engine.addExtension(result.filePaths[0]);
    const ids = [...engine.profiles.keys()]; const running = ids.filter((id) => engine.running.has(id));
    if (ids.length) await engine.assignExtension(extension.id, ids, true);
    for (const id of running) await engine.stop(id);
    for (const id of running) { const profile = engine.profiles.get(id); if (profile) await engine.start(profile); }
    return { canceled: false, extension, assigned: ids.length, restarted: running.length };
  });
  ipcMain.handle('extensions:add-store', async (_event, payload) => {
    const ids = sanitizeIds(payload.profileIds || []);
    const storeUrl = String(payload.url || ''); let extension;
    try { extension = await engine.addStoreExtension(storeUrl); }
    catch (directError) {
      try { extension = await engine.addStoreExtension(storeUrl, (url) => fetchStorePackage(url, 'system')); }
      catch (systemError) { throw new Error(`Chrome 应用商店下载失败。直连：${directError.message}；系统代理：${systemError.message}`); }
    }
    const running = new Set(engine.status().filter((item) => item.running && ids.includes(item.id)).map((item) => item.id));
    if (ids.length) await engine.assignExtension(extension.id, ids, true);
    if (payload.restart) {
      for (const id of running) await engine.stop(id);
      for (const id of running) { const profile = engine.profiles.get(id); if (profile) await engine.start(profile); }
    }
    return { extension, assigned: ids.length, restarted: payload.restart ? running.size : 0 };
  });
  ipcMain.handle('extensions:assign', (_event, payload) => engine.assignExtension(String(payload.extensionId), sanitizeIds(payload.profileIds), Boolean(payload.enabled)));
  ipcMain.handle('extensions:toggle-all', async (_event, payload) => {
    const extensionId = String(payload.extensionId || ''); const enabled = Boolean(payload.enabled);
    const ids = [...engine.profiles.keys()]; const running = ids.filter((id) => engine.running.has(id));
    await engine.assignExtension(extensionId, ids, enabled);
    for (const id of running) await engine.stop(id);
    for (const id of running) { const profile = engine.profiles.get(id); if (profile) await engine.start(profile); }
    return { success: true, enabled, affected: ids.length, restarted: running.length };
  });
  ipcMain.handle('extensions:remove', (_event, id) => engine.removeExtension(String(id)));

  ipcMain.handle('sync:sessions', () => engine.sessions());
  ipcMain.handle('sync:selection', (_event, ids) => { syncSelection = sanitizeIds(ids); syncState.selected = [...syncSelection]; emit({ type: 'sync-state', ...syncSnapshot() }); return syncSnapshot(); });
  ipcMain.handle('sync:state', () => syncSnapshot());
  ipcMain.handle('sync:settings:get', () => liveSync.getSettings());
  ipcMain.handle('sync:settings:set', (_event, value) => liveSync.updateSettings(value));
  ipcMain.handle('sync:start', (_event, ids) => beginSync(ids));
  ipcMain.handle('sync:stop', () => endSync());
  ipcMain.handle('sync:restart', () => restartSync());
  ipcMain.handle('sync:window', async (_event, payload) => {
    const ids = sanitizeIds(payload.ids); const entries = engine.runningWithCdp(ids); const action = String(payload.action);
    if (action === 'tile') return tile(ids, false);
    if (action === 'cascade') return tile(ids, true);
    if (!['minimized', 'normal', 'maximized'].includes(action)) throw new Error('Unknown window action');
    await Promise.all(entries.map(({ item }) => cdp.setWindowState(item.port, action)));
    return { success: true, count: entries.length };
  });
  ipcMain.handle('sync:text', async (_event, payload) => {
    const ids = sanitizeIds(payload.ids); const action = String(payload.action); const text = String(payload.text || '').slice(0, 100000);
    const entries = new Map(engine.runningWithCdp(ids).map((entry) => [entry.id, entry]));
    const min = Math.max(0, Math.min(5, Number(payload.delayMin) || 0)); const max = Math.max(min, Math.min(5, Number(payload.delayMax) || min));
    const profiles = []; const failures = [];
    for (const id of ids) {
      const entry = entries.get(id);
      if (!entry) { failures.push({ id, message: 'Environment is not running or has no CDP session' }); continue; }
      try {
        let result;
        if (action === 'clear') result = await cdp.clearFocused(entry.item.port); else {
          const delay = min + Math.random() * (max - min); if (delay) await sleep(delay * 1000);
          result = await cdp.insertText(entry.item.port, text);
        }
        profiles.push({ id, targetId: result.targetId, textLength: text.length });
      } catch (error) { failures.push({ id, message: error.message }); }
    }
    return { success: failures.length === 0 && profiles.length === ids.length, profiles, failures };
  });
  ipcMain.handle('sync:text-batch', async (_event, payload) => {
    const ids = sanitizeIds(payload.ids);
    const texts = Array.isArray(payload.texts) ? payload.texts.map((value) => String(value || '').slice(0, 100000)) : [];
    if (!ids.length || texts.length !== ids.length) throw new Error('Text assignments must match the selected environments');
    const assignments = new Map(ids.map((id, index) => [id, texts[index]]));
    const entries = new Map(engine.runningWithCdp(ids).map((entry) => [entry.id, entry]));
    const min = Math.max(0, Math.min(5, Number(payload.delayMin) || 0)); const max = Math.max(min, Math.min(5, Number(payload.delayMax) || min));
    const profiles = []; const failures = [];
    for (const id of ids) {
      const entry = entries.get(id); const assignedText = assignments.get(id) || '';
      if (!entry) { failures.push({ id, message: 'Environment is not running or has no CDP session' }); continue; }
      try {
        const delay = min + Math.random() * (max - min); if (delay) await sleep(delay * 1000);
        const result = await cdp.insertText(entry.item.port, assignedText);
        profiles.push({ id, targetId: result.targetId, textLength: assignedText.length });
      } catch (error) { failures.push({ id, message: error.message }); }
    }
    return { success: failures.length === 0 && profiles.length === ids.length, profiles, failures };
  });
  ipcMain.handle('sync:tabs', async (_event, payload) => {
    const ids = sanitizeIds(payload.ids); const entries = engine.runningWithCdp(ids); const action = String(payload.action); const value = payload.payload || {};
    if (action === 'sync') return syncTabsFromMaster(ids);
    if (action === 'list') return engine.sessions();
    for (const { item } of entries) {
      if (action === 'new') await cdp.newTab(item.port, String(value.url || 'about:blank'));
      else if (action === 'navigate') await cdp.navigate(item.port, String(value.url || 'about:blank'));
      else if (action === 'reload') await cdp.reload(item.port);
      else if (action === 'close') { const tab = await cdp.firstTab(item.port); if (tab) await cdp.closeTab(item.port, tab.id); }
      else throw new Error('Unknown tab action');
    }
    return { success: true, count: entries.length };
  });

  await createWindow();
});

app.on('before-quit', (event) => {
  if (quitting || !engine) return;
  event.preventDefault(); quitting = true;
  Promise.all([engine.stopAll(), localApi?.close()]).finally(() => app.quit());
});
app.on('will-quit', () => stopShortcutBridge());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
