const crypto = require('crypto');
const http = require('http');
const fsp = require('fs/promises');
const path = require('path');
const cdp = require('./cdp');

const DEFAULT_PORT = 51415;
const MAX_BODY_BYTES = 1024 * 1024;
const RATE_LIMIT_PER_MINUTE = 600;

class ApiError extends Error {
  constructor(status, message, code = 'API_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function normalizePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_PORT;
}

function createApiKey() {
  return crypto.randomBytes(24).toString('hex');
}

function normalizeSettings(value = {}) {
  return {
    version: 1,
    enabled: value.enabled !== false,
    host: '127.0.0.1',
    port: normalizePort(value.port),
    apiKey: /^[a-f0-9]{48,128}$/i.test(String(value.apiKey || '')) ? String(value.apiKey) : createApiKey(),
    requireKey: true
  };
}

async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp';
  await fsp.writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fsp.rm(file, { force: true });
  await fsp.rename(temporary, file);
}

async function loadApiSettings(file) {
  let saved = {};
  try { saved = JSON.parse(await fsp.readFile(file, 'utf8')); } catch (_) {}
  const settings = normalizeSettings(saved);
  await writeJsonAtomic(file, settings);
  return settings;
}

function redactProxy(value) {
  const raw = String(value || '').trim();
  if (!raw || /^(direct|offline|none)$/i.test(raw)) return 'Direct';
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'socks5://' + raw);
    const protocol = parsed.protocol.replace(':', '').toUpperCase();
    return protocol + '://' + (parsed.username ? '***:***@' : '') + parsed.hostname + ':' + parsed.port;
  } catch (_) {
    const parts = raw.split(':');
    return parts.length >= 2 ? parts[0] + ':' + parts[1] + (parts.length >= 4 ? ':***:***' : '') : 'Configured';
  }
}

function publicProfile(value) {
  if (!value) return null;
  const {
    cookies, executable, profileDirectory, loadedExtensions, proxy, proxyMeta, ...profile
  } = value;
  return {
    ...profile,
    proxy: redactProxy(proxy),
    proxyConfigured: !/^(direct|offline|none)$/i.test(String(proxy || 'Direct')),
    hasImportedCookies: Boolean(cookies),
    proxyMeta: proxyMeta ? { ipChannel: String(proxyMeta.ipChannel || '') } : undefined,
    automation: value.running && value.port ? {
      cdpPort: value.port,
      debuggerAddress: value.debuggerAddress || '127.0.0.1:' + value.port,
      browserURL: value.browserURL || 'http://127.0.0.1:' + value.port
    } : null
  };
}

async function automationDetails(running) {
  if (!running?.running || !running.port) return null;
  let browserWSEndpoint = null;
  try { browserWSEndpoint = await cdp.browserSocket(running.port); } catch (_) {}
  return {
    cdpPort: running.port,
    debuggerAddress: running.debuggerAddress || '127.0.0.1:' + running.port,
    browserURL: running.browserURL || 'http://127.0.0.1:' + running.port,
    browserWSEndpoint
  };
}

function openApiDocument(version, url) {
  const profileSchema = {
    type: 'object',
    properties: {
      id: { type: 'string' }, number: { type: 'integer' }, name: { type: 'string' },
      browser: { type: 'string' }, proxy: { type: 'string' }, running: { type: 'boolean' },
      automation: { type: ['object', 'null'] }
    }
  };
  return {
    openapi: '3.1.0',
    info: { title: '小黑多开器 Local API', version, description: '仅监听本机回环地址，所有业务接口必须通过 X-API-Key 或 Bearer Token 验证。' },
    servers: [{ url }],
    security: [{ ApiKeyAuth: [] }],
    components: {
      securitySchemes: {
        ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        BearerAuth: { type: 'http', scheme: 'bearer' }
      },
      schemas: { Profile: profileSchema }
    },
    paths: {
      '/api/v1/status': { get: { summary: '查询服务与环境统计' } },
      '/api/v1/profiles': {
        get: { summary: '查询环境列表' },
        post: { summary: '创建环境' }
      },
      '/api/v1/profiles/{id}': {
        get: { summary: '读取环境配置' },
        patch: { summary: '更新环境配置' },
        delete: { summary: '删除环境' }
      },
      '/api/v1/profiles/{id}/start': { post: { summary: '启动环境并返回 CDP 自动化地址' } },
      '/api/v1/profiles/{id}/stop': { post: { summary: '关闭环境' } },
      '/api/v1/profiles/{id}/check-proxy': { post: { summary: '检查代理出口' } },
      '/api/v1/sessions': { get: { summary: '查询运行会话和标签页' } },
      '/api/v1/openapi.json': { get: { summary: '读取本 OpenAPI 文档' } }
    }
  };
}

