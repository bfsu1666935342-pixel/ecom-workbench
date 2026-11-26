'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const llm = require('./llm');
const { ensureDir, inside, uid, formatBytes } = require('./util');
const skillconfig = require('./skillconfig');
const proposals = require('./proposals');
const confirmations = require('./confirmations');
const outputguard = require('./outputguard');

const MAX_TOOL_RESULT = 60000;

function resolveSafe(workspace, rel) {
  const raw = String(rel || '').trim().replace(/^[/\\]+/, '');
  if (!raw) throw new Error('缺少文件路径');
  const abs = path.resolve(workspace, raw);
  if (!inside(workspace, abs)) throw new Error('路径必须位于工作区内：' + raw);
  return abs;
}

function snapshot(workspace) {
  const map = new Map();
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs, depth + 1);
      } else if (e.isFile()) {
        try {
          const st = fs.statSync(abs);
          map.set(abs, st.size + ':' + st.mtimeMs);
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(workspace, 0);
  return map;
}

function trim(text, max = MAX_TOOL_RESULT) {
  const s = String(text == null ? '' : text);
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n\n…（内容过长，已截断，共 ' + s.length + ' 字符）';
}

function toolDefs(opts = {}) {
  const defs = [];
  // 只有「带员工的会话」才有这个工具：按需装载岗位技能
  if (Array.isArray(opts.agentSkills) && opts.agentSkills.length) {
    defs.push({
      type: 'function',
      function: {
        name: 'load_skill',
        description:
          '装载当前员工某个技能的完整说明（流程、模板、红线）。需要该技能的专项方法时先调用它，不要凭印象编流程。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '技能 id，例如 market-scan' },
          },
          required: ['id'],
        },
      },
    });
  }
  if (opts.outputGuard) {
    defs.push({
      type: 'function',
      function: {
        name: 'check_output',
        description:
          '交卷前检查产出结构：把你要给用户的完整内容原样传进来，返回缺哪些章节、哪节不合格。' +
          '不合格就按提示补全后重新调用，直到返回通过为止。这个技能要求必须通过才能收尾。',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '完整的产出内容（Markdown 全文）' },
            skip: {
              type: 'array',
              description: '用户明确不要的章节名，例如 ["广告审计","站外痕迹"]。只对可选章节有效',
              items: { type: 'string' },
            },
          },
          required: ['content'],
        },
      },
    });
  }

  if (Array.isArray(opts.configSkills) && opts.configSkills.length) {
    defs.push({
      type: 'function',
      function: {
        name: 'update_skill_config',
        description:
          '提出一份技能配置的修改（周报的复盘产品、父体 ASIN、竞品、月目标、成本等）。' +
          '你只是提案，不会直接写盘：用户会在界面上看到改动清单并点「应用」，点完立即生效。' +
          '必须先 load_skill 看过配置结构，并且提交完整的产品列表（不是增量）。',
        parameters: {
          type: 'object',
          properties: {
            skillId: { type: 'string', description: '技能 id，例如 amazon-weekly-report' },
            products: {
              type: 'array',
              description:
                '完整产品列表。每项含 spu、site、parents[{asin}]、competitor{asin,url}、price、rating、enabled、target{default_monthly,target_margin,cost{unit_cost,first_leg,fba_fee,referral_rate}}',
              items: { type: 'object' },
            },
            note: { type: 'string', description: '一句话说明这次改了什么，给用户看' },
          },
          required: ['skillId', 'products'],
        },
      },
    });
  }

  if (opts.search) {
    defs.push({
      type: 'function',
      function: {
        name: 'web_search',
        description:
          '联网搜索。用于查询最新的亚马逊政策、费用、竞品动态、市场趋势、行业数据等。返回标题、链接、摘要和日期。需要事实依据时先搜再答，并在回答中用链接标注来源。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索词，可用 site:、after:、lang: 等运算符' },
            count: { type: 'integer', description: '返回条数，1-20，默认 8' },
          },
          required: ['query'],
        },
      },
    });
    defs.push({
      type: 'function',
      function: {
        name: 'read_url',
        description: '读取一个网页的正文（Markdown）。当搜索结果摘要不够、需要核对原文时使用。',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: '完整的 http/https 链接' } },
          required: ['url'],
        },
      },
    });
  }
  defs.push(
    {
      type: 'function',
      function: {
        name: 'list_files',
        description: '列出工作区里的文件。产出文件前可先看目录，避免覆盖。',
        parameters: {
          type: 'object',
          properties: { dir: { type: 'string', description: '相对工作区的目录，默认根目录' } },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: '读取工作区内的文本文件（txt/md/csv/json/html 等）。用户上传的附件在 attachments/ 目录。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对工作区的文件路径' },
            max_chars: { type: 'integer', description: '最多读取字符数，默认 60000' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description:
          '把结果写成文件，保存到工作区（用户可在界面上直接打开/下载）。适合：Listing 文案、分析报告 HTML、测算表格 CSV、话术文档 Markdown。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对工作区的路径，如 reports/listing-露营灯.md' },
            content: { type: 'string', description: '完整文件内容' },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'run_javascript',
        description:
          '在工作区运行一段 Node.js 代码，用于精确计算、解析 CSV/JSON、批量处理数据、生成 HTML/CSV 文件。可用内置函数：read(rel)、readCsv(rel)、write(rel, data)、readJson(rel)、list(rel)、table(rows)。必须用 console.log 输出结果；不要访问网络。',
        parameters: {
          type: 'object',
          properties: {
            code: { type: 'string', description: '要执行的 JavaScript 代码' },
            purpose: { type: 'string', description: '一句话说明这段代码要做什么' },
          },
          required: ['code'],
        },
      },
    },
  );
  // 读技能配置：让员工能准确回答「现在登记了哪些 SPU / 店铺 / 目标」
  if (Array.isArray(opts.configSkills) && opts.configSkills.length) {
    defs.push({
      type: 'function',
      function: {
        name: 'read_skill_config',
        description:
          '读取某个技能当前的配置（产品列表、店铺、父体 ASIN、月目标、成本等）。' +
          '用户问「现在配了哪些 SPU / 目标是多少」时先调它，不要猜。改配置用 update_skill_config。',
        parameters: {
          type: 'object',
          properties: {
            skillId: { type: 'string', description: '技能 id，例如 amazon-weekly-report' },
          },
          required: ['skillId'],
        },
      },
    });
  }

  // 运行工具型技能：不直接跑，先发确认
  const runnable = (Array.isArray(opts.skills) ? opts.skills : []).filter((x) => {
    const cmds = (x.meta && Array.isArray(x.meta.commands) && x.meta.commands) || x.commands || [];
    return cmds.length > 0;
  });
  if (runnable.length) {
    defs.push({
      type: 'function',
      function: {
        name: 'run_skill',
        description:
          '发起运行一个「工具型技能」的命令（例如生成周报、生成备货表）。' +
          '调用后不会立刻执行：会向用户弹一张确认卡，用户点「确认运行」才真正开始，' +
          '跑完结果卡会出现在对话里。调用前先确认用户要的周/参数，不要连着调两次。',
        parameters: {
          type: 'object',
          properties: {
            skillId: { type: 'string', description: '技能 id，例如 amazon-weekly-report' },
            index: { type: 'number', description: '命令序号，从 0 开始（第 1 个命令是 0）' },
            reason: { type: 'string', description: '一句话说明这次为什么要跑，会显示在确认卡上' },
          },
          required: ['skillId', 'index'],
        },
      },
    });
  }

  return defs;
}

