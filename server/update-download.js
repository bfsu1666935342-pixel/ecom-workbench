'use strict';

/* 带代理兜底的下载：直连不行就走本地代理（CONNECT 隧道 + TLS）。
   国内网络经常能访问 api.github.com，但 github.com 的二进制被掐，
   这时走 127.0.0.1:12450 这类本地代理就能通。 */

const http = require('http');
const https = require('https');
const tls = require('tls');

// GitHub 加速镜像：把 https://github.com/... 前面拼上这些前缀即可
const MIRROR_PREFIXES = [
  'https://ghfast.top/',
  'https://ghproxy.net/',
  'https://gh-proxy.com/',
  'https://mirror.ghproxy.com/',
];

const PROXY_CANDIDATES = [
  process.env.ECOM_UPDATE_PROXY,
  process.env.HTTPS_PROXY,
  process.env.https_proxy,
  process.env.HTTP_PROXY,
  process.env.http_proxy,
  'http://127.0.0.1:12450',
  'http://127.0.0.1:7890',
  'http://127.0.0.1:7897',
  'http://127.0.0.1:10809',
  'http://127.0.0.1:1080',
].filter(Boolean);

function parseProxy(str) {
  try {
    const u = new URL(str);
    return { host: u.hostname, port: Number(u.port) || 80 };
  } catch {
    return null;
  }
}

function connectProxy(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: host + ':' + port,
      timeout: timeoutMs,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error('代理拒绝 CONNECT：' + res.statusCode));
        return;
      }
      resolve(socket);
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('代理连接超时'));
    });
    req.on('error', reject);
    req.end();
  });
}

/* 通过代理发一次 GET，返回 {status, headers, body:Buffer} */
function proxyGet(proxy, url, timeoutMs, onProgress) {
  return new Promise(async (resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new Error('地址不合法：' + url));
      return;
    }
    const port = Number(target.port) || 443;
    let socket;
    try {
      socket = await connectProxy(proxy, target.hostname, port, timeoutMs);
    } catch (err) {
      reject(err);
      return;
    }
    const t = tls.connect({ socket, servername: target.hostname }, () => {
      t.write(
        'GET ' + (target.pathname + target.search) + ' HTTP/1.1\r\n' +
          'Host: ' + target.hostname + '\r\n' +
          'User-Agent: ecom-workbench\r\n' +
          'Accept: */*\r\n' +
          'Accept-Encoding: identity\r\n' +
          'Connection: close\r\n\r\n'
      );
    });
    t.setTimeout(timeoutMs, () => {
      t.destroy();
      reject(new Error('代理响应超时'));
    });

    const chunks = [];
    let headerDone = false;
    let headerText = '';
    let received = 0;
    t.on('data', (d) => {
      if (headerDone) {
        chunks.push(d);
        received += d.length;
        if (onProgress) onProgress(received);
        return;
      }
      headerText += d.toString('latin1');
      const idx = headerText.indexOf('\r\n\r\n');
      if (idx >= 0) {
        headerDone = true;
        const body = Buffer.from(headerText.slice(idx + 4), 'latin1');
        chunks.push(body);
        headerText = headerText.slice(0, idx);
      }
    });
    t.on('error', reject);
    t.on('end', () => {
      const lines = headerText.split('\r\n');
      const status = Number((lines[0] || '').split(' ')[1]) || 0;
      const headers = {};
      for (const line of lines.slice(1)) {
        const i = line.indexOf(':');
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      resolve({ status, headers, body: Buffer.concat(chunks) });
    });
  });
}

/* 直连下载（Node fetch），返回 Buffer 或抛错 */
async function direct(url, timeoutMs) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'ecom-workbench' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  return Buffer.from(await resp.arrayBuffer());
}

/**
 * 下载一个网址，自动在「直连」和「本地代理」之间切换。
 * 返回 { buffer, via: 'direct'|'proxy:port' }
 */
async function downloadAny(url, opts = {}) {
  const timeoutMs = opts.timeoutMs || 120000;
  const preferProxy = Boolean(opts.preferProxy);
  const errors = [];

  const tryDirect = async () => {
    let target = url;
    for (let hop = 0; hop < 5; hop += 1) {
      const resp = await fetch(target, {
        headers: { 'User-Agent': 'ecom-workbench' },
        signal: AbortSignal.timeout(Math.min(timeoutMs, 600000)),
        redirect: 'manual',
      });
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location');
        if (!loc) break;
        target = new URL(loc, target).toString();
        continue;
      }
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return Buffer.from(await resp.arrayBuffer());
    }
    throw new Error('重定向太多');
  };

  const tryProxy = async (proxy) => {
    let target = url;
    for (let hop = 0; hop < 5; hop += 1) {
      const res = await proxyGet(proxy, target, timeoutMs, opts.onProgress);
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        target = new URL(res.headers.location, target).toString();
        continue;
      }
      if (res.status !== 200) throw new Error('代理 HTTP ' + res.status);
      return res.body;
    }
    throw new Error('代理重定向太多');
  };

  // 默认代理优先：国内网络直连 github 的二进制经常是黑洞（不拒绝、不响应），
  // 先试直连会白等好几分钟。
  const tryMirror = async (prefix) => {
    const target = prefix + url;
    const resp = await fetch(target, {
      headers: { 'User-Agent': 'ecom-workbench' },
      signal: AbortSignal.timeout(Math.min(timeoutMs, 600000)),
      redirect: 'follow',
    });
    if (!resp.ok) throw new Error('镜像 HTTP ' + resp.status);
    return Buffer.from(await resp.arrayBuffer());
  };

  const order = preferProxy === false ? ['direct', 'mirror', 'proxy'] : ['proxy', 'mirror', 'direct'];
  for (const mode of order) {
    if (mode === 'direct') {
      try {
        const buffer = await tryDirect();
        return { buffer, via: 'direct' };
      } catch (err) {
        errors.push('直连：' + err.message);
      }
    } else if (mode === 'mirror') {
      for (const prefix of MIRROR_PREFIXES) {
        try {
          const buffer = await tryMirror(prefix);
          return { buffer, via: 'mirror:' + prefix.replace('https://', '').replace(/\/$/, '') };
        } catch (err) {
          errors.push('镜像 ' + prefix.replace('https://', '') + '：' + err.message);
        }
      }
    } else {
      for (const candidate of PROXY_CANDIDATES) {
        const proxy = parseProxy(candidate);
        if (!proxy) continue;
        try {
          const buffer = await tryProxy(proxy);
          return { buffer, via: 'proxy:' + proxy.port };
        } catch (err) {
          errors.push('代理 ' + proxy.port + '：' + err.message);
        }
      }
    }
  }
  throw new Error('下载失败（' + errors.slice(0, 4).join('；') + '）');
}

module.exports = { downloadAny, proxyGet, PROXY_CANDIDATES, MIRROR_PREFIXES };
