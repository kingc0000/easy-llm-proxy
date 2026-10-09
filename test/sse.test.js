/**
 * sse.test.js — SSE 精简器单元测试
 */
'use strict';
const assert = require('assert');
const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src/proxy.js'), 'utf8');
const sseReducer = new Function(src.match(/function sseReducer\(\) \{[\s\S]*?\n\}/)[0] + '; return sseReducer;')();

module.exports = async () => {
  // 防回归: push() 返回 undefined 但 state 必须可读(曾因简写方法无 return 导致 uncaughtException)
  assert.ok(sseReducer().push(Buffer.from('data: {"choices":[{"delta":{"content":"x"}}]}\n')).state, 'push 返回 {state}');
  assert.strictEqual(sseReducer().state.text, '');

  let failures = 0;
  const t = (name, fn) => { try { fn(); console.log('  ✓', name); } catch (e) { failures++; console.log('  ✗', name, '\n    ', e.message); } };

  t('流式 SSE 精简: 只保留 delta 内容,丢弃协议元数据', () => {
    const r = sseReducer();
    const lines = [
      'event: message',
      'data: {"choices":[{"delta":{"role":"assistant"},"usage":{"prompt_tokens":10,"completion_tokens":1}}]}',
      'id: 1',
      '',
      'data: {"choices":[{"delta":{"content":"你"}}]}',
      ': keep-alive',
      'data: {"choices":[{"delta":{"content":"好"}}]}',
      'data: {"choices":[{"delta":{"content":"世界"}}]}',
      'data: [DONE]',
      '',
    ];
    r.push(Buffer.from(lines.join('\n')));
    assert.strictEqual(r.state.text, '你好世界');
  });

  t('流式错误事件捕获', () => {
    const r = sseReducer();
    r.push(Buffer.from('data: {"error":{"message":"rate limited"}}\n\ndata: [DONE]\n'));
    assert.strictEqual(r.state.error, 'rate limited');
  });

  t('推理模型 reasoning_content 字段也记录', () => {
    const r = sseReducer();
    r.push(Buffer.from('data: {"choices":[{"delta":{"reasoning_content":"思考"}}]}\n'));
    r.push(Buffer.from('data: {"choices":[{"delta":{"content":"答案"}}]}\n'));
    assert.strictEqual(r.state.text, '思考答案');
  });

  t('chunk 跨行切分仍正确拼接(流式边界)', () => {
    const r = sseReducer();
    r.push(Buffer.from('data: {"choices":[{"delta":{"content":"你好"}}]}\n'));   // 完整行
    r.push(Buffer.from('data: {"choices":[{"delta":{"content":"世'));            // 行被切断
    r.push(Buffer.from('界"}}]}\ndata: [DONE]\n'));                              // 补全 + 结束
    assert.strictEqual(r.state.text, '你好世界');
  });

  console.log(failures ? `\n${failures} 个测试失败` : '\n全部通过');
  return failures === 0;
};