class ToolRunner {
  constructor({ workspace, dataDir, apiKey, baseUrl, emit, mcp, noReportFiles, skillTitle, skills, allowedSkills, configSkills, outputGuard, sessionId }) {
    this.sessionId = sessionId || null;
    this.noReportFiles = Boolean(noReportFiles);
    this.skillTitle = String(skillTitle || '');
    this.skills = Array.isArray(skills) ? skills : [];
    this.allowedSkills = Array.isArray(allowedSkills) ? allowedSkills : null;
    this.configSkills = Array.isArray(configSkills) ? configSkills : [];
    this.outputGuard = outputGuard || null;
    this.outputGuardPassed = false;
    this.workspace = workspace;
    this.dataDir = dataDir;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.emit = emit || (() => {});
    this.mcp = mcp || null;
  }

  async run(name, rawArgs) {
    let args = {};
    try {
      args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs || {};
    } catch {
      return { ok: false, content: '工具参数不是合法 JSON：' + String(rawArgs).slice(0, 300) };
    }
    if (name.startsWith('mcp__')) {
      if (!this.mcp) return { ok: false, content: '没有配置数据源' };
      return this.mcp.call(name, args);
    }
    try {
      switch (name) {
        case 'web_search':
          return await this.webSearch(args);
        case 'read_url':
          return await this.readUrl(args);
        case 'list_files':
          return this.listFiles(args);
        case 'update_skill_config':
          return this.updateSkillConfig(args);
        case 'read_skill_config':
          return this.readSkillConfig(args);
        case 'run_skill':
          return this.requestRunSkill(args);
        case 'check_output':
          return this.checkOutput(args);
        case 'load_skill':
          return this.loadSkill(args);
        case 'read_file':
          return this.readFile(args);
        case 'write_file':
          return this.writeFile(args);
        case 'run_javascript':
          return await this.runJs(args);
        default:
          return { ok: false, content: '未知工具：' + name };
      }
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      return { ok: false, content: '工具执行失败：' + msg };
    }
  }

