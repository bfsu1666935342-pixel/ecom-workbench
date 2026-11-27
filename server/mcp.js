'use strict';

const path = require('path');
const { ensureDir, atomicWrite, readJson, uid } = require('./util');

const PROTOCOL = '2024-11-05';
// 所有 MCP 服务加起来的工具上限。原来是 40，SIF(37) 就吃掉大半，
// Sorftime 那种上百个工具的服务会一个都进不来，所以放大到 260。
// 太多会占上下文，真觉得慢再按服务裁剪。
const MAX_TOOLS = 260;

const PRESETS = [
  {
    preset: 'lingxing',
    name: '领星 ERP',
    mark: '领',
    note: '订单、库存、广告等运营数据',
    url: '',
    authMode: 'bearer',
    keyParam: 'key',
  },
  {
    preset: 'sellersprite',
    name: '卖家精灵',
    mark: '卖',
    note: '类目、关键词、竞品数据',
    url: '',
    authMode: 'bearer',
    keyParam: 'key',
  },
  {
    preset: 'sif',
    name: 'SIF',
    mark: 'SIF',
    note: '亚马逊市场与关键词数据',
    url: '',
    authMode: 'bearer',
    keyParam: 'key',
  },
  {
    preset: 'sorftime',
    name: 'Sorftime',
    mark: 'SF',
    note: '类目报告、Top100、关键词与趋势',
    url: 'https://mcp.sorftime.com',
    authMode: 'query',
    keyParam: 'key',
  },
];

function blankPreset(p) {
  return {
    id: 'mcp-' + p.preset,
    preset: p.preset,
    name: p.name,
    mark: p.mark,
    note: p.note,
    url: p.url || '',
    authMode: p.authMode || 'bearer',
    token: '',
    keyParam: p.keyParam || 'key',
    headers: {},
    enabled: false,
    status: 'untested',
    tools: [],
    lastError: '',
    testedAt: 0,
    updatedAt: Date.now(),
  };
}

function sanitizeName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'mcp';
}

function parsePayload(text, contentType, id) {
  if (/text\/event-stream/i.test(contentType || '')) {
    const blocks = String(text).split(/\n\n/);
    for (const block of blocks) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (!data || data === '[DONE]') continue;
      let obj;
      try {
        obj = JSON.parse(data);
      } catch {
        continue;
      }
      if (obj && (obj.id === id || obj.result !== undefined || obj.error !== undefined)) return obj;
    }
    throw new Error('MCP 返回了 SSE 流，但没有可解析的 JSON 消息');
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error('MCP 返回的不是 JSON：' + String(text).slice(0, 200));
  }
  if (!obj || typeof obj !== 'object') throw new Error('MCP 返回了意外的 JSON');
  return obj;
}

class McpClient {
  constructor(server, version) {
    this.server = server;
    this.version = version;
    this.protocol = PROTOCOL;
    this.seq = 0;
    this.sessionId = '';
    this.initialized = false;
  }

  endpoint() {
    const raw = String(this.server.url || '').trim();
    if (!/^https?:\/\//i.test(raw)) throw new Error('MCP 地址必须是 http/https URL');
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new Error('MCP 地址格式不正确');
    }
    if (this.server.authMode === 'query' && this.server.token) {
      url.searchParams.set(this.server.keyParam || 'key', this.server.token);
    }
    return url.toString();
  }

  headers() {
    const headers = {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'User-Agent': 'EcomWorkbench/' + this.version,
    };
    if (this.initialized) headers['MCP-Protocol-Version'] = this.protocol;
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    const authMode = this.server.authMode || 'bearer';
    if (this.server.token && (authMode === 'bearer' || authMode === 'headers')) {
      headers.Authorization = 'Bearer ' + this.server.token;
    }
    if (this.server.headers && typeof this.server.headers === 'object') {
      for (const [key, value] of Object.entries(this.server.headers)) {
        if (value !== undefined && value !== null) headers[key] = String(value);
      }
    }
    return headers;
  }

