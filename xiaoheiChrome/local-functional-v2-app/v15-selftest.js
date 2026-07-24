'use strict';

const assert = require('assert');
const fsp = require('fs/promises');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { LocalApiServer } = require('./local-api');
const { build, isDirect } = require('./environment-audit');

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

class FakeEngine {
  constructor(cdpPort) {
    this.cdpPort = cdpPort;
    this.profiles = new Map([['env-001', {
      id: 'env-001', number: 1, name: '1', browser: 'Google Chrome', tag: '测试', language: 'zh-CN',
      proxy: 'socks5://secret-user:secret-password@127.0.0.1:1080',
      proxyMeta: { ipChannel: 'ip-api', refreshUrl: 'https://secret.example/token' },
      cookies: '[{"name":"session","value":"secret-cookie"}]'
    }]]);
    this.running = new Map();
  }
  getProfile(id) { return this.profiles.get(id) || null; }
  publicRunning(id) {
    if (!this.running.has(id)) return { id, running: false };
    return { id, running: true, pid: 1234, port: this.cdpPort, debuggerAddress: '127.0.0.1:' + this.cdpPort, browserURL: 'http://127.0.0.1:' + this.cdpPort, executable: 'C:/private/chrome.exe', profileDirectory: 'C:/private/profile' };
  }
  status() { return [...this.profiles.values()].map((profile) => ({ ...profile, ...this.publicRunning(profile.id), assignedExtensions: [] })); }
  async createProfile(value = {}) {
    const number = Math.max(0, ...[...this.profiles.values()].map((profile) => profile.number || 0)) + 1;
    const id = value.id || 'env-' + String(number).padStart(3, '0');
    const profile = { id, number, name: String(value.name || number), browser: 'Google Chrome', language: value.language || 'en-US', tag: value.tag || '', proxy: value.proxy || 'Direct' };
    this.profiles.set(id, profile); return { ...profile, ...this.publicRunning(id) };
  }
  async updateProfile(id, patch) { const profile = { ...this.getProfile(id), ...patch, id }; this.profiles.set(id, profile); return { ...profile, ...this.publicRunning(id) }; }
  async deleteProfiles(ids, deleteData) { for (const id of ids) { this.running.delete(id); this.profiles.delete(id); } return { deleted: ids.length, dataDeleted: deleteData, ids }; }
  async start(profile) { this.running.set(profile.id, true); return this.publicRunning(profile.id); }
  async stop(id) { this.running.delete(id); return { id, running: false, graceful: true }; }
  async checkProxy(profile) { return { id: profile.id, ip: '203.0.113.10', countryCode: 'SG', timezone: 'Asia/Singapore' }; }
  async sessions() { return [...this.running.keys()].map((id) => ({ id, profile: this.getProfile(id), port: this.cdpPort, browser: 'Google Chrome', tabs: [{ id: 'tab-1', type: 'page', title: 'Test', url: 'https://example.com' }] })); }
}