  async webSearch(args) {
    const query = String(args.query || '').trim().slice(0, 128);
    if (!query) return { ok: false, content: '缺少搜索词' };
    const count = Math.max(1, Math.min(20, Number(args.count) || 8));
    const results = await llm.search({ apiKey: this.apiKey, baseUrl: this.baseUrl, query, count });
    const items = results.map((r) => ({
      title: r.title || r.url,
      url: r.url,
      snippet: r.snippet || '',
      summary: r.summary || '',
      site: r.site_name || '',
      date: r.date || '',
      icon: r.site_icon || '',
    }));
    this.emit({ t: 'sources', items: items.slice(0, 10), query });
    if (!items.length) {
      return { ok: true, content: '搜索「' + query + '」没有返回结果。可以换个关键词，或直接说明缺少数据。' };
    }
    const text = items
      .map((r, i) => {
        return (
          '[' + (i + 1) + '] ' + r.title + '\n' +
          'URL: ' + r.url + '\n' +
          (r.date ? '日期: ' + r.date + '\n' : '') +
          (r.summary || r.snippet || '')
        );
      })
      .join('\n\n');
    return { ok: true, content: trim(text + '\n\n以上为搜索摘要，引用时请给出 URL。') };
  }

  async readUrl(args) {
    const url = String(args.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return { ok: false, content: '需要 http/https 链接' };
    const page = await llm.fetchUrl({ apiKey: this.apiKey, baseUrl: this.baseUrl, url });
    const content = trim(page.content || '', 30000);
    return { ok: true, content: '# ' + (page.title || url) + '\n\n' + (content || '（页面没有可提取的正文）') };
  }

  listFiles(args) {
    const dir = args.dir ? resolveSafe(this.workspace, args.dir) : this.workspace;
    if (!fs.existsSync(dir)) return { ok: false, content: '目录不存在' };
    const out = [];
    const walk = (d, depth) => {
      if (depth > 4 || out.length > 300) return;
      let entries;
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const abs = path.join(d, e.name);
        const rel = path.relative(this.workspace, abs).replace(/\\/g, '/');
        if (e.isDirectory()) {
          out.push(rel + '/');
          walk(abs, depth + 1);
        } else {
          let size = 0;
          try {
            size = fs.statSync(abs).size;
          } catch {
            /* ignore */
          }
          out.push(rel + '  (' + formatBytes(size) + ')');
        }
      }
    };
    walk(dir, 0);
    return { ok: true, content: out.length ? out.join('\n') : '（空目录）' };
  }

  readFile(args) {
    const abs = resolveSafe(this.workspace, args.path);
    if (!fs.existsSync(abs)) return { ok: false, content: '文件不存在：' + args.path };
    const st = fs.statSync(abs);
    if (st.size > 5 * 1024 * 1024) return { ok: false, content: '文件超过 5MB，无法直接读取' };
    const max = Math.max(1000, Math.min(200000, Number(args.max_chars) || 60000));
    const text = fs.readFileSync(abs, 'utf8');
    return { ok: true, content: trim(text, max) };
  }

