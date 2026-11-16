'use strict';

const http = require('http');

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (req.method !== 'POST' || !url.pathname.startsWith('/mcp')) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    if (url.searchParams.get('key') !== 'test') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"error":"bad key"}');
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    await new Promise((r) => req.on('end', r));
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end('bad json');
      return;
    }
    if (!msg.id) {
      res.writeHead(202);
      res.end();
      return;
    }
    let result;
    if (msg.method === 'initialize') {
      result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'Mock MCP', version: '1.0.0' },
      };
    } else if (msg.method === 'tools/list') {
      result = {
        tools: [
          { name: 'ping', description: 'A test tool that returns pong.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
          {
            name: 'category_report',
            description: 'Return a small fake category report.',
            inputSchema: { type: 'object', properties: { category: { type: 'string' } }, required: ['category'] },
          },
        ],
      };
    } else if (msg.method === 'tools/call') {
      result = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true, tool: msg.params.name, args: msg.params.arguments || {} }),
          },
        ],
      };
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'mcp-session-id': 'mock-session' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
}

if (require.main === module) {
  const port = Number(process.env.MOCK_MCP_PORT || 7901);
  createServer().listen(port, '127.0.0.1', () => console.log('MOCK MCP READY ' + port));
}

module.exports = { createServer };
