'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

/* 应用内更新：查最新版 → 下载 zip → 解压 → 覆盖（跳过 runtime/data/workspace）→ 重启 */

const REPO = 'bfsu1666935342-pixel/ecom-workbench';
const API = 'https://api.github.com/repos/' + REPO + '/releases';
// 这些目录绝不覆盖：runtime 是正在运行的可执行文件，data/workspace 是用户数据
const SKIP = new Set(['runtime', 'data', 'workspace', 'node_modules', '.git']);

function parseVer(v) {
  return String(v || '')
    .replace(/^v/i, '')
    .split('.')
    .map((x) => Number(String(x).replace(/[^0-9]/g, '')) || 0);
}

function isNewer(latest, current) {
  const a = parseVer(latest);
  const b = parseVer(current);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

async function github(pathname, timeoutMs = 8000) {
  const resp = await fetch(API + pathname, {
    headers: { 'User-Agent': 'ecom-workbench', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error('GitHub 返回 HTTP ' + resp.status);
  return resp.json();
}

let lastCheck = { at: 0, version: '', info: null };

function clearCache() {
  lastCheck = { at: 0, version: '', info: null };
}

async function checkForUpdate(currentVersion, opts = {}) {
  const ttl = opts.maxAge === undefined ? 20 * 60 * 1000 : opts.maxAge;
  if (
    !opts.force &&
    lastCheck.info &&
    lastCheck.version === String(currentVersion) &&
    Date.now() - lastCheck.at < ttl
  ) {
    return { ...lastCheck.info, cached: true };
  }
  const rel = await github('/latest');
  const tag = String(rel.tag_name || '');
  const asset = (rel.assets || []).find((a) => /\.zip$/i.test(a.name || ''));
  const result = {
    current: currentVersion,
    latest: tag.replace(/^v/i, ''),
    hasUpdate: isNewer(tag, currentVersion),
    notes: String(rel.body || '').slice(0, 2000),
    pageUrl: rel.html_url || '',
    assetName: asset ? asset.name : '',
    assetSize: asset ? asset.size : 0,
    assetUrl: asset ? asset.browser_download_url : '',
  };
  lastCheck = { at: Date.now(), version: String(currentVersion), info: result };
  return result;
}

function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* 清不掉就留着 */
  }
}

async function download(url, dest, onProgress, expectedSize) {
  const { downloadAny } = require('./update-download');
  const started = Date.now();
  const result = await downloadAny(url, {
    timeoutMs: 600000,
    preferProxy: true,
    onProgress: (bytes) => {
      const secs = Math.max(0.5, (Date.now() - started) / 1000);
      const speed = bytes / 1048576 / secs;
      if (onProgress) {
        onProgress(
          expectedSize ? Math.min(99, Math.round((bytes / expectedSize) * 100)) : 0,
          bytes,
          speed
        );
      }
    },
  });
  const got = result.buffer.length;
  if (expectedSize && got < expectedSize * 0.98) {
    throw new Error(
      '下载不完整：只拿到 ' +
        (got / 1048576).toFixed(1) +
        ' MB / ' +
        (expectedSize / 1048576).toFixed(1) +
        ' MB（' +
        result.via +
        '）。重试一次，或到 GitHub Releases 手动下载。'
    );
  }
  fs.writeFileSync(dest, result.buffer);
  return { path: dest, via: result.via, bytes: got };
}

function unzip(zipPath, destDir) {
  const exe = fs.existsSync('C:\\Windows\\System32\\tar.exe') ? 'C:\\Windows\\System32\\tar.exe' : 'tar';
  const run = (cmd, args) =>
    new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { windowsHide: true, stdio: 'ignore' });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error('解压失败（' + cmd + ' 退出码 ' + code + '）'));
      });
    });
  return run(exe, ['-xf', zipPath, '-C', destDir]).catch(() =>
    run('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      'Expand-Archive -LiteralPath ' + "'" + zipPath + "'" + ' -DestinationPath ' + "'" + destDir + "'" + ' -Force',
    ])
  );
}

function copyTree(from, to, root) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (root && SKIP.has(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyTree(src, dst, false);
    } else {
      fs.copyFileSync(src, dst);
    }
  }
}

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          total += fs.statSync(p).size;
        } catch {
          /* 忽略 */
        }
      }
    }
  };
  walk(dir);
  return total;
}

/* 状态机：前端轮询这个 */
const state = {
  phase: 'idle', // idle | downloading | unpacking | applying | restarting | error | done
  percent: 0,
  message: '',
  latest: '',
  error: '',
};

function getState() {
  return { ...state };
}

/**
 * 下载并应用更新。
 * dryRun=true 时只下载+解压+校验，不覆盖任何文件（用于自检）。
 */