  updateSkillConfig(args) {
    const id = String(args.skillId || '').trim();
    if (!id) return { ok: false, content: '缺少 skillId' };
    const skill = this.configSkills.find((s) => s.id === id);
    if (!skill) {
      return { ok: false, content: '这个技能没有可编辑的配置，或不在本次会话范围内：' + id };
    }
    if (!Array.isArray(args.products)) {
      return { ok: false, content: 'products 必须是完整的产品数组' };
    }
    let preview;
    try {
      preview = skillconfig.saveConfig(skill, { products: args.products, mtimeMs: 0 }, { dryRun: true });
    } catch (err) {
      return { ok: false, content: '配置校验没过：' + err.message };
    }
    const note = String(args.note || '').trim();
    const snapshot = skillconfig.readConfig(skill);
    const mtimeMs = snapshot ? snapshot.mtimeMs : 0;
    const proposalId = proposals.create({
      skillId: id,
      skillTitle: skill.title,
      payload: { products: args.products },
      diff: preview.diff,
      note,
    });
    this.emit({ t: 'config', id: proposalId, skillId: id, skillTitle: skill.title, diff: preview.diff, note });
    const lines = preview.diff.length ? preview.diff : ['（和当前配置没有差异）'];
    return {
      ok: true,
      content:
        '已生成修改提案，用户点「应用」后才写盘：\n' +
        lines.map((x) => '- ' + x).join('\n') +
        '\n\n请告诉用户看一眼清单、点「应用」即生效；不对就说哪里不对，你重新提案。不要让他手改文件。',
    };
  }

  readSkillConfig(args) {
    const id = String(args.skillId || '').trim();
    if (!id) return { ok: false, content: '缺少 skillId' };
    const skill = this.configSkills.find((s) => s.id === id);
    if (!skill) return { ok: false, content: '这个技能没有可读配置：' + id };
    let snap;
    try {
      snap = skillconfig.readConfig(skill);
    } catch (err) {
      return { ok: false, content: '读配置失败：' + err.message };
    }
    if (!snap) return { ok: false, content: '读不到现有配置' };
    const files = snap.files || {};
    const products = files['config/products.json'] || {};
    const targets = files['config/targets.json'] || {};
    const list = Array.isArray(products.products) ? products.products : [];
    const rows = list.map((p) => {
      const key = p.spu || p.id || '';
      const goal = (targets && (targets[key] || targets[p.spu])) || {};
      return {
        spu: p.spu,
        title: p.title || '',
        site: p.site || 'US',
        store: (p.store && (p.store.alias || p.store.sid)) || '',
        parents: (p.parents || []).map((x) => x.asin || x).filter(Boolean),
        enabled: p.enabled !== false,
        targets: goal,
      };
    });
    return {
      ok: true,
      content:
        '当前配置（' + skill.title + '）：共 ' + rows.length + ' 个产品\n' +
        JSON.stringify(rows, null, 1).slice(0, 12000) +
        '\n\n回答用户时按这个说，不要编。要改就用 update_skill_config 提提案。',
    };
  }

  requestRunSkill(args) {
    const id = String(args.skillId || '').trim();
    const index = Number(args.index);
    if (!id) return { ok: false, content: '缺少 skillId' };
    const skill = this.skills.find((s) => s.id === id);
    if (!skill) return { ok: false, content: '找不到这个技能：' + id };
    const cmds =
      (skill.meta && Array.isArray(skill.meta.commands) && skill.meta.commands) ||
      (Array.isArray(skill.commands) ? skill.commands : []);
    if (!cmds.length) return { ok: false, content: '这个技能没有可运行的命令，只能读它的方法自己写。' };
    if (!Number.isInteger(index) || index < 0 || index >= cmds.length) {
      return {
        ok: false,
        content:
          '命令序号不对。这个技能有 ' + cmds.length + ' 个命令：\n' +
          cmds.map((c, i) => i + ': ' + c.label).join('\n'),
      };
    }
    const cmd = cmds[index];
    const reason = String(args.reason || '').trim();
    const record = confirmations.create({
      kind: 'run_skill',
      skillId: skill.id,
      skillTitle: skill.title || skill.id,
      index,
      label: cmd.label || '运行',
      reason,
      sessionId: this.sessionId || null,
    });
    this.emit({
      t: 'confirm',
      id: record.id,
      kind: 'run_skill',
      skillId: skill.id,
      skillTitle: record.skillTitle,
      index,
      label: record.label,
      reason,
      timeoutSec: Math.round((cmd.timeoutMs || 0) / 1000) || null,
    });
    return {
      ok: true,
      content:
        '已向用户发出确认卡：运行「' + record.skillTitle + ' · ' + record.label + '」。' +
        '等用户点「确认运行」后才会真正开始；这期间不要重复调用 run_skill，也不要让用户自己去点技能页。' +
        '跑完后结果卡会自动出现在对话里，你再根据结果说话。',
    };
  }

  checkOutput(args) {
    const guard = this.outputGuard;
    if (!guard) return { ok: true, content: '这个技能没有结构要求。' };
    const text = String(args.content || '');
    if (!text.trim()) return { ok: false, content: 'content 是空的，把完整产出传进来。' };
    const result = outputguard.check(guard, text, { skip: Array.isArray(args.skip) ? args.skip : [] });
    this.outputGuardPassed = result.ok;
    return { ok: true, content: outputguard.describe(guard, result) };
  }

