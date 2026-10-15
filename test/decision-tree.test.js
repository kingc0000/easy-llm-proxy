/**
 * decision-tree.test.js — 降级决策树端到端验证(按用户约定的规则)
 *
 * 规则:
 *  R1 同层 key 逐个失败才切下一个(m1 的 k1 失败 → k2 → k3; m2 的 k1 失败 → k2 → k3)
 *  R2 同层全部失败 或 达到 usageLimit → 重新尝试主 model(回主)
 *  R3 主全失败 → 降级到下一权重层(m1 → m2)
 *  R4 回主后若主仍在冷却: 备2 冷却=0(无冷却) → 立刻可再试备2 的 k1
 *  R5 备2 冷却≠0 且处于冷却期 → 层聚合跳过备2,落到备3
 *  R6 备3 达限/失败 → 回主,如此往复
 *
 * 本测试不启服务、不打真实上游: 直接用内存 mock(upstream 函数)驱动 balance 的
 * plan/report/advanceKey/degrade,复刻 proxy.js 的重试循环,逐请求观察状态演化。
 * 运行: node test/run.js
 */
'use strict';
const assert = require('assert');
const bal = require('../src/balance');

const model = (id, over = {}) => Object.assign(
  { id, weight: 100, usageLimit: null, useSeconds: null, cooldown: null, keys: ['k1', 'k2', 'k3'] }, over);

const provider = (models, over = {}) => Object.assign(
  { name: 't', apiType: 'openai', baseURL: 'http://x', usageLimit: null, useSeconds: null, roundRobin: false, models }, over);

/** m1 主(cooldown 60s) / m2 备2(默认 cooldown=0 无冷却, usageLimit 2) / m3 备3(usageLimit 2) */
const P = provider([
  model('m1', { weight: 100, cooldown: 60 }),
  model('m2', { weight: 99, cooldown: 0, usageLimit: 2 }),
  model('m3', { weight: 98, cooldown: 60, usageLimit: 2 }),
]);

/** 复刻 proxy.js 的重试循环: plan → 逐候选转发 → 失败冷却/耗尽则 degrade+rePlan */
function simulate(p, st, upstream) {
  const cap = bal.maxAttempts(p); // 与 proxy.js 一致: 全局尝试上限
  let planList = bal.plan(p, st, null);
  let idx = 0, dc = 0, attempts = 0;
  const trace = [];
  while (attempts < cap) {
    const c = planList[idx++];
    if (!c) break;
    attempts++;
    trace.push(c.modelId + '/' + c.key);
    if (upstream(c.modelId, c.key)) {
      bal.report(p, st, c.modelId, c.key, true);
      return { ok: true, trace, dc };
    }
    bal.advanceKey(st, c.modelId, c.key);
    if (planList.slice(idx).filter((x) => x.modelId === c.modelId).length === 0) {
      const ks = [...new Set(planList.filter((x) => x.modelId === c.modelId).map((x) => x.key))];
      bal.degrade(p, st, c.modelId, ks);
      dc++;
      planList = bal.plan(p, st, null);
      idx = 0;
      if (dc > p.models.length + 2) break;
    }
  }
  return { ok: false, trace, dc };
}

/** 主层与所有 key 都失败,只有指定集合成功 */
function only(allow) {
  return (mid, k) => allow.has(mid + '/' + k);
}

module.exports = async () => {
  let failures = 0;
  const t = (name, fn) => { try { fn(); console.log('  ✓', name); } catch (e) { failures++; console.log('  ✗', name, '\n    ', e.message); } };

  t('R1 主 model 的 k1 失败 → 切 k2(同层 key 逐个失败才切)', () => {
    const st = bal.newState();
    // 只有 m1/k1 失败,其余成功
    const r = simulate(P, st, (mid, k) => !(mid === 'm1' && k === 'k1'));
    assert.ok(r.ok);
    assert.deepStrictEqual(r.trace.slice(0, 2), ['m1/k1', 'm1/k2']);
    assert.strictEqual(r.dc, 0); // 未降级
  });

  t('R3+R1 主全失败 → 降级备2;备2 的 k1 失败 → 切 k2 → k3', () => {
    const st = bal.newState();
    // 主全 429,备2 全 200
    const r = simulate(P, st, (mid) => mid !== 'm1');
    assert.ok(r.ok);
    assert.deepStrictEqual(r.trace.slice(0, 3), ['m1/k1', 'm1/k2', 'm1/k3'], '主层三个 key 依次尝试');
    assert.strictEqual(r.trace[3], 'm2/k1', '降级后从备2 的 k1 开始');
    assert.strictEqual(r.trace.length, 4);
    assert.strictEqual(r.dc, 1);
    assert.ok(st.degraded.has('k1'), '降级态已建立');
    assert.strictEqual(st.degraded.get('k1').modelId, 'm2');
  });

  t('R1 备2 内 k1 失败 → 切 k2(降级后同层轮转)', () => {
    const st = bal.newState();
    for (const k of ['k1', 'k2', 'k3']) bal.advanceKey(st, 'm1', k); // 主层先全部冷却
    bal.degrade(P, st, 'm1', ['k1', 'k2', 'k3']);
    bal.advanceKey(st, 'm2', 'k1'); // 备2 的 k1 失败
    const p = bal.plan(P, st, null);
    const m2c = p.filter((c) => c.modelId === 'm2');
    assert.strictEqual(m2c[0].key, 'k2', 'k1 冷却 → 从 k2 起');
  });

  t('R2 同层全部失败 → 回主重试(不下探备3)', () => {
    const st = bal.newState();
    for (const k of ['k1', 'k2', 'k3']) { bal.advanceKey(st, 'm1', k); bal.advanceKey(st, 'm2', k); }
    bal.degrade(P, st, 'm1', ['k1', 'k2', 'k3']); // 主失败 → 备2
    const r = bal.degrade(P, st, 'm2', ['k1', 'k2', 'k3']); // 备2 也失败
    assert.strictEqual(r.toModel, null, '非主层失败一律回主');
    assert.ok(!st.degraded.has('k1') && !st.degraded.has('k2') && !st.degraded.has('k3'), '降级态清空');
  });

  t('R2 达到 usageLimit → 回主(跨请求累积计数)', () => {
    const st = bal.newState();
    for (let i = 0; i < 2; i++) {
      const r = simulate(P, st, (mid) => mid === 'm2');
      assert.ok(r.ok, '请求 ' + (i + 1) + ' 应在备2 成功');
    }
    bal.plan(P, st, null); // 触发到期清理
    assert.ok(!st.degraded.has('k1') && !st.degraded.has('k2') && !st.degraded.has('k3'),
      'usageLimit=2 合计达限 → 整组回主(降级态清空)');
    // 回主 ≠ 立刻能用主: 主层刚失败仍在冷却期,需等冷却过期
    assert.ok(!bal.plan(P, st, null).some((c) => c.modelId === 'm1'), '主冷却期内主层仍被跳过');
    for (const k of ['k1', 'k2', 'k3']) st.failAt.set('m1\0' + k, Date.now() - 61 * 1000);
    assert.ok(bal.plan(P, st, null).some((c) => c.modelId === 'm1'), '主冷却过期 → 主层恢复为候选');
  });

  t('R2b 多个 key 各成功一部分,成功次数合计达限 → 整组回主', () => {
    const st = bal.newState();
    // 请求1: 只有 m2/k1 成功;请求2: 只有 m2/k2 成功 → 合计 2 达限(usageLimit=2)
    let r = simulate(P, st, (mid, k) => mid === 'm2' && k === 'k1');
    assert.ok(r.ok, '请求1 应在 m2/k1 成功');
    r = simulate(P, st, (mid, k) => mid === 'm2' && k === 'k2');
    assert.ok(r.ok, '请求2 应在 m2/k2 成功(先试 k1 失败后落到 k2)');
    bal.plan(P, st, null);
    assert.ok(!st.degraded.has('k1') && !st.degraded.has('k2') && !st.degraded.has('k3'),
      '合计 2 ≥ usageLimit=2 → k1/k2/k3 整组回主(不是逐 key 分别达限)');
  });

  t('R4 主冷却中且备2 冷却=0(无冷却) → 回主后立刻可再试备2', () => {
    const st = bal.newState();
    for (const k of ['k1', 'k2', 'k3']) { bal.advanceKey(st, 'm1', k); bal.advanceKey(st, 'm2', k); }
    bal.degrade(P, st, 'm1', ['k1', 'k2', 'k3']); // 主失败 → 备2
    bal.degrade(P, st, 'm2', ['k1', 'k2', 'k3']); // 备2 失败 → 回主
    // 主仍在冷却(60s 内),备2 cooldown=0(无冷却) → 候选: 备2 层在前,备3 层在后
    const p = bal.plan(P, st, null);
    assert.strictEqual(p[0].modelId, 'm2', '主冷却 + 备2 无冷却 → 备2 立刻可用(首个候选)');
    assert.ok(p.some((c) => c.modelId === 'm2') && p.some((c) => c.modelId === 'm3'));
    assert.ok(p.findIndex((c) => c.modelId === 'm2') < p.findIndex((c) => c.modelId === 'm3'), '备2 权重高于备3,排在其前');
  });

  t('R5 主冷却中且备2 冷却期内 → 跳过备2 落到备3', () => {
    const P2 = provider([
      model('m1', { weight: 100, cooldown: 60 }),
      model('m2', { weight: 99, cooldown: 60, usageLimit: 2 }), // 备2 也有冷却
      model('m3', { weight: 98, cooldown: 60, usageLimit: 2 }),
    ]);
    const st = bal.newState();
    for (const k of ['k1', 'k2', 'k3']) { bal.advanceKey(st, 'm1', k); bal.advanceKey(st, 'm2', k); }
    bal.degrade(P2, st, 'm1', ['k1', 'k2', 'k3']);
    bal.degrade(P2, st, 'm2', ['k1', 'k2', 'k3']);
    const p = bal.plan(P2, st, null);
    assert.strictEqual(p[0].modelId, 'm3', '主与备2 都冷却 → 落到备3');
    assert.ok(p.every((c) => c.modelId === 'm3'));
  });

  t('R5+R3 主全失败 + 备2 冷却期内 → 直接落到备3', () => {
    const P2 = provider([
      model('m1', { weight: 100, cooldown: 60 }),
      model('m2', { weight: 99, cooldown: 60, usageLimit: 2 }),
      model('m3', { weight: 98, cooldown: 60, usageLimit: 2 }),
    ]);
    const st = bal.newState();
    // 全部 429 只有备3 成功
    const r = simulate(P2, st, (mid) => mid === 'm3');
    assert.ok(r.ok);
    assert.ok(r.trace.filter((x) => x.startsWith('m1')).length === 3);
    assert.ok(r.trace.filter((x) => x.startsWith('m2')).length === 3);
    assert.ok(r.trace[r.trace.length - 1].startsWith('m3'));
  });

  t('R6 备3 达到 usageLimit → 回主重试(往复)', () => {
    const P2 = provider([
      model('m1', { weight: 100, cooldown: 60 }),
      model('m2', { weight: 99, cooldown: 60, usageLimit: 2 }),
      model('m3', { weight: 98, cooldown: 60, usageLimit: 2 }),
    ]);
    const st = bal.newState();
    for (let i = 0; i < 2; i++) {
      const r = simulate(P2, st, (mid) => mid === 'm3');
      assert.ok(r.ok, '请求 ' + (i + 1));
      for (const k of ['k1', 'k2', 'k3']) bal.advanceKey(st, 'm1', k);
    }
    assert.ok(!st.degraded.has('k1'), '备3 达限 → 回主');
  });

  t('cooldown=0 被解析为"无冷却"(而非未配置→默认 60s)', () => {
    const st = bal.newState();
    bal.advanceKey(st, 'm2', 'k1'); // 刚失败
    assert.ok(!bal.inCooldown(P, st, 'm2', 'k1'), 'cooldown=0 → 立刻可用');
    const st2 = bal.newState();
    bal.advanceKey(st2, 'm1', 'k1'); // m1 cooldown=60
    assert.ok(bal.inCooldown(P, st2, 'm1', 'k1'), 'cooldown=60 → 60s 内冷却中');
  });

  t('cap 有限: 无可用层时不无限循环(全 429)', () => {
    const st = bal.newState();
    const cap = bal.maxAttempts(P);
    const r = simulate(P, st, () => false); // 全部失败
    assert.strictEqual(r.ok, false);
    assert.ok(r.trace.length <= cap, '尝试次数受 maxAttempts(' + cap + ') 限制,实际 ' + r.trace.length);
    assert.ok(r.dc <= P.models.length + 2, '降级轮数受兜底限制,实际 ' + r.dc);
  });

  console.log(failures ? `\n${failures} 个测试失败` : '\n全部通过');
  return failures === 0;
};
