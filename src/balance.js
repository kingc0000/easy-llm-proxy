/**
 * balance.js — per-key 降级链引擎(easy-llm-proxy 核心)
 *
 * 规则:
 *  - 每 provider 多个 model,每个 model 配置 weight(1-100,越大越优先) + keys(多 key)
 *  - 第一权重(主 model): 全部 key 都限流 → 主 model 进入冷却,切到第二权重;第二权重也全部
 *    限流 → 重新尝试主 model(冷却已过则恢复);仍限流 → 第三权重…以此类推。
 *    尝试顺序 = [主, 备2, 主(重试), 备3, 主(重试), …, 备N, 主(兜底重试)],
 *    冷却中的 (model,key) 自动跳过,因此主 model 冷却期内重试层为空、自然落到下一层。
 *    主 model 一旦成功 → 立即解除降级,回到「主要用主 model」的状态。
 *  - **per-key 降级状态**: 某层全部 key 失败 → 这些 key 各自记录降级(到下一权重 model);
 *    其他 key 不受影响继续用主 model(单 key 限流不拖累全局)
 *  - 降级 key 在降级 model 使用达到 成功次数(usageLimit) 或 时长(useSeconds) 任一限制后
 *    **切回主 model 继续轮询**(到期清理);次数 = 成功返回的次数(2xx)
 *  - 回主后若主仍全部限流 → 重新降级到下一权重;最低权重也全失败 → 清态回主(循环)
 *  - 每 model 的 key 池策略(两种,由 provider.roundRobin 选择):
 *    · 超限轮询(默认,roundRobin=false): key 用到限流/失败才切 → 进入冷却期(冷却粒度 (model,key),
 *      因限流多为 model 级);队列指针轮转 + 冷却跳过: 从最近失败 key 的下一个起按序试,冷却中的
 *      (model,key) 跳过;同层全部冷却 → 自动降级到下一权重 model2。
 *      冷却时长三层: 全局 DEFAULT_COOLDOWN_MS → model.cooldown → model.keyCooldowns[key]。
 *    · 平均轮询(roundRobin=true): 每请求严格轮换到下一个 key(平滑分摊),仍按权重层聚合,
 *      失败同样 advanceKey(冷却粒度同上),成功时记录 lastKey 作为下次轮转起点。
 *
 * 状态(state) 按 provider 持久(内存),跨请求共享:
 *   { degraded: Map<key,{modelId,since,success}>,
 *     failAt: Map<"modelId\0key",timestamp>, lastKey: string|null, lastFail: string|null }
 */
const DEFAULT_COOLDOWN_MS = 60 * 1000; // 默认冷却期(可被 model.cooldown / key 覆盖)
'use strict';

/** 按权重降序(同权重保持配置顺序) */
function modelsSorted(p) {
  return [...p.models].sort((a, b) => b.weight - a.weight);
}

/** 主 model = 权重最高 */
function mainModel(p) {
  return modelsSorted(p)[0];
}

/** 初始状态 */
function newState() {
  return { degraded: new Map(), failAt: new Map(), lastKey: null, lastFail: null };
}

function modelOf(p, id) {
  return p.models.find((x) => x.id === id) || null;
}

/** 某 key 降级是否到期(成功次数或时长任一达标 → 切回主) */
function keyDegradedDue(p, d) {
  if (!d) return false;
  const m = modelOf(p, d.modelId);
  if (!m) return true;
  const limitOk = m.usageLimit != null && m.usageLimit > 0 && d.success >= m.usageLimit;
  const timeOk = m.useSeconds != null && m.useSeconds > 0 && (Date.now() - d.since) >= m.useSeconds * 1000;
  return limitOk || timeOk;
}