  loadSkill(args) {
    const id = String(args.id || '').trim();
    if (!id) return { ok: false, content: '缺少技能 id' };
    if (this.allowedSkills && !this.allowedSkills.includes(id)) {
      return { ok: false, content: '「' + id + '」不在当前员工的技能列表里，可选：' + (this.allowedSkills.join('、') || '（空）') };
    }
    const skill = (this.skills || []).find((s) => s.id === id);
    if (!skill) return { ok: false, content: '没有这个技能：' + id };
    // 装载的技能如果声明了固定产出结构，从这个回合起启用检查
    if (skill.meta && skill.meta.outputGuard) {
      this.outputGuard = skill.meta.outputGuard;
      this.outputGuardPassed = false;
    }
const cmds = skill.meta && Array.isArray(skill.meta.commands) ? skill.meta.commands : [];
    const cmdBlock = cmds.length
      ? '\n\n## 这个技能的「直接运行」按钮\n用户在工作台里点按钮执行，你只引用按钮名字，不要贴命令行：\n' +
        cmds
          .map((c) => {
            const need = Array.isArray(c.params) ? c.params.filter((p) => p && p.required).map((p) => p.label || p.key) : [];
            return '- ' + (c.label || '运行') + (need.length ? '（需要填：' + need.join('、') + '）' : '') + (c.desc ? ' —— ' + c.desc : '');
          })
          .join('\n')
      : '';
    return { ok: true, content: '# 技能：' + skill.title + '\n\n' + skill.body + cmdBlock };
  }

  writeFile(args) {
    const rel = String(args.path || '').trim();
    if (!rel) return { ok: false, content: '缺少文件路径' };
    if (this.noReportFiles && /\.(html?|xlsx|xls|csv)$/i.test(rel)) {
      return {
        ok: false,
        content:
          '不能手写报告文件（' + rel + '）：「' + this.skillTitle + '」的报告必须由脚本渲染。' +
          '请让用户点技能卡片上的「直接运行」按钮生成，不要用 write_file 代替。',
      };
    }
    const abs = resolveSafe(this.workspace, rel);
    ensureDir(path.dirname(abs));
    const content = String(args.content == null ? '' : args.content);
    fs.writeFileSync(abs, content, 'utf8');
    const info = {
      path: path.relative(this.workspace, abs).replace(/\\/g, '/'),
      name: path.basename(abs),
      size: Buffer.byteLength(content),
    };
    this.emit({ t: 'file', ...info });
    return { ok: true, content: '已写入 ' + info.path + '（' + formatBytes(info.size) + '）' };
  }

