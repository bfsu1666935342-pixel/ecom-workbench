'use strict';

const path = require('path');
const fs = require('fs');

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:7871';
const PKG_ROOT = process.env.PKG_ROOT || path.resolve(__dirname, '..');

async function main() {
  const boot = await fetch(BASE + '/api/bootstrap').then((r) => r.json());
  console.log('skills=' + boot.skills.length + ' brand=' + boot.brand);
  if (boot.skills.length < 14) throw new Error('skills count mismatch');
  if (!boot.skills.some((s) => s.id === 'review-to-qa')) throw new Error('review-to-qa missing');
  if (boot.skills.some((s) => s.id === 'amazon-category-decision')) throw new Error('dsh-only skill was not filtered');

  for (const p of ['/', '/js/app.js', '/css/app.css', '/docs/%E5%A6%82%E4%BD%95%E6%B7%BB%E5%8A%A0%E6%8A%80%E8%83%BD.md']) {
    const r = await fetch(BASE + p);
    console.log(p, r.status);
    if (r.status !== 200) throw new Error('static fail ' + p);
  }

  const post = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'sk-pkg-test' },
    body: JSON.stringify({ text: '帮我生成文件：packaged test', files: [], options: { thinking: true, search: true } }),
  });
  if (!post.ok) throw new Error('chat ' + post.status);

  const reader = post.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const types = [];
  let sessionId = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      const ev = JSON.parse(line);
      types.push(ev.t);
      if (ev.t === 'session') sessionId = ev.id;
    }
  }
  console.log('events: ' + [...new Set(types)].join(','));
  if (!types.includes('done')) throw new Error('no done event');
  if (!sessionId) throw new Error('no session');

  const file = path.join(PKG_ROOT, 'workspace', 'reports', 'test-listing.md');
  console.log('file exists:', fs.existsSync(file), file);
  if (!fs.existsSync(file)) throw new Error('file not written');

  const sess = await fetch(BASE + '/api/session?id=' + sessionId).then((r) => r.json());
  console.log('session messages=' + sess.ui.length + ' api=' + sess.api.length);
  console.log('PACKAGE OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
