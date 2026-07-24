#!/usr/bin/env node
'use strict';

const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');

const SERVER_NAME = 'xiaohei-local-api';
const SERVER_VERSION = '15.0.0';
const SUPPORTED_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

function settingsPath() {
  if (process.env.XIAOHEI_API_SETTINGS) return path.resolve(process.env.XIAOHEI_API_SETTINGS);
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || process.cwd(), 'AppData', 'Roaming');
  return path.join(appData, 'browserops-local-sync', 'xiaohei-local-api.json');
}

async function apiSettings() {
  const file = settingsPath();
  let value;
  try { value = JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (_) { throw new Error('小黑多开器 Local API 配置不存在。请先启动小黑多开器 V15。'); }
  if (!value.enabled) throw new Error('小黑多开器 Local API 当前已停用。');
  if (!value.apiKey) throw new Error('小黑多开器 Local API Key 缺失。');
  return {
    url: 'http://127.0.0.1:' + Number(value.port || 51415),
    apiKey: String(value.apiKey)
  };
}

async function callApi(endpoint, options = {}) {
  const settings = await apiSettings();
  const response = await fetch(settings.url + endpoint, {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-API-Key': settings.apiKey
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeout || 120000)
  });
  let value;
  try { value = await response.json(); }
  catch (_) { throw new Error('Local API returned a non-JSON response'); }
  if (!response.ok || value.success === false) throw new Error(value?.data?.error?.message || 'Local API request failed with HTTP ' + response.status);
  return value.data;
}

const tools = [
  {
    name: 'xiaohei_list_profiles',
    description: '查询小黑多开器中的环境列表，可按关键词和运行状态筛选。',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '环境编号、名称或分组关键词' },
        running: { type: 'boolean', description: '仅返回运行中或已停止的环境' },
        page: { type: 'integer', minimum: 1, default: 1 },
        pageSize: { type: 'integer', minimum: 1, maximum: 200, default: 50 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'xiaohei_get_profile',
    description: '读取一个环境的公开配置和运行状态。代理密码、Cookie 与本地路径不会返回。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '环境内部 ID，例如 env-001' } },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'xiaohei_create_profile',
    description: '创建一个隔离的 Google Chrome 环境。未提供编号和名称时自动递增。',
    inputSchema: {
      type: 'object',
      properties: {
        profile: {
          type: 'object',
          description: '环境配置；可包含 name、number、proxy、language、tag、privacy、advanced 等字段。',
          additionalProperties: true
        }
      },
      required: ['profile'],
      additionalProperties: false
    }
  },
  {
    name: 'xiaohei_update_profile',
    description: '更新现有环境配置。只提交需要修改的字段；id 不可修改。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        patch: { type: 'object', additionalProperties: true }
      },
      required: ['id', 'patch'],
      additionalProperties: false
    }
  },
  {
    name: 'xiaohei_start_profile',
    description: '启动环境并返回 Selenium debuggerAddress 与 Puppeteer browserWSEndpoint。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'xiaohei_stop_profile',
    description: '正常关闭一个正在运行的环境。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'xiaohei_check_proxy',
    description: '检测指定环境代理的出口 IP、国家、时区和地理信息。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'xiaohei_list_sessions',
    description: '查询全部运行环境及其当前标签页。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
];

function requireString(value, field) {
  const text = String(value || '').trim();
  if (!text) throw new Error(field + ' is required');
  return text;
}

