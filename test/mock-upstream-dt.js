/**
 * mock-upstream-dt.js — 决策树集成测试用假上游(3 模型)
 *
 * 模型行为(可用环境变量切换):
 *   m100 主   : M100_STATUS=429,200(默认前 5 次 429,之后 200) 全 429 限流
 *   m99  备2 : M99_STATUS=200(默认) 成功
 *   m98  备3 : M98_STATUS=200(默认) 成功
 *
 *   *N* 语法: 形如 "429,200" 表示前 N 次返回 429、之后返回 200(N 默认 5);
 *   "429" 表示一直 429;"200" 表示一直 200。
 *
 * 用途: 隔离实例(端口 8791)端到端验证降级决策树,不碰生产 elp(8790)/真实上游/dsh。
 * 用法: node test/mock-upstream-dt.js 9902
 */
'use strict';
const http = require('http');
const port = parseInt(process.argv[2] || '9902', 10);
const counter = {};
// 解析 "429,200" → 前 N 次 429 之后 200;N 取 M*_FAIL_TIMES(默认 5)
const seqOf = (env, def = 200) => {
  const parts = String(env || def).split(',').map((s) => parseInt(s.trim(), 10));
  if (parts.length === 1) return () => parts[0];
  const n = parseInt(process.env.M_FAIL_TIMES || '5', 10);
  let i = 0;
  return () => (i++ < n ? parts[0] : parts[1]);
};
// 顶层单例: 计数器跨请求累积(每次调用都新建闭包会让计数永远归零)
const seq100 = seqOf(process.env.M100_STATUS);
const seq99 = seqOf(process.env.M99_STATUS);
const seq98 = seqOf(process.env.M98_STATUS);
const statusOf = (m) => (m === 'm100' ? seq100() : m === 'm99' ? seq99() : m === 'm98' ? seq98() : 200);

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: ['m100', 'm99', 'm98'].map((id) => ({ id })) }));
    }
    const model = body.model || '?';
    counter[model] = (counter[model] || 0) + 1;
    const auth = req.headers['authorization'] || req.headers['x-api-key'] || 'none';
    const st = statusOf(model); // seqOf 已在模块顶层求值返回数字状态码
    console.log(`[mock-dt] ${model} key=${auth.slice(0, 18)} → ${st} (累计 ${counter[model]})`);
    if (st === 429) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'rate limit (mock)', type: 'rate_limit_error' } }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'mock-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: 'assistant', content: `OK from ${model}` }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10, prompt_tokens_details: { cached_tokens: 2 } },
    }));
  });
}).listen(port, '127.0.0.1', () => console.log(`[mock-dt] http://127.0.0.1:${port} m100=${process.env.M100_STATUS || '429,200'} m99=${process.env.M99_STATUS || '200'} m98=${process.env.M98_STATUS || '200'} (前 ${process.env.M_FAIL_TIMES || 5} 次)`));
module.exports = () => {};
