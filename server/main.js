'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { loadConfig } = require('./config');
const { Store } = require('./store');
const { loadSkills } = require('./skills');
const { loadAgents } = require('./agents');
const { McpManager } = require('./mcp');
const { createApi, friendlyError } = require('./api');
const { mimeFor, sendText } = require('./util');

const cfg = loadConfig();
const store = new Store(cfg.root);
const skills = loadSkills(cfg.skillsDirs);
const agents = loadAgents(cfg.skillsDirs);

// 技能热重载：改完 SKILL.md / skill.json 不用重启服务，刷新页面即可生效。
// 原地替换数组内容，这样 api.js 里已经拿到的引用会自动看到新数据。
function reloadSkills() {
  let next;
  try {
    next = loadSkills(cfg.skillsDirs);
  } catch (err) {
    console.error('  [skills] 重载失败，继续用上一版：' + ((err && err.message) || err));
    return false;
  }
  skills.length = 0;
  skills.push(...next);
  const nextAgents = loadAgents(cfg.skillsDirs);
  agents.length = 0;
  agents.push(...nextAgents);
  console.log(
    '  [' + new Date().toTimeString().slice(0, 8) + '] 技能已重载：' + skills.length + ' 个 · 员工 ' + agents.length + ' 名'
  );
  return true;
}

function watchSkills() {
  if (process.env.ECOM_NO_WATCH === '1' || process.env.ECOM_TEST === '1') return;
  const watched = new Set();
  const watchDir = (dir) => {
    if (!dir || watched.has(dir) || !fs.existsSync(dir)) return;
    watched.add(dir);
    let timer = null;
    try {
      const watcher = fs.watch(dir, { recursive: true }, (event, file) => {
        if (file && !/\.(md|json)$/i.test(String(file))) return;
        clearTimeout(timer);
        timer = setTimeout(reloadSkills, 150);
      });
      watcher.on('error', () => {});
    } catch {
      /* 个别环境不支持 recursive watch，退化成重启服务即可 */
    }
  };
  for (const dir of cfg.skillsDirs) watchDir(dir);
}

const mcp = new McpManager({ dataDir: store.dataDir, version: cfg.version });
const api = createApi({ cfg, store, skills, agents, mcp });

const APP_DIR = path.join(cfg.root, 'app');
const DOCS_DIR = path.join(cfg.root, 'docs');

function serveStatic(req, res, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendText(res, 400, 'Bad Request');
    return;
  }
  if (pathname === '/') pathname = '/index.html';

  let baseDir = APP_DIR;
  let rel = pathname;
  if (pathname.startsWith('/docs/')) {
    baseDir = DOCS_DIR;
    rel = pathname.slice('/docs'.length);
  } else if (pathname.startsWith('/app/')) {
    baseDir = APP_DIR;
    rel = pathname.slice('/app'.length);
  }

  const abs = path.resolve(baseDir, '.' + rel);
  if (!abs.toLowerCase().startsWith(baseDir.toLowerCase() + path.sep) && abs.toLowerCase() !== baseDir.toLowerCase()) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    sendText(res, 404, 'Not Found');
    return;
  }
  if (stat.isDirectory()) {
    const index = path.join(abs, 'index.html');
    if (fs.existsSync(index)) return sendFile(res, index);
    sendText(res, 404, 'Not Found');
    return;
  }
  sendFile(res, abs);
}

function sendFile(res, abs) {
  const ext = path.extname(abs).toLowerCase();
  const noCache = ['.html', '.js', '.css', '.json'].includes(ext);
  res.writeHead(200, {
    'Content-Type': mimeFor(abs),
    'Cache-Control': noCache ? 'no-cache' : 'max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(abs).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, 'http://127.0.0.1');
  } catch {
    sendText(res, 400, 'Bad Request');
    return;
  }

  try {
    if (url.pathname.startsWith('/api/')) {
      const handled = await api.handle(req, res, url);
      if (!handled) sendText(res, 404, 'API Not Found', 'application/json; charset=utf-8');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'Method Not Allowed');
      return;
    }
    serveStatic(req, res, url);
  } catch (err) {
    console.error('[http]', friendlyError(err));
    if (!res.headersSent) sendText(res, 500, 'Internal Server Error');
    else if (!res.writableEnded) res.end();
  } finally {
    if (process.env.DSH_DEBUG) {
      console.log(req.method, url.pathname, res.statusCode, Date.now() - started + 'ms');
    }
  }
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

function listen(port, attempts = 0) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE' && attempts < 30) {
        resolve(listen(port + 1, attempts + 1));
      } else {
        reject(err);
      }
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    if (attempts > 0) {
    console.log('  端口 ' + (port - 1) + ' 被占用（可能是上次没退干净的进程），改用 ' + port);
  }
  server.listen(port, process.env.ECOM_HOST || '127.0.0.1');
  });
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* ignore */
  }
}

async function main() {
  const noOpen = process.argv.includes('--no-open') || process.env.ECOM_NO_OPEN === '1';

  // 不管是否 --no-open，都先看看有没有实例在跑；有就只（可选地）打开浏览器，不再起第二个
  if (process.env.ECOM_TEST !== '1') {
    for (let p = cfg.port; p < cfg.port + 6; p += 1) {
      try {
        const r = await fetch('http://127.0.0.1:' + p + '/api/health', { signal: AbortSignal.timeout(400) });
        if (r.ok) {
          const data = await r.json();
          if (data && data.brand === cfg.brand) {
            console.log('\n  ' + cfg.brand + ' 已经在运行：http://127.0.0.1:' + p + '/\n');
            openBrowser('http://127.0.0.1:' + p + '/');
            return;
          }
        }
      } catch {
        /* not running */
      }
    }
  }

  let port = cfg.port;
  try {
    port = await listen(port);
  } catch (err) {
    console.error('\n启动失败：' + err.message + '\n');
    process.exit(1);
  }
  const url = 'http://127.0.0.1:' + port + '/';
  watchSkills();
  console.log('');
  console.log('  ' + cfg.brand + '  v' + cfg.version);
  console.log('  ' + '─'.repeat(46));
  console.log('  地址    ' + url);
  console.log('  工作区  ' + store.workspace);
  const extraDirs = cfg.extraSkillsDirs.filter((d) => fs.existsSync(d));
  console.log('  技能    ' + skills.length + ' 个' + (extraDirs.length ? '（外部目录：' + extraDirs.map((d) => path.basename(d)).join('、') + '）' : ''));
  console.log('  员工    ' + agents.length + ' 名');
  console.log('  数据源  ' + mcp.connectedCount() + ' 个已连接');
  console.log('  ' + '─'.repeat(46));
  console.log('  关闭这个窗口即可停止服务。');
  console.log('');
  if (!noOpen) openBrowser(url);
  if (process.env.ECOM_TEST === '1') {
    console.log('READY ' + port);
  }
}

process.on('SIGINT', () => {
  console.log('\n已停止。');
  process.exit(0);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaught]', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandled]', err);
});

main();
