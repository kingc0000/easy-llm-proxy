/**
 * balance.js — 降级链引擎(easy-llm-proxy 核心)
 *
 * 决策树(用户约定):
 *  - 每个请求按权重层生成候选: m1(主,权重最高) 层全部 key → m2 层 → m3 层 → …,
 *    冷却中的 (model,key) 跳过;某层全冷却 → 该层为空,自动落到下一可用层。
 *  - 同层 key 逐个尝试(轮转起点见下),层内全失败 / 达 usageLimit 任一条件 → **回主**:
 *    清除降级态,下轮重新从主 model 层开始。
 *  - 主 model 全失败 → 降级: key 标记到主 model 的下一权重层(m2);若 m2 也在冷却期,
 *    层聚合时 m2 层为空 → 自动落到 m3,依此类推(m2 冷却=0 即无冷却,回主后立刻可再试 m2)。
 *  - 往复: m3 全失败 / 达限 → 回主 → 主全失败 → 看 m2 冷却 → m2 或 m3 → …循环。
 *  - 关键: **非主层失败总是回主,不检查主冷却**(主冷却由 plan() 的 inCooldown 跳过处理);
 *    **达限也总是回主**(不再因主冷却未过而下探)。旧实现的"主冷却中→整层下探一层"
 *    会让 m2 失败后绕开主 model 直接下探 m3,违反本决策树。
 *  - 降级达限判定 **per-key**: 组内达限的 key 单独回主,不被"从未达限"的 key 阻塞
 *    (旧实现整组 every 判定,会因某 key 在降级层一直 429 无成功而拖死整组永不回主)。
 *  - 每 model 的 key 池策略(两种,由 provider.roundRobin 选择):
 *    · 超限轮询(默认,roundRobin=false): key 用到限流/失败才切 → 进入冷却期(冷却粒度 (model,key),
 *      因限流多为 model 级);队列指针从最近失败 key 的下一个起,冷却中的 (model,key) 跳过。
 *    · 平均轮询(roundRobin=true): 每请求严格轮换到下一个 key(平滑分摊),
 *      成功时记录 lastKey 作为下次轮转起点。
 *  - 冷却时长三层: 全局 DEFAULT_COOLDOWN_MS → model.cooldown → model.keyCooldowns[key]。
 *    **cooldown = 0 表示无冷却**(0 不被当作"未配置";仅缺失/null 才回退全局默认)。
 *
 * 状态(state) 按 provider 持久(内存),跨请求共享:
 *   { degraded: Map<key,{modelId,since,success}>,
 *     failAt: Map<"modelId\0key",timestamp>, lastKey: string|null, lastFail: string|null }
 */
const DEFAULT_COOLDOWN_MS = 60 * 1000; // 默认冷却期(可被 model.cooldown / key 覆盖;0=无冷却)
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

/** 冷却时长(秒→ms): key 覆盖 → model.cooldown → 全局默认;0 = 无冷却 */
function cooldownMs(p, modelId, key) {
  const m = modelOf(p, modelId);
  if (m) {
    if (m.keyCooldowns && Number.isFinite(m.keyCooldowns[key]) && m.keyCooldowns[key] >= 0) return m.keyCooldowns[key] * 1000;
    if (Number.isFinite(m.cooldown) && m.cooldown >= 0) return m.cooldown * 1000;
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
 *  1) 到期清理(次数/时长达标),**整层统一**: 同一降级目标的全部 key 都达限才切换——
 *     主 model 已过冷却 → 整层回主;主仍在冷却 → 整层下探一层(如 m2→m3,重新起降级期);
 *     无更低层 → 清态回主;本层还有 key 未达限 → 整层保持不动(不提前切)
 *  2) 每 key 一条链: 降级中从降级 model 起,否则从主(或请求 model)起;链内按权重降序(同权重兄弟)
 *     → 降级 key 在降级期用完之前一直留在当前降级 model(不因主冷却过期而提前回主)
 *  3) 按权重层聚合: 最高权重层(所有 key 的主候选) → 下一权重层(所有 key 的链中该层候选) → …
 *     → "第一权重(全 key)都限流才切第二权重";整层一起降级/恢复
 *  4) 冷却中的 (model,key) 不进候选(跳过),全冷却则该层为空、自动落到下一层
 */
