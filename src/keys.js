/**
 * keys.js — 外部接入 key（ingress key）管理
 *
 * 提供「baseURL + key」形态的外部服务接入:
 *   客户端 baseURL 指向本服务的 /v1,携带 Authorization: Bearer <key>
 *   （或 x-api-key: <key>）调用。本模块只管入口这一层,
 *   与 config.json 里上游 provider 的 key 完全无关。
 *
 *  设计要点:
 *  - key 形如 sk-elp-<32 字节 base64url>,**只在创建时返回一次**
 *  - 落盘只存 HMAC-SHA256 摘要（签名密钥 keys-secret,0600）,
 *    即使密钥文件泄露也不会直接得到可用的 key
 *  - 未创建任何 key 时 = 开放模式（保留旧的仅内网自用行为）,
 *    启动打警告;创建第一个 key 后立即强制校验（fail closed）
 *  - **强制状态持久化**:启用过就永久强制,全部吊销后**仍是强制**。
 *    否则「想禁用某个外部用户」会意外变成「向全网开放」。
 *    回到开放模式请删除 keys.json,或设 OPEN_ACCESS=1
 *  - revoke 即时生效:从内存索引删除,不等落盘
 *  - touch() 惰性更新计数/最后使用时间,批量节流落盘（每 N 次写一次）
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STORE_FILE = process.env.KEYS_FILE || '/etc/easy-llm-proxy/keys.json';
const SECRET_FILE = process.env.KEYS_SECRET_FILE || path.join(path.dirname(STORE_FILE), 'keys-secret');
const PREFIX = 'sk-elp-';
const KEY_BYTES = 32;                 // 随机字节数（256bit）
const KEY_CHARS = Math.ceil(KEY_BYTES * 8 / 6); // base64url 字符数 = 43
const KEY_MIN = 20;                   // 校验长度下限（防空串/明显错误的快速失败）
const KEY_MAX = 256;                  // 校验长度上限（防恶意超长字符串拖垮比较）
const TOUCH_EVERY = 10;               // 每 N 次调用落盘一次计数（避免每请求同步写盘）
const MAX_KEYS = 200;                 // 单实例 key 上限（防误操作刷爆文件）

/* ---------------- 签名密钥（与 auth.js 同一模式:持久化,重启后历史 key 仍有效） ---------------- */
let _secret = null;
function getSecret() {
  if (_secret) return _secret;
  try {
    const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (s) { _secret = s; return _secret; }
  } catch {}
  _secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
    fs.writeFileSync(SECRET_FILE, _secret, { mode: 0o600 });
  } catch { /* 写失败仍用内存密钥:进程内可用,重启后 key 需重建 */ }
  return _secret;
}

/* ---------------- 存储 ---------------- */
let store = null;   // { version, keys: [...] }
let dirty = 0;      // 未落盘的计数更新次数

function readStore() {
  try {
    const j = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (j && Array.isArray(j.keys)) return j;
  } catch {}
  return null;
}

function load() {
  if (store) return store;
  const j = readStore();
  store = j || { version: 1, keys: [] };
  return store;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
    const tmp = STORE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(load(), null, 2), { mode: 0o600 }); // 含 key 摘要,仅属主可读
    fs.renameSync(tmp, STORE_FILE);
    invalidateIndex(); // 索引按 hash 重建,保证 revoke 后立即失效
  } catch (e) { console.error('[keys] 落盘失败:', e && (e.message)); }
}

/* ---------------- key 生成 / 摘要 ---------------- */
function makeKey() {
  return PREFIX + crypto.randomBytes(KEY_BYTES).toString('base64url');
}

function hashKey(key) {
  return crypto.createHmac('sha256', getSecret()).update(String(key)).digest('hex');
}

function makeId() {
  return 'k_' + crypto.randomBytes(8).toString('base64url').slice(0, 11);
}

/** 脱敏展示: sk-elp-AbCd…wxyz（仅首尾 4 位,足够区分,不足以冒用） */
function mask(key) {
  const body = String(key).startsWith(PREFIX) ? String(key).slice(PREFIX.length) : String(key);
  if (body.length <= 8) return PREFIX + body.slice(0, 2) + '…';
  return PREFIX + body.slice(0, 4) + '…' + body.slice(-4);
}

/* hash -> record 索引（懒加载;变更时 invalidate 后重建,保证 revoke 即时失效） */
let _idxBuilt = false;
let _idxMap = null;
function index() {
  if (!_idxBuilt) {
    _idxMap = new Map();
    for (const k of load().keys) {
      if (!k.revoked) _idxMap.set(k.hash, k);
    }
    _idxBuilt = true;
  }
  return _idxMap;
}
function invalidateIndex() { _idxBuilt = false; }

