'use strict';

/* 本地假模型：用来在没有 API Key 的情况下跑通端到端流程。 */
const http = require('http');

const PORT = Number(process.env.MOCK_PORT || 7900);
let turn = 0;

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function sse(res, chunks) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const chunk of chunks) {
    res.write('data: ' + JSON.stringify(chunk) + '\n\n');
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

function delta(d) {
  return { id: 'mock', object: 'chat.completion.chunk', created: Date.now() / 1000, model: 'deepseek-flash', choices: [{ index: 0, delta: d }] };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let body = '';
  req.on('data', (c) => (body += c));
  await new Promise((r) => req.on('end', r));

  if (url.pathname === '/models') return json(res, 200, { object: 'list', data: [{ id: 'deepseek-flash' }] });

  if (url.pathname === '/files') {
    return json(res, 200, { id: 'file-api-mock123', object: 'file', bytes: 100, filename: 'mock', purpose: 'user_data' });
  }

  if (url.pathname === '/v1/tools/search') {
    return json(res, 200, {
      results: [
        {
          title: 'Amazon FBA fees update 2026',
          url: 'https://sell.amazon.com/fees',
          snippet: 'Updated FBA fulfillment fees for 2026.',
          summary: 'Amazon publishes FBA fee changes each year. Check the official fee page for current rates.',
          site_name: 'Amazon Seller Central',
          date: '2026-01-15T00:00:00+00:00',
          site_icon: null,
        },
      ],
    });
  }

  if (url.pathname === '/v1/tools/fetch') {
    return json(res, 200, { title: 'FBA fees', content: '# FBA fees\n\nFulfillment fee table.' });
  }

  if (url.pathname === '/chat/completions') {
    const payload = JSON.parse(body || '{}');
    const messages = payload.messages || [];
    const hasTool = messages.some((m) => m.role === 'tool');
    const last = messages[messages.length - 1] || {};
    turn += 1;

    if (!hasTool && String(last.content || '').includes('MCP')) {
      return sse(res, [
        delta({ reasoning_content: '先调用已连接的数据源确认链路。' }),
        delta({ tool_calls: [{ index: 0, id: 'call_mock_mcp', type: 'function', function: { name: 'mcp__sorftime__ping', arguments: '{}' } }] }),
        { id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        { id: 'mock', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 0 } },
      ]);
    }

    if (!hasTool && String(last.content || '').includes('搜索')) {
      const args = JSON.stringify({ query: 'Amazon FBA fees 2026', count: 3 });
      return sse(res, [
        delta({ reasoning_content: '需要最新费用数据，先搜一下。' }),
        delta({ tool_calls: [{ index: 0, id: 'call_mock_s', type: 'function', function: { name: 'web_search', arguments: args } }] }),
        { id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        { id: 'mock', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 90, completion_tokens: 20, prompt_cache_hit_tokens: 0 } },
      ]);
    }

    if (!hasTool && String(last.content || '').includes('生成文件')) {
      const args = JSON.stringify({
        path: 'reports/test-listing.md',
        content: '# 露营灯 Listing\n\n## 标题\nPortable Camping Lantern, USB Rechargeable, 3 Lighting Modes\n\n## 五点\n- USB-C 充电\n- 三档调光\n- 挂钩设计\n',
      });
      return sse(res, [
        delta({ reasoning_content: '用户要一个 Listing 文件，我先写文件再总结。' }),
        delta({ tool_calls: [{ index: 0, id: 'call_mock_1', type: 'function', function: { name: 'write_file', arguments: args } }] }),
        { id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        { id: 'mock', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 120, completion_tokens: 40, prompt_cache_hit_tokens: 0 } },
      ]);
    }

    const text = hasTool
      ? (() => {
          const toolMsgs = messages.filter((m) => m.role === 'tool');
          const lastTool = toolMsgs[toolMsgs.length - 1];
          const toolText = String((lastTool && lastTool.content) || '');
          if (toolText.includes('"tool":"ping"')) {
            return '数据源链路正常，MCP 工具返回了 ping。';
          }
          if (toolText.includes('Amazon FBA') || toolText.includes('FBA fees')) {
            return (
              '根据公开资料，亚马逊 2026 年的 FBA 配送费继续按尺寸和重量分段计费，旺季（10–12 月）另有仓储附加费。\n\n' +
              '| 费用项 | 变化 | 你要做什么 |\n|---|---|---|\n' +
              '| 配送费 | 按尺寸分段调整 | 用后台 Fee Preview 核对本品 |\n' +
              '| 旺季仓储 | 10–12 月上浮 | 提前清滞销、控库存 |\n' +
              '| 低库存费 | 长期低库存加收 | 保持 4–8 周覆盖 |\n\n' +
              '建议：先用卖家后台的 Revenue Calculator 按实际尺寸重算一遍，再把结果发我，我帮你更新利润表。\n\n' +
              '来源：Amazon Seller Central 费用页（见下方来源卡片）。'
            );
          }
          return '已经把 Listing 写好了：`reports/test-listing.md`。\n\n| 模块 | 状态 |\n|---|---|\n| 标题 | 完成 |\n| 五点 | 完成 |\n\n需要我再补一版 A+ 文案吗？';
        })()
      : '这是模拟回答。当前对话**没有调用工具**。\n\n- 第一条\n- 第二条\n\n```js\nconsole.log("hello")\n```';
    return sse(res, [
      delta({ reasoning_content: '先理解问题，再给结论。' }),
      delta({ content: text.slice(0, 12) }),
      delta({ content: text.slice(12) }),
      { id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { id: 'mock', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 80, completion_tokens: 60, prompt_cache_hit_tokens: 20 } },
    ]);
  }

  json(res, 404, { error: { message: 'mock: not found ' + url.pathname } });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('MOCK READY ' + PORT);
});