async function applyUpdate({ appRoot, dryRun, restart }) {
  if (state.phase === 'downloading' || state.phase === 'unpacking' || state.phase === 'applying') {
    throw new Error('已经在更新了');
  }
  const work = path.join(os.tmpdir(), 'ecom-update-' + Date.now());
  Object.assign(state, { phase: 'downloading', percent: 0, message: '正在查最新版本…', error: '' });

  try {
    const info = await checkForUpdate(require(path.join(appRoot, 'config.json')).version);
    if (!info.hasUpdate && !dryRun) throw new Error('已经是最新版本（v' + info.current + '）');
    if (!info.assetUrl) throw new Error('这个版本没有可下载的 zip');
    Object.assign(state, { latest: info.latest, message: '正在下载 v' + info.latest + '…' });

    fs.mkdirSync(work, { recursive: true });
    const zip = path.join(work, info.assetName || 'update.zip');
    let lastMb = 0;
    const got = await download(
      info.assetUrl,
      zip,
      (p, bytes, speed) => {
        state.percent = p || 0;
        const mb = Math.round((bytes || 0) / 1048576);
        if (mb !== lastMb) {
          lastMb = mb;
          const total = info.assetSize ? ' / ' + (info.assetSize / 1048576).toFixed(0) + ' MB' : '';
          const sp = speed ? '（' + speed.toFixed(1) + ' MB/s）' : '';
          state.message = '正在下载 v' + info.latest + '… ' + mb + ' MB' + total + sp;
        }
      },
      info.assetSize
    );
    state.message = '下载完成（' + got.via + '），正在解压…';

    state.phase = 'unpacking';
    state.percent = 100;
    state.message = '正在解压…';
    const staging = path.join(work, 'staging');
    fs.mkdirSync(staging, { recursive: true });
    await unzip(zip, staging);

    // 找包根：递归往下找（最多 3 层），含 server/main.js 的那层就是根
    const looksLikeRoot = (dir) =>
      fs.existsSync(path.join(dir, 'server', 'main.js')) && fs.existsSync(path.join(dir, 'app', 'index.html'));
    let root = null;
    const scan = (dir, depth) => {
      if (root || depth > 3) return;
      if (looksLikeRoot(dir)) {
        root = dir;
        return;
      }
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
      } catch {
        return;
      }
      for (const entry of entries) scan(path.join(dir, entry.name), depth + 1);
    };
    scan(staging, 0);
    if (!root) {
      const top = (() => {
        try {
          return fs
            .readdirSync(staging, { withFileTypes: true })
            .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
            .slice(0, 12)
            .join(', ');
        } catch {
          return '(读不到)';
        }
      })();
      throw new Error('包结构不对：没找到 server/main.js（解压后顶层是：' + top + '）');
    }
    if (!fs.existsSync(path.join(root, 'app', 'index.html'))) {
      throw new Error('包结构不对：没找到 app/index.html');
    }

    if (dryRun) {
      state.phase = 'done';
      state.message = '自检通过：v' + info.latest + ' 的包完整，可以更新（这次没有覆盖文件）';
      return { ok: true, dryRun: true, latest: info.latest, size: dirSize(root) };
    }

    state.phase = 'applying';
    state.message = '正在替换文件…';

    // 先把旧的 server/app 备份一份，出问题还能退回去
    const backup = path.join(appRoot, 'update-backup-' + info.current);
    rmrf(backup);
    for (const dir of ['server', 'app', 'skills']) {
      const src = path.join(appRoot, dir);
      if (fs.existsSync(src)) copyTree(src, path.join(backup, dir), false);
    }

    // 覆盖：skills 整个换掉（技能跟版本走），server/app/docs 覆盖
    rmrf(path.join(appRoot, 'skills'));
    for (const dir of ['server', 'app', 'docs', 'skills']) {
      const src = path.join(root, dir);
      if (!fs.existsSync(src)) continue;
      copyTree(src, path.join(appRoot, dir), false);
    }
    for (const file of ['README.md', 'config.json', 'Start.bat', '启动.bat', '停止工作台.bat', 'silent-start.vbs']) {
      const src = path.join(root, file);
      if (fs.existsSync(src)) {
        try {
          fs.copyFileSync(src, path.join(appRoot, file));
        } catch {
          /* 个别被占用的文件跳过，不影响主流程 */
        }
      }
    }

    rmrf(work);
    state.phase = 'restarting';
    state.message = '更新完成，正在重启…';
    if (restart !== false) startRestart(appRoot);
    return { ok: true, latest: info.latest, backup };
  } catch (err) {
    state.phase = 'error';
    state.error = err.message;
    state.message = err.message;
    throw err;
  }
}

/* 起一个脱离的脚本：等本进程退出后重新启动 */
function startRestart(appRoot) {
  // 以前调 Start.bat，那套是给打包版写的（要 runtime\node\node.exe），
  // 在代码目录里跑就起不来，结果「文件更新了、进程还是老的」。
  // 现在直接用 node 起 server/main.js，不再依赖 bat。
  const runtimeNode = path.join(appRoot, 'runtime', 'node', 'node.exe');
  const nodeExe = fs.existsSync(runtimeNode) ? runtimeNode : process.execPath;
  const script = path.join(os.tmpdir(), 'ecom-restart-' + Date.now() + '.cmd');
  const lines = [
    '@echo off',
    'ping 127.0.0.1 -n 4 >nul',
    'cd /d "' + appRoot + '"',
    'start "" "' + nodeExe + '" "' + path.join(appRoot, 'server', 'main.js') + '" --no-open',
  ];
  fs.writeFileSync(script, lines.join('\r\n'), 'utf8');
  const child = spawn('cmd.exe', ['/c', script], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  setTimeout(() => {
    process.exit(0);
  }, 1000);
}

/** 供 /api/restart 用：直接重启当前实例 */
function restartNow(appRoot) {
  startRestart(appRoot || path.join(__dirname, '..'));
}

module.exports = { checkForUpdate, applyUpdate, getState, isNewer, restartNow };


