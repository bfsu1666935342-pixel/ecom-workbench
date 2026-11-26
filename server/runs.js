'use strict';
/**
 * 服务端托管的技能运行。
 *
 * 为什么要有它：技能库那条路是「浏览器发起 → NDJSON 流」，浏览器一关就把子进程杀掉。
 * 对话里跑周报要 15 分钟，用户切走/刷新都不能断，所以运行状态必须放在服务端，
 * 前端靠轮询接回来。
 */
const { runCommand } = require('./run');

const MAX_LINES = 600;
const MAX_KEEP = 30; // 内存里最多留 30 次运行记录

const runs = new Map(); // id -> run
let seq = 0;

function push(run, item) {
  run.lines.push(item);
  if (run.lines.length > MAX_LINES) run.lines.splice(0, run.lines.length - MAX_LINES);
  run.updatedAt = Date.now();
}

/**
 * run.js 给的是「本次运行新产出的所有文件」，里面常混着一堆中间 json。
 * 结果卡只留人真正要打开的：html > xlsx > md > csv > pdf，最多 3 个，去重。
 */
const SHOW_EXT = ['.html', '.xlsx', '.md', '.csv', '.pdf', '.png'];
function pickOutputs(files) {
  const list = (files || [])
    .map((f) => (typeof f === 'string' ? f : f && (f.path || f.rel)))
    .filter(Boolean);
  const rank = (p) => {
    const i = SHOW_EXT.indexOf(require('path').extname(p).toLowerCase());
    return i === -1 ? 99 : i;
  };
  const seen = new Set();
  return list
    .filter((p) => {
      if (seen.has(p)) return false;
      seen.add(p);
      return rank(p) < 99;
    })
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 3);
}

function prune() {
  if (runs.size <= MAX_KEEP) return;
  const done = [...runs.values()]
    .filter((r) => r.status !== 'running')
    .sort((a, b) => a.updatedAt - b.updatedAt);
  while (runs.size > MAX_KEEP && done.length) {
    runs.delete(done.shift().id);
  }
}

/**
 * 启动一次运行。立刻返回 run 对象，不等跑完。
 * @returns {{id:string, skillId:string, index:number}}
 */
function start({ skill, index, params, workspace, dataDir, sessionId, label }) {
  const id = 'run-' + Date.now().toString(36) + '-' + (seq += 1);
  const run = {
    id,
    skillId: skill.id,
    skillTitle: skill.title || skill.id,
    commandLabel:
      label ||
      (skill.meta && skill.meta.commands && skill.meta.commands[index] && skill.meta.commands[index].label) ||
      '',
    index,
    sessionId: sessionId || null,
    status: 'running',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    lines: [],
    output: '',
    files: [],
    error: null,
    child: null,
  };
  runs.set(id, run);

  runCommand({
    skill,
    index,
    params: params || {},
    workspace,
    dataDir,
    onData: (text, stream) => {
      const chunk = String(text || '');
      if (!chunk) return;
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) push(run, { t: 'out', text: line.slice(0, 2000), stream: stream || 'stdout' });
      }
    },
    onChild: (child) => {
      run.child = child;
    },
  })
    .then((result) => {
      run.status = result && result.ok ? 'done' : 'error';
      run.result = Object.assign({ ok: false }, result || {});
      run.output = (result && result.output) || '';
      run.files = pickOutputs((result && result.files) || []);
      run.error = (result && result.error) || null;
      run.finishedAt = Date.now();
      run.child = null;
      if (typeof run.onFinish === 'function') {
        try {
          run.onFinish(run);
        } catch (err) {
          console.warn('[runs] onFinish 失败：' + (err && err.message));
        }
      }
      prune();
    })
    .catch((err) => {
      run.status = 'error';
      run.error = (err && err.message) || String(err);
      run.finishedAt = Date.now();
      run.child = null;
      prune();
    });

  return { id, skillId: skill.id, index };
}

function get(id) {
  return runs.get(String(id || '')) || null;
}

function cancel(id) {
  const run = get(id);
  if (!run) return { ok: false, error: '找不到这次运行' };
  if (run.status !== 'running') return { ok: true, already: run.status };
  run.status = 'cancelled';
  run.finishedAt = Date.now();
  if (run.child && run.child.pid) {
    try {
      require('child_process').spawn('taskkill', ['/pid', String(run.child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      /* 杀不掉就算了 */
    }
  }
  push(run, { t: 'out', text: '已取消', stream: 'system' });
  return { ok: true };
}

/** 给前端轮询用：只回增量 */
function state(id, cursor = 0) {
  const run = get(id);
  if (!run) return { ok: false, error: '找不到这次运行' };
  const from = Math.max(0, Number(cursor) || 0);
  return {
    ok: true,
    id: run.id,
    skillId: run.skillId,
    commandLabel: run.commandLabel,
    status: run.status,
    cursor: run.lines.length,
    lines: run.lines.slice(from),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt || null,
    error: run.error,
    result: run.status === 'running' ? null : run.result || null,
    files: run.status === 'running' ? [] : run.files || [],
  };
}

/** 服务重启时，把残留的 running 标记为中断，避免前端一直转圈 */
function markStale() {
  for (const run of runs.values()) {
    if (run.status === 'running') {
      run.status = 'error';
      run.error = '服务重启过，这次运行已中断';
    }
  }
}

module.exports = { start, get, cancel, state, markStale, runs };
