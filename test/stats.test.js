/**
 * stats.test.js — 统计口径与配置/路径防御回归测试
 *  - failed 计数口径(errors = 所有非成功尝试, 与 errorTypes 分类总数一致;
 *    用户约定: 所有非成功都要对失败计数, 有失败则成功率必 <100%)
 *  - auth.json hash 格式损坏时 login/update 必须降级返回而非抛异常
 *  - 静态资源路径解析的 WEB_DIR 逃逸防护
 * 运行: node test/run.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const fresh = (m) => { delete require.cache[require.resolve(m)]; return require(m); };

module.exports = async () => {
  let failures = 0;
  const t = (name, fn) => { try { fn(); console.log('  ✓', name); } catch (e) { failures++; console.log('  ✗', name, '\n    ', e.message); } };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elap-test-'));
  process.env.STATS_FILE = path.join(tmp, 'stats.json');
  const stats = require('../src/stats');

  try {
    t('所有非成功尝试都计 failed: errors 与 errorTypes 分类总数一致', () => {
      stats.reset();
      const [P, M, K] = ['p1', 'm1', 'k1'];
      // 尝试 1: 429 → 记分类 + errors(用户约定: 所有非成功都要计失败)
      stats.bump(P, M, K, 'requests');
      stats.bump(P, M, K, 'retries');
      stats.markError(P, M, K, '429');
      // 尝试 2: 5xx → 同样计
      stats.bump(P, M, K, 'requests');
      stats.markError(P, M, K, '5xx');
      // 尝试 3: 成功
      stats.bump(P, M, K, 'requests');
      stats.bump(P, M, K, 'ok');

      const s = stats.summary().summary;
      assert.strictEqual(s.ok, 1, '成功 1 次');
      assert.strictEqual(s.retries, 1, '重试 1 次');
      assert.strictEqual(s.errors, 2, '非成功 2 次(429+5xx)都计失败');
      assert.strictEqual(s.failed, 2, 'failed = errors = 所有非成功尝试数');
      assert.strictEqual(s.errorTypes['429'], 1, '分类 429 = 1');
      assert.strictEqual(s.errorTypes['5xx'], 1, '分类 5xx = 1');
      // requests = ok + errors, 成功率对得上
      assert.strictEqual(s.requests, 3, 'requests = 尝试总数');
    });

    t('provider/model 层级 failed 同步取 errors(与分类总数一致)', () => {
      stats.reset();
      const [P, M, K] = ['p2', 'm2', 'k2'];
      stats.bump(P, M, K, 'requests');
      stats.markError(P, M, K, '429');
      stats.markError(P, M, K, '429'); // 分类累加两次 → errors 也两次
      stats.bump(P, M, K, 'requests');
      stats.bump(P, M, K, 'ok');

      const r = stats.summary();
      assert.strictEqual(r.byProvider.length, 1);
      const p = r.byProvider[0];
      assert.strictEqual(p.failed, 2, 'provider failed = 2 次非成功');
      const m = [...p.models.values()][0];
      assert.strictEqual(m.failed, 2, 'model failed = 2 次非成功');
      // 错误分类只在顶层 summary 聚合(provider/model 层级不展开分类),保持既有展示语义
      assert.strictEqual(r.summary.errorTypes['429'], 2, '顶层 errorTypes 累计分类');
      assert.strictEqual(r.summary.errors, 2, '顶层 errors 与分类一致');
    });

    t('snapshot 每 key 行 failed 取 errors', () => {
      stats.reset();
      const [P, M, K] = ['p3', 'm3', 'k3'];
      stats.bump(P, M, K, 'requests');
      stats.markError(P, M, K, 'net');
      const row = stats.summary().byKey[0];
      assert.strictEqual(row.failed, 1);
      assert.strictEqual(row.errorTypes.net, 1);
      assert.strictEqual(row.errors, 1);
    });
  } finally {
    stats.reset();
  }

  t('auth: auth.json hash 格式损坏时 login 返回 bad 而非抛异常', () => {
    const f = path.join(tmp, 'auth.json');
    fs.writeFileSync(f, JSON.stringify({ username: 'admin', hash: 'somesalt:not-a-real-hex' }), { mode: 0o600 });
    process.env.AUTH_FILE = f;
    process.env.SECRET_FILE = path.join(tmp, 'auth-secret');
    const auth = fresh('../src/auth');
    let r;
    try { r = auth.login('admin', 'whatever'); } catch (e) { assert.fail('login 抛异常: ' + e.message); }
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'bad', '格式损坏应判定为密码错误而非 500');
  });

  t('auth: 损坏 hash 的 update 旧密码校验同样不抛异常', () => {
    const auth = fresh('../src/auth');
    let r;
    try { r = auth.update('wrong', 'newuser', 'newpass'); } catch (e) { assert.fail('update 抛异常: ' + e.message); }
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'old_password_wrong');
  });

  t('auth: 合法 hash 仍可登录(长度校验不破坏正常凭证)', () => {
    const f = path.join(tmp, 'auth2.json');
    const salt = crypto.randomBytes(16).toString('hex');
    const pw = 'correct-password';
    fs.writeFileSync(f, JSON.stringify({ username: 'admin', hash: salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex') }), { mode: 0o600 });
    process.env.AUTH_FILE = f;
    const auth = fresh('../src/auth');
    const r = auth.login('admin', pw);
    assert.strictEqual(r.ok, true, '合法 hash 应校验通过');
    const bad = auth.login('admin', 'wrong-password');
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.reason, 'bad');
  });

  t('静态资源: WEB_DIR 逃逸路径一律拒绝', () => {
    const srv = fresh('../src/server');
    assert.strictEqual(srv.resolveStatic('/'), path.join(srv.WEB_DIR, 'index.html'), '根路径映射 index.html');
    assert.strictEqual(srv.resolveStatic('/app.js'), path.join(srv.WEB_DIR, 'app.js'), '子资源放行');
    assert.strictEqual(srv.resolveStatic('/../../etc/passwd'), null, '../ 逃逸必须拒绝');
    assert.strictEqual(srv.resolveStatic('/../../../etc/shadow'), null, '多层 ../ 逃逸必须拒绝');
    assert.strictEqual(srv.resolveStatic('/web2/../../etc/passwd'), null, '中段 ../ 逃逸必须拒绝');
    assert.strictEqual(srv.resolveStatic('/%2e%2e/etc/passwd'), path.join(srv.WEB_DIR, '%2e%2e/etc/passwd'),
      'URL 编码 %2e 不做二次解码(文件系统报 404,不逃逸)');
  });

  // 还原环境(避免污染同进程后续 require)
  delete process.env.STATS_FILE;
  delete process.env.AUTH_FILE;
  delete process.env.SECRET_FILE;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

  console.log(`stats.test: ${7 - failures} pass / ${failures} fail`);
  return failures === 0;
};
