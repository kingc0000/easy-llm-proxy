/* easy-llm-proxy Web 管理面板 */
'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

async function api(path, opts = {}) {
  const token = localStorage.getItem('token') || '';
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), opts.timeout || 20000); // 20s 超时,避免无限 loading
  let r;
  try {
    r = await fetch(path, {
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token, ...(opts.headers || {}) },
      signal: ctl.signal,
      ...opts,
    });
  } catch (e) {
    clearTimeout(to);
    if (e && e.name === 'AbortError') throw new Error('请求超时(20s),请重试');
    throw e;
  }
  clearTimeout(to);
  if (!r.ok) {
    let msg = 'HTTP ' + r.status;
    try { msg = (await r.json()).error?.message || msg; } catch {}
    const e = new Error(msg);
    if (r.status === 401) e.needToken = true;   // 标记: 需要/错误的 ADMIN_TOKEN
    throw e;
  }
  return r.json();
}

/* 401 处理: 显示引导并聚焦令牌输入框 */
function maybeNeedToken(e) {
  if (e && e.needToken) {
    $('#health').textContent = '🔑 需要登录';
    return true;
  }
  return false;
}

/* ---------- 视图切换 ---------- */
function show(view) {
  $$('.view').forEach((v) => v.classList.add('hidden'));
  $('#view-' + view).classList.remove('hidden');
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === view));
}
$$('.tab').forEach((t) => t.addEventListener('click', () => {
  show(t.dataset.tab);
  if (t.dataset.tab === 'stats') loadStats();
  if (t.dataset.tab === 'requests') { loadRequestDates(); loadRequests(); }
}));

/* ---------- 健康 ---------- */
async function loadHealth() {
  try {
    const h = await api('/health');
    $('#health').textContent = `✅ ${h.providers} providers / ${h.totalModels} models / ${h.totalKeys} keys`;
    if (h.version) $('#ver').textContent = 'v' + h.version;
  } catch { $('#health').textContent = '❌ 服务异常'; }
}

