'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { inside } = require('./util');

// 技能自己声明能跑什么命令（skill.json 的 commands），模型不能临时拼命令行。
const SKIP_DIR = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.idea', '.vscode']);
const SHOW_EXT = new Set(['.html', '.htm', '.md', '.csv', '.xlsx', '.png', '.jpg', '.jpeg', '.pdf', '.json', '.txt']);
const MAX_FILES = 20;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_OUTPUT = 40000;

function skillDir(skill) {
  return path.join(skill.source, skill.dir);
}

function normalizeCommand(raw, index) {
  if (!raw || !Array.isArray(raw.run) || !raw.run.length) return null;
  const params = Array.isArray(raw.params)
    ? raw.params
        .filter((p) => p && p.key)
        .map((p) => ({
          key: String(p.key),
          label: String(p.label || p.key),
          placeholder: String(p.placeholder || ''),
          required: Boolean(p.required),
        }))
    : [];
  return {
    index,
    label: String(raw.label || '运行'),
    desc: String(raw.desc || ''),
    run: raw.run.map(String),
    params,
    timeoutMs: Math.max(5000, Math.min(3600000, Number(raw.timeoutMs) || 180000)),
  };
}

function commandList(skill) {
  const raw = skill && skill.meta && Array.isArray(skill.meta.commands) ? skill.meta.commands : [];
  return raw.map((c, i) => normalizeCommand(c, i)).filter(Boolean);
}

// 参数留空时，连同它前面的 --flag 一起丢掉，这样可选参数不用占位
function fillArgs(template, params) {
  const out = [];
  for (const raw of template) {
    const token = String(raw);
    let missing = false;
    const filled = token.replace(/\{(\w+)\}/g, (m, key) => {
      const v = params[key];
      if (v === undefined || v === null || String(v).trim() === '') {
        missing = true;
        return '';
      }
      return String(v);
    });
    if (missing) {
      if (/^\{\w+\}$/.test(token) && out.length && String(out[out.length - 1]).startsWith('-')) {
        out.pop();
      }
      continue;
    }
    out.push(filled);
  }
  return out;
}

// 把「数据源」里配好的 MCP 凭据注入技能进程。
// 技能脚本优先读环境变量、其次读自己的 .env（.env 不会覆盖已有环境变量），
// 所以用户在界面里配过一次数据源，周报这类技能就不用再填一遍 .env。
function envFromMcp(dataDir) {
  const out = {};
  if (!dataDir) return out;
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(path.join(dataDir, 'mcp.json'), 'utf8'));
  } catch {
    return out;
  }
  const servers = Array.isArray(doc.servers) ? doc.servers : [];
  const secretOf = (url) => {
    try {
      const u = new URL(url);
      for (const key of ['secret-key', 'secret_key', 'key', 'token', 'api_key']) {
        const v = u.searchParams.get(key);
        if (v) return v;
      }
    } catch {
      /* 不是合法 URL 就算了 */
    }
    return '';
  };

  const fromHeaders = (headers) => {
    if (!headers || typeof headers !== 'object') return '';
    const entries = Object.entries(headers).map(([k, v]) => [String(k).toLowerCase(), String(v || '').trim()]);
    // 明确的键名优先
    const preferred = ['x-mcp-key', 'x-api-key', 'x-auth-token', 'api-key', 'authorization', 'mcp-key', 'key', 'token'];
    for (const name of preferred) {
      const hit = entries.find(([k]) => k === name);
      if (hit && hit[1]) return name === 'authorization' ? hit[1].replace(/^Bearer\s+/i, '').trim() : hit[1];
    }
    // 兜底：名字里带 key / token / auth 的任意头（例如 X-Mcp-Key、X-Lingxing-Key）
    const loose = entries.find(([k, v]) => v && /key|token|auth/.test(k));
    if (loose) return loose[0] === 'authorization' ? loose[1].replace(/^Bearer\s+/i, '').trim() : loose[1];
    return '';
  };

  const DEFAULTS = {
    lingxing: 'https://openmcp.lingxing.com/mcp-servers/lingxing-mcp',
    sorftime: 'https://mcp.sorftime.com',
    sif: '',
  };

  for (const server of servers) {
    // 不看 enabled：用户把 Key 填进去就是有意图用，界面的开关只影响 AI 侧
    if (!server) continue;
    const url = String(server.url || '').trim();
    const token = String(server.token || '').trim() || fromHeaders(server.headers);
    const inline = secretOf(url);
    // 认三个地方：URL 域名、数据源名称、预设 id。只填了 Key 没填地址也要认出来
    const hay = [
      url.toLowerCase(),
      String(server.name || '').toLowerCase(),
      String(server.preset || '').toLowerCase(),
    ].join(' ');

    const pick = (tag, prefixes) => {
      if (!prefixes.some((p) => hay.includes(p))) return;
      out[tag + '_MCP_URL'] = url || DEFAULTS[tag.toLowerCase()] || out[tag + '_MCP_URL'];
      if (token || inline) out[tag + '_MCP_KEY'] = token || inline;
    };

    pick('LINGXING', ['lingxing', '领星']);
    pick('SIF', ['sif', '卖家精灵', 'sellersprite']);
    pick('SORFTIME', ['sorftime', '卖家穿海']);
  }
  return out;
}