  async runJs(args) {
    const code = String(args.code || '');
    if (!code.trim()) return { ok: false, content: '缺少代码' };
    if (code.length > 200000) return { ok: false, content: '代码过长' };

    const tmpDir = path.join(this.dataDir, 'tmp');
    ensureDir(tmpDir);
    const file = path.join(tmpDir, 'run-' + uid() + '.js');

    const prelude = `
const fs = require('fs');
const path = require('path');
const Module = require('module');
const BLOCKED = new Set(['child_process','worker_threads','cluster','net','http','https','http2','dgram','dns','tls','inspector','vm']);
const origRequire = Module.prototype.require;
Module.prototype.require = function(id){
  const name = String(id).replace(/^node:/, '');
  if (BLOCKED.has(name)) throw new Error('此计算环境不允许使用 ' + id + '（只做本地数据处理）');
  return origRequire.apply(this, arguments);
};
try { globalThis.fetch = function(){ throw new Error('此计算环境不允许联网'); }; } catch (e) {}
try { globalThis.WebSocket = undefined; } catch (e) {}
const WS = process.cwd();
function p(rel){ return path.resolve(WS, String(rel)); }
function read(rel){ return fs.readFileSync(p(rel), 'utf8'); }
function readJson(rel){ return JSON.parse(read(rel)); }
function write(rel, data){
  const target = p(rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  fs.writeFileSync(target, text, 'utf8');
  console.log('[saved] ' + rel + ' (' + Buffer.byteLength(text) + ' bytes)');
  return rel;
}
function list(rel){
  const dir = p(rel || '.');
  return fs.readdirSync(dir, { withFileTypes: true }).map(function(e){
    return e.name + (e.isDirectory() ? '/' : '');
  });
}
function readCsv(rel){
  const text = read(rel).replace(/^\\uFEFF/, '');
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i+1] === '"') { field += '"'; i++; } else { quoted = false; } }
      else field += ch;
    } else if (ch === '"') { quoted = true; }
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch === '\\r') { /* skip */ }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map(function(h){ return h.trim(); });
  return rows.slice(1).filter(function(r){ return r.some(function(x){ return String(x).trim(); }); }).map(function(r){
    const o = {}; header.forEach(function(h, i){ o[h] = r[i] === undefined ? '' : r[i]; }); return o;
  });
}
function table(data){ console.table(data); return data.length; }
`;
    // 「只能用按钮运行」的技能：run_javascript 里的 write() 也不许写报告文件
    const reportGuard = this.noReportFiles
      ? "\nconst _origWrite = write;\nwrite = function(rel, data){\n  if (/\\.(html?|xlsx|xls|csv)$/i.test(String(rel))) {\n    throw new Error('不能手写报告文件（' + rel + '）：这个技能的报告必须由脚本生成，请让用户点技能卡片上的「直接运行」');\n  }\n  return _origWrite(rel, data);\n};\n" +
        "const _origWriteFileSync = fs.writeFileSync;\nfs.writeFileSync = function(target){\n  if (/\\.(html?|xlsx|xls|csv)$/i.test(String(target))) {\n    throw new Error('不能手写报告文件：这个技能的报告必须由脚本生成，请让用户点技能卡片上的「直接运行」');\n  }\n  return _origWriteFileSync.apply(fs, arguments);\n};\n"
      : '';
    fs.writeFileSync(file, prelude + reportGuard + '\n' + code, 'utf8');
    const before = snapshot(this.workspace);
    const outFile = path.join(tmpDir, path.basename(file, '.js') + '.out');
    const errFile = path.join(tmpDir, path.basename(file, '.js') + '.err');
    const outFd = fs.openSync(outFile, 'w');
    const errFd = fs.openSync(errFile, 'w');

    const result = await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [
          '--no-warnings',
          '--permission',
          '--allow-fs-read=' + this.workspace,
          '--allow-fs-write=' + this.workspace,
          '--allow-fs-read=' + tmpDir,
          '--allow-fs-write=' + tmpDir,
          file,
        ],
        {
          cwd: this.workspace,
          windowsHide: true,
          stdio: ['ignore', outFd, errFd],
          env: {
            SystemRoot: process.env.SystemRoot,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP,
            USERPROFILE: process.env.USERPROFILE,
            PATH: process.env.PATH,
            NODE_OPTIONS: '',
          },
        }
      );
      let settled = false;
      const finish = (code, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          fs.closeSync(outFd);
        } catch {
          /* ignore */
        }
        try {
          fs.closeSync(errFd);
        } catch {
          /* ignore */
        }
        resolve({ code, error: error || null });
      };
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        finish(-1, '执行超时（30 秒）');
      }, 30000);
      child.on('error', (e) => finish(-1, e.message));
      child.on('close', (code) => finish(code, null));
    });

    let out = '';
    let err = '';
    try {
      out = fs.readFileSync(outFile, 'utf8').slice(0, 200000);
    } catch {
      /* ignore */
    }
    try {
      err = fs.readFileSync(errFile, 'utf8').slice(0, 60000);
    } catch {
      /* ignore */
    }
    for (const f of [file, outFile, errFile]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }

    const after = snapshot(this.workspace);
    const changed = [];
    for (const [abs, sig] of after) {
      if (before.get(abs) !== sig) {
        changed.push({
          path: path.relative(this.workspace, abs).replace(/\\/g, '/'),
          name: path.basename(abs),
          size: fs.statSync(abs).size,
        });
      }
    }
    for (const info of changed) this.emit({ t: 'file', ...info });

    const parts = [];
    if (out.trim()) parts.push(out.trim());
    if (err.trim()) parts.push('[stderr]\n' + err.trim());
    if (result.error) parts.push('[错误] ' + result.error);
    if (result.code !== 0) parts.push('[退出码] ' + result.code);
    if (changed.length) parts.push('[生成/修改文件]\n' + changed.map((c) => c.path).join('\n'));
    return {
      ok: result.code === 0 && !result.error,
      content: trim(parts.join('\n\n') || '（代码执行完成，没有输出）'),
    };
  }
}

module.exports = { toolDefs, ToolRunner };