/* ---------------- 对外 API ---------------- */

/**
 * 是否强制校验。
 * 一旦创建过 key 就永久强制(fail closed)——全部吊销后**不会**把公网服务静默切回开放,
 * 否则「想禁用某个外部用户」会意外变成「向全网开放」。
 * 需要回到开放模式(仅本地自用场景)请删除 keys.json,或设 OPEN_ACCESS=1 强制开放。
 */
function isEnforced() {
  if (process.env.OPEN_ACCESS === '1') return false;
  const s = load();
  return s.enforced === true || s.keys.some((k) => !k.revoked);
}

/** 有效 key 数量 */
function activeCount() {
  return load().keys.filter((k) => !k.revoked).length;
}

/** 校验入口 key;成功返回记录（含 name/id）,失败返回 null */
function verify(key) {
  if (typeof key !== 'string') return null;
  const k = key.trim();
  if (k.length < KEY_MIN || k.length > KEY_MAX) return null;
  if (!k.startsWith(PREFIX)) return null;   // 前缀先比对,绝大多数错误请求在此短路
  const h = hashKey(k);
  const rec = index().get(h) || null;
  if (!rec) return null;
  touch(rec.id);
  return rec;
}

/** 计数/最后使用时间（惰性节流落盘） */
function touch(id, tokens = 0) {
  const k = load().keys.find((x) => x.id === id);
  if (!k || k.revoked) return;
  k.reqs = (k.reqs || 0) + 1;
  k.tokens = (k.tokens || 0) + Number(tokens || 0);
  k.lastUsed = Date.now();
  if (++dirty >= TOUCH_EVERY) { dirty = 0; save(); }
}

/** 创建 key。返回 { id, key, name, prefix, created }（key 仅此处可见） */
function create(name) {
  const s = load();
  if (s.keys.filter((k) => !k.revoked).length >= MAX_KEYS) {
    return { ok: false, reason: 'too_many', message: `key 数量已达上限 ${MAX_KEYS}` };
  }
  const key = makeKey();
  const now = Date.now();
  const rec = {
    id: makeId(),
    name: String(name || '').trim().slice(0, 64) || '默认 key',
    hash: hashKey(key),
    prefix: mask(key),          // 持久化脱敏标识:列表能区分 key,又不泄露可用片段
    created: new Date(now).toISOString(),
    lastUsed: 0,
    reqs: 0,
    tokens: 0,
    revoked: false,
  };
  s.keys.push(rec);
  s.enforced = true;   // 一旦启用 key 接入就永久强制,吊销全部 key 也不会退回开放模式
  save();
  return { ok: true, id: rec.id, key, name: rec.name, prefix: rec.prefix, created: rec.created };
}

/** 吊销:即时生效（从索引移除）+ 落盘留痕 */
function revoke(id) {
  const s = load();
  const k = s.keys.find((x) => x.id === id);
  if (!k) return { ok: false, reason: 'not_found', message: 'key 不存在' };
  if (k.revoked) return { ok: false, reason: 'already', message: '已吊销' };
  k.revoked = true;
  k.revokedAt = Date.now();
  save();
  return { ok: true, id };
}

/** 列出（脱敏:完整 key 创建后即丢弃,哈希不可逆,列表以 name/created 区分） */
function list() {
  const s = load();
  return s.keys
    .slice()
    .sort((a, b) => (b.created || '').localeCompare(a.created || ''))
    .map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix || '',
      created: k.created,
      lastUsed: k.lastUsed || 0,
      reqs: k.reqs || 0,
      tokens: k.tokens || 0,
      revoked: !!k.revoked,
      revokedAt: k.revokedAt || 0,
    }));
}

/** 统计快照（面板/健康检查用） */
function summary() {
  const s = load();
  const act = s.keys.filter((k) => !k.revoked);
  return {
    enforced: isEnforced(),
    active: act.length,
    revoked: s.keys.length - act.length,
    totalReqs: act.reduce((n, k) => n + (k.reqs || 0), 0),
    totalTokens: act.reduce((n, k) => n + (k.tokens || 0), 0),
    storeFile: STORE_FILE,
  };
}

/* 进程退出前把计数刷盘（token 统计不至于丢） */
process.on('exit', () => { if (dirty > 0) save(); });

module.exports = {
  PREFIX, KEY_MIN, KEY_MAX, MAX_KEYS,
  STORE_FILE, SECRET_FILE,
  makeKey, hashKey, mask,
  isEnforced, activeCount, verify, touch,
  create, revoke, list, summary,
  _load: load,
};