async function jsonRequest(url, apiKey, options = {}) {
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: { Accept: 'application/json', ...(apiKey ? { 'X-API-Key': apiKey } : {}), ...(options.headers || {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  return { status: response.status, body: await response.json() };
}

function makeMcpClient(script, settingsFile) {
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, XIAOHEI_API_SETTINGS: settingsFile },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const pending = new Map(); let stderr = '';
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    let value; try { value = JSON.parse(line); } catch (error) { for (const item of pending.values()) item.reject(error); return; }
    const item = pending.get(value.id); if (!item) return; pending.delete(value.id); value.error ? item.reject(new Error(value.error.message)) : item.resolve(value.result);
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  let serial = 0;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial; const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP timeout: ' + method + '\n' + stderr)); }, 8000);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { child, request, stderr: () => stderr };
}

async function main() {
  const audit = build({ id: 'env-001', proxy: 'Direct', os: 'Windows', privacy: { webrtc: 'real', timezoneMode: 'real', geoMode: 'disabled' }, advanced: {} }, { systemTimezone: 'Asia/Shanghai' });
  assert.equal(isDirect('Direct'), true);
  assert.equal(audit.checks.find((item) => item.id === 'profile').state, 'pass');

  const cdpServer = http.createServer((request, response) => {
    if (request.url === '/json/version') {
      const body = JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/v15-test' });
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }); response.end(body); return;
    }
    response.writeHead(404); response.end();
  });
  const cdpPort = await listen(cdpServer);
  const apiPort = await freePort();
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'xiaohei-v15-'));
  const settingsFile = path.join(temporary, 'api.json');
  const apiKey = 'a'.repeat(48);
  await fsp.writeFile(settingsFile, JSON.stringify({ enabled: true, host: '127.0.0.1', port: apiPort, apiKey }), 'utf8');
  const service = new LocalApiServer({ engine: new FakeEngine(cdpPort), settingsFile, version: '15.0.0' });
  await service.init();
  const base = 'http://127.0.0.1:' + apiPort;
  try {
    assert.equal((await jsonRequest(base + '/api/v1/health')).status, 200);
    assert.equal((await jsonRequest(base + '/api/v1/profiles')).status, 401);
    assert.equal((await jsonRequest(base + '/api/v1/profiles', apiKey, { headers: { Origin: 'https://evil.example' } })).status, 403);

    const listed = await jsonRequest(base + '/api/v1/profiles', apiKey);
    assert.equal(listed.status, 200); assert.equal(listed.body.data.total, 1);
    const serialized = JSON.stringify(listed.body);
    for (const secret of ['secret-user', 'secret-password', 'secret-cookie', 'secret.example', 'C:/private']) assert.equal(serialized.includes(secret), false, 'response leaked ' + secret);

    const created = await jsonRequest(base + '/api/v1/profiles', apiKey, { method: 'POST', body: { name: 'API Profile', tag: 'V15', proxy: 'http://api-user:api-password@127.0.0.1:8080' } });
    assert.equal(created.status, 201); const createdId = created.body.data.id; assert.ok(createdId);
    const updated = await jsonRequest(base + '/api/v1/profiles/' + createdId, apiKey, { method: 'PATCH', body: { language: 'ja-JP' } });
    assert.equal(updated.body.data.language, 'ja-JP');
    const started = await jsonRequest(base + '/api/v1/profiles/' + createdId + '/start', apiKey, { method: 'POST' });
    assert.equal(started.body.data.running, true);
    assert.equal(started.body.data.automation.debuggerAddress, '127.0.0.1:' + cdpPort);
    assert.equal(started.body.data.automation.browserWSEndpoint, 'ws://127.0.0.1/devtools/browser/v15-test');
    const sessions = await jsonRequest(base + '/api/v1/sessions', apiKey); assert.equal(sessions.body.data.length, 1);
    const openapi = await jsonRequest(base + '/api/v1/openapi.json', apiKey); assert.equal(openapi.body.data.openapi, '3.1.0');

    const client = makeMcpClient(path.join(__dirname, 'mcp-server.js'), settingsFile);
    const initialized = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'v15-selftest', version: '1' } });
    assert.equal(initialized.serverInfo.version, '15.0.0');
    const tools = await client.request('tools/list'); assert.ok(tools.tools.some((tool) => tool.name === 'xiaohei_start_profile')); assert.ok(!tools.tools.some((tool) => /delete/i.test(tool.name)));
    const toolResult = await client.request('tools/call', { name: 'xiaohei_list_profiles', arguments: { pageSize: 10 } });
    assert.equal(toolResult.isError, undefined); assert.ok(toolResult.structuredContent.total >= 2);
    client.child.stdin.end();
    await new Promise((resolve) => client.child.once('exit', resolve));
    assert.equal(client.stderr(), '');

    const index = await fsp.readFile(path.join(__dirname, 'index.html'), 'utf8');
    const renderer = await fsp.readFile(path.join(__dirname, 'renderer.js'), 'utf8');
    const preload = await fsp.readFile(path.join(__dirname, 'preload.js'), 'utf8');
    assert.ok(index.includes('data-view="api"') && index.includes('id="view-api"'));
    assert.ok(renderer.includes("value.type === 'profiles'") && renderer.includes('refreshApiInfo'));
    assert.ok(preload.includes('getApiInfo') && preload.includes('resetApiKey'));
    assert.ok(await fsp.stat(path.join(__dirname, 'skills', 'xiaohei-browser', 'SKILL.md')));
  } finally {
    await service.close(); await close(cdpServer); await fsp.rm(temporary, { recursive: true, force: true });
  }
  console.log('V15 Local API, MCP, Skill and UI self-test passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });