/**
 * config.test.js — 配置归一化回归测试
 *  - provider 级 key 的 cooldown 在 model 共享池时必须继承(修复: 此前被静默丢弃,退化为 60s 默认)
 *  - model 级 key cooldown 优先于 provider 级
 *  - key 归一(字符串 / {value,note,cooldown} 对象)、去重、model 空则共享池
 *  - 同名 provider / 同 id model 去重
 * 运行: node test/run.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const fresh = (m) => { delete require.cache[require.resolve(m)]; return require(m); };

module.exports = async () => {
  let failures = 0;
  const t = (name, fn) => { try { fn(); console.log('  ✓', name); } catch (e) { failures++; console.log('  ✗', name, '\n    ', e.message); } };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elap-cfg-'));
  const cf = path.join(tmp, 'config.json');
  const writeCfg = (cfg) => fs.writeFileSync(cf, JSON.stringify(cfg), { mode: 0o600 });
  const load = () => { process.env.CONFIG_FILE = cf; return fresh('../src/config').load(); };

  t('provider 级 key cooldown 在 model 共享池时继承(不再静默丢弃)', () => {
    writeCfg({ providers: [{
      name: 'p1', apiType: 'openai', baseURL: 'http://up',
      keys: [{ value: 'sk-a', note: '主', cooldown: 300 }, { value: 'sk-b' }],
      models: [{ id: 'm1', weight: 100 }],
    }]});
    const p = load().providers[0];
    assert.strictEqual(p.models[0].keys.length, 2, 'model 共享 provider 池');
    assert.strictEqual(p.models[0].keyCooldowns['sk-a'], 300, 'provider 级 cooldown=300 应继承到 model');
    assert.strictEqual(p.models[0].keyCooldowns['sk-b'], undefined, '未配 cooldown 的 key 不产生条目');
  });

  t('model 级 key cooldown 生效且不覆盖 provider 级其他 key', () => {
    writeCfg({ providers: [{
      name: 'p2', baseURL: 'http://up',
      keys: [{ value: 'sk-a', cooldown: 300 }],
      models: [{ id: 'm1', weight: 100, keys: [{ value: 'sk-x', cooldown: 60 }, 'sk-a'] }],
    }]});
    const m = load().providers[0].models[0];
    assert.deepStrictEqual(m.keys, ['sk-x', 'sk-a'], 'model 独立 keys 覆盖共享池');
    assert.strictEqual(m.keyCooldowns['sk-x'], 60, 'model 级 cooldown 生效');
    assert.strictEqual(m.keyCooldowns['sk-a'], 300, 'model 未配的同 key 仍继承 provider 级 cooldown');
  });

  t('同一 key 两处配置时 model 级 cooldown 覆盖 provider 级', () => {
    writeCfg({ providers: [{
      name: 'p2b', baseURL: 'http://up',
      keys: [{ value: 'sk-a', cooldown: 300 }],
      models: [{ id: 'm1', weight: 100, keys: [{ value: 'sk-a', cooldown: 15 }] }],
    }]});
    const m = load().providers[0].models[0];
    assert.strictEqual(m.keyCooldowns['sk-a'], 15, 'model 级显式值优先');
  });

  t('key 归一: 字符串与 {value,note,cooldown} 对象混合 + 去重', () => {
    writeCfg({ providers: [{
      name: 'p3', baseURL: 'http://up',
      keys: ['sk-1', { value: 'sk-1', note: '重复' }, { key: 'sk-2', cooldown: 120, note: 'legacy' }, ''],
      models: [{ id: 'm1' }],
    }]});
    const p = load().providers[0];
    assert.deepStrictEqual(p.keys, ['sk-1', 'sk-2'], '字符串/对象统一为 value,空串与重复丢弃');
    assert.strictEqual(p.keyNotes['sk-1'], '', '重复项保留首次(无 note)');
    assert.strictEqual(p.keyNotes['sk-2'], 'legacy');
    assert.strictEqual(p.models[0].keyCooldowns['sk-2'], 120, 'legacy {key,cooldown} 形式解析');
  });

  t('model 无 keys 且 provider 无 keys → provider 被过滤;有 keys 则建 default model', () => {
    writeCfg({ providers: [
      { name: 'empty', baseURL: 'http://up', keys: [], models: [{ id: 'm1' }] },
      { name: 'auto', baseURL: 'http://up', keys: ['sk-9'], models: [] },
    ]});
    const cfg = load();
    assert.strictEqual(cfg.providers.length, 1, '无任何 key 的 provider 被丢弃');
    assert.deepStrictEqual(cfg.providers[0].models.map((m) => m.id), ['default'], '无 models 但有 keys 时自动建 default');
    assert.strictEqual(cfg.providers[0].models[0].weight, 100);
  });

  t('同名 provider / 同 id model 去重(保留首个)', () => {
    writeCfg({ providers: [{
      name: 'dup', baseURL: 'http://up',
      keys: ['sk-1'],
      models: [{ id: 'm1', weight: 90 }, { id: 'm1', weight: 10 }],
    }]});
    const cfg = load();
    assert.strictEqual(cfg.providers.length, 1);
    assert.strictEqual(cfg.providers[0].models.length, 1, '同 id model 去重');
    assert.strictEqual(cfg.providers[0].models[0].weight, 90, '保留首个');
  });

  t('权重越界收敛到 [1,100];非法类型回退 100', () => {
    writeCfg({ providers: [{
      name: 'w', baseURL: 'http://up', keys: ['sk-1'],
      models: [{ id: 'a', weight: -5 }, { id: 'b', weight: 999 }, { id: 'c', weight: 'x' }, { id: 'd', weight: 7 }],
    }]});
    const ws = load().providers[0].models.map((m) => m.weight);
    assert.deepStrictEqual(ws, [1, 100, 100, 7], '越界收敛,非数字回退 100');
  });

  t('usageLimit/useSeconds: model 级显式优先(含 0=不限),未配回退 provider 默认', () => {
    writeCfg({ providers: [{
      name: 'u', baseURL: 'http://up', keys: ['sk-1'], usageLimit: 3, useSeconds: 30,
      models: [{ id: 'a', usageLimit: 0, useSeconds: 12 }, { id: 'b' }],
    }]});
    const [a, b] = load().providers[0].models;
    assert.strictEqual(a.usageLimit, 0, 'model 显式 0 = 不限次数');
    assert.strictEqual(a.useSeconds, 12);
    assert.strictEqual(b.usageLimit, 3, '未配回退 provider 级默认');
    assert.strictEqual(b.useSeconds, 30);
  });

  t('旧格式兼容: 顶层 keys 数组 / provider.keys 字符串数组 自动包装为 provider', () => {
    writeCfg({ baseURL: 'http://old', keys: ['sk-1', 'sk-2'] });
    let cfg = load();
    assert.strictEqual(cfg.providers.length, 1, '顶层 keys 包装为单 provider');
    assert.strictEqual(cfg.providers[0].baseURL, 'http://old');
    assert.deepStrictEqual(cfg.providers[0].models.map((m) => m.id), ['default']);

    writeCfg({ providers: [{ name: 'strkeys', baseURL: 'http://up', keys: ['sk-1'] }] });
    cfg = load();
    assert.deepStrictEqual(cfg.providers[0].keys, ['sk-1'], 'provider.keys 字符串数组');
  });

  const vp = require('../src/api').validateProviderPayload;
  t('validateProviderPayload: model 省略 keys(共享 provider 池)合法', () => {
    assert.strictEqual(vp({ name: 'p', keys: ['sk-1'], models: [{ id: 'm1' }] }), null,
      'model 无 keys 且 provider 有 keys 应通过');
  });

  t('validateProviderPayload: model 级 keys 支持字符串与 {value,note,cooldown} 对象', () => {
    assert.strictEqual(vp({ name: 'p', keys: ['sk-1'], models: [{ id: 'm1', keys: ['sk-2'] }] }), null, '字符串 keys');
    assert.strictEqual(vp({ name: 'p', keys: ['sk-1'], models: [{ id: 'm1', keys: [{ value: 'sk-2', note: 'x', cooldown: 60 }] }] }), null,
      '对象 keys(修复: 此前被误判为无效)');
  });

  t('validateProviderPayload: 非法配置仍被拒绝', () => {
    const base = { name: 'p', keys: ['sk-1'], models: [{ id: 'm1' }] };
    assert.ok(vp({ ...base, models: [{ id: 'm1', keys: [] }] }), '空 keys 数组拒绝');
    assert.ok(vp({ ...base, models: [{ id: 'm1', keys: [''] }] }), '空串 key 拒绝');
    assert.ok(vp({ name: 'p', keys: [], models: [{ id: 'm1' }] }), 'provider 无 keys 且 model 无 keys 拒绝');
    assert.ok(vp({ ...base, models: [{ id: 'm1', weight: 0 }] }), 'weight<1 拒绝');
    assert.ok(vp({ ...base, models: [{ id: 'm1', weight: 101 }] }), 'weight>100 拒绝');
    assert.ok(vp({ ...base, models: [{ id: '' }] }), 'model 缺 id 拒绝');
    assert.ok(vp({ ...base, models: [] }), '无 model 拒绝');
    assert.ok(vp({ ...base, name: '' }), 'provider 缺 name 拒绝');
  });

  const maskStatsKeys = require('../src/api').maskStatsKeys;
  t('maskStatsKeys: byKey 替换为 key1/key2 序号,未知 key 标记 key?(/stats 与 /api/stats 共用)', () => {
    writeCfg({ providers: [{
      name: 'p', apiType: 'openai', baseURL: 'http://up',
      keys: ['sk-abc1234567890wxyz', 'sk-def234567890wxyz1'],
      models: [{ id: 'm1', weight: 100 }],
    }]});
    const shortOf = (k) => (k.length > 12 ? k.slice(0, 8) + '…' + k.slice(-4) : k);
    const sum = { byKey: [
      { key: shortOf('sk-abc1234567890wxyz'), requests: 1 },
      { key: shortOf('sk-def234567890wxyz1'), requests: 2 },
      { key: 'sk-unknown', requests: 3 },
    ]};
    const masked = maskStatsKeys(sum, load().providers);
    assert.deepStrictEqual(masked.byKey.map((x) => x.key), ['key1', 'key2', 'key?'],
      '真实 key 片段不出接口(修复: /stats 此前直接展开 summary 泄露 shortKey)');
    assert.strictEqual(masked.byKey[0].requests, 1, '非 key 字段保留');
  });

  delete process.env.CONFIG_FILE;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

  console.log(`config.test: ${12 - failures} pass / ${failures} fail`);
  return failures === 0;
};