class LocalApiServer {
  constructor(options = {}) {
    if (!options.engine) throw new Error('LocalApiServer requires a browser engine');
    if (!options.settingsFile) throw new Error('LocalApiServer requires a settings file');
    this.engine = options.engine;
    this.settingsFile = path.resolve(options.settingsFile);
    this.version = String(options.version || '15.0.0');
    this.settings = null;
    this.server = null;
    this.lastError = null;
    this.rate = { minute: 0, count: 0 };
    this.profileLocks = new Map();
  }

  async init() {
    this.settings = await loadApiSettings(this.settingsFile);
    if (this.settings.enabled) {
      try { await this.start(); } catch (error) { this.lastError = error.message; }
    }
    return this.info();
  }

  info() {
    const settings = this.settings || normalizeSettings();
    const running = Boolean(this.server?.listening);
    return {
      enabled: settings.enabled,
      running,
      host: settings.host,
      port: settings.port,
      url: 'http://' + settings.host + ':' + settings.port,
      apiKey: settings.apiKey,
      requireKey: true,
      settingsFile: this.settingsFile,
      version: this.version,
      lastError: this.lastError,
      security: ['loopback-only', 'api-key-required', 'host-header-validation', 'no-cors', 'rate-limited']
    };
  }

  async resetKey() {
    this.settings.apiKey = createApiKey();
    await writeJsonAtomic(this.settingsFile, this.settings);
    return this.info();
  }

  async setEnabled(enabled) {
    this.settings.enabled = Boolean(enabled);
    await writeJsonAtomic(this.settingsFile, this.settings);
    if (this.settings.enabled) {
      try { await this.start(); }
      catch (error) { this.lastError = error.message; throw error; }
    }
    else await this.close();
    return this.info();
  }

  async start() {
    if (this.server?.listening) return this.info();
    this.lastError = null;
    const server = http.createServer((request, response) => {
      this.handle(request, response).catch((error) => this.sendError(response, error));
    });
    server.on('clientError', (_error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => { server.removeListener('listening', onListening); reject(error); };
      const onListening = () => { server.removeListener('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.settings.port, this.settings.host);
    });
    server.on('error', (error) => { this.lastError = error.message; });
    this.server = server;
    return this.info();
  }

  async close() {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise((resolve) => server.close(() => resolve()));
  }

  checkRate() {
    const minute = Math.floor(Date.now() / 60000);
    if (this.rate.minute !== minute) this.rate = { minute, count: 0 };
    this.rate.count += 1;
    if (this.rate.count > RATE_LIMIT_PER_MINUTE) throw new ApiError(429, 'Local API rate limit exceeded', 'RATE_LIMIT');
  }

  validateHost(request) {
    const host = String(request.headers.host || '').toLowerCase();
    if (!/^(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(host)) throw new ApiError(403, 'Invalid Host header', 'HOST_NOT_ALLOWED');
    const origin = String(request.headers.origin || '');
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/i.test(origin)) throw new ApiError(403, 'Cross-origin browser requests are not allowed', 'ORIGIN_NOT_ALLOWED');
  }

  authorized(request) {
    const direct = String(request.headers['x-api-key'] || '');
    const authorization = String(request.headers.authorization || '');
    const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || '';
    const supplied = direct || bearer;
    const expected = String(this.settings.apiKey || '');
    if (!supplied || supplied.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  }

  async readBody(request) {
    const values = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new ApiError(413, 'Request body is too large', 'BODY_TOO_LARGE');
      values.push(chunk);
    }
    if (!values.length) return {};
    try { return JSON.parse(Buffer.concat(values).toString('utf8')); }
    catch (_) { throw new ApiError(400, 'Request body must be valid JSON', 'INVALID_JSON'); }
  }

  send(response, status, data) {
    if (response.headersSent) return;
    const body = JSON.stringify({ success: status < 400, data });
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(body);
  }

  sendError(response, error) {
    const status = Number(error?.status) || 500;
    const message = status >= 500 ? 'Local API internal error' : String(error?.message || 'Request failed');
    this.send(response, status, { error: { code: error?.code || 'INTERNAL_ERROR', message } });
  }

  profileId(value) {
    const id = decodeURIComponent(String(value || '')).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    if (!id) throw new ApiError(400, 'Invalid profile id', 'INVALID_PROFILE_ID');
    return id;
  }

  requireProfile(id) {
    const profile = this.engine.getProfile(id);
    if (!profile) throw new ApiError(404, 'Profile not found', 'PROFILE_NOT_FOUND');
    return profile;
  }

  async withProfileLock(id, action) {
    const previous = this.profileLocks.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.profileLocks.set(id, next);
    try { return await next; }
    finally { if (this.profileLocks.get(id) === next) this.profileLocks.delete(id); }
  }

  async handle(request, response) {
    this.checkRate();
    this.validateHost(request);
    const url = new URL(request.url, this.info().url);
    const method = String(request.method || 'GET').toUpperCase();

    if (method === 'GET' && url.pathname === '/api/v1/health') {
      return this.send(response, 200, { status: 'ok', version: this.version, api: 'local-only' });
    }
    if (!this.authorized(request)) throw new ApiError(401, 'API key is required', 'UNAUTHORIZED');

    if (method === 'GET' && url.pathname === '/api/v1/status') {
      const profiles = this.engine.status();
      return this.send(response, 200, {
        version: this.version,
        profiles: profiles.length,
        running: profiles.filter((item) => item.running).length,
        api: { host: this.settings.host, port: this.settings.port, security: this.info().security }
      });
    }

    if (method === 'GET' && url.pathname === '/api/v1/openapi.json') {
      return this.send(response, 200, openApiDocument(this.version, this.info().url));
    }

    if (method === 'GET' && url.pathname === '/api/v1/profiles') {
      const query = String(url.searchParams.get('q') || '').toLowerCase();
      const runningFilter = url.searchParams.get('running');
      const page = Math.max(1, Number.parseInt(url.searchParams.get('page'), 10) || 1);
      const pageSize = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get('pageSize'), 10) || 50));
      let values = this.engine.status();
      if (query) values = values.filter((item) => [item.id, item.number, item.name, item.tag, item.browser].join(' ').toLowerCase().includes(query));
      if (runningFilter === 'true' || runningFilter === 'false') values = values.filter((item) => item.running === (runningFilter === 'true'));
      const total = values.length;
      values = values.slice((page - 1) * pageSize, page * pageSize).map(publicProfile);
      return this.send(response, 200, { items: values, page, pageSize, total });
    }

