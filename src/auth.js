/**
 * auth.js — 登录鉴权(Web 面板用)
 *
 *  - 凭证存 auth.json {username, salt, hash}(scrypt 哈希,600 权限)
 *  - 登录成功签发会话 token(内存,默认 7 天);管理 API 用 X-Admin-Token 携带
 *  - 登录失败限速(1 分钟内失败超过 5 次锁 60s,防暴力猜解)
 *  - 支持修改用户名/密码(需旧密码),修改后全部会话失效重新登录
 *
 * 初始化: auth.json 不存在时,由部署流程以 AUTH_USER/AUTH_PASS(或手动)创建;
 *         未初始化时登录被拒,提示管理员初始化(不提供默认弱口令)。
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const AUTH_FILE = process.env.AUTH_FILE || '/etc/easy-llm-proxy/auth.json';
const SESSION_HOURS = parseInt(process.env.SESSION_HOURS || '168', 10); // 会话有效期(小时)
const LOCK_FAILS = 5;                      // 连续失败次数
const LOCK_MS = 60 * 1000;                 // 锁定时长
const DEFAULT_USER = 'admin';               // 公开默认账号(仅首次初始化无 auth.json 时使用)
const DEFAULT_PASS = 'admin123';

function hashPassword(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 64).toString('hex');
}

function makeHash(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + hashPassword(pw, salt);
}

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    if (j && typeof j.username === 'string' && typeof j.hash === 'string') return j;
  } catch {}
  return null;
}

let CRED = load();
// 无状态会话 token: HMAC-SHA256(secret, 过期时间) 签名,不依赖内存;
// secret 持久化到 auth-secret(600),服务重启后已签发 token 仍有效(不会掉登录);
// 修改账号密码时轮换 secret → 全部历史 token 立即失效(保持原语义)
const SECRET_FILE = process.env.SECRET_FILE || path.join(path.dirname(AUTH_FILE), 'auth-secret');
let _secret = null;
function getSecret() {
  if (_secret) return _secret;
  try { _secret = fs.readFileSync(SECRET_FILE, 'utf8').trim(); if (_secret) return _secret; } catch {}
  _secret = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(SECRET_FILE, _secret, { mode: 0o600 }); } catch {}
  return _secret;
}
function bumpSecret() {
  _secret = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(SECRET_FILE, _secret, { mode: 0o600 }); } catch {}
}
function makeToken(expMs) {
  const expHex = expMs.toString(16);
  return expHex + '.' + crypto.createHmac('sha256', getSecret()).update(expHex).digest('hex');
}
let failCount = 0;
let lockUntil = 0;

/** 刷新凭证: 登录/改密前重读文件(支持外部创建/热更新 auth.json) */
function refresh() {
  const c = load();
  if (c) CRED = c; // 文件被删时保留内存凭证,防锁死
}

/** 初始化账号文件(仅首次创建;已存在不覆盖)
 *  默认 admin/admin123(公开默认),服务实例实际账号通过
 *  手动创建 auth.json 或启动时 AUTH_USER / AUTH_PASS 指定。 */
function init(user, pass) {
  if (CRED) return false;
  const u = String(user || process.env.AUTH_USER || DEFAULT_USER).trim();
  const p = String(pass || process.env.AUTH_PASS || DEFAULT_PASS);
  if (!u || !p) return false;
  CRED = { username: u, hash: makeHash(p) };
  save();
  return true;
}

function login(username, pw) {
  refresh();
  const now = Date.now();
  if (now < lockUntil) return { ok: false, reason: 'locked', retryAfter: Math.ceil((lockUntil - now) / 1000) };
  if (!CRED) return { ok: false, reason: 'no_account' };
  const salt = CRED.hash.split(':')[0];
  const expected = CRED.hash.split(':')[1];
  const actual = hashPassword(pw, salt);
  const okUser = typeof username === 'string' && username === CRED.username;
  const okPass = expected && crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
  if (!okUser || !okPass) {
    failCount++;
    if (failCount >= LOCK_FAILS) { lockUntil = now + LOCK_MS; failCount = 0; }
    return { ok: false, reason: 'bad' };
  }
  failCount = 0;
  const token = makeToken(now + SESSION_HOURS * 3600 * 1000);
  const weak = CRED.username === DEFAULT_USER && String(pw) === DEFAULT_PASS; // 默认口令提示改密
  return { ok: true, token, username: CRED.username, weak };
}

/** 会话校验(惰性清理过期) */
function check(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [expHex, sig] = parts;
  if (!/^[0-9a-f]+$/.test(expHex) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const exp = parseInt(expHex, 16);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  const expected = crypto.createHmac('sha256', getSecret()).update(expHex).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
}

/** 修改账号: 需旧密码;改用户名/密码后全部会话失效 */
function update(oldPassword, newUsername, newPassword) {
  refresh();
  if (!CRED) return { ok: false, reason: 'no_account' };
  const salt = CRED.hash.split(':')[0];
  const expected = CRED.hash.split(':')[1];
  const actual = hashPassword(String(oldPassword || ''), salt);
  if (!expected || !crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))) {
    return { ok: false, reason: 'old_password_wrong' };
  }
  let username = CRED.username;
  let hash = CRED.hash;
  let changed = false;
  if (typeof newUsername === 'string' && newUsername.trim() && newUsername.trim() !== CRED.username) {
    username = newUsername.trim();
    changed = true;
  }
  if (typeof newPassword === 'string' && newPassword.trim()) {
    hash = makeHash(newPassword.trim());
    changed = true;
  }
  if (!changed) return { ok: false, reason: 'nothing_changed' };
  CRED = { username, hash };
  save();
  bumpSecret(); // 轮换签名密钥 → 全部历史 token 立即失效,重新登录
  return { ok: true, username };
}

function save() {
  try {
    fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
    const tmp = AUTH_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(CRED, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, AUTH_FILE);
  } catch { /* 凭证写失败不阻塞主流程(登录仍可鉴权) */ }
}

module.exports = { init, login, check, update, AUTH_FILE };