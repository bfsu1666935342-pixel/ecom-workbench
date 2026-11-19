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
  const result = await downloadAny(url, {
    timeoutMs: 240000,
    preferProxy: true,
    onProgress: (bytes) => {
      if (onProgress) onProgress(expectedSize ? Math.min(99, Math.round((bytes / expectedSize) * 100)) : 0, bytes);
    },
  });
  fs.writeFileSync(dest, result.buffer);
  return { path: dest, via: result.via };
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
      (p, bytes) => {
        state.percent = p || 0;
        const mb = Math.round((bytes || 0) / 1048576);
        if (mb !== lastMb) {
          lastMb = mb;
          state.message = '正在下载 v' + info.latest + '… 已下载 ' + mb + ' MB';
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

    // zip 里通常套一层目录，找到含 server/main.js 的那层
    let root = staging;
    const entries = fs.readdirSync(staging, { withFileTypes: true }).filter((e) => e.isDirectory());
    if (!fs.existsSync(path.join(root, 'server', 'main.js')) && entries.length === 1) {
      root = path.join(staging, entries[0].name);
    }
    if (!fs.existsSync(path.join(root, 'server', 'main.js'))) {
      throw new Error('包结构不对：没找到 server/main.js');
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
  const script = path.join(os.tmpdir(), 'ecom-restart-' + Date.now() + '.cmd');
  const lines = [
    '@echo off',
    'timeout /t 2 /nobreak >nul',
    'cd /d "' + appRoot + '"',
    'start "" "' + path.join(appRoot, 'Start.bat') + '"',
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
  }, 1200);
}

module.exports = { checkForUpdate, applyUpdate, getState, isNewer };
