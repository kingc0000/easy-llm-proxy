/**
 * mock-upstream.js — 集成测试用假上游
 * 模型 m100(main) 的所有 key → 429 限流;m99 → 200;其余 → 200
 */
'use strict';
const http = require('http');
const port = parseInt(process.argv[2] || '9902', 10);
const counter = { m100: 0, m99: 0 };
http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'm100' }, { id: 'm99' }] }));
    }
    const model = body.model || '?';
    counter[model] = (counter[model] || 0) + 1;
    const auth = req.headers['authorization'] || req.headers['x-api-key'] || 'none';
    if (model === 'm100') {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'rate limit (mock)', type: 'rate_limit_error' } }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'mock-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: 'assistant', content: `OK,来自 ${model} (auth=${auth.slice(0, 12)}…)` }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10, prompt_tokens_details: { cached_tokens: 2 } },
    }));
  });
}).listen(port, '127.0.0.1', () => console.log(`[mock] 限流上游 http://127.0.0.1:${port}`));
module.exports = () => {};