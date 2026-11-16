'use strict';

const fs = require('fs');
const path = require('path');

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:7862';
const ROOT = path.resolve(__dirname, '..');
let failures = 0;

function check(cond, label, detail) {
  if (cond) {
    console.log('  ok   ' + label);
  } else {
    failures += 1;
    console.log('  FAIL ' + label + (detail ? ' :: ' + detail : ''));
  }
}

async function readStream(resp) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        /* ignore */
      }
    }
  }
  return events;
}

async function chat(payload) {
  const resp = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'sk-test' },
    body: JSON.stringify(payload),
  });
  const events = await readStream(resp);
  return { status: resp.status, events };
}

async function main() {
  console.log('\n== health / verify ==');
  const health = await fetch(BASE + '/api/health').then((r) => r.json());
  check(health.ok === true, 'health 正常');
  const verify = await fetch(BASE + '/api/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'sk-test' }),
  }).then((r) => r.json());
  check(verify.ok === true, 'verify 通过', JSON.stringify(verify));

  console.log('\n== 第一轮：工具调用 + 写文件 ==');
  const first = await chat({
    sessionId: null,
    text: '帮我生成文件：露营灯 listing',
    files: [],
    skillId: null,
    options: { thinking: true, search: true },
  });
  check(first.status === 200, 'HTTP 200');
  const types = first.events.map((e) => e.t);
  check(types.includes('session'), '收到 session 事件');
  check(types.includes('reasoning'), '收到 reasoning 事件');
  check(types.includes('text'), '收到 text 事件');
  check(types.filter((t) => t === 'tool').length >= 2, '收到 tool start/end');
  check(types.includes('done'), '收到 done 事件');
  const done = first.events.find((e) => e.t === 'done');
  check(done && done.message && done.message.text.includes('Listing'), '回答文本正确');
  const file = path.join(ROOT, 'workspace', 'reports', 'test-listing.md');
  check(fs.existsSync(file), '工具确实写出了文件');
  const sessionId = (first.events.find((e) => e.t === 'session') || {}).id;
  check(Boolean(sessionId), '拿到 sessionId');

  console.log('\n== 会话持久化 ==');
  const session = await fetch(BASE + '/api/session?id=' + sessionId).then((r) => r.json());
  check(Array.isArray(session.ui) && session.ui.length === 2, 'ui 有 2 条消息', String(session.ui && session.ui.length));
  check(Array.isArray(session.api) && session.api.length >= 4, 'api 历史完整', String(session.api && session.api.length));
  const assistantApi = session.api.find((m) => m.role === 'assistant' && m.tool_calls);
  check(Boolean(assistantApi), 'assistant 带 tool_calls');
  check(Boolean(assistantApi && assistantApi.reasoning_content), '思考内容已回传保存');

  console.log('\n== 第二轮：同一会话继续 ==');
  const second = await chat({
    sessionId,
    text: '继续',
    files: [],
    skillId: null,
    options: { thinking: true, search: false },
  });
  check(second.status === 200, 'HTTP 200');
  check(second.events.some((e) => e.t === 'done'), '第二轮完成');
  const session2 = await fetch(BASE + '/api/session?id=' + sessionId).then((r) => r.json());
  check(session2.ui.length === 4, '会话累计 4 条消息', String(session2.ui.length));

  console.log('\n== 联网搜索工具 ==');
  const searchRun = await chat({
    sessionId: null,
    text: '搜索一下 FBA 费用 2026',
    files: [],
    skillId: null,
    options: { thinking: true, search: true },
  });
  check(searchRun.status === 200, '搜索对话 HTTP 200');
  check(searchRun.events.some((e) => e.t === 'sources'), '收到 sources 事件');
  const sourceEv = searchRun.events.find((e) => e.t === 'sources');
  check(sourceEv && sourceEv.items && sourceEv.items[0].url.includes('amazon'), '来源 URL 正确');
  check(searchRun.events.some((e) => e.t === 'done'), '搜索对话完成');

  console.log('\n== 附件上传 + 文件块 ==');
  const csv = Buffer.from('search term,clicks,spend\ncamping lantern,120,45.5\nusb lantern,30,12\n', 'utf8');
  const upResp = await fetch(BASE + '/api/upload?name=' + encodeURIComponent('搜索词报告.csv') + '&mime=' + encodeURIComponent('text/csv'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: csv,
  });
  const up = await upResp.json();
  check(upResp.status === 200 && up.file && up.file.id, '上传成功');
  check(fs.existsSync(path.join(ROOT, 'workspace', 'attachments')), '附件保存到 workspace/attachments');
  const third = await chat({
    sessionId,
    text: '看一下这个搜索词报告',
    files: [{ id: up.file.id }],
    skillId: null,
    options: { thinking: false, search: false },
  });
  check(third.status === 200 && third.events.some((e) => e.t === 'done'), '带附件的对话完成');
  const uploadEvents = third.events.filter((e) => e.t === 'upload');
  check(uploadEvents.some((e) => e.status === 'ok'), '附件解析成功事件');

  console.log('\n== 静态资源 ==');
  for (const p of ['/', '/css/app.css', '/js/app.js', '/js/markdown.js', '/assets/logo.svg']) {
    const r = await fetch(BASE + p);
    check(r.status === 200, 'GET ' + p);
  }

  console.log('\n== 错误处理 ==');
  const noKey = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hi' }),
  });
  check(noKey.status === 401, '没有 Key 返回 401');

  const csrf = await fetch(BASE + '/api/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: '{}',
  });
  check(csrf.status === 403, '跨站 POST 被拒绝', String(csrf.status));

  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