/* ---------- Dashboard ---------- */
/* 高亮导航项/卡片,并滚动到卡片 */
function focusProvider(i) {
  document.querySelectorAll('.pn-item').forEach((n) => n.classList.toggle('active', Number(n.dataset.i) === i));
  const card = document.querySelector(`.card[data-i="${i}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.add('hl');
}
/* 点击空白处取消高亮 */
document.addEventListener('click', (e) => {
  const t = e.target;
  if (t.closest('.pn-item') || t.closest('.card')) return;
  document.querySelectorAll('.card.hl').forEach((c) => c.classList.remove('hl'));
  document.querySelectorAll('.pn-item.active').forEach((n) => n.classList.remove('active'));
});

async function loadDashboard() {
  try {
    const d = await api('/api/providers');
    const el = $('#providers');
    if (!d.providers.length) {
      el.innerHTML = '<div class="empty">还没有 provider,点击右上角新增</div>';
      $('#provider-nav').innerHTML = '';
      return;
    }
    const sorted = [...d.providers].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')); // 按名称排序
    $('#provider-nav').innerHTML = sorted.map((p, i) => `
      <div class="pn-item" data-i="${i}" onclick="focusProvider(${i})" title="${esc(p.name)}">
        <span class="pn-dot" style="background:${p.apiType === 'anthropic' ? '#d97757' : ''}"></span>
        <span class="pn-name">${esc(p.name)}</span>
      </div>`).join('');
    el.innerHTML = sorted.map((p, i) => `
      <div class="card" data-i="${i}">
        <div class="card-head">
          <div class="card-title">
            <span class="tag ${p.apiType}">${p.apiType}</span>
            <b>${esc(p.name)}</b>
          </div>
          <div class="card-actions">
            <button class="btn small" title="测试连接" onclick="testProvider('${jesc(p.name)}')">▶ 测试</button>
            <button class="btn small" onclick="openEditor('${jesc(p.name)}')">✏️</button>
            <button class="btn small danger" onclick="deleteProvider('${jesc(p.name)}')">🗑</button>
          </div>
        </div>
        <div class="card-body">
          <div class="mono">${esc(p.baseURL)}</div>
          <div class="models">
            ${p.models.map((m) => `
              <span class="model-chip" title="${esc(m.id)} · 权重 ${m.weight} · 共享 provider 级 key 池">
                ${esc(m.id)} <em>w${m.weight}</em> <i>openai</i>
              </span>`).join('')}
          </div>
          <div class="card-meta">降级默认: 成功 ${p.usageLimit} 次 或 ${p.useSeconds}s 切回主</div>
        </div>
      </div>`).join('');
  } catch (e) {
    if (maybeNeedToken(e)) return;
    $('#providers').innerHTML = `<div class="empty err">加载失败: ${esc(e.message)}</div>`;
  }
}

/* ---------- 编辑 ---------- */
let editingConfig = null;
let editingName = null;

async function openEditor(name) {
  editingName = name;
  const d = await api('/api/config');
  editingConfig = d;
  const p = d.providers.find((x) => x.name === name);
  if (!p) return;
  $('#editor-title').textContent = '编辑 Provider: ' + name;
  $('#f-name').value = p.name;
  $('#f-apiType').value = p.apiType || 'openai';
  $('#f-baseURL').value = p.baseURL || '';
  $('#f-apiPath').value = p.apiPath || '';
  $('#f-apiKeyHeader').value = p.apiKeyHeader || '';
  $('#f-extraHeaders').value = p.extraHeaders && Object.keys(p.extraHeaders).length ? JSON.stringify(p.extraHeaders) : '';
  $('#f-usageLimit').value = p.usageLimit ?? 5;
  $('#f-useSeconds').value = p.useSeconds ?? 10;
  renderKeys(p.keys || (p.models && p.models[0] && p.models[0].keys));
  renderModels(p.models);
  show('editor');
}

function modelRow(m, i) {
  return `
  <div class="model-row" data-i="${i}" draggable="true">
    <input class="m-id" value="${esc(m.id)}" placeholder="model id" title="model id">
    <input class="m-weight" type="number" min="1" max="100" value="${m.weight || 100}" title="权重 1-100,越大越优先">
    <input class="m-usage" type="number" min="0" value="${m.usageLimit ?? ''}" placeholder="成功次数" title="降级后成功 N 次切回主(0=不限)">
    <input class="m-seconds" type="number" min="0" value="${m.useSeconds ?? ''}" placeholder="秒数" title="降级后 N 秒切回主(0=不限)">
    <span class="m-keys-note" title="key 在 provider 级统一管理,全部 model 共享">shared keys</span>
    <button type="button" class="btn small danger" onclick="delModel(this)">✕</button>
  </div>`;
}

function maskKey(k) { return (k && k.length > 12) ? k.slice(0, 8) + '…' + k.slice(-4) : k; }

function pkeyValue(k) { return (typeof k === 'string') ? k : (k && k.value || ''); }
function pkeyNote(k) { return (typeof k === 'object' && k) ? (k.note || '') : ''; }

function renderKeys(keys) {
  const rows = (keys || []).map((k, i) => `
    <div class="pkey-row" data-key="${esc(pkeyValue(k))}">
      <span class="pkey-idx">key${i + 1}</span>
      <span class="mono">${esc(maskKey(pkeyValue(k)))}</span>
      <input class="pkey-note" value="${esc(pkeyNote(k))}" placeholder="备注(可选)" autocomplete="off" title="给这个 key 加备注,随时可改">
      <button type="button" class="btn small danger" onclick="delKey(this)">−</button>
    </div>`).join('');
  $('#p-keys').innerHTML = rows + (rows ? '' : '<div class="empty" style="padding:.4rem 0">还没有 key,点击下方 + Key 添加</div>');
}
function addKeyRow() {
  const div = document.createElement('div');
  div.innerHTML = `
    <div class="pkey-row new">
      <span class="pkey-idx">key${$$('#p-keys .pkey-row').length + 1}</span>
      <input class="pkey-input" placeholder="输入真实 key" autocomplete="off">
      <input class="pkey-note" placeholder="备注(可选)" autocomplete="off">
      <button type="button" class="btn small danger" onclick="delKey(this)">−</button>
    </div>`.trim();
  const row = div.firstChild;          // appendChild 移动节点后 div.firstChild 会变 null,先存引用
  $('#p-keys').appendChild(row);
  row.querySelector('.pkey-input').focus();
}
function delKey(btn) { btn.closest('.pkey-row').remove(); }
window.delKey = delKey;

function renderModels(models) {
  $('#models').innerHTML = models.map(modelRow).join('') || '<div class="empty" style="padding:.6rem">还没有 model,点击下方添加</div>';
}

/* Models 卡片拖拽排序(上下拖动调整顺序,保存时按 DOM 顺序提交) */
(function () {
  const list = $('#models');
  if (!list) return;
  let dragRow = null;
  function clearIndicators() { list.querySelectorAll('.model-row').forEach((r) => r.classList.remove('dragging', 'drop-before', 'drop-after')); }
  list.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.model-row');
    if (!row) return;
    dragRow = row; row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', 'x');
  });
  list.addEventListener('dragover', (e) => {
    if (!dragRow) return;
    e.preventDefault();
    const target = e.target.closest('.model-row');
    list.querySelectorAll('.model-row').forEach((r) => r.classList.remove('drop-before', 'drop-after'));
    if (!target || target === dragRow) return;
    const rect = target.getBoundingClientRect();
    target.classList.add(e.clientY < rect.top + rect.height / 2 ? 'drop-before' : 'drop-after');
  });
  list.addEventListener('drop', (e) => {
    if (!dragRow) return;
    e.preventDefault();
    const target = e.target.closest('.model-row');
    if (target && target !== dragRow) {
      const rect = target.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      target.parentNode.insertBefore(dragRow, before ? target : target.nextSibling);
    }
    clearIndicators(); dragRow = null;
  });
  list.addEventListener('dragend', () => { clearIndicators(); dragRow = null; });
  list.addEventListener('dragleave', () => { list.querySelectorAll('.model-row').forEach((r) => r.classList.remove('drop-before', 'drop-after')); });
})();

// 数字输入: 空 → null(服务端用默认);数字(含 0=不限) → 原值
function numOrNull(v) { const n = parseInt(v, 10); return Number.isNaN(n) ? null : n; }

function collectProvider() {
  const name = $('#f-name').value.trim();
  if (!name) throw new Error('名称必填');
  const models = $$('#models .model-row').map((r) => {
    const id = r.querySelector('.m-id').value.trim();
    const weight = parseInt(r.querySelector('.m-weight').value, 10);
    if (!id) return null;
    return {
      id,
      weight: weight >= 1 && weight <= 100 ? weight : 100,
      usageLimit: numOrNull(r.querySelector('.m-usage').value),
      useSeconds: numOrNull(r.querySelector('.m-seconds').value),
    };
  }).filter(Boolean);
  if (!models.length) throw new Error('至少需要一个有效的 model(id 必填)');
  const keys = $$('#p-keys .pkey-row').map((r) => {
    const inp = r.querySelector('.pkey-input');
    const val = inp ? inp.value.trim() : (r.dataset.key || '');
    const note = r.querySelector('.pkey-note') ? r.querySelector('.pkey-note').value.trim() : '';
    return val ? { value: val, note } : null;
  }).filter(Boolean);
  if (!keys.length) throw new Error('至少需要一个 provider 级 key');
  let extraHeaders = {};
  const eh = $('#f-extraHeaders').value.trim();
  if (eh) { try { extraHeaders = JSON.parse(eh); } catch { throw new Error('extraHeaders 不是合法 JSON'); } }
  return {
    name,
    apiType: $('#f-apiType').value,
    baseURL: $('#f-baseURL').value.trim(),
    apiPath: $('#f-apiPath').value.trim() || null,
    apiKeyHeader: $('#f-apiKeyHeader').value.trim() || null,
    extraHeaders,
    usageLimit: numOrNull($('#f-usageLimit').value),
    useSeconds: numOrNull($('#f-useSeconds').value),
    keys,
    models,
  };
}

$('#editor-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const p = collectProvider();
    const cfg = editingConfig;
    const idx = cfg.providers.findIndex((x) => x.name === editingName);
    if (idx >= 0) cfg.providers[idx] = p; else cfg.providers.push(p);
    await api('/api/config', { method: 'PUT', body: JSON.stringify(cfg) });
    msg('✅ 已保存');
    await loadDashboard();
    setTimeout(() => show('dashboard'), 400);
  } catch (err) { msg('❌ ' + err.message, true); }
});

$('#btn-add-key').addEventListener('click', addKeyRow);
$('#btn-add-model').addEventListener('click', () => {
  const div = document.createElement('div');
  div.innerHTML = modelRow({ id: 'new-model', weight: 90, usageLimit: null, useSeconds: null, keys: [] }, $$('#models .model-row').length).trim();
  $('#models').appendChild(div.firstChild);
});

function delModel(btn) { btn.closest('.model-row').remove(); }
window.delModel = delModel;

async function deleteProvider(name) {
  if (!confirm('删除 provider ' + name + ' ?')) return;
  try {
    await api('/api/providers/' + encodeURIComponent(name), { method: 'DELETE' });
    await loadDashboard();
  } catch (e) { alert(e.message); }
}
window.deleteProvider = deleteProvider;

async function testProvider(name) {
  try {
    const r = await api('/api/providers/' + encodeURIComponent(name) + '/test', { method: 'POST', body: '{}' });
    alert(`${name} 测试: ${r.ok ? '✅ 可达' : '❌ 失败'} status=${r.status} 耗时=${r.ms}ms\n${r.error ? r.error : (r.sample || '')}`);
  } catch (e) { alert('测试失败: ' + e.message); }
}
window.testProvider = testProvider;

$('#btn-add').addEventListener('click', async () => {
  const d = await api('/api/config');
  editingConfig = d;
  const tpl = { name: 'new-provider-' + Date.now().toString(36).slice(-4), apiType: 'openai', baseURL: 'https://api.example.com/v1', apiPath: null, apiKeyHeader: null, extraHeaders: {}, usageLimit: 5, useSeconds: 10, models: [{ id: 'default', weight: 100, usageLimit: null, useSeconds: null, keys: [] }] };
  editingName = tpl.name;
  $('#editor-title').textContent = '新增 Provider (保存后写入配置)';
  $('#f-name').value = tpl.name;
  $('#f-apiType').value = 'openai';
  $('#f-baseURL').value = tpl.baseURL;
  $('#f-apiPath').value = ''; $('#f-apiKeyHeader').value = '';
  $('#f-extraHeaders').value = '';
  $('#f-usageLimit').value = 5; $('#f-useSeconds').value = 10;
  renderKeys([]);
  renderModels(tpl.models);
  show('editor');
});

$('#btn-back').addEventListener('click', async () => { await loadDashboard(); show('dashboard'); });

/* 测试连接: 直接用表单当前配置(未保存也能测),body 传临时 provider */
$('#btn-test').addEventListener('click', async () => {
  try {
    const p = collectProvider();
    const btn = $('#btn-test');
    btn.disabled = true; btn.textContent = '⏳ 测试中…';
    const r = await api('/api/providers/' + encodeURIComponent(p.name) + '/test', { method: 'POST', body: JSON.stringify({ provider: p }) });
    alert(`${p.name} 测试: ${r.ok ? '✅ 可达' : '❌ 失败'} status=${r.status} 耗时=${r.ms}ms\n${r.error ? r.error : (r.sample || '')}`);
  } catch (err) { alert('测试失败: ' + err.message); }
  finally { const btn = $('#btn-test'); btn.disabled = false; btn.textContent = '▶ 测试连接'; }
});

/* ---------- 统计 ---------- */
function fmtBytes(b) { if (!b) return '0'; if (b >= 1048576) return (b / 1048576).toFixed(1) + 'MB'; if (b >= 1024) return (b / 1024).toFixed(0) + 'KB'; return b + 'B'; }
// 趋势小时标签: hour 形如 "2026-10-08T10"(UTC);补全秒+Z 后缀才能被 Chrome 解析,并转为浏览器本地时区显示
function fmtHour(h) { const d = new Date(String(h).slice(0, 13) + ':00:00Z'); return (Number.isNaN(d.getTime()) ? (String(h).slice(11, 13) || '?') : String(d.getHours()).padStart(2, '0')) + ':00'; }

function renderKpis(s) {
  const err = s.errorTypes || {};
  const kpi = (label, val, sub = '') => `<div class="kpi"><div class="kpi-v">${val}</div><div class="kpi-l">${label}</div>${sub ? `<div class="kpi-s">${sub}</div>` : ''}</div>`;
  const inTok = (s.promptTokens || 0) + (s.cachedTokens || 0);
  const cacheRate = inTok > 0 ? Math.round((s.cachedTokens || 0) / inTok * 1000) / 10 : 0;
  $('#stats-summary').innerHTML =
    kpi('总请求', s.requests) +
    kpi('成功率', (s.successRate ?? 0) + '%', `${s.ok} 成功 / ${s.failed} 失败尝试 / ${s.retries} 重试`) +
    kpi('缓存率', cacheRate + '%', `缓存 ${(s.cachedTokens || 0).toLocaleString()} tok / 输入 ${inTok.toLocaleString()} tok`) +
    kpi('限流(429)', err['429'] || 0, `5xx: ${err['5xx'] || 0} · 网络: ${err['net'] || 0} · 模型: ${err['model'] || 0} · 超时: ${err['timeout'] || 0}`) +
    kpi('降级次数', s.degrades, '权重引擎限流降级') +
    kpi('平均耗时', s.avgMs + 'ms') +
    kpi('请求 token', (s.promptTokens || 0).toLocaleString(), `缓存命中 ${(s.cachedTokens || 0).toLocaleString()}`) +
    kpi('输出 token', (s.completionTokens || 0).toLocaleString(), `输出流量 ${fmtBytes(s.outputBytes)}`);
}

function renderTrend(hours) {
  const svg = $('#trend-chart');
  const W = 720, H = 150, PAD = 6;
  const list = hours.slice(-24);
  if (!list.length) { svg.innerHTML = '<text x="360" y="75" text-anchor="middle" fill="#94a3b8" font-size="13">暂无数据</text>'; return; }
  const maxReq = Math.max(1, ...list.map((h) => h.requests));
  const bw = (W - PAD * 2) / list.length;
  let bars = '', line = '';
  list.forEach((h, i) => {
    const x = PAD + i * bw + bw * 0.15;
    const bh = (h.requests / maxReq) * (H - 34);
    const y = H - 20 - bh;
    bars += `<rect x="${x}" y="${y}" width="${bw * 0.7}" height="${bh || 1}" rx="3" fill="${h.requests ? '#3b82f6' : '#dce3ef'}" data-hour="${esc(h.hour)}" data-req="${h.requests}" data-rate="${h.successRate ?? ''}"></rect>`;
    const rateY = H - 20 - (h.successRate ?? 0) / 100 * (H - 34);
    line += `${i ? 'L' : 'M'}${x + bw * 0.35},${rateY} `;
  });
  svg.innerHTML = bars +
    `<path d="${line}" fill="none" stroke="#10b981" stroke-width="1.8" stroke-dasharray="4 2"/>` +
    `<line x1="${PAD}" y1="${H - 20}" x2="${W - PAD}" y2="${H - 20}" stroke="#dce3ef"/>` +
    (list.length <= 13 ? list.map((h, i) => `<text x="${PAD + i * bw + bw * 0.35}" y="${H - 6}" text-anchor="middle" fill="#94a3b8" font-size="9">${fmtHour(h.hour)}</text>`).join('') : '');
}

/* 趋势图悬浮提示: 显示该小时请求数与成功率 */
(function () {
  const wrap = document.querySelector('.trend-wrap');
  if (!wrap) return;
  const svg = document.getElementById('trend-chart');
  const tip = document.getElementById('trend-tip');
  if (!svg || !tip) return;
  svg.addEventListener('mousemove', (e) => {
    const t = e.target && e.target.closest ? e.target.closest('rect[data-hour]') : null;
    if (!t) { tip.classList.add('hidden'); return; }
    const hour = t.dataset.hour;
    const rate = t.dataset.rate !== '' ? t.dataset.rate + '%' : '-';
    tip.textContent = `${hour.slice(5, 10)} ${fmtHour(hour)} · 请求 ${Number(t.dataset.req).toLocaleString()} · 成功率 ${rate}`;
    tip.classList.remove('hidden');
    const r = svg.getBoundingClientRect();
    let x = e.clientX - r.left + 12, y = e.clientY - r.top - 12;
    if (x + tip.offsetWidth + 8 > r.width) x = e.clientX - r.left - tip.offsetWidth - 12;
    if (y < 0) y = 0;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  });
  svg.addEventListener('mouseleave', () => tip.classList.add('hidden'));
})();

function renderErrors(err = {}) {
  const order = ['429', '5xx', 'net', 'model', 'timeout', 'other'];
  const total = Object.values(err).reduce((a, b) => a + b, 0) || 1;
  $('#error-chart').innerHTML = order.filter((t) => err[t]).map((t) => {
    const n = err[t];
    const label = { '429': '限流 429', '5xx': '服务器 5xx', 'net': '网络错误', 'model': '模型错误', 'timeout': '超时', 'other': '其他' }[t];
    return `<div class="bar-row"><span class="bar-l">${label}</span><div class="bar-track"><div class="bar-fill" style="width:${(n / total) * 100}%"></div></div><span class="bar-n">${n}</span></div>`;
  }).join('') || '<div class="empty" style="padding:.6rem">暂无错误</div>';
}

const _rate = (req, ok) => (req ? Math.round(ok / req * 1000) / 10 + '%' : '-');
const _arrow = (open) => open ? '<span class="arr">▼</span>' : '<span class="arr">▶</span>';

/* 统计页: Provider 主表 → Models 子表 → Keys 子表(三级层级) */
function renderStatsTree(providers, byKey) {
  const keyMap = new Map(); // "provider\0model" -> [key..]
  for (const s of byKey) {
    const id = s.provider + '\u0000' + s.model;
    if (!keyMap.has(id)) keyMap.set(id, []);
    keyMap.get(id).push(s);
  }
  const rows = providers.map((p) => {
    const modelRows = p.models.map((m) => {
      const ks = keyMap.get(p.name + '\u0000' + m.id) || [];
      const keyRows = ks.map((k) => `<tr class="sk-row">
          <td class="mono">${esc(k.key)}</td><td>${k.requests}</td><td>${k.ok}</td><td>${k.failed}</td>
          <td>${_rate(k.requests, k.ok)}</td><td>${k.avgMs}ms</td>
          <td>${(k.promptTokens || 0).toLocaleString()}</td><td>${(k.cachedTokens || 0).toLocaleString()}</td><td>${(k.completionTokens || 0).toLocaleString()}</td>
          <td>${fmtBytes(k.outputBytes)}</td><td>${k.lastSeen ? new Date(k.lastSeen).toLocaleTimeString() : '-'}</td>
        </tr>`).join('');
      return `<tr class="sm-row" data-p="${esc(p.name)}" data-m="${esc(m.id)}">
          <td>${_arrow(0)} <b>${esc(m.id)}</b></td><td>${m.requests}</td><td>${m.ok}</td><td>${m.failed}</td>
          <td>${_rate(m.requests, m.ok)}</td><td>${m.avgMs}ms</td>
          <td>${(m.promptTokens || 0).toLocaleString()}</td><td>${(m.cachedTokens || 0).toLocaleString()}</td><td>${(m.completionTokens || 0).toLocaleString()}</td>
          <td>${fmtBytes(m.outputBytes)}</td><td></td>
        </tr>
        <tr class="sm-keys hidden" data-p="${esc(p.name)}" data-m="${esc(m.id)}"><td colspan="11"><table class="sub-table">
          <thead><tr><th>Key</th><th>请求</th><th>成功</th><th>失败</th><th>成功率</th><th>平均耗时</th><th>请求tok</th><th>缓存tok</th><th>输出tok</th><th>输出(B)</th><th>最后活跃</th></tr></thead>
          <tbody>${keyRows || '<tr><td colspan="11" class="empty">暂无 key 数据</td></tr>'}</tbody>
        </table></td></tr>`;
    }).join('');
    return `<tr class="sp-row" data-p="${esc(p.name)}">
        <td>${_arrow(0)} <b>${esc(p.name)}</b></td><td>${p.requests}</td><td>${p.ok}</td><td>${p.failed}</td>
        <td>${_rate(p.requests, p.ok)}</td><td>${p.retries}</td><td>${p.avgMs}ms</td>
        <td>${(p.promptTokens || 0).toLocaleString()}</td><td>${(p.cachedTokens || 0).toLocaleString()}</td><td>${(p.completionTokens || 0).toLocaleString()}</td>
        <td>${fmtBytes(p.outputBytes)}</td>
      </tr>
      <tr class="sp-models hidden" data-p="${esc(p.name)}"><td colspan="11"><table class="sub-table">
        <thead><tr><th>Model</th><th>请求</th><th>成功</th><th>失败</th><th>成功率</th><th>平均耗时</th><th>请求tok</th><th>缓存tok</th><th>输出tok</th><th>输出(B)</th><th></th></tr></thead>
        <tbody>${modelRows || '<tr><td colspan="11" class="empty">暂无 model 数据</td></tr>'}</tbody>
      </table></td></tr>`;
  }).join('');
  $('#provider-table tbody').innerHTML = rows || '<tr><td colspan="11" class="empty">暂无数据</td></tr>';
}

/* 层级展开/收起(手风琴) */
$('#provider-table tbody').addEventListener('click', (e) => {
  const sp = e.target.closest('.sp-row');
  if (sp) {
    const sub = document.querySelector(`.sp-models[data-p="${CSS.escape(sp.dataset.p)}"]`);
    const opening = sub && sub.classList.contains('hidden');
    document.querySelectorAll('#provider-table .sp-models, #provider-table .sm-keys').forEach((x) => x.classList.add('hidden'));
    document.querySelectorAll('#provider-table .sp-row, #provider-table .sm-row').forEach((x) => { x.classList.remove('open'); const arr = x.querySelector('.arr'); if (arr) arr.textContent = '▶'; });
    if (opening) { sub.classList.remove('hidden'); sp.classList.add('open'); const arr = sp.querySelector('.arr'); if (arr) arr.textContent = '▼'; }
    return;
  }
  const sm = e.target.closest('.sm-row');
  if (sm) {
    const sub = document.querySelector(`.sm-keys[data-p="${CSS.escape(sm.dataset.p)}"][data-m="${CSS.escape(sm.dataset.m)}"]`);
    const opening = sub && sub.classList.contains('hidden');
    document.querySelectorAll('#provider-table .sm-keys').forEach((x) => x.classList.add('hidden'));
    document.querySelectorAll('#provider-table .sm-row').forEach((x) => { x.classList.remove('open'); const arr = x.querySelector('.arr'); if (arr) arr.textContent = '▶'; });
    if (opening) { sub.classList.remove('hidden'); sm.classList.add('open'); const arr = sm.querySelector('.arr'); if (arr) arr.textContent = '▼'; }
  }
});

function renderEvents(events) {
  $('#event-list').innerHTML = events.map((e) => {
    const t = new Date(e.time);
    const line = e.type === 'degrade'
      ? `🔀 <b>${esc(e.provider)}</b> ${esc(e.model)} → <b>${e.toModel ? esc(e.toModel) : '主 model(回切)'}</b> <span class="dim">${esc(e.reason || '')}</span>`
      : e.type === 'recover'
        ? `↩️ <b>${esc(e.provider)}</b> ${esc(e.model)} <b>达限切回主</b> <span class="dim">key ${esc(e.key || '')} · ${esc(e.reason || '')}</span>`
        : `⚠️ <b>${esc(e.provider)}</b> ${esc(e.model || '')} ${esc(e.detail || '')}`;
    return `<div class="evt"><span class="dim">${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}</span> ${line}</div>`;
  }).join('') || '<div class="empty" style="padding:.6rem">暂无事件</div>';
}

async function loadStats() {
  try {
    const d = await api('/api/stats');
    renderKpis(d.summary);
    renderTrend(d.trends.hours);
    renderErrors(d.summary.errorTypes);
    renderStatsTree(d.byProvider, d.byKey);
    renderEvents(d.recentEvents);
  } catch (e) {
    if (maybeNeedToken(e)) return;
    $('#provider-table tbody').innerHTML = `<tr><td colspan="11" class="empty err">${esc(e.message)}</td></tr>`;
  }
}
$('#btn-refresh-stats').addEventListener('click', loadStats);
$('#btn-reset-stats').addEventListener('click', async () => {
  if (!confirm('确定清空全部统计?此操作不可恢复')) return;
  try {
    await api('/api/stats/reset', { method: 'POST' });
    await loadStats();
    alert('✅ 统计已重置');
  } catch (e) { alert('重置失败: ' + e.message); }
});

/* ---------- 调用记录 ---------- */
async function loadRequestDates() {
  try {
    const d = await api('/api/requests/dates');
    const sel = $('#req-date');
    sel.innerHTML = (d.dates || []).map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join('') || '<option value="">无记录</option>';
    if (d.dates.length && !sel.value) sel.value = d.dates[0];
  } catch (e) { if (!maybeNeedToken(e)) $('#req-list').innerHTML = `<div class="empty err">加载失败: ${esc(e.message)}</div>`; }
}
function detailJson(o, truncated) {
  if (o == null) return truncated ? '(请求体超限未记录)' : '无';
  if (typeof o === 'string') return o + (truncated ? '\n(超出上限未全记)' : '');
  try { return JSON.stringify(o, null, 2) + (truncated ? '\n(超出上限未全记)' : ''); } catch { return String(o); }
}
async function loadRequests() {
  const listEl = $('#req-list');
  if (listEl && listEl.innerHTML === '') listEl.innerHTML = `<div class="empty">加载中…</div>`;
  const date = $('#req-date').value || '';
  const model = $('#req-model').value.trim();
  const status = $('#req-status').value.trim();
  const q = $('#req-q').value.trim();
  const query = new URLSearchParams({ date, model, status, q, limit: '20' }).toString();
  try {
    const d = await api('/api/requests?' + query);
    const list = $('#req-list');
    if (!d.total) { list.innerHTML = `<div class="empty">${date ? date + ' ' : ''}暂无调用记录${(model || status || q) ? '(符合筛选)' : ''}</div>`; return; }
    window.__reqRows = d.rows; // 供展开时惰性生成详情
    list.innerHTML = d.rows.map((r, i) => {
      const st = r.status;
      const cls = (st >= 200 && st < 300) ? 'ok' : 'err';
      const errInfo = r.error ? ` <span class="req-err">⚡ ${esc(r.error)}</span>` : '';
      const downgraded = r.degraded ? ' <span title="降级命中">⇣降级</span>' : '';
      return `<div class="req-row">
        <div class="req-head" onclick="toggleReqDetail(${i}, event)">
          <span class="req-time">${new Date(r.t).toLocaleString()}</span>
          <b>${esc(r.provider)}</b>
          <span>${r.model !== r.usedModel && r.model ? esc(r.model) + ' → ' : ''}${esc(r.usedModel || r.model || '-')}</span>
          <span class="mono">${esc(r.key || '-')}</span>
          <span class="req-status ${cls}">${st || '-'}</span>
          <span>${r.ms}ms</span>
          <span title="请求tok/缓存tok/输出tok">${r.promptTokens}/${r.cachedTokens}/${r.completionTokens}</span>
          ${downgraded}
          <span class="req-time">${r.attempts > 1 ? '尝试' + r.attempts + '次' : ''}</span>
          ${errInfo}
        </div>
        <div class="req-detail hidden" id="reqd-${i}">
          <div><h4>原始请求${r.reqTruncated ? '(截断)' : ''}</h4><pre data-kind="req" data-i="${i}"></pre></div>
          <div><h4>原始返回${r.truncated ? '(原始超出512KB截断)' : ''}${r.resClipped ? '(列表仅显示前128KB,磁盘完整)' : ''}${(!r.truncated && !r.resClipped && r.apiType === 'anthropic') ? '(上游原始)' : ''}</h4><pre data-kind="res" data-i="${i}"></pre></div>
        </div>
      </div>`;
    }).join('');
  } catch (e) { if (maybeNeedToken(e)) return; $('#req-list').innerHTML = `<div class="empty err">加载失败: ${esc(e.message)}</div>`; }
}
function toggleReqDetail(i, ev) {
  ev.stopPropagation();
  const el = $('#reqd-' + i);
  if (!el) return;
  const closing = !el.classList.contains('hidden');
  el.classList.toggle('hidden');
  if (closing) return; // 收起无需填充
  const r = (window.__reqRows || [])[i];
  if (!r) return;
  el.querySelectorAll('pre').forEach((p) => {
    if (p.dataset.kind === 'req') p.textContent = detailJson(r.req, r.reqTruncated);
    else if (p.dataset.kind === 'res') p.textContent = detailJson(r.res == null ? (r.error ? '无(失败)' : '无') : String(r.res), r.truncated);
  });
}
$('#btn-req-search').addEventListener('click', loadRequests);
$('#btn-req-refresh').addEventListener('click', () => { loadRequestDates(); loadRequests(); });
if ($('#req-date')) $('#req-date').addEventListener('change', loadRequests);
$('#req-model').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadRequests(); });
$('#req-status').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadRequests(); });
$('#req-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadRequests(); });

/* ---------- 工具 ---------- */
function esc(s) { return String(s ?? '').replace(/[&<>"'\\]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '\\': '&#92;' }[c])); }
// onclick 内联 JS 字符串转义(HTML 解码后 ' 与 \ 仍需 JS 级转义防断句/注入)
function jesc(s) { return String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
function msg(text, err = false) {
  const el = $('#save-msg');
  el.textContent = text;
  el.className = 'msg ' + (err ? 'err' : 'ok');
  setTimeout(() => { el.textContent = ''; }, 2500);
}

/* ---------- 登录 ---------- */
function showLogin(msgText) {
  $$('.tab').forEach((t) => t.classList.remove('active'));
  $('#app-header').classList.add('hidden'); // 登录页不显示顶部导航条
  $('#view-login').classList.remove('hidden');
  ['view-dashboard', 'view-editor', 'view-stats', 'view-requests'].forEach((v) => $('#' + v).classList.add('hidden'));
  $('#user-info').classList.add('hidden');
  $('#btn-account').classList.add('hidden');
  $('#btn-logout').classList.add('hidden');
  $('#login-msg').textContent = msgText || '';
  if (msgText) $('#login-msg').className = 'msg err';
}
/* 登录后显示顶部导航的用户信息/账号/退出(登录提交与刷新直进共用) */
function showHeaderUI(username) {
  $('#app-header').classList.remove('hidden');
  $('#user-info').classList.remove('hidden');
  $('#user-info').textContent = '👤 ' + username;
  $('#btn-account').classList.remove('hidden');
  $('#btn-logout').classList.remove('hidden');
}

function showMain(username) {
  localStorage.setItem('username', username);
  show('dashboard');
  $('#view-login').classList.add('hidden');
  showHeaderUI(username);
  $('#user-info').textContent = '👤 ' + username;
  show('dashboard');
  loadDashboard();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#login-form button[type=submit]');
  btn.disabled = true; btn.textContent = '登录中…';
  try {
    const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: $('#f-login-user').value.trim(), password: $('#f-login-pass').value }) });
    localStorage.setItem('token', r.token);
    $('#f-login-pass').value = '';
    showMain(r.username);
    $('#weak-banner').classList.toggle('hidden', !r.weak);   // 默认弱口令提醒改密
    loadHealth();
  } catch (err) {
    $('#login-msg').textContent = err.message;
    $('#login-msg').className = 'msg err';
  } finally { btn.disabled = false; btn.textContent = '登 录'; }
});

$('#btn-logout').addEventListener('click', () => {
  localStorage.removeItem('token');
  showLogin('已退出登录');
  $('#health').textContent = '…';
});

/* ---------- 修改账号 ---------- */
$('#btn-account').addEventListener('click', () => {
  $('#account-modal').classList.remove('hidden');
  $('#account-msg').textContent = '';
  $('#f-old-pass').focus();
});
$('#btn-acct-close').addEventListener('click', () => $('#account-modal').classList.add('hidden'));
$('#account-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nu = $('#f-new-user').value.trim();
  const np = $('#f-new-pass').value;
  if (np && np !== $('#f-new-pass2').value) { $('#account-msg').textContent = '两次新密码不一致'; $('#account-msg').className = 'msg err'; return; }
  const btn = $('#account-form button[type=submit]');
  btn.disabled = true;
  try {
    const r = await api('/api/account', { method: 'POST', body: JSON.stringify({ old_password: $('#f-old-pass').value, new_username: nu || undefined, new_password: np || undefined }) });
    $('#account-msg').textContent = '✅ 已保存,请重新登录';
    $('#account-msg').className = 'msg ok';
    setTimeout(() => {
      $('#account-modal').classList.add('hidden');
      localStorage.removeItem('token');
      showLogin('账号已更新,请重新登录');
    }, 1200);
  } catch (err) { $('#account-msg').textContent = err.message; $('#account-msg').className = 'msg err'; }
  finally { btn.disabled = false; }
});

/* 弱密码横幅关闭 */
$('#weak-banner') && $('#weak-banner').addEventListener('dblclick', () => $('#weak-banner').classList.add('hidden'));

/* 退出登录时隐藏横幅 */
$('#btn-logout').addEventListener('click', () => { $('#weak-banner').classList.add('hidden'); }, true);

/* 401(会话失效/未登录)统一回登录页 */
function maybeNeedToken(e) {
  if (e && e.needToken) { showLogin('请先登录(会话已过期或未登录)'); return true; }
  return false;
}

/* ---------- 启动 ---------- */
loadHealth();
if (localStorage.getItem('token')) {
  show('dashboard');
  const who = localStorage.getItem('username') || '';
  if (who) showHeaderUI(who);  // 刷新直进也恢复右上角(账号/退出)
  loadDashboard();
} else { showLogin(); }
setInterval(loadHealth, 15000);