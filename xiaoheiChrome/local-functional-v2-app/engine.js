const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const cdp = require('./cdp');
const { addChromeStoreExtension } = require('./store-extension');
const { launchPipeBrowser, reconcileOnConnection } = require('./extension-pipe');
const { parseProxy, displayProxy, startAuthenticatedProxy, lookupProxyCountry } = require('./proxy-forwarder');

async function retryProxyOperation(operation, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      lastError = error;
      if (/authentication failed|username or password|rejected available authentication/i.test(String(error?.message || '')) || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
    }
  }
  throw lastError;
}

class BrowserEngine {
  constructor(app, options = {}) {
    this.app = app;
    this.profiles = new Map();
    this.running = new Map();
    this.networkInfo = new Map();
    this.extensions = new Map();
    this.assignments = new Map();
    this.listeners = new Set();
    this.stateFile = path.join(app.getPath('userData'), 'browserops-v2-engine.json');
    this.profileDataRootPath = path.resolve(String(options.profileDataRoot || path.join(app.getPath('userData'), 'browser-profiles-v2')));
  }

  candidates() {
    const local = process.env.LOCALAPPDATA || '';
    const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
    const pfx = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    return [
      { name: 'Google Chrome', path: path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'Microsoft Edge', path: path.join(pfx, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
      { name: 'Google Chrome', path: path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'Brave', path: path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') },
      { name: 'Chromium', path: path.join(local, 'Chromium', 'Application', 'chrome.exe') }
    ].filter((item, index, all) => fs.existsSync(item.path) && all.findIndex((other) => other.path === item.path) === index);
  }

  async init(bundledExtensionPath) {
    try {
      const saved = JSON.parse(await fsp.readFile(this.stateFile, 'utf8'));
      for (const value of saved.profiles || []) {
        try { const profile = this.sanitizeProfile(value); this.profiles.set(profile.id, profile); } catch (_) {}
      }
      for (const extension of saved.extensions || []) if (fs.existsSync(extension.path)) this.extensions.set(extension.id, extension);
      for (const [profileId, ids] of Object.entries(saved.assignments || {})) this.assignments.set(profileId, new Set(ids));
    } catch (_) {}
    if (bundledExtensionPath && fs.existsSync(path.join(bundledExtensionPath, 'manifest.json'))) {
      const builtIn = await this.readExtension(bundledExtensionPath, true);
      this.extensions.set(builtIn.id, builtIn);
      await this.persist();
    }
  }

  async persist() {
    await fsp.mkdir(path.dirname(this.stateFile), { recursive: true });
    const assignments = Object.fromEntries([...this.assignments].map(([id, values]) => [id, [...values]]));
    await fsp.writeFile(this.stateFile, JSON.stringify({ profiles: [...this.profiles.values()], extensions: [...this.extensions.values()], assignments }, null, 2), 'utf8');
  }

  sanitizeProfile(value) {
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' || typeof value.name !== 'string') throw new Error('Invalid profile');
    const id = value.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    if (!id) throw new Error('Invalid profile id');
    const privacyValue = value.privacy && typeof value.privacy === 'object' ? value.privacy : {};
    const advancedValue = value.advanced && typeof value.advanced === 'object' ? value.advanced : {};
    const proxyMetaValue = value.proxyMeta && typeof value.proxyMeta === 'object' ? value.proxyMeta : {};
    const allowed = (candidate, values, fallback) => values.includes(String(candidate || '')) ? String(candidate) : fallback;
    const finite = (candidate) => candidate !== '' && candidate !== null && candidate !== undefined && Number.isFinite(Number(candidate)) ? Number(candidate) : null;
    const width = Math.min(7680, Math.max(640, Number(value.width) || 1280)); const height = Math.min(4320, Math.max(480, Number(value.height) || 820));
    const number = Number.parseInt(value.number, 10);
    return {
      id, number: Number.isInteger(number) && number > 0 ? number : null, name: value.name.slice(0, 100), browser: 'Google Chrome', os: String(value.os || 'Windows').slice(0, 40), location: String(value.location || 'Local').slice(0, 80),
      proxy: String(value.proxy || 'Direct').slice(0, 500), tag: String(value.tag || '').slice(0, 40), language: String(value.language || 'en-US').slice(0, 20), width, height,
      userAgent: String(value.userAgent || '').replace(/[\r\n]/g, ' ').slice(0, 1000), cookies: String(value.cookies || '').slice(0, 500000), note: String(value.note || '').slice(0, 2000),
      exitIp: String(value.exitIp || '').slice(0, 80), exitCountryCode: String(value.exitCountryCode || '').slice(0, 4), exitTimezone: String(value.exitTimezone || '').slice(0, 100),
      exitLatitude: finite(value.exitLatitude), exitLongitude: finite(value.exitLongitude),
      proxyMeta: { ipChannel: allowed(proxyMetaValue.ipChannel, ['ip-api', 'ip2location'], 'ip-api'), refreshUrl: String(proxyMetaValue.refreshUrl || '').slice(0, 1000) },
      privacy: {
        webrtc: allowed(privacyValue.webrtc, ['proxy', 'disabled', 'real'], 'proxy'), timezoneMode: allowed(privacyValue.timezoneMode, ['ip', 'real', 'custom'], 'ip'), timezone: String(privacyValue.timezone || '').slice(0, 100),
        geoMode: allowed(privacyValue.geoMode, ['ip', 'disabled', 'custom'], 'ip'), latitude: finite(privacyValue.latitude),
        longitude: finite(privacyValue.longitude), accuracy: Math.min(100000, Math.max(1, Number(privacyValue.accuracy) || 100)),
        uiLanguage: String(privacyValue.uiLanguage || 'profile').slice(0, 20), fontMode: allowed(privacyValue.fontMode, ['default', 'custom'], 'default'), fontSize: Math.min(36, Math.max(9, Number(privacyValue.fontSize) || 16)),
        canvas: allowed(privacyValue.canvas, ['real', 'blocked'], 'real'), webgl: allowed(privacyValue.webgl, ['real', 'blocked'], 'real'), webgpu: allowed(privacyValue.webgpu, ['real', 'blocked'], 'real'), audio: allowed(privacyValue.audio, ['real', 'muted'], 'real'),
        media: allowed(privacyValue.media, ['real', 'blocked'], 'real'), clientRects: 'real', speech: allowed(privacyValue.speech, ['real', 'blocked'], 'real'), dnt: Boolean(privacyValue.dnt)
      },
      advanced: {
        saveCookies: advancedValue.saveCookies !== false, savePasswords: Boolean(advancedValue.savePasswords), saveBookmarks: advancedValue.saveBookmarks !== false,
        saveLocalStorage: advancedValue.saveLocalStorage !== false, saveIndexedDB: advancedValue.saveIndexedDB !== false, saveHistory: advancedValue.saveHistory !== false,
        allowSignin: Boolean(advancedValue.allowSignin), restoreSession: Boolean(advancedValue.restoreSession), blockVideo: Boolean(advancedValue.blockVideo),
        blockImages: Boolean(advancedValue.blockImages), clearCacheOnStart: Boolean(advancedValue.clearCacheOnStart)
      }
    };
  }

  syncProfiles(values) {
    if (!Array.isArray(values) || values.length > 1000) throw new Error('Invalid profile list');
    const existingIds = [...this.profiles.keys()];
    const globallyEnabled = existingIds.length ? [...this.extensions.keys()].filter((extensionId) => existingIds.every((profileId) => (this.assignments.get(profileId) || new Set()).has(extensionId))) : [];
    let assignmentsChanged = false;
    for (const value of values) {
      const profile = this.sanitizeProfile(value); const previous = this.profiles.get(profile.id); const isNew = !previous;
      if (previous && previous.proxy !== profile.proxy) this.networkInfo.delete(profile.id);
      this.profiles.set(profile.id, profile);
      if (isNew && globallyEnabled.length) {
        const assigned = this.assignments.get(profile.id) || new Set();
        for (const extensionId of globallyEnabled) assigned.add(extensionId);
        this.assignments.set(profile.id, assigned); assignmentsChanged = true;
      }
    }
    this.persist().catch((error) => this.emit({ type: 'sync-error', action: 'persist-profiles', message: error.message }));
    this.emit({ type: 'profiles', action: assignmentsChanged ? 'sync-and-assign' : 'sync' });
    return this.status();
  }

  nextProfileNumber() {
    const values = [...this.profiles.values()].map((profile) => Number.parseInt(profile.number, 10)).filter((value) => Number.isInteger(value) && value > 0);
    return values.length ? Math.max(...values) + 1 : 1;
  }

  getProfile(id) {
    const safe = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    return this.profiles.get(safe) || null;
  }

  async createProfile(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid profile');
    const number = Number.isInteger(Number(value.number)) && Number(value.number) > 0 ? Number(value.number) : this.nextProfileNumber();
    let id = String(value.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    if (!id) id = 'env-' + String(number).padStart(3, '0');
    for (let suffix = 2; this.profiles.has(id); suffix += 1) id = 'env-' + String(number).padStart(3, '0') + '-' + suffix;
    const profile = this.sanitizeProfile({ ...value, id, number, name: String(value.name || number), browser: 'Google Chrome' });
    this.syncProfiles([profile]);
    await this.persist();
    this.emit({ type: 'profiles', action: 'create', ids: [profile.id] });
    return this.status().find((item) => item.id === profile.id);
  }

  async updateProfile(id, patch = {}) {
    const current = this.getProfile(id);
    if (!current) throw new Error('Profile not found');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid profile update');
    const profile = this.sanitizeProfile({
      ...current, ...patch, id: current.id,
      privacy: { ...current.privacy, ...(patch.privacy || {}) },
      advanced: { ...current.advanced, ...(patch.advanced || {}) },
      proxyMeta: { ...current.proxyMeta, ...(patch.proxyMeta || {}) }
    });
    if (profile.proxy !== current.proxy) this.networkInfo.delete(profile.id);
    this.profiles.set(profile.id, profile);
    await this.persist();
    this.emit({ type: 'profiles', action: 'update', ids: [profile.id] });
    return this.status().find((item) => item.id === profile.id);
  }

  getProfileDataRoot() { return this.profileDataRootPath; }

  setProfileDataRoot(value) {
    const raw = String(value || '').trim();
    if (!raw) throw new Error('Environment data directory is required');
    if (this.running.size) throw new Error('Stop all browser environments before changing the data directory');
    this.profileDataRootPath = path.resolve(raw);
    return this.profileDataRootPath;
  }

  profileRoot(id) { return path.join(this.profileDataRootPath, id); }

  chooseBrowser() {
    const browser = this.candidates().find((item) => item.name === 'Google Chrome');
    if (!browser) throw new Error('未找到本机 Google Chrome；本版本不再自动切换 Microsoft Edge');
    return browser;
  }

  proxyArg(value) {
    const proxy = String(value || '').trim();
    if (!proxy || /^(direct|offline|none)/i.test(proxy)) return null;
    if (/^(https?|socks4|socks5):\/\/[a-zA-Z0-9._-]+:\d{1,5}$/i.test(proxy)) return proxy;
    if (/^[a-zA-Z0-9._-]+:\d{1,5}$/.test(proxy)) return `http://${proxy}`;
    return null;
  }

  proxyConfig(value) { return parseProxy(value); }

  async resetZoom(root) {
    const file = path.join(root, 'Default', 'Preferences');
    try { const prefs = JSON.parse(await fsp.readFile(file, 'utf8')); if (prefs.partition) prefs.partition.per_host_zoom_levels = {}; if (prefs.browser && 'default_zoom_level' in prefs.browser) prefs.browser.default_zoom_level = 0; await fsp.writeFile(file, JSON.stringify(prefs), 'utf8'); } catch (_) {}
  }

  async resetTabs(root) {
    const profile = path.join(root, 'Default');
    for (const name of ['Sessions', 'Current Session', 'Current Tabs', 'Last Session', 'Last Tabs']) await fsp.rm(path.join(profile, name), { recursive: true, force: true }).catch(() => {});
  }

  async clearProfileCache(root) {
    const base = path.join(root, 'Default');
    for (const name of ['Cache', 'Code Cache', 'GPUCache', path.join('Service Worker', 'CacheStorage')]) await fsp.rm(path.join(base, name), { recursive: true, force: true }).catch(() => {});
  }

  async enforceDataRetention(root, profile) {
    const base = path.join(root, 'Default'); const targets = [];
    const add = (...names) => targets.push(...names.map((name) => path.join(base, name)));
    if (!profile.advanced.saveCookies) add(path.join('Network', 'Cookies'), path.join('Network', 'Cookies-journal'), 'Cookies', 'Cookies-journal');
    if (!profile.advanced.savePasswords) add('Login Data', 'Login Data-journal', 'Login Data For Account', 'Login Data For Account-journal');
    if (!profile.advanced.saveBookmarks) add('Bookmarks', 'Bookmarks.bak');
    if (!profile.advanced.saveLocalStorage) add('Local Storage');
    if (!profile.advanced.saveIndexedDB) add('IndexedDB');
    if (!profile.advanced.saveHistory) add('History', 'History-journal', 'Visited Links', 'Top Sites', 'Top Sites-journal');
    for (const target of targets) await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
  }

  async applyProfilePreferences(root, profile) {
    const defaultRoot = path.join(root, 'Default'); const file = path.join(defaultRoot, 'Preferences'); await fsp.mkdir(defaultRoot, { recursive: true });
    let prefs = {}; try { prefs = JSON.parse(await fsp.readFile(file, 'utf8')); } catch (_) {}
    prefs.profile ||= {}; prefs.profile.default_content_setting_values ||= {};
    prefs.profile.exit_type = 'Normal'; prefs.profile.exited_cleanly = true;
    const content = prefs.profile.default_content_setting_values;
    if (profile.advanced.blockImages) content.images = 2; else delete content.images;
    if (profile.privacy.media === 'blocked') { content.media_stream_mic = 2; content.media_stream_camera = 2; } else { delete content.media_stream_mic; delete content.media_stream_camera; }
    if (profile.privacy.geoMode === 'disabled') content.geolocation = 2; else delete content.geolocation;
    prefs.credentials_enable_service = Boolean(profile.advanced.savePasswords); prefs.profile.password_manager_enabled = Boolean(profile.advanced.savePasswords);
    prefs.signin ||= {}; prefs.signin.allowed = Boolean(profile.advanced.allowSignin); prefs.intl ||= {}; prefs.intl.accept_languages = profile.language;
    prefs.webkit ||= {}; prefs.webkit.webprefs ||= {}; if (profile.privacy.fontMode === 'custom') prefs.webkit.webprefs.default_font_size = profile.privacy.fontSize; else delete prefs.webkit.webprefs.default_font_size;
    await fsp.writeFile(file, JSON.stringify(prefs), 'utf8');
  }

  async importProfileCookies(connection, raw) {
    if (!raw) return 0; const values = JSON.parse(raw); if (!Array.isArray(values)) throw new Error('Cookie JSON must be an array');
    const sameSite = (value) => ({ strict: 'Strict', lax: 'Lax', none: 'None', no_restriction: 'None', unspecified: undefined })[String(value || '').toLowerCase()];
    const cookies = values.slice(0, 5000).map((item) => {
      if (!item || typeof item.name !== 'string' || typeof item.value !== 'string') throw new Error('Cookie entries require name and value');
      const cookie = { name: item.name, value: item.value, path: String(item.path || '/'), secure: Boolean(item.secure), httpOnly: Boolean(item.httpOnly ?? item.http_only) };
      if (item.url) cookie.url = String(item.url); else if (item.domain) cookie.domain = String(item.domain);
      if (!cookie.url && !cookie.domain) throw new Error('Cookie entry requires url or domain');
      const site = sameSite(item.sameSite ?? item.same_site); if (site) cookie.sameSite = site;
      const expires = Number(item.expires ?? item.expirationDate ?? item.expiration_date); if (Number.isFinite(expires) && expires > 0) cookie.expires = expires > 1e12 ? expires / 1000 : expires;
      return cookie;
    });
    if (cookies.length) await connection.command('Storage.setCookies', { cookies }, 30000); return cookies.length;
  }

  async applyRuntimeSettings(port, profile) {
    const tabs = await cdp.tabs(port); const network = this.networkInfo.get(profile.id) || {};
    const timezone = profile.privacy.timezoneMode === 'custom' ? profile.privacy.timezone : profile.privacy.timezoneMode === 'ip' ? (profile.exitTimezone || network.timezone || '') : '';
    const latitude = profile.privacy.geoMode === 'custom' ? profile.privacy.latitude : profile.privacy.geoMode === 'ip' ? Number(profile.exitLatitude ?? network.latitude) : null;
    const longitude = profile.privacy.geoMode === 'custom' ? profile.privacy.longitude : profile.privacy.geoMode === 'ip' ? Number(profile.exitLongitude ?? network.longitude) : null;
    const blocked = profile.advanced.blockVideo ? ['*.mp4', '*.webm', '*.m3u8', '*.mov', '*.avi'] : [];
    const scripts = [];
    if (profile.privacy.canvas === 'blocked') scripts.push(`(() => { const deny=()=>{throw new DOMException('Canvas reading is disabled by this profile','SecurityError')}; HTMLCanvasElement.prototype.toDataURL=deny; HTMLCanvasElement.prototype.toBlob=deny; if(globalThis.CanvasRenderingContext2D) CanvasRenderingContext2D.prototype.getImageData=deny; })();`);
    if (profile.privacy.speech === 'blocked') scripts.push(`(() => { if(globalThis.speechSynthesis){ try{speechSynthesis.cancel(); Object.defineProperty(speechSynthesis,'getVoices',{value:()=>[]});}catch(_){}} })();`);
    for (const tab of tabs) {
      if (timezone) await cdp.call(tab.webSocketDebuggerUrl, 'Emulation.setTimezoneOverride', { timezoneId: timezone }).catch(() => {});
      if (Number.isFinite(latitude) && Number.isFinite(longitude)) await cdp.call(tab.webSocketDebuggerUrl, 'Emulation.setGeolocationOverride', { latitude, longitude, accuracy: profile.privacy.accuracy }).catch(() => {});
      if (blocked.length) { await cdp.call(tab.webSocketDebuggerUrl, 'Network.enable').catch(() => {}); await cdp.call(tab.webSocketDebuggerUrl, 'Network.setBlockedURLs', { urls: blocked }).catch(() => {}); }
      for (const source of scripts) { await cdp.call(tab.webSocketDebuggerUrl, 'Page.addScriptToEvaluateOnNewDocument', { source }).catch(() => {}); await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: source }).catch(() => {}); }
    }
  }

  async suppressStartupExtensionPages(connection, installed, durationMs = 7000) {
    const popupPaths = new Map();
    for (const extension of installed || []) {
      const chromeId = String(extension.chromeExtensionId || '').toLowerCase();
      if (!chromeId) continue;
      let popup = '';
      try {
        const manifest = JSON.parse(await fsp.readFile(path.join(extension.path, 'manifest.json'), 'utf8'));
        popup = String(manifest.action?.default_popup || manifest.browser_action?.default_popup || '').replace(/^\/+/, '').toLowerCase();
      } catch (_) {}
      popupPaths.set(chromeId, popup);
    }
    if (!popupPaths.size) return { closed: 0 };

    const blockedOpeners = new Set(); const closedTargets = new Set(); const started = Date.now();
    while (Date.now() - started < durationMs) {
      let values;
      try { values = (await connection.command('Target.getTargets', {}, 3000)).targetInfos || []; }
      catch (_) { break; }

      for (const target of values) {
        if (target.type !== 'page' || closedTargets.has(target.targetId)) continue;
        let shouldClose = blockedOpeners.has(String(target.openerId || ''));
        if (!shouldClose) {
          try {
            const url = new URL(String(target.url || ''));
            if (url.protocol === 'chrome-extension:' || url.protocol === 'edge-extension:') {
              const popup = popupPaths.get(url.hostname.toLowerCase());
              if (popup !== undefined) {
                const currentPath = decodeURIComponent(url.pathname).replace(/^\/+/, '').toLowerCase();
                const isToolbarPopup = Boolean(popup) && currentPath === popup;
                shouldClose = !isToolbarPopup;
              }
            }
          } catch (_) {}
        }
        if (!shouldClose) continue;
        blockedOpeners.add(target.targetId); closedTargets.add(target.targetId);
        await connection.command('Target.closeTarget', { targetId: target.targetId }, 3000).catch(() => {});
      }
      await new Promise((resolve) => { const timer = setTimeout(resolve, 120); timer.unref?.(); });
    }
    if (closedTargets.size) this.emit({ type: 'startup-extension-pages-suppressed', count: closedTargets.size });
    return { closed: closedTargets.size };
  }
  async keepDefaultTab(port, startFile) {
    const values = await cdp.tabs(port); if (!values.length) return;
    const expected = 'file:///' + startFile.replace(/\\/g, '/');
    let keep = values.find((tab) => tab.url.toLowerCase().includes('browserops-start.html')) || values[0];
    if (!keep.url.toLowerCase().includes('browserops-start.html')) await cdp.call(keep.webSocketDebuggerUrl, 'Page.navigate', { url: expected });
    for (const tab of values) if (tab.id !== keep.id) await cdp.closeTab(port, tab.id).catch(() => {});
    await cdp.activateTab(port, keep.id).catch(() => {});
  }

  async startPage(profile, root, browserName, extensionCount) {
    const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    const number = escape(profile.number || profile.name || profile.id); const name = escape(profile.name || number); const internalId = escape(profile.id); const proxy = escape(profile.proxy || 'Direct'); const exitIp = escape(profile.exitIp || '尚未检测');
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="browserops-profile-id" content="${internalId}"><meta name="browserops-profile-number" content="${number}"><title>${number}</title><style>body{margin:0;font-family:Segoe UI,"Microsoft YaHei",sans-serif;background:#f4f6fb;color:#172033;display:grid;place-items:center;min-height:100vh}.environment-chip{position:fixed;left:12px;top:12px;padding:7px 11px;border-radius:8px;background:#173d8f;color:#fff;font-size:12px;font-weight:750;box-shadow:0 4px 16px #0003}.card{width:min(820px,calc(100% - 48px));padding:34px;border:1px solid #dce2ee;border-radius:18px;background:#fff;box-shadow:0 22px 65px #2d3b6018}.badge{display:inline-block;padding:7px 10px;border-radius:99px;background:#e9f8f1;color:#16845f;font-size:11px;font-weight:700}h1{margin:16px 0 8px}p{color:#66728a;line-height:1.7}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-top:24px}.fact{padding:14px;border:1px solid #e0e5ef;border-radius:11px}.fact span{display:block;color:#8a95a9;font-size:11px}.fact strong{display:block;margin-top:6px;font-size:14px;overflow-wrap:anywhere}</style></head><body><div class="environment-chip">环境编号：${number}</div><main class="card"><span class="badge">环境编号：${number}</span><h1>${name}</h1><p>当前页面只显示本环境自己的名称、编号和网络配置，不会复用其他环境的数据。</p><div class="grid"><div class="fact"><span>环境名称</span><strong>${name}</strong></div><div class="fact"><span>环境编号</span><strong>${number}</strong></div><div class="fact"><span>出口 IP</span><strong>${exitIp}</strong></div><div class="fact"><span>代理</span><strong>${proxy}</strong></div><div class="fact"><span>浏览器</span><strong>${escape(browserName)}</strong></div><div class="fact"><span>已分配扩展</span><strong>${extensionCount}</strong></div></div></main></body></html>`;
    const file = path.join(root, 'browserops-start.html'); await fsp.writeFile(file, html, 'utf8'); return file;
  }

  assignedExtensions(profileId) {
    const ids = this.assignments.get(profileId) || new Set();
    return [...ids].map((id) => this.extensions.get(id)).filter((item) => item && fs.existsSync(item.path));
  }

  async markProfileCleanExit(root) {
    const file = path.join(root, 'Default', 'Preferences');
    try {
      const prefs = JSON.parse(await fsp.readFile(file, 'utf8')); prefs.profile ||= {};
      prefs.profile.exit_type = 'Normal'; prefs.profile.exited_cleanly = true;
      await fsp.writeFile(file, JSON.stringify(prefs), 'utf8');
    } catch (_) {}
  }

  startNativeProfileMarker(pid, profileId) {
    if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return null;
    const executable = path.join(__dirname, 'native-profile-marker.exe'); if (!fs.existsSync(executable)) return null;
    try { return spawn(executable, [String(pid), String(profileId)], { windowsHide: true, stdio: 'ignore' }); } catch (_) { return null; }
  }

  async waitForPort(root, timeout = 12000) {
    const file = path.join(root, 'DevToolsActivePort');
    const started = Date.now();
    while (Date.now() - started < timeout) {
      try { const content = await fsp.readFile(file, 'utf8'); const port = Number(content.split(/\r?\n/)[0]); if (Number.isInteger(port) && port > 0) return port; } catch (_) {}
      await new Promise((resolve) => setTimeout(resolve, 180));
    }
    throw new Error('Browser started but CDP port was not ready');
  }

  async start(raw) {
    const profile = this.sanitizeProfile(raw); this.profiles.set(profile.id, profile);
    await this.persist();
    if (this.running.has(profile.id)) return this.publicRunning(profile.id);
    const extensions = this.assignedExtensions(profile.id);
    const browser = this.chooseBrowser(profile);
    const root = this.profileRoot(profile.id); await fsp.mkdir(root, { recursive: true }); if (!profile.advanced.restoreSession) await this.resetTabs(root); await this.resetZoom(root);
    if (profile.advanced.clearCacheOnStart) await this.clearProfileCache(root); await this.enforceDataRetention(root, profile); await this.applyProfilePreferences(root, profile);
    await fsp.rm(path.join(root, 'DevToolsActivePort'), { force: true }).catch(() => {});
    const pageNetwork = this.networkInfo.get(profile.id) || {};
    const startFile = await this.startPage({ ...profile, exitIp: pageNetwork.ip || profile.exitIp || '', proxy: displayProxy(profile.proxy) }, root, browser.name, extensions.length);
    const proxyConfig = this.proxyConfig(profile.proxy); let proxyForwarder = null;
    if (proxyConfig?.authenticated) {
      proxyForwarder = await startAuthenticatedProxy(proxyConfig, (value) => this.emit({ type: 'proxy-error', id: profile.id, code: value.code, message: value.message }));
    }
    const args = [`--user-data-dir=${root}`, '--profile-directory=Default', '--no-first-run', '--no-default-browser-check', '--hide-crash-restore-bubble', '--disable-session-crashed-bubble', '--disable-background-mode', '--enable-unsafe-extension-debugging', '--remote-debugging-pipe', '--remote-debugging-port=0', '--remote-allow-origins=*', `--lang=${profile.language}`, `--window-size=${profile.width},${profile.height}`];
    if (!profile.advanced.allowSignin) args.push('--disable-sync'); if (profile.userAgent) args.push(`--user-agent=${profile.userAgent}`);
    if (['proxy', 'disabled'].includes(profile.privacy.webrtc)) args.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp', '--enforce-webrtc-ip-permission-check');
    const disabledFeatures = [];
    if (profile.privacy.webgl === 'blocked') args.push('--disable-webgl', '--disable-webgl2', '--disable-3d-apis');
    if (profile.privacy.webgpu === 'blocked') disabledFeatures.push('WebGPU');
    if (profile.privacy.audio === 'muted') args.push('--mute-audio');
    if (profile.privacy.dnt) args.push('--do-not-track'); if (profile.advanced.blockImages) args.push('--blink-settings=imagesEnabled=false');
    if (profile.advanced.blockVideo) args.push('--autoplay-policy=user-gesture-required');
    if (profile.advanced.restoreSession) args.push('--restore-last-session');
    // Authenticated proxies must be exposed to Chrome through the local bridge.
    // Passing both the upstream proxy and the bridge creates duplicate
    // --proxy-server switches; Chromium may keep the unauthenticated upstream
    // switch and bypass the bridge entirely.
    const proxy = proxyForwarder ? proxyForwarder.url : this.proxyArg(profile.proxy);
    if (proxy) args.push(`--proxy-server=${proxy}`);
    if (!profile.advanced.restoreSession) args.push(`file:///${startFile.replace(/\\/g, '/')}`);
    if (proxyConfig) {
      args.push('--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-client-side-phishing-detection', '--disable-domain-reliability', '--disable-quic', '--dns-prefetch-disable', '--no-pings', '--metrics-recording-only');
      disabledFeatures.push('OptimizationHints', 'MediaRouter', 'Translate', 'AutofillServerCommunication', 'NetworkPrediction');
    }
    if (disabledFeatures.length) args.push(`--disable-features=${[...new Set(disabledFeatures)].join(',')}`);
    let pipeBrowser;
    try { pipeBrowser = await launchPipeBrowser(browser.path, args, false); } catch (error) { await proxyForwarder?.close().catch(() => {}); throw error; }
    const child = pipeBrowser.child;
    if (profile.cookies && profile.advanced.saveCookies) { try { await this.importProfileCookies(pipeBrowser.connection, profile.cookies); } catch (error) { this.emit({ type: 'sync-error', action: 'import-cookies', id: profile.id, message: 'Cookie 导入失败：' + error.message }); } }
    let reconciled;
    try { const managedPaths = [...this.extensions.values()].map((item) => item.path).filter(Boolean); reconciled = await reconcileOnConnection(pipeBrowser.connection, extensions, managedPaths); }
    catch (error) { try { await pipeBrowser.connection.command('Browser.close'); } catch (_) {} await proxyForwarder?.close().catch(() => {}); throw error; }
    const markerProcess = this.startNativeProfileMarker(child.pid, profile.number || profile.name || profile.id);
    const item = { child, pipeConnection: pipeBrowser.connection, proxyForwarder, markerProcess, pid: child.pid, browser, root, profile, port: null, startedAt: new Date().toISOString(), extensions: extensions.map((entry) => entry.id), loadedExtensions: reconciled.extensions };
    this.running.set(profile.id, item); child.once('exit', () => { if (item.markerProcess && !item.markerProcess.killed) { try { item.markerProcess.kill(); } catch (_) {} } item.proxyForwarder?.close().catch(() => {}); this.markProfileCleanExit(item.root).catch(() => {}); this.running.delete(profile.id); this.emit({ type: 'status', id: profile.id, running: false }); });
    child.once('error', (error) => { if (item.markerProcess && !item.markerProcess.killed) { try { item.markerProcess.kill(); } catch (_) {} } item.proxyForwarder?.close().catch(() => {}); this.running.delete(profile.id); this.emit({ type: 'status', id: profile.id, running: false, error: error.message }); });
    item.startupExtensionGuard = this.suppressStartupExtensionPages(pipeBrowser.connection, reconciled.installed).catch((error) => this.emit({ type: 'sync-error', action: 'startup-extension-pages', id: profile.id, message: error.message }));
    try { item.port = await this.waitForPort(root); if (!profile.advanced.restoreSession) await this.keepDefaultTab(item.port, startFile); await this.applyRuntimeSettings(item.port, profile); } catch (error) { item.cdpError = error.message; }
    this.emit({ type: 'status', id: profile.id, running: true, ...this.publicRunning(profile.id) });
    return this.publicRunning(profile.id);
  }

  publicRunning(id) {
    const item = this.running.get(id); if (!item) return { id, running: false };
    return { id, running: true, pid: item.pid, port: item.port, debuggerAddress: item.port ? '127.0.0.1:' + item.port : null, browserURL: item.port ? 'http://127.0.0.1:' + item.port : null, browser: item.browser.name, executable: item.browser.path, profileDirectory: item.root, extensionCount: item.extensions.length, loadedExtensions: item.loadedExtensions || [], cdpError: item.cdpError || null };
  }

  async stop(id) {
    const safe = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64); const item = this.running.get(safe);
    if (!item) return { id: safe, running: false, alreadyStopped: true };
    let graceful = item.child.exitCode !== null;
    if (!graceful) {
      try { await Promise.race([item.pipeConnection.command('Browser.close', {}, 5000).catch(() => {}), new Promise((resolve) => setTimeout(resolve, 1200))]); } catch (_) {}
      graceful = await new Promise((resolve) => {
        if (item.child.exitCode !== null) return resolve(true);
        const timer = setTimeout(() => { item.child.removeListener('exit', exited); resolve(false); }, 6500);
        const exited = () => { clearTimeout(timer); resolve(true); };
        item.child.once('exit', exited);
      });
    }
    if (!graceful && item.child.exitCode === null) {
      await new Promise((resolve) => { const killer = spawn('taskkill.exe', ['/PID', String(item.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.once('exit', resolve); killer.once('error', resolve); });
    }
    if (item.markerProcess && !item.markerProcess.killed) { try { item.markerProcess.kill(); } catch (_) {} }
    await item.proxyForwarder?.close().catch(() => {});
    await this.markProfileCleanExit(item.root);
    await this.enforceDataRetention(item.root, this.profiles.get(safe) || item.profile).catch(() => {});
    this.running.delete(safe); this.emit({ type: 'status', id: safe, running: false }); return { id: safe, running: false, graceful };
  }

  async stopAll() { await Promise.all([...this.running.keys()].map((id) => this.stop(id))); }

  async deleteProfiles(ids, deleteData = true) {
    if (!Array.isArray(ids) || ids.length > 200) throw new Error('Invalid profile selection');
    const safeIds = [...new Set(ids.map((id) => String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)).filter(Boolean))];
    const deleted = []; let stopped = 0;
    for (const id of safeIds) {
      if (!this.profiles.has(id)) continue;
      if (this.running.has(id)) { await this.stop(id); stopped += 1; }
      this.profiles.delete(id); this.assignments.delete(id); this.networkInfo.delete(id); deleted.push(id);
      if (deleteData) await fsp.rm(this.profileRoot(id), { recursive: true, force: true });
    }
    await this.persist();
    this.emit({ type: 'profiles', action: 'delete', ids: deleted }); this.emit({ type: 'extensions' });
    return { success: true, deleted: deleted.length, stopped, dataDeleted: Boolean(deleteData), ids: deleted };
  }

  status() { return [...this.profiles.values()].map((profile) => ({ ...profile, ...this.publicRunning(profile.id), network: this.networkInfo.get(profile.id) || null, assignedExtensions: [...(this.assignments.get(profile.id) || [])] })); }

  async testProxy(raw) {
    const profile = this.sanitizeProfile(raw); const config = parseProxy(profile.proxy);
    if (!config) throw new Error('Direct environments do not have a proxy exit to inspect');
    const result = await retryProxyOperation(() => lookupProxyCountry(config));
    return { ...result, protocol: config.protocol, endpoint: config.host + ':' + config.port };
  }

  async checkProxy(raw) {
    const profile = this.sanitizeProfile(raw); const network = await this.testProxy(profile);
    this.networkInfo.set(profile.id, network); this.emit({ type: 'status', id: profile.id, running: this.running.has(profile.id), network });
    return network;
  }

  async readExtension(directory, builtIn = false) {
    const manifestPath = path.join(directory, 'manifest.json'); const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
    if (![2, 3].includes(manifest.manifest_version) || typeof manifest.name !== 'string' || typeof manifest.version !== 'string') throw new Error('The selected folder does not contain a valid Chrome extension manifest');
    let messages = {}; const locale = String(manifest.default_locale || 'en').replace(/[^a-zA-Z0-9_-]/g, '');
    for (const candidate of [locale, 'en', 'en_US', 'zh_CN']) { try { messages = JSON.parse(await fsp.readFile(path.join(directory, '_locales', candidate, 'messages.json'), 'utf8')); if (Object.keys(messages).length) break; } catch (_) {} }
    const localized = (text) => { const match = String(text || '').match(/^__MSG_([^_].*?)__$/i); return match && messages[match[1]]?.message ? String(messages[match[1]].message) : String(text || ''); };
    const id = crypto.createHash('sha256').update(path.resolve(directory).toLowerCase()).digest('hex').slice(0, 20);
    return { id, name: localized(manifest.name), version: manifest.version, description: localized(manifest.description), manifestVersion: manifest.manifest_version, path: path.resolve(directory), builtIn, addedAt: new Date().toISOString() };
  }

  async addExtension(directory) { const value = await this.readExtension(directory, false); this.extensions.set(value.id, value); await this.persist(); this.emit({ type: 'extensions' }); return value; }
  async addStoreExtension(url, fetchPackage) { const value = await addChromeStoreExtension(url, this.app.getPath('userData'), (directory, builtIn) => this.readExtension(directory, builtIn), fetchPackage); this.extensions.set(value.id, value); await this.persist(); this.emit({ type: 'extensions' }); return value; }
  listExtensions() {
    const profileIds = [...this.profiles.keys()];
    return [...this.extensions.values()].map((item) => {
      const assignedProfileIds = profileIds.filter((id) => (this.assignments.get(id) || new Set()).has(item.id));
      return { ...item, assignedProfiles: assignedProfileIds.length, assignedProfileIds, enabledAll: profileIds.length > 0 && assignedProfileIds.length === profileIds.length };
    });
  }
  async assignExtension(extensionId, profileIds, enabled) {
    if (!this.extensions.has(extensionId)) throw new Error('Unknown extension');
    if (!Array.isArray(profileIds) || profileIds.length > 1000) throw new Error('Invalid profile list');
    for (const profileId of profileIds) { const safe = String(profileId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64); if (!safe) continue; const set = this.assignments.get(safe) || new Set(); if (enabled) set.add(extensionId); else set.delete(extensionId); this.assignments.set(safe, set); }
    await this.persist(); this.emit({ type: 'extensions' }); return { success: true, restartRequired: profileIds.filter((id) => this.running.has(id)) };
  }
  async removeExtension(id) { const value = this.extensions.get(id); if (!value || value.builtIn) throw new Error('Built-in extension cannot be removed'); this.extensions.delete(id); for (const set of this.assignments.values()) set.delete(id); await this.persist(); return { success: true }; }
  on(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(value) { for (const listener of this.listeners) listener(value); }
  runningWithCdp(ids) { return ids.map((id) => ({ id, item: this.running.get(id) })).filter((entry) => entry.item?.port); }
  async sessions() { const result = []; for (const { id, item } of this.runningWithCdp([...this.running.keys()])) { try { result.push({ id, profile: this.profiles.get(id), port: item.port, browser: item.browser.name, tabs: await cdp.tabs(item.port) }); } catch (error) { result.push({ id, profile: this.profiles.get(id), port: item.port, browser: item.browser.name, tabs: [], error: error.message }); } } return result; }
}

module.exports = { BrowserEngine };
