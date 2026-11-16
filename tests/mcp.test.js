'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { McpManager } = require('../server/mcp');
const { createServer } = require('./mock-mcp');

let failures = 0;
const check = (c, l, d) => {
  if (c) console.log('  ok   ' + l);
  else {
    failures += 1;
    console.log('  FAIL ' + l + (d ? ' :: ' + d : ''));
  }
};

async function main() {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecom-mcp-'));
  const manager = new McpManager({ dataDir, version: '1.1.0' });

  check(manager.list().length === 4, '默认 4 个 MCP 预设');
  const saved = manager.save({
    id: 'mcp-sorftime',
    url: 'http://127.0.0.1:' + port + '/mcp',
    authMode: 'query',
    token: 'test',
    enabled: true,
  });
  check(saved.url.includes('127.0.0.1'), '保存 MCP 地址');

  const tested = await manager.test('mcp-sorftime');
  check(tested.status === 'ok', 'MCP 连接成功', JSON.stringify(tested.lastError));
  check(tested.tools.length === 2, '读取到 2 个工具', String(tested.tools.length));

  const defs = manager.defs();
  const ping = defs.find((d) => d.function.name.endsWith('__ping'));
  check(Boolean(ping), '工具定义已生成');
  check(ping && ping.function.description.includes('[Sorftime]'), '工具描述带来源');
  check(ping && ping.function.parameters.type === 'object', '工具参数是 object schema');

  const result = await manager.call(ping.function.name, { q: 'hello' });
  check(result.ok, 'MCP 工具调用成功', result.content);
  check(result.content.includes('ping'), '工具返回正确');
  check(result.content.includes('hello'), '参数已传到 MCP');

  const wrong = manager.save({ id: 'mcp-sorftime', token: 'wrong' });
  check(Boolean(wrong), '保存错误 key');
  let failed = false;
  try {
    await manager.test('mcp-sorftime');
  } catch {
    failed = true;
  }
  const after = manager.get('mcp-sorftime');
  check(failed && after.status === 'error', '错误 key 被标记为失败');

  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