function plan(p, st, requestedId) {
  const sorted = modelsSorted(p);

  // 1) 到期清理(次数/时长达标);调用方 diff 前后 Map 记 recover 事件
  //    判定粒度: **per-key** —— 组内达限的 key 单独回主,不被"从未达限"的
  //    key 阻塞;全部达限 → **总是回主**(用户约定: 达限就重新尝试主 model,
  //    主冷却由下方层聚合的 inCooldown 跳过机制处理,不在此处下探)。
  const main = mainModel(p);
  const groups = new Map(); // 降级目标 modelId → [keys]
  for (const [k, d] of [...st.degraded]) {
    if (!groups.has(d.modelId)) groups.set(d.modelId, []);
    groups.get(d.modelId).push(k);
  }
  for (const [gModel, gkeys] of groups) {
    const dueKeys = gkeys.filter((k) => keyDegradedDue(p, st.degraded.get(k)));
    if (dueKeys.length === 0) continue; // 本组无 key 达限 → 保持不动

    // 部分达限: 达限 key 单独回主,其余保持降级(不整组切换,避免抖动)
    if (dueKeys.length < gkeys.length) {
      for (const k of dueKeys) st.degraded.delete(k);
      continue;
    }

    // 全部达限 → 整层回主(旧实现在此检查主冷却并可能下探一层,已废除。
    // 主冷却中时,层聚合会让主层为空并落到下一可用层 —— 即"达限 → 回主")
    for (const k of gkeys) st.degraded.delete(k);
  }

  const req = requestedId ? modelOf(p, requestedId) : null;

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
    const start = d ? (modelOf(p, d.modelId) || main) : (req || main);
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

  // 3) 按权重层聚合(层降序 × key 依序)
  const weights = [...new Set(sorted.map((m) => m.weight))].sort((a, b) => b - a);
  const out = [];
  for (const w of weights) {
    for (const key of keys) {
      const mAtW = chainOf(key).find((m) => m.weight === w);
      if (mAtW && !inCooldown(p, st, mAtW.id, key)) out.push({ modelId: mAtW.id, key });
    }
  }
  return out;
}

/** 失败时记录该 (modelId,key) 的失败时间(进入冷却期) → 冷却期内该候选被跳过,过期重新可用;
 *  并推进队列指针到该 key 的下一个(超限模式: 失败才前进,下次请求从它后面起)。 */
function advanceKey(st, modelId, key) {
  st.failAt.set(modelId + '\0' + key, Date.now());
  st.lastFail = key;
}

/** 结果回报: 降级期间某 key 的 2xx 成功计数(达 usageLimit 到期考虑回主);
 *  平均轮询模式下成功时记 lastKey(下次请求轮转起点)。
 *  成功即解除该 (model,key) 的冷却;主 model 成功 → 兜底解除该 key 的降级(防御性,正常流程降级 key 不会在主层出现)。 */
function report(p, st, modelId, key, ok) {
  if (!ok) return;
  st.failAt.delete(modelId + '\0' + key);
  if (modelId === mainModel(p).id) st.degraded.delete(key);
  const d = st.degraded.get(key);
  if (d && d.modelId === modelId) d.success++;
  if (p.roundRobin) st.lastKey = key;
}

/**
 * 某权重层的全部 key 都尝试失败(proxy 判定,即本层所有 key 都耗尽) → 决策:
 *  - **非主层(如 m2/m3)全失败 → 总是回主**: 清除这些 key 的降级态,
 *    下轮计划重新从主 model 层开始(主冷却则层为空,自然落到下一可用层 ——
 *    含"m2 冷却=0 → 回主后立刻可再试 m2 k1")。
 *  - **主 model 全失败 → 降级**: key 标记降级到主 model 的下一权重层(m2),
 *    下轮从 m2 层开始(m2 冷却期内层为空 → 层聚合自动落到 m3)。
 * 返回 { toModel, cleared } 供事件记录。
 */
function degrade(p, st, failedModelId, keys) {
  const main = mainModel(p);
  if (failedModelId !== main.id) {
    // 非主层全失败 → 回主(不检查主冷却;主冷却由 plan 的 inCooldown 跳过处理)
    let cleared = 0;
    for (const k of keys) { if (st.degraded.delete(k)) cleared++; }
    return { toModel: null, cleared };
  }
  // 主 model 全失败 → 降级到下一权重层
  const lower = nextLower(p, failedModelId);
  let toModel = null;
  let cleared = 0;
  const now = Date.now();
  for (const k of keys) {
    if (!lower) { if (st.degraded.delete(k)) cleared++; continue; } // 无更低层 → 清态回主
    st.degraded.set(k, { modelId: lower.id, since: now, success: 0 });
    toModel = toModel || lower.id;
  }
  return { toModel, cleared };
}

/** 总尝试上限(防死循环): 层聚合候选最长 = keys × models,留余量 */
function maxAttempts(p) {
  const ks = allKeys(p).length;
  return ks * p.models.length + ks;
}

/** 兼容旧调用: 某 key 降级是否到期 */
function degradedDue(p, d) { return keyDegradedDue(p, d); }

module.exports = { modelsSorted, mainModel, newState, plan, report, degrade, maxAttempts, degradedDue, advanceKey, inCooldown, cooldownMs };