/** 某 model 的下一个候选(降级目标): 同权重兄弟优先, 之后严格更低权重 */
function nextLower(p, modelId) {
  const sorted = modelsSorted(p);
  const idx = sorted.findIndex((x) => x.id === modelId);
  if (idx < 0) return null;
  const base = sorted[idx].weight;
  for (let i = idx + 1; i < sorted.length; i++) {
    if (sorted[i].weight === base) return sorted[i]; // 同权重兄弟(配置顺序)
  }
  for (let i = idx + 1; i < sorted.length; i++) {
    if (sorted[i].weight < base) return sorted[i];   // 严格更低权重
  }
  return null;
}

/** 冷却时长(秒→ms): key 覆盖 → model.cooldown → 全局默认 */
function cooldownMs(p, modelId, key) {
  const m = modelOf(p, modelId);
  if (m) {
    if (m.keyCooldowns && Number.isFinite(m.keyCooldowns[key]) && m.keyCooldowns[key] > 0) return m.keyCooldowns[key] * 1000;
    if (Number.isFinite(m.cooldown) && m.cooldown > 0) return m.cooldown * 1000;
  }
  return DEFAULT_COOLDOWN_MS;
}
/** 该 (modelId,key) 是否处于冷却期 */
function inCooldown(p, st, modelId, key) {
  const ts = st.failAt.get(modelId + '\0' + key);
  return !!ts && (Date.now() - ts) < cooldownMs(p, modelId, key);
}

/** 全部 key(去重,保持配置顺序) */
function allKeys(p) {
  const s = new Set();
  for (const m of p.models) for (const k of m.keys) s.add(k);
  return [...s];
}

/**
 * 生成尝试计划(候选列表,顺序即尝试顺序)。
 *  1) 先清理到期的 per-key 降级态(次数/时长达标 → 切回主)
 *  2) 每 key 一条链: 默认从主(或请求 model)起;仅当该 key 已降级且主 model 对它仍在冷却时,
 *     才从降级 model 起 —— 即主 model 冷却一过,降级 key 立刻回到主 model 重试(主要用主)
 *  3) 按权重层聚合,并在每层更低权重之间穿插主 model 重试层:
 *     [主, 备2, 主(重试), 备3, 主(重试), …, 备N, 主(兜底重试)]
 *     冷却中的 (model,key) 不进候选 —— 主 model 冷却期内其重试层为空、自动跳过。
 *  4) 连续同权重空层去重,避免无意义的重复尝试
 */
function plan(p, st, requestedId) {
  const sorted = modelsSorted(p);

  // 1) 到期清理(次数/时长达标 → 切回主);调用方 diff 前后 Map 记 recover 事件
  for (const [k, d] of [...st.degraded]) {
    if (keyDegradedDue(p, d)) st.degraded.delete(k);
  }

  const main = mainModel(p);
  const req = requestedId ? modelOf(p, requestedId) : null;
  const primary = req || main;

  // 2) 每 key 链(无兜底: 最低层失败由 degrade 清态回主处理);
  //    key 顺序 = 队列指针轮转一圈:
  //      超限模式从 lastFail(最近失败 key)的下一个起;平均模式从 lastKey(上次成功)的下一个起。
  //    冷却中的 (model,key) 在层聚合时跳过(不进候选),全冷却则自动降下一层。
  const baseKeys = allKeys(p);
  const rotate = (anchor) => {
    const i = anchor ? baseKeys.indexOf(anchor) : -1;
    const s = (i + 1) % baseKeys.length;
    return baseKeys.slice(s).concat(baseKeys.slice(0, s));
  };
  const keys = rotate(p.roundRobin ? st.lastKey : st.lastFail);
  const chainOf = (key) => {
    const d = st.degraded.get(key);
    // 主 model 对该 key 仍在冷却 → 从降级 model 起;否则回主(冷却一过立即恢复)
    const start = (d && inCooldown(p, st, primary.id, key)) ? (modelOf(p, d.modelId) || main) : primary;
    const seq = [];
    const seen = new Set();
    const add = (m) => { if (m && !seen.has(m.id)) { seen.add(m.id); seq.push(m); } };
    let w = start.weight;
    for (;;) {
      const layer = sorted.filter((m) => m.weight === w); // 同权重层
      if (layer.some((m) => m.id === start.id)) { add(start); layer.filter((m) => m.id !== start.id).forEach(add); }
      else layer.forEach(add);
      const lower = sorted.find((m) => m.weight < w);     // 下一层更低权重
      if (!lower) break;
      w = lower.weight;
    }
    return seq;
  };

  // 3) 层顺序 = 每层更低权重之间穿插主 model 重试,末尾再兜一次主:
  //    [w1, w2, w1, w3, w1, …, wn, w1]
  const weights = [...new Set(sorted.map((m) => m.weight))].sort((a, b) => b - a);
  const pw = primary.weight;
  const order = [];
  for (let i = 0; i < weights.length; i++) {
    order.push(weights[i]);
    if (weights[i] !== pw && i < weights.length - 1) order.push(pw); // 每层之间重试主
  }
  if (order.length && order[order.length - 1] !== pw) order.push(pw); // 末尾兜底重试主

  // 4) 按层聚合(层顺序 × key 依序);空层跳过;连续同层(中间层全空)去重
  const out = [];
  let lastW = null;
  for (const w of order) {
    if (w === lastW) continue;
    let added = 0;
    for (const key of keys) {
      const mAtW = chainOf(key).find((m) => m.weight === w);
      if (mAtW && !inCooldown(p, st, mAtW.id, key)) { out.push({ modelId: mAtW.id, key }); added++; }
    }
    if (added) lastW = w;
  }
  return out;
}

