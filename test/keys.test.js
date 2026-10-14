/**
 * keys.test.js — 外部接入 key(baseURL + key)模块级测试
 *
 * 覆盖:
 *  生成格式/校验(正误短空前缀)、名称归一化、落盘只存哈希 + 600 权限、
 *  吊销即时失效、**强制状态持久化(fail closed:吊销全部 key 也不退回开放)**、
 *  进程重启后 key 仍有效、OPEN_ACCESS 逃生开关、计数与节流落盘、脱敏列表、上限。
 *
 * 用法: node test/keys.test.js (单跑) / 由 test/run.js 聚合运行
 */
'use strict';
const fs = require('fs');
const path = require('path');

const TMP = path.join(__dirname, '.tmp-keys-test');
process.env.KEYS_FILE = path.join(TMP, 'keys.json');
process.env.KEYS_SECRET_FILE = path.join(TMP, 'keys-secret');
delete process.env.OPEN_ACCESS;

const MOD = require.resolve('../src/keys');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  OK', msg); }
  else { fail++; console.log('  FAIL', msg); }
}
/** 全新存储 + 清空模块缓存(初始态测试) */
function fresh() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  delete require.cache[MOD];
  return require('../src/keys');
}
/** 仅清空模块缓存,保留磁盘存储(模拟进程重启后的持久化) */
function reload() {
  delete require.cache[MOD];
  return require('../src/keys');
}