    if (method === 'POST' && url.pathname === '/api/v1/profiles') {
      const profile = await this.engine.createProfile(await this.readBody(request));
      return this.send(response, 201, publicProfile(profile));
    }

    if (method === 'GET' && url.pathname === '/api/v1/sessions') {
      const sessions = await this.engine.sessions();
      return this.send(response, 200, sessions.map((item) => ({ ...item, profile: publicProfile(item.profile) })));
    }

    const match = url.pathname.match(/^\/api\/v1\/profiles\/([^/]+)(?:\/(start|stop|check-proxy|automation))?$/);
    if (!match) throw new ApiError(404, 'Endpoint not found', 'NOT_FOUND');
    const id = this.profileId(match[1]);
    const action = match[2] || '';

    if (method === 'GET' && !action) {
      this.requireProfile(id);
      return this.send(response, 200, publicProfile(this.engine.status().find((item) => item.id === id)));
    }

    if (method === 'PATCH' && !action) {
      this.requireProfile(id);
      const updated = await this.engine.updateProfile(id, await this.readBody(request));
      return this.send(response, 200, publicProfile(updated));
    }

    if (method === 'DELETE' && !action) {
      this.requireProfile(id);
      const deleteData = url.searchParams.get('deleteData') !== 'false';
      const result = await this.engine.deleteProfiles([id], deleteData);
      return this.send(response, 200, result);
    }

    if (method === 'POST' && action === 'start') {
      const profile = this.requireProfile(id);
      const running = await this.withProfileLock(id, () => this.engine.start(profile));
      return this.send(response, 200, { ...publicProfile(this.engine.status().find((item) => item.id === id)), automation: await automationDetails(running) });
    }

    if (method === 'POST' && action === 'stop') {
      this.requireProfile(id);
      const result = await this.withProfileLock(id, () => this.engine.stop(id));
      return this.send(response, 200, result);
    }

    if (method === 'POST' && action === 'check-proxy') {
      const result = await this.withProfileLock(id, () => this.engine.checkProxy(this.requireProfile(id)));
      return this.send(response, 200, result);
    }

    if (method === 'GET' && action === 'automation') {
      this.requireProfile(id);
      const running = this.engine.publicRunning(id);
      if (!running.running) throw new ApiError(409, 'Profile is not running', 'PROFILE_NOT_RUNNING');
      return this.send(response, 200, await automationDetails(running));
    }

    throw new ApiError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED');
  }
}

module.exports = {
  LocalApiServer,
  ApiError,
  DEFAULT_PORT,
  loadApiSettings,
  normalizeSettings,
  publicProfile,
  redactProxy,
  openApiDocument,
  automationDetails
};