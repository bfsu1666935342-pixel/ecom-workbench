'use strict';

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:7862';
let failures = 0;
const check = (c, l, d) => {
  if (c) console.log('  ok   ' + l);
  else {
    failures += 1;
    console.log('  FAIL ' + l + (d ? ' :: ' + d : ''));
  }
};

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json() };
}

async function main() {
  const saved = await post('/api/mcp/save', {
    id: 'mcp-sorftime',
    url: 'http://127.0.0.1:7901/mcp',
    authMode: 'query',
    token: 'test',
    keyParam: 'key',
    enabled: true,
  });
  check(saved.data.ok, '保存 MCP 配置', JSON.stringify(saved.data));
  const tested = await post('/api/mcp/test', { id: 'mcp-sorftime' });
  check(tested.data.ok && tested.data.server.tools.length === 2, '测试连接并读取工具', JSON.stringify(tested.data.error || ''));

  const resp = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'sk-test' },
    body: JSON.stringify({ text: 'MCP 测试一下', files: [], options: { thinking: false, search: false } }),
  });
  if (!resp.ok) throw new Error('chat HTTP ' + resp.status);
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) events.push(JSON.parse(line));
    }
  }
  const start = events.find((e) => e.t === 'tool' && e.status === 'start');
  const end = events.find((e) => e.t === 'tool' && e.status !== 'start');
  const done = events.find((e) => e.t === 'done');
  check(Boolean(start && start.name.startsWith('mcp__')), '模型调用了 MCP 工具', start && start.name);
  check(Boolean(end && end.status === 'ok'), 'MCP 工具调用成功', end && end.status);
  check(Boolean(done && done.message.text.includes('数据源')), '回答里说明了数据源', done && done.message.text);
  check(tested.data.summary.connected >= 1, '数据源计入已连接', String(tested.data.summary.connected));

  const removed = await post('/api/mcp/remove', { id: 'mcp-sorftime' });
  check(removed.data.ok, '清除测试配置');

  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
