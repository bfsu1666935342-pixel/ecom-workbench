'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const llm = require('./llm');
const { runTurn } = require('./agent');
const { commandList, runCommand } = require('./run');
const { readConfig, saveConfig, configFiles } = require('./skillconfig');
const proposals = require('./proposals');
const updater = require('./update');
const {
  sendJson,
  readJsonBody,
  readBody,
  safeFileName,
  inside,
  mimeFor,
  formatBytes,
} = require('./util');

function createApi(ctx) {
  const { cfg, store, skills, agents, mcp } = ctx;
  const busy = new Set();
let shopsCache = null; // 领星店铺列表缓存（10 分钟）

  function skillById(id) {
    return skills.find((s) => s.id === id) || null;
  }

  function agentById(id) {
    return (agents || []).find((a) => a.id === id) || null;
  }

  function publicAgent(a) {
    return {
      id: a.id,
      role: a.role,
      avatar: a.avatar || '',
      title: a.title,
      icon: a.icon,
      order: a.order,
      tagline: a.tagline,
      description: a.description,
      skills: a.skills,
      defaultSkill: a.defaultSkill,
    };
  }

  function publicSkill(s) {
    return {
      id: s.id,
      title: s.title,
      icon: s.icon,
      group: s.group,
      order: s.order,
      tagline: s.tagline,
      description: s.description,
      starters: s.starters,
      fields: s.fields,
      featured: s.featured,
      runOnly: Boolean(s.runOnly),
      commands: commandList(s),
      configFiles: s.meta && Array.isArray(s.meta.configFiles) ? s.meta.configFiles : [],
      primaryOutput: s.meta && typeof s.meta.primaryOutput === 'string' ? s.meta.primaryOutput : '',
    };
  }

  function originAllowed(req, origin) {
    if (!origin) return true;
    if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)) return true;

    const configured = String(process.env.ECOM_PUBLIC_ORIGIN || '').replace(/\/+$/, '');
    if (configured && origin === configured) return true;

    try {
      const parsed = new URL(origin);
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
        .split(',')[0]
        .trim();
      const proto = String(req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http'))
        .split(',')[0]
        .trim();
      return Boolean(host) && parsed.host === host && parsed.protocol === proto + ':';
    } catch {
      return false;
    }
  }

  async function handle(req, res, url) {
    const pathname = url.pathname;

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      const crossSite = req.headers['sec-fetch-site'] === 'cross-site';
      if (crossSite || !originAllowed(req, origin)) {
        sendJson(res, 403, { error: '跨站请求被拒绝' });
        return true;
      }
    }

    if (pathname === '/api/health') {
      sendJson(res, 200, { ok: true, version: cfg.version, brand: cfg.brand });
      return true;
    }

    if (pathname === '/api/bootstrap' && req.method === 'GET') {
      sendJson(res, 200, {
        brand: cfg.brand,
        brandEn: cfg.brandEn,
        tagline: cfg.tagline,
        version: cfg.version,
        model: cfg.model,
        workspace: store.workspace,
        skills: skills.map(publicSkill),
        agents: (agents || []).map(publicAgent),
        sessions: store.listSessions(),
        mcp: mcp.summary(),
      });
      return true;
    }

    if (pathname === '/api/mcp' && req.method === 'GET') {
      sendJson(res, 200, mcp.summary());
      return true;
    }

    if (pathname === '/api/mcp/save' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req, 1024 * 1024);
        const server = mcp.save(body);
        sendJson(res, 200, { ok: true, server, summary: mcp.summary() });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: friendlyError(err) });
      }
      return true;
    }

    if (pathname === '/api/mcp/test' && req.method === 'POST') {
      let id = '';
      try {
        const body = await readJsonBody(req, 1024 * 1024);
        id = String(body.id || '');
        const server = await mcp.test(id);
        sendJson(res, 200, { ok: true, server, summary: mcp.summary() });
      } catch (err) {
        sendJson(res, 200, {
          ok: false,
          error: friendlyError(err),
          server: id ? mcp.get(id) : null,
          summary: mcp.summary(),
        });
      }
      return true;
    }

    if (pathname === '/api/mcp/remove' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req, 1024 * 1024);
        const ok = mcp.remove(body.id);
        sendJson(res, ok ? 200 : 404, { ok, summary: mcp.summary() });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: friendlyError(err) });
      }
      return true;
    }

    if (pathname === '/api/skills' && req.method === 'GET') {
      const id = url.searchParams.get('id');
      const skill = skillById(id);
      if (!skill) {
        sendJson(res, 404, { error: '技能不存在' });
        return true;
      }
      sendJson(res, 200, { ...publicSkill(skill), body: skill.body });
      return true;
    }

    // 员工头像：直接读 agents/<id>/avatar.*，只允许该员工目录内的文件
    if (pathname === '/api/agent/avatar' && req.method === 'GET') {
      const agent = agentById(url.searchParams.get('id') || '');
      if (!agent || !agent.avatar) {
        sendJson(res, 404, { error: '没有头像' });
        return true;
      }
      const dir = path.join(agent.source, 'agents', agent.dir);
      const abs = path.join(dir, agent.avatar);
      if (!inside(dir, abs) || !fs.existsSync(abs)) {
        sendJson(res, 404, { error: '没有头像' });
        return true;
      }
      res.writeHead(200, {
        'Content-Type': mimeFor(abs),
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      fs.createReadStream(abs).pipe(res);
      return true;
    }
    // 给员工增删技能（写回 agent.json，热重载会自动生效）
    if (pathname === '/api/agent/skills' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req, 1024 * 1024);
        const agent = agentById(String(body.agentId || ''));
        if (!agent) {
          sendJson(res, 404, { ok: false, error: '找不到这个员工' });
          return true;
        }
        const wanted = Array.isArray(body.skills) ? body.skills.map(String) : [];
        const valid = wanted.filter((id) => skillById(id));
        const file = path.join(agent.source, 'agents', agent.dir, 'agent.json');
        const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        raw.skills = valid;
        fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n', 'utf8');
        sendJson(res, 200, { ok: true, agent: { ...publicAgent(agent), skills: valid } });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: friendlyError(err) });
      }
      return true;
    }
    // 应用模型提出的配置改动（提案是内存里的，30 分钟过期）
    if (pathname === '/api/skill/config/apply' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req, 1024 * 1024);
        const proposal = proposals.take(String(body.proposalId || ''));
        if (!proposal) {
          sendJson(res, 404, { ok: false, error: '这个提案已经失效，让助手重新提交一次' });
          return true;
        }
        const skill = skillById(proposal.skillId);
        if (!skill) {
          sendJson(res, 404, { ok: false, error: '找不到技能：' + proposal.skillId });
          return true;
        }
        const result = saveConfig(skill, {
          products: proposal.payload.products,
          mtimeMs: proposal.mtimeMs,
        });
        sendJson(res, 200, { ...result, skillId: proposal.skillId, skillTitle: proposal.skillTitle });
      } catch (err) {
        sendJson(res, err.status || 400, { ok: false, error: friendlyError(err) });
      }
      return true;
    }

    // 应用内更新
    if (pathname === '/api/update/check' && req.method === 'GET') {
      try {
        const force = url.searchParams.get('force') === '1';
        const info = await updater.checkForUpdate(cfg.version, { force });
        sendJson(res, 200, { ok: true, ...info });
      } catch (err) {
        sendJson(res, 200, { ok: false, error: friendlyError(err) });
      }
      return true;
    }

    if (pathname === '/api/update/status' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, ...updater.getState(), version: cfg.version });
      return true;
    }

    if (pathname === '/api/update/apply' && req.method === 'POST') {
      let body = {};
      try {
        body = await readJsonBody(req, 1024 * 64);
      } catch {
        body = {};
      }
      const dryRun = Boolean(body && body.dry);
      const restart = !(body && body.restart === false);
      updater.applyUpdate({ appRoot: cfg.root, dryRun, restart }).catch((err) => {
        console.error('  [更新失败] ' + err.message);
      });
      sendJson(res, 200, { ok: true, started: true, dryRun });
      return true;
    }

    // 技能配置（只限 skill.json 里 configFiles 声明的那几个文件）
    if (pathname === '/api/skill/config' && req.method === 'GET') {
      const skill = skillById(url.searchParams.get('id') || '');
      if (!skill) {
        sendJson(res, 404, { ok: false, error: '找不到技能' });
        return true;
      }
      const data = readConfig(skill);
      if (!data) {
        sendJson(res, 400, { ok: false, error: '这个技能没有可编辑的配置' });
        return true;
      }
      sendJson(res, 200, { ok: true, paths: configFiles(skill), ...data });
      return true;
    }

    if (pathname === '/api/skill/config' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req, 4 * 1024 * 1024);
      } catch (err) {
        sendJson(res, 400, { ok: false, error: friendlyError(err) });
        return true;
      }
      const skill = skillById(String(body.skillId || ''));
      if (!skill) {
        sendJson(res, 404, { ok: false, error: '找不到技能' });
        return true;
      }
      try {
        const result = saveConfig(skill, body);
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, err.status || 400, { ok: false, error: friendlyError(err) });
      }
      return true;
    }
    // 打开技能自己的文件夹（一般是 config/），让人可以直接改 JSON
    if (pathname === '/api/skill/open' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req, 1024 * 1024);
        const skill = skillById(String(body.skillId || ''));
        if (!skill) {
          sendJson(res, 404, { ok: false, error: '找不到技能' });
          return true;
        }
        const dir = path.join(skill.source, skill.dir);
        const sub = String(body.sub || '').trim();
        let abs = dir;
        if (sub) {
          abs = path.resolve(dir, sub);
          if (!inside(dir, abs)) throw new Error('路径不合法');
        }
        openInExplorer(abs, false);
        sendJson(res, 200, { ok: true, path: abs });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: friendlyError(err) });
      }
      return true;
    }
    // 技能自带命令：只跑 skill.json 里声明过的入口，模型不能临时拼命令行
    if (pathname === '/api/skill/run' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req, 1024 * 1024);
      } catch (err) {
        sendJson(res, 400, { ok: false, error: friendlyError(err) });
        return true;
      }
      const skill = skillById(String(body.skillId || ''));
      if (!skill) {
        sendJson(res, 404, { ok: false, error: '找不到技能' });
        return true;
      }
      if (busy.has('run:' + skill.id)) {
        sendJson(res, 409, { ok: false, error: '这个技能正在运行，等它跑完' });
        return true;
      }
      busy.add('run:' + skill.id);
      try {
        // 浏览器关掉或刷新时把子进程一起收掉，避免留下孤儿占着端口或锁
        let child = null;
        let gone = false;
        const killChild = () => {
          if (!child) return;
          try {
            require('child_process').spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
              windowsHide: true,
              stdio: 'ignore',
            });
          } catch {
            /* 杀不掉就算了 */
          }
        };
        const onClose = () => {
          gone = true;
          killChild();
        };
        req.on('close', onClose);

        const need = Array.isArray(skill.meta && skill.meta.requiresEnv) ? skill.meta.requiresEnv : [];
        if (need.length) {
          const have = require('./run').envFromMcp(store.dataDir);
          const missing = need.filter((k) => !have[k]);
          if (missing.length) {
            sendJson(res, 200, {
              ok: false,
              code: null,
              error:
                '这个技能需要「' +
                missing.join(' / ') +
                '」，现在没有。到侧边栏「数据源」里把对应的服务商配好（保存即生效），再回来运行。',
              missing,
              injected: Object.keys(have),
              output: '',
              files: [],
              ms: 0,
            });
            return true;
          }
        }

        const result = await runCommand({
          skill,
          index: body.index,
          params: body.params || {},
          workspace: store.workspace,
          dataDir: store.dataDir,
          onChild: (c) => {
            child = c;
            if (gone) killChild();
          },
        });
        req.removeListener('close', onClose);
        sendJson(res, 200, Object.assign({ ok: false }, result));
      } catch (err) {
        sendJson(res, 200, { ok: false, error: friendlyError(err) });
      } finally {
        busy.delete('run:' + skill.id);
      }
      return true;
    }

    if (pathname === '/api/verify' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req, 1024 * 1024);
        const key = String(body.key || '').trim();
        if (!key) {
          sendJson(res, 400, { ok: false, error: '请填写 API Key' });
          return true;
        }
        await llm.verifyKey({ apiKey: key, baseUrl: cfg.apiBase });
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendJson(res, 200, { ok: false, error: friendlyError(err) });
      }
      return true;
    }

    if (pathname === '/api/upload' && req.method === 'POST') {
      try {
        const name = safeFileName(url.searchParams.get('name') || 'file');
        const mime = url.searchParams.get('mime') || 'application/octet-stream';
        const buf = await readBody(req, 40 * 1024 * 1024);
        if (!buf.length) {
          sendJson(res, 400, { error: '空文件' });
          return true;
        }
        if (buf.length > 32 * 1024 * 1024) {
          sendJson(res, 413, { error: '文件超过 32MB，建议先在本地压缩或拆分' });
          return true;
        }
        const meta = store.saveUpload(buf, name, mime);
        sendJson(res, 200, {
          ok: true,
          file: { id: meta.id, name: meta.name, size: meta.size, mime: meta.mime },
        });
      } catch (err) {
        sendJson(res, err.status || 500, { error: friendlyError(err) });
      }
      return true;
    }

    if (pathname === '/api/session' && req.method === 'GET') {
      const id = url.searchParams.get('id');
      const session = store.getSession(id);
      if (!session) {
        sendJson(res, 404, { error: '会话不存在' });
        return true;
      }
      sendJson(res, 200, session);
      return true;
    }

    if (pathname === '/api/session' && req.method === 'DELETE') {
      const id = url.searchParams.get('id');
      const ok = store.deleteSession(id);
      sendJson(res, ok ? 200 : 404, { ok });
      return true;
    }

    if (pathname === '/api/session' && req.method === 'PATCH') {
      try {
        const body = await readJsonBody(req, 1024 * 1024);
        const session = store.getSession(body.id);
        if (!session) {
          sendJson(res, 404, { error: '会话不存在' });
          return true;
        }
        if (body.title) session.title = String(body.title).slice(0, 80);
        store.saveSession(session);
        sendJson(res, 200, { ok: true, title: session.title });
      } catch (err) {
        sendJson(res, err.status || 500, { error: friendlyError(err) });
      }
      return true;
    }

    if (pathname === '/api/chat' && req.method === 'POST') {
      return handleChat(req, res);
    }

    if (pathname === '/api/outputs' && req.method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 300, 800);
      const items = [];
      const walk = (dir, base, depth) => {
        if (depth > 4 || items.length > limit * 3) return;
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const name = entry.name;
          if (name.startsWith('.') || name === 'node_modules' || /^_?tmp/i.test(name)) continue;
          const abs = path.join(dir, name);
          const rel = base ? base + '/' + name : name;
          if (entry.isDirectory()) {
            walk(abs, rel, depth + 1);
            continue;
          }
          if (!entry.isFile()) continue;
          let stat;
          try {
            stat = fs.statSync(abs);
          } catch {
            continue;
          }
          const parts = rel.split('/');
          let group = '工作区';
          if (parts[0] === '技能产出') group = parts[1] || '技能产出';
          else if (parts.length > 1) group = parts[0];
          items.push({
            rel,
            name,
            group,
            size: stat.size,
            mtime: stat.mtimeMs,
            ext: (path.extname(name) || '').replace('.', '').toLowerCase(),
          });
        }
      };
      walk(store.workspace, '', 0);
      items.sort((a, b) => b.mtime - a.mtime);
      sendJson(res, 200, { items: items.slice(0, limit), total: items.length });
      return true;
    }

    if (pathname === '/api/shops' && req.method === 'GET') {
      const now = Date.now();
      if (shopsCache && now - shopsCache.at < 10 * 60 * 1000) {
        sendJson(res, 200, shopsCache.data);
        return true;
      }
      try {
        const { McpClient } = require('./mcp');
        const target =
          mcp.list().find((s) => /lingxing\.com/i.test(String(s.url || ''))) ||
          mcp.list().find((s) => /lingxing/i.test(String(s.id || '')) + String(s.mark || ''));
        if (!target) throw new Error('还没有配置领星数据源');
        const client = new McpClient(target, cfg.version);
        const text = await client.callTool('action', { toolId: 'ad_auth_shops', params: {} });
        let doc = null;
        try {
          doc = JSON.parse(text);
        } catch {
          throw new Error('领星返回的不是 JSON：' + String(text).slice(0, 120));
        }
        const inner = doc && doc.data;
        const rows = Array.isArray(inner) ? inner : (inner && (inner.data || inner.list)) || [];
        const shops = (Array.isArray(rows) ? rows : [])
          .map((r) => ({
            alias: String(r.alias || r.name || '').trim(),
            sid: Number(r.sid) || 0,
            profileId: String(r.profile_id || ''),
            country: String(r.country || '').toUpperCase(),
            storeId: Number(r.store_id) || 0,
          }))
          .filter((s) => s.alias);
        shopsCache = { at: now, data: { ok: true, shops } };
        sendJson(res, 200, shopsCache.data);
      } catch (err) {
        sendJson(res, 200, { ok: false, error: friendlyError(err), shops: [] });
      }
      return true;
    }

    if (pathname === '/api/file' && req.method === 'GET') {
      const rel = url.searchParams.get('path') || '';
      let abs;
      try {
        abs = path.resolve(store.workspace, rel);
        if (!inside(store.workspace, abs)) throw new Error('bad path');
      } catch {
        sendJson(res, 400, { error: '路径不合法' });
        return true;
      }
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        sendJson(res, 404, { error: '文件不存在' });
        return true;
      }
      const download = url.searchParams.get('download') === '1';
      const fileName = path.basename(abs);
      res.writeHead(200, {
        'Content-Type': mimeFor(abs),
        'Content-Length': fs.statSync(abs).size,
        'Content-Disposition': (download ? 'attachment' : 'inline') + "; filename*=UTF-8''" + encodeURIComponent(fileName),
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(abs).pipe(res);
      return true;
    }

    if (pathname === '/api/open' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req, 1024 * 1024);
        const target = String(body.path || '');
        let abs = store.workspace;
        if (target) {
          abs = path.resolve(store.workspace, target);
          if (!inside(store.workspace, abs)) throw new Error('路径不合法');
        }
        openInExplorer(abs, Boolean(target));
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendJson(res, 400, { error: friendlyError(err) });
      }
      return true;
    }

    if (pathname === '/api/export' && req.method === 'GET') {
      const all = [];
      for (const s of store.listSessions()) {
        const full = store.getSession(s.id);
        if (full) all.push({ title: full.title, skillId: full.skillId, createdAt: full.createdAt, updatedAt: full.updatedAt, messages: full.ui });
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent('跨境工作台-对话导出-' + new Date().toISOString().slice(0, 10) + '.json'),
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ exportedAt: new Date().toISOString(), version: cfg.version, conversations: all }, null, 2));
      return true;
    }

    if (pathname === '/api/clear' && req.method === 'POST') {
      for (const s of store.listSessions()) store.deleteSession(s.id);
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (pathname === '/api/stats' && req.method === 'GET') {
      const sessions = store.listSessions();
      let files = 0;
      const walk = (dir, depth) => {
        if (depth > 4) return;
        let entries = [];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (e.name.startsWith('.')) continue;
          if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
          else files += 1;
        }
      };
      walk(store.workspace, 0);
      sendJson(res, 200, { sessions: sessions.length, files });
      return true;
    }

    return false;
  }

  async function handleChat(req, res) {
    const apiKey = String(req.headers['x-api-key'] || '').trim();
    if (!apiKey) {
      sendJson(res, 401, { error: '还没有填写 API Key', code: 'NO_KEY' });
      return true;
    }
    let body;
    try {
      body = await readJsonBody(req, 2 * 1024 * 1024);
    } catch (err) {
      sendJson(res, 400, { error: friendlyError(err) });
      return true;
    }

    const skill = body.skillId ? skillById(body.skillId) : null;
    let session = body.sessionId ? store.getSession(body.sessionId) : null;
    if (!session) session = store.newSession(skill ? skill.id : null);
    if (skill) session.skillId = skill.id;
    else if (body.skillId === null) session.skillId = null;
const activeSkill = session.skillId ? skillById(session.skillId) : skill;

    const agent = body.agentId ? agentById(body.agentId) : null;
    if (agent) session.agentId = agent.id;
    else if (body.agentId === null) session.agentId = null;
    const activeAgent = session.agentId ? agentById(session.agentId) : null;

    if (busy.has(session.id)) {
      sendJson(res, 409, { error: '这个对话还在生成中，请稍候' });
      return true;
    }
    busy.add(session.id);

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    if (res.flushHeaders) res.flushHeaders();

    let closed = false;
    let ended = false;
    const write = (obj) => {
      if (closed || ended) return;
      try {
        res.write(JSON.stringify(obj) + '\n');
      } catch {
        closed = true;
      }
    };
    const heartbeat = setInterval(() => write({ t: 'ping' }), 15000);

    const controller = new AbortController();
    req.on('aborted', () => {
      if (!ended) controller.abort();
    });
    res.on('close', () => {
      closed = true;
      if (!ended) controller.abort();
    });

    try {
      write({ t: 'start', sessionId: session.id, skillId: session.skillId, model: cfg.model });
      await runTurn({
        cfg,
        store,
        session,
        skill: activeSkill,
        agent: activeAgent,
        skills,
        text: body.text,
        files: body.files || [],
        options: {
          thinking: Boolean(body.options && body.options.thinking),
          search: Boolean(body.options && body.options.search),
          model: body.model || cfg.model,
        },
        apiKey,
        signal: controller.signal,
        emit: write,
        mcp,
      });
    } catch (err) {
      if (err && (err.name === 'AbortError' || controller.signal.aborted)) {
        write({ t: 'aborted' });
      } else {
        console.error('[chat]', err && err.message);
        write({ t: 'error', message: friendlyError(err), code: err.status || 500 });
      }
    } finally {
      clearInterval(heartbeat);
      ended = true;
      busy.delete(session.id);
      if (!res.writableEnded) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
    }
    return true;
  }

  return { handle };
}

function friendlyError(err) {
  if (!err) return '未知错误';
  const msg = String(err.message || err);
  if (err.status === 401) return 'API Key 无效或已过期，请到 platform.deepseek.com 检查。';
  if (err.status === 402) return '账户余额不足，请到 DeepSeek 开放平台充值后再试。';
  if (err.status === 429) return '请求太频繁（429），等几秒再试。';
  if (err.status === 413) return '文件太大，无法上传。';
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|network/i.test(msg)) {
    return '连不上 DeepSeek 接口，请检查网络或代理设置。';
  }
  if (/aborted|abort/i.test(msg)) return '请求已取消。';
  return msg.slice(0, 500);
}

function openInExplorer(abs, select) {
  try {
    if (process.platform === 'win32') {
      if (select && fs.existsSync(abs)) {
        spawn('explorer.exe', ['/select,' + abs], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('explorer.exe', [abs], { detached: true, stdio: 'ignore' }).unref();
      }
    } else if (process.platform === 'darwin') {
      spawn('open', [select ? '-R' : '', abs].filter(Boolean), { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [select ? path.dirname(abs) : abs], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* ignore */
  }
}

module.exports = { createApi, friendlyError, formatBytes };
