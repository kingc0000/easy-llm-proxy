/** mock-anthropic.js — 假 Anthropic 上游(非流式 + SSE) */
'use strict';
const http = require('http');
const port = parseInt(process.argv[2] || '9903', 10);
http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try { body = JSON.parse(raw); } catch {}
    if (!req.headers['x-api-key']) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'missing x-api-key' } })); }
    console.log(`[mock-anthropic] ${req.method} ${req.url} | model=${body.model} stream=${body.stream} | system=${body.system ? 'Y' : 'N'} msgs=${(body.messages || []).length}`);
    if (req.url === '/v1/models') {
      return res.end(JSON.stringify({ data: [{ id: 'm100-a', type: 'model' }, { id: 'm99-a', type: 'model' }] }));
    }
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"' + (body.model || '') + '","content":[]}}\n\n');
      res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好,来自 "}}\n\n');
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"' + (body.model || 'm') + '"}}\n\n');
      res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":3,"cache_read_input_tokens":1}}}\n\n');
      res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":8}}\n\n'); // 真实 anthropic: delta 仅输出
      res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_x', type: 'message', role: 'assistant', model: body.model || 'unknown',
      content: [{ type: 'text', text: 'anthropic-' + (body.stream ? 'stream' : 'sync') + '-' + (body.model || 'm') }],
      stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 8, cache_read_input_tokens: 1 },
    }));
  });
}).listen(port, '127.0.0.1', () => console.log(`[mock-anthropic] http://127.0.0.1:${port}`));