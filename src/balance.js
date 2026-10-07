/**
 * balance.js — 加权轮询引擎（easy-llm-proxy 核心）
 *
 * 规则（按需求）:
 *  - 每 provider 多个 model,每个 model 配置 weight(1-100,越大越优先) + keys(多 key)
 *  - 主 model(权重最高) 限流 → 换下一个 key;该 model 全部 key 都限流 → 降级到
 *    权重更低的 model(如 100 → 99 → 97,按权重降序以此类推)
 *  - 降级 model 在使用达到 成功次数(usageLimit) 或 时长(useSeconds) 任一限制后
 *    切回权重最高的主 model;次数 = 成功返回的次数(2xx),不是调用次数
 *  - 最低权重也限流 → 回到主 model 重试(循环,带总尝试上限防死循环)
 *  - 每 model 的 key 池内部 round-robin(记录游标,429/5xx 跳过)
 *
 * 状态(state) 按 provider 持久(内存),跨请求共享:
 *   { degraded: {modelId, since, success} | null, cursor: Map<modelId, int> }
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
  return { degraded: null, cursor: new Map() };
}

function modelOf(p, id) {
  return p.models.find((x) => x.id === id) || null;
}

/** 降级是否到期(成功次数或时长任一达标 → 切回主) */
function degradedDue(p, st) {
  const d = st.degraded;
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

/**
 * 生成尝试计划(候选列表,顺序即尝试顺序)。
 *  - 降级中且未到期: 从降级 model 开始,再更低权重,最后主
 *  - 否则: 从请求 model(若在配置中)或主开始,再更低权重,最后主
 *  - 每个 model 的 keys 从游标开始 round-robin
 */
function plan(p, st, requestedId) {
  const sorted = modelsSorted(p);
  if (st.degraded && degradedDue(p, st)) {
    st.degraded = null; // 到期 → 切回主
  }

  let start;
  if (st.degraded) {
    start = modelOf(p, st.degraded.modelId) || mainModel(p);
  } else {
    const req = requestedId ? modelOf(p, requestedId) : null;
    start = req || mainModel(p);
  }

  // 尝试序列: 从 start 权重开始, 逐层收集[同权重兄弟 → 严格更低权重层] + 主兜底
  // (同权重 model 均参与尝试,避免同权重兄弟被整层跳过)
  const seq = [];
  const seen = new Set();
  const add = (m) => { if (m && !seen.has(m.id)) { seen.add(m.id); seq.push(m); } };
  let w = start.weight;
  for (;;) {
    const layer = sorted.filter((m) => m.weight === w); // 同权重层
    // 层内: 起点(降级 model/请求 model)优先,其余按配置顺序
    if (layer.some((m) => m.id === start.id)) {
      add(start);
      layer.filter((m) => m.id !== start.id).forEach(add);
    } else {
      layer.forEach(add);
    }
    const lower = sorted.find((m) => m.weight < w);     // 下一层更低权重
    if (!lower) break;
    w = lower.weight;
  }
  const main = mainModel(p);
  if (main) add(main); // 主兜底(若未包含)

  const out = [];
  for (const m of seq) {
    const c = st.cursor.get(m.id) || 0;
    const ks = m.keys;
    for (let i = 0; i < ks.length; i++) {
      const key = ks[(c + i) % ks.length];
      out.push({ modelId: m.id, key });
    }
    // 游标不在此推进: 由 proxy 尝试后调用 advanceKey(成功/失败都用掉的 key)
  }
  return out;
}

/** 推进某 model 的 key 轮询游标(proxy 每尝试一个 key 后调用一次) */
function advanceKey(st, modelId) {
  const c = st.cursor.get(modelId) || 0;
  st.cursor.set(modelId, c + 1);
}

/** 结果回报(成功计数: 仅降级期间的 2xx 计入,次数=成功返回次数) */
function report(p, st, modelId, ok) {
  if (ok && st.degraded && st.degraded.modelId === modelId) {
    st.degraded.success++;
  }
}

/**
 * 某 model 全部 key 失败时调用 → 更新降级状态,返回下一轮计划。
 *  - 有更低权重: 设为降级目标(记录起始时间/成功计数)
 *  - 已是最低: 清除降级(回主)
 */
function degrade(p, st, failedModelId) {
  const lower = nextLower(p, failedModelId);
  if (lower) {
    st.degraded = { modelId: lower.id, since: Date.now(), success: 0 };
  } else {
    st.degraded = null; // 回主
  }
  return plan(p, st, null);
}

/** 总尝试上限(防死循环) */
function maxAttempts(p) {
  return p.models.reduce((n, m) => n + m.keys.length, 0) * 2 + p.models.length;
}

module.exports = { modelsSorted, mainModel, newState, plan, report, degrade, maxAttempts, degradedDue, advanceKey };