function spawnFor(exe, args, cwd, extraEnv) {
  const lower = exe.toLowerCase();
  const opts = { cwd, windowsHide: true, env: { ...process.env, ...(extraEnv || {}) } };
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    return spawn('cmd.exe', ['/c', exe].concat(args), opts);
  }
  if (lower.endsWith('.ps1')) {
    return spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', exe].concat(args), opts);
  }
  return spawn(exe, args, opts);
}

function walkFiles(dir, since, out, depth) {
  if (depth > 6 || out.length >= MAX_FILES * 4) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES * 4) return;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR.has(entry.name)) continue;
      walkFiles(abs, since, out, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SHOW_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    try {
      const st = fs.statSync(abs);
      if (st.mtimeMs >= since && st.size > 0 && st.size <= MAX_FILE_BYTES) out.push({ abs, mtimeMs: st.mtimeMs });
    } catch {
      /* ignore */
    }
  }
}

function copyToWorkspace(list, workspace, skillId) {
  const base = path.join(workspace, '技能产出', skillId);
  fs.mkdirSync(base, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const saved = [];
  for (const item of list) {
    const name = path.basename(item.abs);
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    let target = path.join(base, name);
    if (fs.existsSync(target)) target = path.join(base, stem + '-' + stamp + ext);
    try {
      fs.copyFileSync(item.abs, target);
      saved.push(path.relative(workspace, target).replace(/\\/g, '/'));
    } catch {
      /* 复制失败就跳过，不影响运行结果 */
    }
  }
  return saved;
}

function runCommand({ skill, index, params, workspace, dataDir, onChild, onData }) {
  const list = commandList(skill);
  const cmd = list.find((c) => c.index === Number(index)) || list[Number(index)];
  if (!cmd) return Promise.reject(Object.assign(new Error('这个技能没有配置可运行命令'), { status: 400 }));

  const dir = skillDir(skill);
  const exe = path.isAbsolute(cmd.run[0]) ? cmd.run[0] : path.join(dir, cmd.run[0]);
  if (!inside(dir, exe)) return Promise.reject(Object.assign(new Error('命令路径不合法'), { status: 400 }));
  if (!fs.existsSync(exe)) return Promise.reject(Object.assign(new Error('找不到脚本：' + cmd.run[0]), { status: 400 }));

  const clean = {};
  for (const p of cmd.params) {
    const v = params && params[p.key] !== undefined ? String(params[p.key]).trim() : '';
    if (p.required && !v) return Promise.reject(Object.assign(new Error('请填写「' + p.label + '」'), { status: 400 }));
    if (/[\r\n\0]/.test(v)) return Promise.reject(Object.assign(new Error('参数里不能有换行'), { status: 400 }));
    clean[p.key] = v.slice(0, 300);
  }

  const args = fillArgs(cmd.run.slice(1), clean);
  const startedAt = Date.now();
  const before = [];
  walkFiles(dir, 0, before, 0);

  return new Promise((resolve) => {
    const emit = (chunk, stream) => {
      if (typeof onData !== 'function') return;
      try {
        onData(String(chunk), stream);
      } catch {
        /* 回调出错不影响运行 */
      }
    };
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;
    let injected = {};
    try {
      injected = envFromMcp(dataDir);
      child = spawnFor(exe, args, dir, injected);
      if (typeof onChild === 'function') {
        try {
          onChild(child);
        } catch {
          /* 回调出错不影响运行 */
        }
      }
    } catch (err) {
      resolve({ ok: false, error: '启动失败：' + (err && err.message), output: '', files: [], ms: 0 });
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } catch {
        /* ignore */
      }
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, timedOut: true, error: '运行超时（' + Math.round(cmd.timeoutMs / 1000) + ' 秒），已终止', output: (stdout + stderr).slice(-MAX_OUTPUT), files: [], ms: Date.now() - startedAt });
    }, cmd.timeoutMs);

    child.stdout.on('data', (d) => {
      const text = d.toString();
      if (stdout.length < MAX_OUTPUT) stdout += text;
      emit(text, 'out');
    });
    child.stderr.on('data', (d) => {
      const text = d.toString();
      if (stderr.length < MAX_OUTPUT) stderr += text;
      emit(text, 'err');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: '启动失败：' + err.message, output: '', files: [], ms: Date.now() - startedAt });
    });
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const fresh = [];
      walkFiles(dir, startedAt - 2000, fresh, 0);
      fresh.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const saved = copyToWorkspace(fresh.slice(0, MAX_FILES), workspace, skill.id);
      resolve({
        ok: code === 0,
        code,
        output: (stdout + stderr).slice(-MAX_OUTPUT),
        files: saved,
        injected: Object.keys(injected || {}).sort(),
        ms: Date.now() - startedAt,
      });
    };

    // 进程退出就算跑完：有时管道被别的进程攥着，close 迟迟不来，
    // 结果就是"活干完了但按钮一直在转"，等 1.5 秒收尾即可
    child.on('exit', (code) => {
      setTimeout(() => finish(code), 1500);
    });
    child.on('close', (code) => finish(code));
  });
}

module.exports = {
  envFromMcp, commandList, runCommand, skillDir };