  async request(method, params, opts = {}) {
    const notify = Boolean(opts.notify);
    const id = notify ? undefined : ++this.seq;
    const payload = { jsonrpc: '2.0', method };
    if (!notify) payload.id = id;
    if (params !== undefined) payload.params = params;

    let resp;
    try {
      resp = await fetch(this.endpoint(), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(opts.timeout || 30000),
      });
    } catch (err) {
      throw new Error('连不上 MCP：' + (err && err.message ? err.message : String(err)));
    }
    const sid = resp.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (!resp.ok) {
      let detail = '';
      try {
        detail = (await resp.text()).slice(0, 300);
      } catch {
        /* ignore */
      }
      throw new Error('MCP HTTP ' + resp.status + (detail ? '：' + detail : ''));
    }
    if (resp.status === 202 || resp.status === 204) return null;
    const text = await resp.text();
    if (!text.trim()) return null;
    const contentType = resp.headers.get('content-type') || '';
    const obj = parsePayload(text, contentType, id);
    if (obj.error) {
      throw new Error('MCP 错误 ' + (obj.error.code || '') + '：' + (obj.error.message || ''));
    }
    return obj.result;
  }

  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: this.protocol,
      capabilities: {},
      clientInfo: { name: 'EcomWorkbench', version: this.version },
    });
    if (result && result.protocolVersion) this.protocol = result.protocolVersion;
    this.initialized = true;
    try {
      await this.request('notifications/initialized', undefined, { notify: true });
    } catch {
      /* some servers do not accept the notification */
    }
    return result;
  }

  async ensure() {
    if (!this.initialized) await this.initialize();
  }

  async listTools() {
    await this.ensure();
    const tools = [];
    let cursor;
    for (let page = 0; page < 10; page += 1) {
      const result = await this.request('tools/list', cursor ? { cursor } : {});
      const batch = Array.isArray(result && result.tools) ? result.tools : [];
      tools.push(...batch);
      cursor = result && result.nextCursor;
      if (!cursor || batch.length === 0) break;
    }
    return tools;
  }

  async callTool(name, args) {
    await this.ensure();
    const result = await this.request('tools/call', { name, arguments: args || {} });
    if (result && result.isError) {
      return 'MCP 工具返回错误：' + contentToText(result);
    }
    return contentToText(result);
  }
}

function contentToText(result) {
  if (!result || typeof result !== 'object') return String(result || '');
  if (result.structuredContent !== undefined) {
    try {
      return JSON.stringify(result.structuredContent, null, 2);
    } catch {
      /* fallthrough */
    }
  }
  const blocks = Array.isArray(result.content) ? result.content : [];
  const parts = [];
  for (const block of blocks) {
    if (!block) continue;
    if (block.type === 'text') parts.push(String(block.text || ''));
    else if (block.type === 'image') parts.push('[图片]');
    else if (block.type === 'resource') parts.push('[资源] ' + (block.resource && block.resource.uri ? block.resource.uri : ''));
    else parts.push(JSON.stringify(block));
  }
  return parts.join('\n\n') || '（MCP 工具没有返回内容）';
}

class McpManager {
  constructor({ dataDir, version = '1.1.0' }) {
    this.dataDir = dataDir;
    this.version = version;
    this.file = path.join(dataDir, 'mcp.json');
    this.servers = [];
    this.toolMap = new Map();
    ensureDir(dataDir);
    this.load();
  }

  load() {
    const data = readJson(this.file, null);
    if (!data || !Array.isArray(data.servers)) {
      this.servers = PRESETS.map(blankPreset);
      this.saveFile();
      return;
    }
    this.servers = data.servers.map((s) => ({ ...s, headers: s.headers || {}, tools: Array.isArray(s.tools) ? s.tools : [] }));
    for (const p of PRESETS) {
      if (!this.servers.some((s) => s.preset === p.preset)) this.servers.push(blankPreset(p));
    }
    this.saveFile();
  }

  saveFile() {
    atomicWrite(this.file, JSON.stringify({ servers: this.servers }, null, 2));
  }

  list() {
    return this.servers.map((s) => ({
      ...s,
      hasToken: Boolean(s.token),
      headers: s.headers || {},
    }));
  }

  get(id) {
    return this.servers.find((s) => s.id === id) || null;
  }

  save(payload) {
    const id = String(payload.id || '').trim();
    let server = id ? this.get(id) : null;
    if (!server) {
      server = {
        id: 'mcp-' + uid(),
        preset: payload.preset || 'custom',
        mark: payload.mark || 'MCP',
        note: payload.note || '自定义 MCP 服务',
        token: '',
        keyParam: 'key',
        headers: {},
        enabled: false,
        status: 'untested',
        tools: [],
        lastError: '',
        testedAt: 0,
      };
      this.servers.push(server);
    }
    const nextUrl = String(payload.url !== undefined ? payload.url : server.url || '').trim();
    if (nextUrl) {
      let parsed;
      try {
        parsed = new URL(nextUrl);
      } catch {
        throw new Error('MCP 地址格式不正确');
      }
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('MCP 地址必须使用 http/https');
    }
    if (payload.name !== undefined) server.name = String(payload.name).trim().slice(0, 60) || server.name;
    if (payload.authMode !== undefined) {
      server.authMode = ['bearer', 'query', 'headers'].includes(payload.authMode) ? payload.authMode : 'bearer';
    }
    if (payload.token !== undefined) server.token = String(payload.token).trim();
    if (payload.keyParam !== undefined) server.keyParam = String(payload.keyParam).trim() || 'key';
    if (payload.headers !== undefined) {
      let headers = payload.headers;
      if (typeof headers === 'string') {
        const text = headers.trim();
        if (text) {
          try {
            headers = JSON.parse(text);
          } catch {
            throw new Error('附加 Headers 不是合法 JSON');
          }
        } else {
          headers = {};
        }
      }
      if (headers && typeof headers === 'object' && !Array.isArray(headers)) server.headers = headers;
    }
    if (payload.enabled !== undefined) server.enabled = Boolean(payload.enabled);
    if (nextUrl !== server.url) {
      server.status = 'untested';
      server.tools = [];
      server.lastError = '';
    }
    server.url = nextUrl;
    server.updatedAt = Date.now();
    this.saveFile();
    return this.publicServer(server);
  }