async function executeTool(name, input = {}) {
  if (name === 'xiaohei_list_profiles') {
    const query = new URLSearchParams();
    if (input.q) query.set('q', String(input.q));
    if (typeof input.running === 'boolean') query.set('running', String(input.running));
    if (input.page) query.set('page', String(input.page));
    if (input.pageSize) query.set('pageSize', String(input.pageSize));
    return callApi('/api/v1/profiles' + (query.size ? '?' + query : ''));
  }
  if (name === 'xiaohei_get_profile') return callApi('/api/v1/profiles/' + encodeURIComponent(requireString(input.id, 'id')));
  if (name === 'xiaohei_create_profile') return callApi('/api/v1/profiles', { method: 'POST', body: input.profile || {} });
  if (name === 'xiaohei_update_profile') return callApi('/api/v1/profiles/' + encodeURIComponent(requireString(input.id, 'id')), { method: 'PATCH', body: input.patch || {} });
  if (name === 'xiaohei_start_profile') return callApi('/api/v1/profiles/' + encodeURIComponent(requireString(input.id, 'id')) + '/start', { method: 'POST' });
  if (name === 'xiaohei_stop_profile') return callApi('/api/v1/profiles/' + encodeURIComponent(requireString(input.id, 'id')) + '/stop', { method: 'POST' });
  if (name === 'xiaohei_check_proxy') return callApi('/api/v1/profiles/' + encodeURIComponent(requireString(input.id, 'id')) + '/check-proxy', { method: 'POST' });
  if (name === 'xiaohei_list_sessions') return callApi('/api/v1/sessions');
  throw new Error('Unknown MCP tool: ' + name);
}

function send(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function error(id, code, message, data) {
  send({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    if (message?.id !== undefined) error(message.id, -32600, 'Invalid Request');
    return;
  }
  if (message.method.startsWith('notifications/')) return;
  if (message.id === undefined) return;

  try {
    if (message.method === 'initialize') {
      const requested = String(message.params?.protocolVersion || '');
      const protocolVersion = SUPPORTED_PROTOCOLS.has(requested) ? requested : '2025-06-18';
      return result(message.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: '先查询环境，再对明确的环境 ID 执行创建、更新、启动或停止。不得把 API Key、代理凭据、Cookie 或浏览器数据写入对话、日志和代码仓库。'
      });
    }
    if (message.method === 'ping') return result(message.id, {});
    if (message.method === 'tools/list') return result(message.id, { tools });
    if (message.method === 'tools/call') {
      const name = String(message.params?.name || '');
      const output = await executeTool(name, message.params?.arguments || {});
      return result(message.id, {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output
      });
    }
    if (message.method === 'resources/list') {
      return result(message.id, {
        resources: [{
          uri: 'xiaohei://local-api/openapi',
          name: '小黑多开器 Local API OpenAPI',
          description: 'V15 本地环境管理接口定义',
          mimeType: 'application/json'
        }]
      });
    }
    if (message.method === 'resources/read') {
      if (message.params?.uri !== 'xiaohei://local-api/openapi') throw new Error('Unknown resource URI');
      const document = await callApi('/api/v1/openapi.json');
      return result(message.id, {
        contents: [{ uri: 'xiaohei://local-api/openapi', mimeType: 'application/json', text: JSON.stringify(document, null, 2) }]
      });
    }
    error(message.id, -32601, 'Method not found');
  } catch (cause) {
    const messageText = String(cause?.message || cause || 'MCP tool failed');
    if (message.method === 'tools/call') {
      return result(message.id, { content: [{ type: 'text', text: messageText }], isError: true });
    }
    error(message.id, -32603, messageText);
  }
}

function runStdio() {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  input.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try { message = JSON.parse(text); }
    catch (_) { return error(null, -32700, 'Parse error'); }
    handle(message).catch((cause) => error(message.id, -32603, String(cause?.message || cause)));
  });
  input.on('close', () => process.exit(0));
}

if (require.main === module) {
  process.on('uncaughtException', (cause) => {
    process.stderr.write('[xiaohei-mcp] ' + String(cause?.stack || cause) + '\n');
  });
  process.on('unhandledRejection', (cause) => {
    process.stderr.write('[xiaohei-mcp] ' + String(cause?.stack || cause) + '\n');
  });
  runStdio();
}

module.exports = { tools, executeTool, apiSettings, callApi, settingsPath, handle, runStdio };