/** 失败时记录该 (modelId,key) 的失败时间(进入冷却期) → 冷却期内该候选被跳过,过期重新可用;
 *  并推进队列指针到该 key 的下一个(超限模式: 失败才前进,下次请求从它后面起)。 */
function advanceKey(st, modelId, key) {
  st.failAt.set(modelId + '\0' + key, Date.now());
  st.lastFail = key;
}

/** 结果回报: 降级期间某 key 的 2xx 成功计数(达 usageLimit 到期回主);
 *  平均轮询模式下成功时记 lastKey(下次请求轮转起点)。
 *  成功即解除该 (model,key) 的冷却;主 model 成功 → 立即解除该 key 的降级(主要用主)。 */
function report(p, st, modelId, key, ok) {
  if (!ok) return;
  st.failAt.delete(modelId + '\0' + key);
  if (modelId === mainModel(p).id) st.degraded.delete(key);
  const d = st.degraded.get(key);
  if (d && d.modelId === modelId) d.success++;
  if (p.roundRobin) st.lastKey = key;
}

/**
 * 某权重层的全部 key 都尝试失败(proxy 判定) → per-key 设置/更新降级态到下一权重。
 *  - 有更低权重: keys 全部降级到 nextLower(更深链式降级)
 *  - 已是最低权重: 清除这些 keys 的降级态(回主,下次从主重试)
 * 返回 { toModel } 供事件记录。
 */
function degrade(p, st, failedModelId, keys) {
  const lower = nextLower(p, failedModelId);
  if (!lower) {
    // 已是最低权重 → 清除这些 keys 的降级态(兜底回主,下次从主重试);cleared 供恢复事件
    let cleared = 0;
    for (const k of keys) { if (st.degraded.delete(k)) cleared++; }
    return { toModel: null, cleared };
  }
  for (const k of keys) st.degraded.set(k, { modelId: lower.id, since: Date.now(), success: 0 });
  return { toModel: lower.id, cleared: 0 };
}

/** 总尝试上限(防死循环): 层聚合含主 model 穿插重试,候选最长 ≈ keys × (2×models),留余量 */
function maxAttempts(p) {
  const ks = allKeys(p).length;
  return ks * p.models.length * 2 + ks;
}

/** 兼容旧调用: 某 key 降级是否到期 */
function degradedDue(p, d) { return keyDegradedDue(p, d); }

module.exports = { modelsSorted, mainModel, newState, plan, report, degrade, maxAttempts, degradedDue, advanceKey };