function run() {
  return new Promise((resolve) => {
    (async () => {
      // ================= 1. 初始态: 未创建任何 key -> 开放模式 =================
      let KK = fresh();
      ok(KK.isEnforced() === false, '空库不强制(开放模式)');
      ok(KK.activeCount() === 0, '空库有效数为 0');
      ok(KK.list().length === 0, '空库列表为空');
      ok(KK.verify('sk-elp-' + 'a'.repeat(43)) === null, '空库校验任何 key 都不通过');

      // ================= 2. 生成与校验 =================
      const r1 = KK.create('外部用户A');
      ok(r1.ok === true, '创建返回 ok');
      ok(r1.key.startsWith('sk-elp-'), 'key 前缀 sk-elp-');
      ok(r1.key.length === 50, 'key 长度 50(7 前缀 + 43 随机字符)');
      ok(r1.key.slice(7).match(/^[\w._-]{43}$/), 'key 主体为 43 位 base64url');
      ok(r1.id.startsWith('k_'), 'id 前缀 k_');
      ok(KK.isEnforced() === true, '创建后强制开启');
      ok(!!KK.verify(r1.key) && KK.verify(r1.key).name === '外部用户A', '正确 key 校验通过并带 name');

      ok(KK.verify(r1.key + 'x') === null, '错误尾缀不通过');
      ok(KK.verify(r1.key.slice(0, -1)) === null, '截断一位不通过');
      ok(KK.verify('sk-elp-tooshort') === null, '短串不通过');
      ok(KK.verify('sk-other-' + 'a'.repeat(43)) === null, '空前缀不通过');
      ok(KK.verify('sk-elp-' + 'a'.repeat(43)) === null, '格式对但哈希不存在不通过');
      ok(KK.verify('sk-elp-' + 'a'.repeat(260)) === null, '超长串不通过');
      ok(KK.verify(null) === null && KK.verify('') === null && KK.verify(undefined) === null
         && KK.verify(123) === null && KK.verify({}) === null, 'null/空/非字符串不通过');

      // ================= 3. 名称归一化 =================
      const r2 = KK.create('  带空格名  ');
      ok(r2.ok && r2.name === '带空格名', '名称 trim 前后空格');
      const r3 = KK.create('x'.repeat(80));
      ok(r3.ok && r3.name.length === 64, '名称截断 64 字符');
      const r4 = KK.create('   ');
      ok(r4.ok && r4.name === '默认 key', '纯空格名回退默认 key');

      // ================= 4. 落盘安全 =================
      ok(/^sk-elp-.{4}…/.test(r1.prefix), 'prefix 形态 sk-elp-xxxx…');
      const store = JSON.parse(fs.readFileSync(TMP + '/keys.json', 'utf8'));
      ok(!store.keys.some((k) => 'key' in k), '落盘无完整 key 字段');
      ok(store.keys.every((k) => /^[0-9a-f]{64}$/.test(k.hash)), '落盘只有 HMAC 哈希(64 hex)');
      ok(store.enforced === true, '落盘持久化 enforced 标记');
      ok((fs.statSync(TMP + '/keys.json').mode & 0o777) === 0o600, 'keys.json 权限 600');
      ok((fs.statSync(TMP + '/keys-secret').mode & 0o777) === 0o600, 'keys-secret 权限 600');
      ok(!store.keys.some((k) => k.prefix === r1.key), 'prefix 不等于完整 key');

      // ================= 5. 吊销即时失效 + fail closed =================
      ok(KK.activeCount() === 4, '四个 key 全部有效');
      ok(KK.revoke(r1.id).ok === true, '吊销返回 ok');
      ok(KK.verify(r1.key) === null, '吊销后立即失效');
      ok(KK.activeCount() === 3, '吊销一个后剩余 3 个有效');
      ok(KK.isEnforced() === true, '吊销后仍强制(不退回开放)');
      ok(KK.revoke(r1.id).reason === 'already', '重复吊销 -> already');
      ok(KK.revoke('k_none').reason === 'not_found', '吊销不存在 -> not_found');

      // 全部吊销 -> 仍强制(fail closed 的核心保证)
      for (const r of [r2, r3, r4]) KK.revoke(r.id);
      ok(KK.activeCount() === 0, '全部吊销后有效数为 0');
      ok(KK.isEnforced() === true, '全部吊销后仍然强制(fail closed,不会因最后一个 key 消失而向全网开放)');
      ok(KK.verify(r2.key) === null, '全部吊销后旧 key 全部失效');

      // ================= 6. 进程重启后持久化 =================
      KK = reload();
      ok(KK.isEnforced() === true, '重启后仍强制(enforced 标记从磁盘恢复)');
      ok(KK.activeCount() === 0, '重启后有效数仍为 0');
      ok(KK.verify(r1.key) === null && KK.verify(r4.key) === null, '重启后已吊销 key 仍失效');
      ok(fs.statSync(TMP + '/keys-secret').size > 0, '签名密钥文件跨重启保留(历史 key 不必重建)');

      // ================= 7. 计数与节流落盘 =================
      const c1 = KK.create('计数测试');
      const before30 = fs.statSync(TMP + '/keys.json').mtimeMs;
      const got0 = KK.list().find((k) => k.id === c1.id);
      ok(got0 && got0.reqs === 0 && got0.tokens === 0, '新建 key 计数为 0');
      KK.touch(c1.id, 0);   // 第 1 次 touch, 不消耗 token
      const got1 = KK.list().find((k) => k.id === c1.id);
      ok(got1 && got1.reqs === 1 && got1.tokens === 0, '单次 touch 计 1 次请求, token 不变');
      for (let i = 0; i < 29; i++) KK.touch(c1.id, 3);   // 共 30 次, 每 10 次触发一次落盘
      const got = KK.list().find((k) => k.id === c1.id);
      ok(got && got.reqs === 30 && got.tokens === 87, '30 次 touch 累计 reqs=30 tokens=87(首次 touch 传 0)');
      ok(fs.statSync(TMP + '/keys.json').mtimeMs >= before30, '超节流阈值后落盘成功');
      const persisted = JSON.parse(fs.readFileSync(TMP + '/keys.json', 'utf8'))
        .keys.find((k) => k.id === c1.id);
      ok(persisted && persisted.reqs === 30 && persisted.tokens === 87, '落盘后的计数正确持久化');
      ok(persisted && !!persisted.lastUsed, '落盘记录 lastUsed 时间戳');

      // ================= 8. 摘要与脱敏列表 =================
      const s = KK.summary();
      ok(s.active === 1 && s.revoked === 4, 'summary active=1 revoked=4');
      ok(typeof s.totalReqs === 'number' && s.totalReqs >= 16, 'summary 累计请求正确');
      ok(typeof s.totalTokens === 'number' && s.totalTokens >= 48, 'summary 累计 token 正确');
      const list = KK.list();
      ok(list.length === 5, '列表含 5 条记录');
      ok(list.every((k) => !('key' in k) && !('hash' in k)), '列表不含 key/hash');
      ok(list.every((k) => typeof k.prefix === 'string' && k.prefix.startsWith('sk-elp-')), '列表含脱敏 prefix');
      ok(list.some((k) => k.revoked === true), '列表保留吊销记录');
      ok(list.every((k, i) => i === 0 || list[i - 1].created >= k.created), '列表按创建时间倒序');
      ok(KK.isEnforced() === true, '有 key 时强制');

      // ================= 9. OPEN_ACCESS 逃生开关 =================
      process.env.OPEN_ACCESS = '1';
      KK = reload();
      ok(KK.isEnforced() === false, 'OPEN_ACCESS=1 时强制关闭(本地自用场景)');
      delete process.env.OPEN_ACCESS;

      // ================= 10. 上限 =================
      KK = fresh();
      const limit = KK.MAX_KEYS;
      for (let i = 0; i < limit; i++) KK.create('批量' + i);
      ok(KK.activeCount() === limit, '上限内可创建 ' + limit + ' 个');
      const overflow = KK.create('溢出');
      ok(overflow.ok === false && overflow.reason === 'too_many', '达到上限后拒绝创建');
      ok(KK.activeCount() === limit, '溢出尝试未增加有效数');

      fs.rmSync(TMP, { recursive: true, force: true });
      console.log('keys.test: ' + pass + ' pass / ' + fail + ' fail');
      resolve(fail === 0);
    })()
      .catch((e) => { console.error(e); resolve(false); });
  });
}

module.exports = { run };

if (require.main === module) {
  run().then((okc) => process.exit(okc ? 0 : 1));
}
