/**
 * balance.js — per-key 降级链引擎(easy-llm-proxy 核心)
 *
 * 规则:
 *  - 每 provider 多个 model,每个 model 配置 weight(1-100,越大越优先) + keys(多 key)
 *  - 第一权重(主 model): 全部 key 都限流 → 切到第二权重;第二权重也全部限流 → 更低权重…
 *    (层聚合: 每个权重层内,所有 key 依序尝试;该层全部失败才降下一层)
 *  - **per-key 降级状态**: 某层全部 key 失败 → 这些 key 各自记录降级(到下一权重 model);
 *    其他 key 不受影响继续用主 model(单 key 限流不拖累全局)
 *  - 降级 key 在降级 model 使用达到 成功次数(usageLimit) 或 时长(useSeconds) 任一限制后
 *    **切回主 model 继续轮询**(到期清理);次数 = 成功返回的次数(2xx)
 *  - 回主后若主仍全部限流 → 重新降级到下一权重;最低权重也全失败 → 清态回主(循环)
 *  - 每 model 的 key 池: 限流/失败才切换下一个 key(advanceKey 仅失败推进)
 *
 * 状态(state) 按 provider 持久(内存),跨请求共享:
 *   { degraded: Map<key, {modelId, since, success}>, cursor: Map<key, int>(失败次数,参与排序) }
 */
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
  return { degraded: new Map(), cursor: new Map() };
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

/** 全部 key(去重,保持配置顺序) */
function allKeys(p) {
  const s = new Set();
  for (const m of p.models) for (const k of m.keys) s.add(k);
  return [...s];
}

/**
 * 生成尝试计划(候选列表,顺序即尝试顺序)。
 *  1) 先清理到期的 per-key 降级态(次数/时长达标 → 切回主)
 *  2) 每 key 一条链: 降级中从降级 model 起,否则从主(或请求 model)起;链内按权重降序(同权重兄弟)
 *  3) 按权重层聚合: 最高权重层(所有 key 的主候选) → 下一权重层(所有 key 的链中该层候选) → …
 *     → "第一权重(全 key)都限流才切第二权重";per-key 独立降级/恢复互不影响
 *  4) 降级中的 key 不进主层(到期由步骤 1 恢复),避免每请求白试主
 */
function plan(p, st, requestedId) {
  const sorted = modelsSorted(p);

  // 1) 到期清理(次数/时长达标 → 切回主);调用方 diff 前后 Map 记 recover 事件
  for (const [k, d] of [...st.degraded]) {
    if (keyDegradedDue(p, d)) st.degraded.delete(k);
  }

  const main = mainModel(p);
  const req = requestedId ? modelOf(p, requestedId) : null;

  // 2) 每 key 链(无兜底: 最低层失败由 degrade 清态回主处理);
  //    key 顺序按失败游标升序(游标=失败次数,失败多的排后 → 不每请求白试失效 key)
  const keys = allKeys(p).sort((a, b) => (st.cursor.get(a) || 0) - (st.cursor.get(b) || 0));
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
      if (mAtW) out.push({ modelId: mAtW.id, key });
    }
  }
  return out;
}

/** 失败时推进该 key 的游标(失败次数+1) → 候选排序时排后,同一 key 持续使用到限流 */
function advanceKey(st, key) {
  const c = st.cursor.get(key) || 0;
  st.cursor.set(key, c + 1);
}

/** 结果回报(降级期间某 key 的 2xx 成功计数: 达到 usageLimit 时到期回主) */
function report(p, st, modelId, key, ok) {
  if (!ok) return;
  const d = st.degraded.get(key);
  if (d && d.modelId === modelId) d.success++;
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

/** 总尝试上限(防死循环): 层聚合候选最长 = keys × models,留余量 */
function maxAttempts(p) {
  const ks = allKeys(p).length;
  return ks * p.models.length + ks;
}

/** 兼容旧调用: 某 key 降级是否到期 */
function degradedDue(p, d) { return keyDegradedDue(p, d); }

module.exports = { modelsSorted, mainModel, newState, plan, report, degrade, maxAttempts, degradedDue, advanceKey };