  remove(id) {
    const server = this.get(id);
    if (!server) return false;
    if (server.preset && PRESETS.some((p) => p.preset === server.preset)) {
      Object.assign(server, blankPreset(PRESETS.find((p) => p.preset === server.preset)));
    } else {
      this.servers = this.servers.filter((s) => s.id !== id);
    }
    this.saveFile();
    return true;
  }

  async test(id) {
    const server = this.get(id);
    if (!server) throw new Error('数据源不存在');
    if (!server.url) throw new Error('请先填写 MCP 地址');
    const client = new McpClient(server, this.version);
    try {
      await client.initialize();
      const tools = await client.listTools();
      server.tools = tools.map((t) => ({
        name: String(t.name || ''),
        description: String(t.description || '').slice(0, 800),
        inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
      })).filter((t) => t.name);
      server.status = 'ok';
      server.lastError = '';
      server.testedAt = Date.now();
      server.updatedAt = Date.now();
      this.saveFile();
      return this.publicServer(server);
    } catch (err) {
      server.status = 'error';
      server.lastError = err && err.message ? err.message : String(err);
      server.testedAt = Date.now();
      this.saveFile();
      throw err;
    }
  }

  publicServer(server) {
    return { ...server, hasToken: Boolean(server.token) };
  }

  connectedCount() {
    return this.servers.filter((s) => s.status === 'ok' && s.tools.length).length;
  }

  summary() {
    return {
      servers: this.list(),
      connected: this.connectedCount(),
      toolCount: this.servers.reduce((n, s) => n + (s.enabled && s.status === 'ok' ? s.tools.length : 0), 0),
    };
  }

  defs() {
    this.toolMap = new Map();
    const defs = [];
    const slugs = new Set();
    for (const server of this.servers) {
      if (!server.enabled || server.status !== 'ok' || !server.tools.length) continue;
      let slug = sanitizeName(server.preset || server.name || server.id);
      let base = slug;
      let n = 2;
      while (slugs.has(slug)) {
        slug = base + '_' + n;
        n += 1;
      }
      slugs.add(slug);
      for (const tool of server.tools) {
        if (defs.length >= MAX_TOOLS) {
        console.warn('[mcp] 工具数到上限 ' + MAX_TOOLS + '，' + server.name + ' 的其余工具被截断');
        break;
      }
        const toolName = sanitizeName(tool.name);
        const fullName = ('mcp__' + slug + '__' + toolName).slice(0, 120);
        if (this.toolMap.has(fullName)) continue;
        this.toolMap.set(fullName, { serverId: server.id, toolName: tool.name });
        const description = ('[' + server.name + '] ' + (tool.description || server.note || '')).slice(0, 700);
        const parameters = tool.inputSchema && typeof tool.inputSchema === 'object'
          ? tool.inputSchema
          : { type: 'object', properties: {} };
        defs.push({
          type: 'function',
          function: {
            name: fullName,
            description,
            parameters: parameters.type ? parameters : { type: 'object', properties: parameters.properties || {} },
          },
        });
      }
    }
    return defs;
  }

  async call(fullName, args) {
    if (!this.toolMap.size) this.defs();
    const target = this.toolMap.get(fullName);
    if (!target) return { ok: false, content: '找不到数据源工具：' + fullName };
    const server = this.get(target.serverId);
    if (!server) return { ok: false, content: '数据源已被删除' };
    try {
      const client = new McpClient(server, this.version);
      const text = await client.callTool(target.toolName, args);
      return { ok: true, content: String(text || '').slice(0, 60000) };
    } catch (err) {
      return { ok: false, content: '数据源调用失败：' + (err && err.message ? err.message : String(err)) };
    }
  }
}

module.exports = { McpManager, McpClient, PRESETS, PROTOCOL };
