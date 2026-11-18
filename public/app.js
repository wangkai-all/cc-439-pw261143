import { api, esc, shortHash, ts, relTime, money, stateBadge, fileStatusBadge, outcomeBadge, kindBadge, kindLabel, severityBadge, fieldLabel, fieldValue, toast } from '/lib.js';

const views = {};
let currentTab = location.hash.replace('#', '') || 'overview';
let health = null;

// ------------------------------------------------------------------ router

function setTab(tab, { replace = false } = {}) {
  if (!views[tab]) tab = 'overview';
  currentTab = tab;
  if (replace) history.replaceState(null, '', `#${tab}`);
  else history.pushState(null, '', `#${tab}`);
  document.querySelectorAll('.tab').forEach((el) => {
    const active = el.dataset.tab === tab;
    el.classList.toggle('is-active', active);
    el.setAttribute('aria-selected', String(active));
  });
  render();
}

async function render() {
  const view = document.getElementById('view');
  view.innerHTML = '<div class="empty">加载中…</div>';
  try {
    await views[currentTab](view);
  } catch (err) {
    view.innerHTML = `<div class="error-box">页面加载失败：${esc(err.message)}</div>`;
  }
}

window.addEventListener('popstate', () => {
  currentTab = location.hash.replace('#', '') || 'overview';
  document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('is-active', el.dataset.tab === currentTab));
  render();
});

document.querySelectorAll('.tab').forEach((el) => {
  el.addEventListener('click', () => setTab(el.dataset.tab));
});

// ------------------------------------------------------------------ drawer

const drawer = document.getElementById('drawer');
const drawerBody = document.getElementById('drawer-body');
let drawerCloser = null;

let lastFocus = null;

export function openDrawer(html, { onMount } = {}) {
  lastFocus = document.activeElement;
  drawerBody.innerHTML = html;
  drawer.hidden = false;
  drawerCloser = onMount ?? null;
  drawerCloser?.(drawerBody);
  document.body.style.overflow = 'hidden';
  drawer.querySelector('.drawer-close')?.focus();
}

export function closeDrawer() {
  drawer.hidden = true;
  drawerBody.innerHTML = '';
  drawerCloser = null;
  document.body.style.overflow = '';
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  lastFocus = null;
}

drawer.querySelectorAll('[data-close-drawer]').forEach((el) => el.addEventListener('click', closeDrawer));
document.addEventListener('keydown', (e) => {
  if (drawer.hidden) return;
  if (e.key === 'Escape') {
    closeDrawer();
    return;
  }
  if (e.key !== 'Tab') return;
  // Keep focus inside the dialog while it is open.
  const focusable = [...drawer.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && el.offsetParent !== null);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

async function withButton(button, fn) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '处理中…';
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

// ------------------------------------------------------------------ overview

views.overview = async (root) => {
  const [data, batches] = await Promise.all([api('/api/overview'), api('/api/batches?limit=4')]);
  const docs = data.documents;
  const q = data.quarantine;
  const last = data.intake.lastBatch;

  root.innerHTML = `
    <div class="section-head">
      <div>
        <h2>总览</h2>
        <p>监控本地目录中的 XML 与 PDF，按供应商规则解析；原文哈希与解析器版本随每份文件记录，字段缺失或金额不一致的文件进入人工隔离。</p>
      </div>
      <div class="actions">
        <span class="muted" style="font-size:12px">最近扫描 ${last ? relTime(last.started_at) : '—'}</span>
      </div>
    </div>

    <div class="tiles">
      <div class="tile">
        <div class="tile-label"><span class="status-dot"></span>已确认</div>
        <div class="tile-value">${docs.confirmed}</div>
        <div class="tile-foot">共 ${docs.total} 份发票 · 已接收 ${docs.received}</div>
      </div>
      <div class="tile ${q.open ? 'is-alert' : ''}">
        <div class="tile-label"><span class="status-dot ${q.open ? 'crit' : ''}"></span>待人工处理</div>
        <div class="tile-value">${q.open}</div>
        <div class="tile-foot">今日新增 ${q.openedToday} 条</div>
      </div>
      <div class="tile">
        <div class="tile-label"><span class="status-dot ${data.intake.deferredLast ? 'warn' : ''}"></span>等待稳定 / 半写入</div>
        <div class="tile-value">${data.intake.deferredLast}</div>
        <div class="tile-foot">最近批次 · 文件未完成写入时不入库</div>
      </div>
      <div class="tile">
        <div class="tile-label"><span class="status-dot"></span>重复文件</div>
        <div class="tile-value">${data.intake.duplicates}</div>
        <div class="tile-foot">按原文哈希与业务键判重</div>
      </div>
      <div class="tile">
        <div class="tile-label"><span class="status-dot ${data.sourceFiles.missing ? 'warn' : ''}"></span>目录文件</div>
        <div class="tile-value">${data.sourceFiles.active}</div>
        <div class="tile-foot">${data.sourceFiles.missing ? `${data.sourceFiles.missing} 个历史文件缺失` : '无缺失文件'}</div>
      </div>
    </div>

    <div class="grid-2">
      <div>
        <div class="card">
          <div class="card-head">
            <h3>近 14 天接入结果</h3>
            <span class="muted">按文件处理结果计数</span>
          </div>
          <div id="intake-chart"></div>
        </div>

        <div class="card">
          <div class="card-head">
            <h3>最近批次</h3>
            <button class="linkbtn" data-go="batches">查看全部批次</button>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>开始时间</th><th>触发</th><th class="num">文件</th><th class="num">入库</th><th class="num">隔离</th><th class="num">重复</th><th>备注</th></tr></thead>
              <tbody>
                ${batches.map((b) => `
                  <tr>
                    <td class="nowrap"><button class="linkbtn" data-batch="${esc(b.id)}">${ts(b.started_at)}</button></td>
                    <td>${esc(b.trigger)}</td>
                    <td class="num">${b.files_seen}</td>
                    <td class="num">${b.intakes}</td>
                    <td class="num">${b.quarantined}</td>
                    <td class="num">${b.duplicates}</td>
                    <td class="secondary">${esc(b.note ?? '—')}</td>
                  </tr>`).join('') || '<tr><td colspan="7" class="empty">尚无批次</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div>
        <div class="card">
          <div class="card-head">
            <h3>人工隔离队列</h3>
            <button class="linkbtn" data-go="quarantine">打开队列</button>
          </div>
          <div class="card-body" style="padding-bottom:6px">
            ${q.byKind.length
              ? q.byKind.map((k) => `<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--grid)">
                  <span>${kindBadge(k.kind)}</span><strong style="font-variant-numeric:tabular-nums">${k.n}</strong></div>`).join('')
              : '<div class="muted">队列为空</div>'}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>解析器版本</h3><button class="linkbtn" data-go="parsers">管理</button></div>
          <div class="card-body" style="padding-top:8px">
            ${data.parsers.map((p) => `<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--grid)">
              <span class="mono">${esc(p.parser_key)}</span><span class="badge info">v${esc(p.active_version)}</span>
            </div>`).join('') || '<div class="muted">未注册解析器</div>'}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>最近重放</h3><button class="linkbtn" data-go="replays">全部重放</button></div>
          <div class="card-body">
            ${data.latestReplay
              ? `<div class="secondary" style="font-size:12.5px">${ts(data.latestReplay.started_at)} · <span class="mono">${esc(data.latestReplay.parser_key)} v${esc(data.latestReplay.to_version)}</span></div>
                 <div style="display:flex;gap:18px;margin-top:8px">
                   <div><div class="muted" style="font-size:11.5px">扫描</div><strong>${data.latestReplay.documents_scanned}</strong></div>
                   <div><div class="muted" style="font-size:11.5px">变化</div><strong>${data.latestReplay.documents_changed}</strong></div>
                   <div><div class="muted" style="font-size:11.5px">恢复</div><strong class="delta-pos">${data.latestReplay.documents_recovered}</strong></div>
                   <div><div class="muted" style="font-size:11.5px">隔离</div><strong class="delta-neg">${data.latestReplay.documents_quarantined}</strong></div>
                 </div>`
              : '<div class="muted">尚未执行重放</div>'}
          </div>
        </div>
      </div>
    </div>
  `;

  renderIntakeChart(document.getElementById('intake-chart'), data.recentDays);

  root.querySelectorAll('[data-go]').forEach((el) =>
    el.addEventListener('click', () => setTab(el.dataset.go)));
  root.querySelectorAll('[data-batch]').forEach((el) =>
    el.addEventListener('click', () => showBatch(el.dataset.batch)));

  bindScanButton();
};

function renderIntakeChart(host, days) {
  // Build a 14-day axis, filling gaps with zeros.
  const byKey = new Map();
  for (const row of days) {
    if (!byKey.has(row.day)) byKey.set(row.day, { ingested: 0, quarantined: 0, duplicate: 0 });
    const bucket = byKey.get(row.day);
    if (row.status === 'ingested' || row.status === 'quarantined') bucket[row.status === 'ingested' ? 'ingested' : 'quarantined'] += row.n;
    else if (row.status === 'duplicate') bucket.duplicate += row.n;
  }

  const today = new Date();
  const axis = [];
  for (let i = 13; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    axis.push({ key, ...(byKey.get(key) ?? { ingested: 0, quarantined: 0, duplicate: 0 }) });
  }

  const series = [
    { key: 'ingested', label: '成功入库', color: 'var(--series-1)' },
    { key: 'quarantined', label: '隔离', color: 'var(--series-2)' },
    { key: 'duplicate', label: '重复', color: 'var(--series-3)' },
  ];
  const totals = axis.map((d) => d.ingested + d.quarantined + d.duplicate);
  const max = Math.max(4, ...totals);
  const niceMax = Math.ceil(max / 4) * 4;

  const W = 640, H = 220;
  const pad = { top: 10, right: 8, bottom: 24, left: 32 };
  const iw = W - pad.left - pad.right;
  const ih = H - pad.top - pad.bottom;
  const slot = iw / axis.length;
  const barW = Math.min(28, slot * 0.62);

  let bars = '';
  let labels = '';
  axis.forEach((d, i) => {
    const x = pad.left + i * slot + (slot - barW) / 2;
    let y = pad.top + ih;
    const segs = series.map((s) => ({ ...s, value: d[s.key] })).filter((s) => s.value > 0);
    // 2px surface gap between stacked segments, 4px rounded top on the cap.
    segs.forEach((s, si) => {
      const h = (s.value / niceMax) * ih;
      const isTop = si === segs.length - 1;
      const gap = si === segs.length - 1 ? 0 : 2;
      y -= h;
      bars += `<rect class="bar-seg" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, h - gap).toFixed(1)}"
        rx="${isTop ? 3 : 1}" fill="${s.color}"
        data-day="${d.key}" data-series="${s.label}" data-value="${s.value}"
        tabindex="0" role="listitem" aria-label="${d.key} ${s.label} ${s.value}"></rect>`;
      y -= gap;
    });
    if (i % 2 === 0 || i === axis.length - 1) {
      labels += `<text class="axis-label" x="${(pad.left + i * slot + slot / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${d.key.slice(5)}</text>`;
    }
  });

  let grid = '';
  const ticks = 4;
  for (let t = 0; t <= ticks; t += 1) {
    const value = (niceMax / ticks) * t;
    const y = pad.top + ih - (value / niceMax) * ih;
    grid += `<line class="grid-line" x1="${pad.left}" x2="${W - pad.right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"></line>`;
    grid += `<text class="axis-label" x="${pad.left - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${value}</text>`;
  }

  const total = totals.reduce((a, b) => a + b, 0);
  host.innerHTML = `
    <div class="chart">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="近 14 天文件接入结果柱状图，共 ${total} 个文件">
        ${grid}
        ${bars || `<text class="axis-label" x="${W / 2}" y="${H / 2}" text-anchor="middle">近 14 天暂无接入记录</text>`}
        ${labels}
      </svg>
      <div class="legend" role="list">
        ${series.map((s) => `<span class="legend-item" role="listitem"><span class="legend-swatch" style="background:${s.color}"></span>${s.label}</span>`).join('')}
      </div>
    </div>
  `;

  // Hover/focus tooltip: hit target is the segment itself (bars are >= 8px wide
  // with a transparent twin for thin days).
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  document.body.appendChild(tip);
  const show = (el) => {
    const r = el.getBoundingClientRect();
    tip.innerHTML = `<strong>${esc(el.dataset.day)}</strong><br>${esc(el.dataset.series)}：${esc(el.dataset.value)}`;
    tip.style.left = `${Math.min(window.innerWidth - 170, r.left + r.width / 2 + 8)}px`;
    tip.style.top = `${r.top - 8}px`;
    tip.hidden = false;
  };
  host.querySelectorAll('.bar-seg').forEach((el) => {
    el.addEventListener('mouseenter', () => show(el));
    el.addEventListener('focus', () => show(el));
    el.addEventListener('mouseleave', () => { tip.hidden = true; });
    el.addEventListener('blur', () => { tip.hidden = true; });
  });
  const cleanup = new MutationObserver(() => {
    if (!document.body.contains(host)) {
      tip.remove();
      cleanup.disconnect();
    }
  });
  cleanup.observe(document.body, { childList: true, subtree: true });
}

// ------------------------------------------------------------------ batches

views.batches = async (root) => {
  const batches = await api('/api/batches?limit=30');
  const collapsed = batches.filter((b) => b.files.length === 0).length;
  const withFiles = batches.filter((b) => b.files.length > 0);

  root.innerHTML = `
    <div class="section-head">
      <div>
        <h2>文件批次</h2>
        <p>每次目录扫描形成一个批次。文件只有在连续两次观察中大小与修改时间一致、且写入结束后才会被读取；半写入文件停留在「等待稳定」。</p>
      </div>
    </div>
    ${batches.length === 0 ? '<div class="card"><div class="empty">尚无扫描批次。点击右上角「立即扫描」或运行 npm run seed。</div></div>' : ''}
    ${withFiles.length === 0 && collapsed > 0 ? '<div class="card"><div class="empty">最近 30 次扫描都没有文件变化。</div></div>' : ''}
    ${withFiles.map((b) => `
      <div class="card">
        <div class="card-head">
          <div>
            <h3>${ts(b.started_at)} <span class="muted" style="font-weight:400">· ${esc(b.trigger)}</span></h3>
            <div class="muted" style="font-size:12px;margin-top:2px">
              共 ${b.files_seen} 个文件 · 入库 ${b.intakes} · 隔离 ${b.quarantined} · 重复 ${b.duplicates} · 等待 ${b.deferred} · 缺失 ${b.missing}${b.recovered ? ` · 恢复 ${b.recovered}` : ''}${b.ignored ? ` · 忽略 ${b.ignored}` : ''}
            </div>
          </div>
          <div class="actions">
            ${b.status === 'running' ? stateBadge('running') : stateBadge('completed')}
            <button class="btn btn-ghost btn-sm" data-open-batch="${esc(b.id)}">详情</button>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>文件</th><th>结果</th><th>说明</th><th>原文哈希</th><th class="num">大小</th></tr></thead>
            <tbody>
              ${b.files.map((f) => `
                <tr>
                  <td class="mono truncate" title="${esc(f.path)}">${esc(f.name)}</td>
                  <td>${fileStatusBadge(f.status)}</td>
                  <td class="secondary">${esc(f.detail ?? '—')}</td>
                  <td class="mono">${f.hash ? `<span title="${esc(f.hash)}">${esc(shortHash(f.hash))}</span>` : '—'}</td>
                  <td class="num">${f.size === null ? '—' : f.size.toLocaleString()}</td>
                </tr>`).join('') || '<tr><td colspan="5" class="empty">批次中没有文件</td></tr>'}
            </tbody>
          </table>
        </div>
        ${b.note ? `<div class="card-body" style="padding-top:8px"><span class="muted" style="font-size:12px">备注：${esc(b.note)}</span></div>` : ''}
      </div>
    `).join('')}
  `;

  root.querySelectorAll('[data-open-batch]').forEach((el) =>
    el.addEventListener('click', () => showBatch(el.dataset.openBatch)));

  bindScanButton();
};

async function showBatch(id) {
  const batch = await api(`/api/batches/${encodeURIComponent(id)}`);
  openDrawer(`
    <h2>批次 ${esc(batch.id)}</h2>
    <div class="subtitle">${ts(batch.started_at)} · 触发方式 ${esc(batch.trigger)} · 目录 <span class="mono">${esc(batch.dir)}</span></div>
    <dl class="kv">
      <div><dt>状态</dt><dd>${stateBadge(batch.status)}</dd></div>
      <div><dt>文件数</dt><dd>${batch.files_seen}</dd></div>
      <div><dt>入库 / 隔离</dt><dd>${batch.intakes} / ${batch.quarantined}</dd></div>
      <div><dt>重复 / 等待稳定</dt><dd>${batch.duplicates} / ${batch.deferred}</dd></div>
      <div><dt>缺失 / 恢复</dt><dd>${batch.missing} / ${batch.recovered}</dd></div>
      <div><dt>失败</dt><dd>${batch.errors}</dd></div>
    </dl>
    ${batch.note ? `<div class="info-box">${esc(batch.note)}</div>` : ''}
    <h3>文件明细</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>文件</th><th>结果</th><th>说明</th><th>哈希</th></tr></thead>
        <tbody>${batch.files.map((f) => `
          <tr>
            <td class="mono truncate" title="${esc(f.path)}">${esc(f.name)}</td>
            <td>${fileStatusBadge(f.status)}</td>
            <td class="secondary">${esc(f.detail ?? '—')}</td>
            <td class="mono">${f.hash ? esc(shortHash(f.hash)) : '—'}${f.intake_id ? `<br><button class="linkbtn" data-intake="${esc(f.intake_id)}">查看接入</button>` : ''}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
  `, {
    onMount(body) {
      body.querySelectorAll('[data-intake]').forEach((el) =>
        el.addEventListener('click', () => showIntake(el.dataset.intake)));
    },
  });
}

async function showIntake(id) {
  const data = await api(`/api/intakes/${encodeURIComponent(id)}`);
  const intake = data.intake;
  const doc = data.document?.document;
  openDrawer(`
    <h2>接入记录</h2>
    <div class="subtitle mono">${esc(intake.id)}</div>
    <dl class="kv">
      <div><dt>结果</dt><dd>${fileStatusBadge(intake.status === 'ingested' ? 'ingested' : intake.status === 'duplicate' ? 'duplicate' : 'quarantined')}</dd></div>
      <div><dt>文件哈希</dt><dd class="hash">${esc(intake.content_hash)}</dd></div>
      <div><dt>大小</dt><dd>${intake.size.toLocaleString()} 字节</dd></div>
      <div><dt>解析器</dt><dd class="mono">${esc(intake.parser_key ?? '—')} ${intake.parser_version ? `v${esc(intake.parser_version)}` : ''}</dd></div>
      <div><dt>时间</dt><dd>${ts(intake.created_at)}</dd></div>
      <div><dt>说明</dt><dd>${esc(intake.reason ?? '—')}</dd></div>
    </dl>
    ${doc ? `<div class="info-box">对应发票 <button class="linkbtn" data-doc="${esc(doc.id)}">${esc(doc.invoice_number ?? doc.id)}</button> · ${stateBadge(doc.state)}</div>` : ''}
    ${intake.duplicate_of_document_id ? `<div class="info-box">与已存在发票 <span class="mono">${esc(intake.duplicate_of_document_id)}</span> 内容或业务键重复。</div>` : ''}
    <h3>相同原文哈希的接入尝试（${data.attempts.length}）</h3>
    <ul class="timeline">
      ${data.attempts.map((a) => `
        <li class="${a.status === 'ingested' ? 'is-run' : a.status === 'duplicate' ? '' : 'is-bad'}">
          <div class="t-head">${fileStatusBadge(a.status === 'ingested' ? 'ingested' : a.status)} <span class="mono">${esc(a.id)}</span></div>
          <div class="t-meta">${ts(a.created_at)}${a.batch_id ? ` · 批次 ${esc(a.batch_id)}` : ''}</div>
        </li>`).join('')}
    </ul>
  `, {
    onMount(body) {
      body.querySelector('[data-doc]')?.addEventListener('click', (e) => showDocument(e.target.dataset.doc));
    },
  });
}

// ------------------------------------------------------------------ documents

views.documents = async (root) => {
  const params = new URLSearchParams(location.search);
  const state = params.get('state') ?? '';
  const q = params.get('q') ?? '';
  const query = new URLSearchParams({ limit: '100' });
  if (state) query.set('state', state);
  if (q) query.set('q', q);
  await new Promise((r) => setTimeout(r, 0));
  const data = await api(`/api/documents?${query}`);

  root.innerHTML = `
    <div class="section-head">
      <div>
        <h2>发票</h2>
        <p>每份发票保留原文哈希、结构化字段与产生该结果的解析器版本。已确认的发票不会被重放或重复文件覆盖。</p>
      </div>
    </div>
    <form class="filters" id="doc-filters">
      <input type="search" name="q" placeholder="搜索发票号 / 供应商 / 哈希 / 文件名" value="${esc(q)}">
      <select name="state">
        <option value="">全部状态</option>
        ${['received', 'confirmed', 'quarantined', 'rejected'].map((s) => `<option value="${s}" ${state === s ? 'selected' : ''}>${({ received: '已接收', confirmed: '已确认', quarantined: '隔离中', rejected: '已拒绝' })[s]}</option>`).join('')}
      </select>
      <button class="btn btn-ghost btn-sm" type="submit">筛选</button>
      <span class="spacer"></span>
      <span class="muted" style="font-size:12px">${data.total} 份</span>
    </form>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>发票号</th><th>供应商</th><th>开票日期</th><th class="num">含税总额</th>
            <th>解析器</th><th>状态</th><th>原文哈希</th><th>接入时间</th>
          </tr></thead>
          <tbody>
            ${data.items.map((d) => `
              <tr>
                <td><button class="linkbtn" data-doc="${esc(d.id)}">${esc(d.invoice_number ?? '（无发票号）')}</button>
                  ${d.open_quarantine ? `<span class="badge warn" title="有待处理隔离项"><span class="ico" aria-hidden="true">▲</span>${d.open_quarantine}</span>` : ''}</td>
                <td>${esc(d.supplier_name ?? '—')}</td>
                <td class="mono">${esc(d.issue_date ?? '—')}</td>
                <td class="num">${money(d.fields?.grossAmount)} ${esc(d.currency ?? '')}</td>
                <td class="mono">${esc(d.parser_key ?? '—')} v${esc(d.parser_version ?? '?')}</td>
                <td>${stateBadge(d.state)}</td>
                <td class="mono" title="${esc(d.content_hash)}">${esc(shortHash(d.content_hash))}</td>
                <td class="nowrap secondary">${ts(d.created_at)}</td>
              </tr>`).join('') || '<tr><td colspan="8" class="empty">没有匹配的发票</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;

  root.querySelector('#doc-filters').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const next = new URLSearchParams();
    if (fd.get('q')) next.set('q', fd.get('q'));
    if (fd.get('state')) next.set('state', fd.get('state'));
    history.replaceState(null, '', `${location.pathname}${next.toString() ? `?${next}` : ''}#documents`);
    render();
  });
  root.querySelectorAll('[data-doc]').forEach((el) =>
    el.addEventListener('click', () => showDocument(el.dataset.doc)));
};

async function showDocument(id) {
  const data = await api(`/api/documents/${encodeURIComponent(id)}`);
  const doc = data.document;
  const baseline = data.runs.find((r) => r.id === data.baseline_run_id) ?? null;
  const latest = data.runs.find((r) => r.id === data.latest_run_id) ?? null;
  const diff = latest?.diff ?? [];
  const fields = doc.confirmed_fields ?? doc.fields ?? {};
  const issues = latest?.issues ?? [];
  const openItems = data.quarantine.filter((q) => q.status === 'open');

  const actions = doc.state === 'confirmed'
    ? `<span class="badge good"><span class="ico" aria-hidden="true">●</span>已确认，字段不会被覆盖</span>`
    : `<button class="btn" id="confirm-doc">确认发票</button>
       <button class="btn btn-danger" id="reject-doc">拒绝</button>`;

  openDrawer(`
    <h2>${esc(doc.invoice_number ?? '（无发票号）')}</h2>
    <div class="subtitle">${esc(doc.supplier_name ?? '—')} · ${stateBadge(doc.state)}</div>

    <div class="form-actions" style="margin-bottom:12px">${actions}</div>

    ${doc.state === 'confirmed'
      ? `<div class="info-box">确认于 ${ts(doc.confirmed_at)}（${esc(doc.confirmed_by ?? '—')}）${doc.confirmed_note ? ` · ${esc(doc.confirmed_note)}` : ''}。解析器升级后的重放只做比对，不会覆盖此处字段。</div>`
      : ''}

    ${openItems.length ? `<div class="error-box">有 ${openItems.length} 条待处理隔离记录：${openItems.map((q) => kindBadge(q.kind)).join(' ')}</div>` : ''}

    <h3>结构化字段 <span class="muted" style="font-weight:400;font-size:12px">（${doc.state === 'confirmed' ? '确认值' : '最新解析'}）</span></h3>
    <div class="card"><div class="card-body">
      <dl class="kv">
        <div><dt>发票号</dt><dd>${fieldValue('invoiceNumber', fields.invoiceNumber)}</dd></div>
        <div><dt>供应商</dt><dd>${fieldValue('supplierName', fields.supplierName)}</dd></div>
        <div><dt>供应商税号</dt><dd class="mono">${fieldValue('supplierTaxId', fields.supplierTaxId)}</dd></div>
        <div><dt>开票日期</dt><dd class="mono">${fieldValue('issueDate', fields.issueDate)}</dd></div>
        <div><dt>币种</dt><dd>${fieldValue('currency', fields.currency)}</dd></div>
        <div><dt>净额</dt><dd class="num">${fieldValue('netAmount', fields.netAmount)}</dd></div>
        <div><dt>税额</dt><dd>${fieldValue('taxAmount', fields.taxAmount)}</dd></div>
        <div><dt>含税总额</dt><dd>${fieldValue('grossAmount', fields.grossAmount)}</dd></div>
        <div><dt>红字发票</dt><dd>${fieldValue('creditNote', fields.creditNote)}</dd></div>
        <div><dt>成本中心</dt><dd>${fieldValue('costCenter', fields.costCenter)}</dd></div>
        <div style="grid-column:1/-1"><dt>行金额</dt><dd>${fieldValue('lineAmounts', fields.lineAmounts)}</dd></div>
      </dl>
    </div></div>

    ${diff.length ? `
      <h3>最近一次重放差异 <span class="muted" style="font-weight:400;font-size:12px">（基线 → ${esc(latest.parser_key)} v${esc(latest.parser_version)}）</span></h3>
      <div class="card"><div class="table-wrap"><table class="diff-table">
        <thead><tr><th>字段</th><th>基线值</th><th></th><th>重放值</th></tr></thead>
        <tbody>${diff.map((d) => `
          <tr>
            <td>${esc(fieldLabel(d.field))}</td>
            <td class="diff-before">${fieldValue(d.field, d.before)}</td>
            <td class="arrow" aria-hidden="true">→</td>
            <td class="${d.before === null ? 'diff-add' : 'diff-after'}">${fieldValue(d.field, d.after)}</td>
          </tr>`).join('')}</tbody>
      </table></div></div>
    ` : ''}

    <h3>校验结果</h3>
    ${issues.length ? `<ul class="reasons">${issues.map((i) => `
      <li>
        <div class="r-head">${severityBadge(i.severity)} <span class="r-code">${esc(i.code)}</span>${i.field ? `<span class="muted" style="font-size:12px">${esc(fieldLabel(i.field))}</span>` : ''}</div>
        <div class="r-msg">${esc(i.message)}</div>
      </li>`).join('')}</ul>` : `<div class="info-box">未发现字段缺失或金额不一致。</div>`}

    ${openItems.length ? `
      <h3>隔离记录</h3>
      ${openItems.map((q) => `
        <div class="card" style="margin-bottom:10px"><div class="card-body">
          <div class="r-head">${kindBadge(q.kind)} <span class="muted mono" style="font-size:11px">${esc(q.id)}</span></div>
          <ul class="reasons" style="margin-top:8px">${q.reasons.map((r) => `<li><div class="r-head">${severityBadge(r.severity)} <span class="r-code">${esc(r.code)}</span></div><div class="r-msg">${esc(r.message)}</div></li>`).join('')}</ul>
          <div class="form-actions" style="margin-top:8px">
            <button class="btn btn-sm" data-confirm-q="${esc(q.id)}">接受并确认</button>
            <button class="btn btn-ghost btn-sm" data-resolve-q="${esc(q.id)}">标记已处理</button>
          </div>
        </div></div>`).join('')}
    ` : ''}

    <h3>原文与版本</h3>
    <dl class="kv">
      <div style="grid-column:1/-1"><dt>原文 SHA-256</dt><dd class="hash">${esc(doc.content_hash)}</dd></div>
      <div><dt>归档路径</dt><dd class="mono">${esc(doc.archive_path ?? '—')}</dd></div>
      <div><dt>原始文件</dt><dd class="mono">${esc(doc.original_name ?? '—')}</dd></div>
      <div><dt>解析器</dt><dd class="mono">${esc(doc.parser_key ?? '—')} v${esc(doc.parser_version ?? '?')}</dd></div>
      <div><dt>接入记录</dt><dd class="mono">${esc(data.intakes[0]?.id ?? '—')}</dd></div>
    </dl>

    <h3>解析历史</h3>
    <ul class="timeline">
      ${data.runs.map((r) => `
        <li class="${r.outcome === 'quarantined' || r.outcome?.includes('failed') ? 'is-bad' : r.id === data.latest_run_id ? 'is-run' : ''}">
          <div class="t-head">${outcomeBadge(r.outcome)} <span class="mono">${esc(r.parser_key ?? '—')} v${esc(r.parser_version ?? '?')}</span>
            ${r.trigger === 'replay' ? '<span class="badge info"><span class="ico" aria-hidden="true">◆</span>重放</span>' : ''}
            ${r.id === data.baseline_run_id ? '<span class="badge neutral">基线</span>' : ''}
          </div>
          <div class="t-meta">${ts(r.created_at)} · ${esc(r.id)}${r.compared_run_id ? ` · 对比 ${esc(r.compared_run_id)}` : ''}</div>
          ${r.error_message ? `<div class="r-msg">${esc(r.error_message)}</div>` : ''}
          ${r.diff?.length ? `<div class="r-msg">差异 ${r.diff.length} 项：${r.diff.map((d) => fieldLabel(d.field)).join('、')}</div>` : ''}
        </li>`).join('') || '<li class="muted">无解析记录</li>'}
    </ul>

    <h3>接入尝试</h3>
    <ul class="timeline">
      ${data.intakes.map((i) => `
        <li>
          <div class="t-head">${fileStatusBadge(i.status === 'ingested' ? 'ingested' : i.status)} <span class="mono">${esc(i.id)}</span></div>
          <div class="t-meta">${ts(i.created_at)} · ${esc(i.batch_trigger ?? '直接接入')}${i.reason ? ` · ${esc(i.reason)}` : ''}</div>
        </li>`).join('') || '<li class="muted">无接入记录</li>'}
    </ul>
  `, {
    onMount(body) {
      body.querySelector('#confirm-doc')?.addEventListener('click', async (e) => {
        const note = prompt('确认备注（可选）：', '人工确认');
        if (note === null) return;
        try {
          await withButton(e.currentTarget, () => api(`/api/documents/${doc.id}/confirm`, {
            method: 'POST',
            body: { by: 'operator', note },
          }));
          toast('已确认，字段已锁定');
          closeDrawer();
          render();
        } catch (err) { toast(err.message, { error: true }); }
      });
      body.querySelector('#reject-doc')?.addEventListener('click', async (e) => {
        const note = prompt('拒绝原因（可选）：', '人工拒绝');
        if (note === null) return;
        try {
          await withButton(e.currentTarget, () => api(`/api/documents/${doc.id}/reject`, {
            method: 'POST', body: { by: 'operator', note },
          }));
          toast('已拒绝');
          closeDrawer();
          render();
        } catch (err) { toast(err.message, { error: true }); }
      });
      body.querySelectorAll('[data-confirm-q]').forEach((el) => el.addEventListener('click', async () => {
        try {
          await api(`/api/quarantine/${el.dataset.confirmQ}/confirm-document`, { method: 'POST', body: { by: 'operator' } });
          toast('已接受并确认');
          closeDrawer();
          render();
        } catch (err) { toast(err.message, { error: true }); }
      }));
      body.querySelectorAll('[data-resolve-q]').forEach((el) => el.addEventListener('click', async () => {
        try {
          await api(`/api/quarantine/${el.dataset.resolveQ}/resolve`, { method: 'POST', body: { resolution: 'dismissed', by: 'operator' } });
          toast('隔离项已处理');
          closeDrawer();
          render();
        } catch (err) { toast(err.message, { error: true }); }
      }));
    },
  });
}

// ------------------------------------------------------------------ quarantine

views.quarantine = async (root) => {
  const params = new URLSearchParams(location.search);
  const status = params.get('qstatus') ?? 'open';
  const kind = params.get('kind') ?? '';
  const query = new URLSearchParams({ status, limit: '200' });
  if (kind) query.set('kind', kind);
  const [items, allOpen] = await Promise.all([
    api(`/api/quarantine?${query}`),
    api('/api/quarantine?status=all&limit=500'),
  ]);
  const kinds = [...new Set(allOpen.map((i) => i.kind))];

  root.innerHTML = `
    <div class="section-head">
      <div>
        <h2>人工隔离队列</h2>
        <p>字段缺失、金额校验不一致、损坏文件、未知供应商、重复文件与重放差异都进入这里。已确认的发票不会因为重放而变化，差异以隔离项提示复核。</p>
      </div>
    </div>
    <form class="filters" id="q-filters">
      <select name="qstatus">
        <option value="open" ${status === 'open' ? 'selected' : ''}>待处理</option>
        <option value="resolved" ${status === 'resolved' ? 'selected' : ''}>已处理</option>
        <option value="all" ${status === 'all' ? 'selected' : ''}>全部</option>
      </select>
      <select name="kind">
        <option value="">全部类型</option>
        ${kinds.map((k) => `<option value="${esc(k)}" ${kind === k ? 'selected' : ''}>${esc(kindLabel(k))}</option>`).join('')}
      </select>
      <button class="btn btn-ghost btn-sm" type="submit">筛选</button>
      <span class="spacer"></span>
      <span class="muted" style="font-size:12px">${items.length} 条</span>
    </form>
    <div class="card">
      ${items.length === 0
        ? '<div class="empty">队列为空</div>'
        : `<ul class="qlist">${items.map((item) => `
          <li>
            <div class="q-main">
              <div class="q-title">
                ${kindBadge(item.kind)}
                ${item.invoice_number ? `<span>${esc(item.invoice_number)}</span>` : item.file_name ? `<span class="mono">${esc(item.file_name)}</span>` : ''}
                ${item.document_state ? stateBadge(item.document_state) : ''}
                ${item.status === 'resolved' ? `<span class="badge neutral">已处理${item.resolution ? `：${esc(item.resolution)}` : ''}</span>` : ''}
              </div>
              <div class="q-msg">${item.reasons.map((r) => esc(r.message)).join('；')}</div>
              <div class="q-meta">${ts(item.created_at)}${item.batch_trigger ? ` · 批次触发 ${esc(item.batch_trigger)}` : ''} · ${esc(item.id)}</div>
            </div>
            <div class="actions nowrap">
              <button class="btn btn-ghost btn-sm" data-open-q="${esc(item.id)}">查看</button>
            </div>
          </li>`).join('')}</ul>`}
    </div>
  `;

  root.querySelector('#q-filters').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const next = new URLSearchParams();
    if (fd.get('qstatus') !== 'open') next.set('qstatus', fd.get('qstatus'));
    if (fd.get('kind')) next.set('kind', fd.get('kind'));
    history.replaceState(null, '', `${location.pathname}${next.toString() ? `?${next}` : ''}#quarantine`);
    render();
  });
  root.querySelectorAll('[data-open-q]').forEach((el) =>
    el.addEventListener('click', () => showQuarantine(el.dataset.openQ)));
};

async function showQuarantine(id) {
  const item = await api(`/api/quarantine/${encodeURIComponent(id)}`);
  const docData = item.document_id ? await api(`/api/documents/${encodeURIComponent(item.document_id)}`) : null;
  const doc = docData?.document ?? null;
  const latestRun = docData?.runs.find((r) => r.id === docData.latest_run_id);
  const open = item.status === 'open';

  openDrawer(`
    <h2>隔离项</h2>
    <div class="subtitle">${kindBadge(item.kind)} ${stateBadge(item.status)} ${item.file_name ? `<span class="mono">${esc(item.file_name)}</span>` : ''}</div>
    ${item.file_status === 'missing' ? '<div class="error-box">该文件目前已不在监控目录中，归档原文仍可复核。</div>' : ''}

    <dl class="kv">
      <div><dt>触发时间</dt><dd>${ts(item.created_at)}</dd></div>
      <div><dt>来源批次</dt><dd>${item.batch_trigger ? `${esc(item.batch_trigger)} · ${ts(item.batch_started_at)}` : '—'}</dd></div>
      <div><dt>发票</dt><dd>${doc ? `<button class="linkbtn" data-doc="${esc(doc.id)}">${esc(doc.invoice_number ?? doc.id)}</button>` : '—'}</dd></div>
      <div><dt>文件</dt><dd class="mono truncate">${esc(item.file_path ?? '—')}</dd></div>
      <div><dt>原文哈希</dt><dd class="hash">${esc(item.content_hash ?? '—')}</dd></div>
      <div><dt>当前状态</dt><dd>${doc ? stateBadge(doc.state) : '—'}</dd></div>
    </dl>

    <h3>原因</h3>
    <ul class="reasons">${item.reasons.map((r) => `
      <li>
        <div class="r-head">${severityBadge(r.severity)} <span class="r-code">${esc(r.code)}</span>${r.field ? `<span class="muted" style="font-size:12px">${esc(fieldLabel(r.field))}</span>` : ''}</div>
        <div class="r-msg">${esc(r.message)}</div>
        ${r.meta && r.meta.deltaCents !== undefined ? `<div class="r-msg mono" style="font-size:12px">差额 ${money(r.meta.deltaCents)} · 净额 ${money(r.meta.netAmount)} + 税额 ${money(r.meta.taxAmount)} = ${money(r.meta.computed)}，票面总额 ${money(r.meta.grossAmount)}</div>` : ''}
        ${r.meta && r.meta.diff ? `<div class="r-msg mono" style="font-size:12px">${r.meta.diff.map((d) => `${fieldLabel(d.field)}: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}`).map(esc).join('<br>')}</div>` : ''}
      </li>`).join('')}</ul>

    ${doc ? `
      <h3>${doc.state === 'confirmed' ? '已确认字段（不会被覆盖）' : '当前解析字段'}</h3>
      <div class="card"><div class="card-body">
        <dl class="kv">
          ${['invoiceNumber', 'supplierName', 'issueDate', 'currency', 'netAmount', 'taxAmount', 'grossAmount'].map((f) => `
            <div><dt>${fieldLabel(f)}</dt><dd>${fieldValue(f, (doc.confirmed_fields ?? doc.fields ?? {})[f])}</dd></div>`).join('')}
        </dl>
      </div></div>
    ` : ''}

    ${open ? `
      <h3>处理</h3>
      <div class="note-form">
        <textarea id="resolution-note" placeholder="处理备注（可选）"></textarea>
        <div class="form-actions">
          ${doc && doc.state !== 'confirmed' && item.kind !== 'confirmed_drift' ? '<button class="btn" id="q-accept">接受并确认</button>' : ''}
          <button class="btn btn-ghost" id="q-resolve">标记已处理</button>
          ${doc ? '<button class="btn btn-ghost" id="q-doc">打开发票</button>' : ''}
        </div>
      </div>
    ` : `
      <div class="info-box">已于 ${ts(item.resolved_at)} 处理为 <strong>${esc(item.resolution ?? '—')}</strong>（${esc(item.resolved_by ?? '—')}）${item.resolution_note ? ` · ${esc(item.resolution_note)}` : ''}</div>
      ${doc ? `<div class="form-actions"><button class="btn btn-ghost" id="q-doc">打开发票</button><button class="btn btn-ghost" id="q-reopen">重新打开</button></div>` : ''}
    `}

    ${docData ? `
      <h3>解析历史</h3>
      <ul class="timeline">${docData.runs.map((r) => `
        <li class="${r.id === docData.latest_run_id ? 'is-run' : ''}">
          <div class="t-head">${outcomeBadge(r.outcome)} <span class="mono">${esc(r.parser_key ?? '—')} v${esc(r.parser_version ?? '?')}</span>${r.trigger === 'replay' ? '<span class="badge info"><span class="ico" aria-hidden="true">◆</span>重放</span>' : ''}</div>
          <div class="t-meta">${ts(r.created_at)}</div>
        </li>`).join('')}</ul>
    ` : ''}
  `, {
    onMount(body) {
      const note = () => body.querySelector('#resolution-note')?.value.trim() || null;
      body.querySelector('#q-accept')?.addEventListener('click', async (e) => {
        try {
          await withButton(e.currentTarget, () => api(`/api/quarantine/${item.id}/confirm-document`, { method: 'POST', body: { by: 'operator', note: note() } }));
          toast('已接受并确认发票');
          closeDrawer();
          render();
        } catch (err) { toast(err.message, { error: true }); }
      });
      body.querySelector('#q-resolve')?.addEventListener('click', async (e) => {
        try {
          await withButton(e.currentTarget, () => api(`/api/quarantine/${item.id}/resolve`, { method: 'POST', body: { resolution: 'dismissed', by: 'operator', note: note() } }));
          toast('隔离项已处理');
          closeDrawer();
          render();
        } catch (err) { toast(err.message, { error: true }); }
      });
      body.querySelector('#q-reopen')?.addEventListener('click', async (e) => {
        try {
          await withButton(e.currentTarget, () => api(`/api/quarantine/${item.id}/reopen`, { method: 'POST', body: { by: 'operator' } }));
          toast('已重新打开');
          closeDrawer();
          render();
        } catch (err) { toast(err.message, { error: true }); }
      });
      body.querySelector('#q-doc')?.addEventListener('click', () => showDocument(doc.id));
      body.querySelector('[data-doc]')?.addEventListener('click', () => showDocument(doc.id));
    },
  });
}

// ------------------------------------------------------------------ replays

views.replays = async (root) => {
  const data = await api('/api/replays?limit=30');
  root.innerHTML = `
    <div class="section-head">
      <div>
        <h2>解析器重放</h2>
        <p>重放会从归档中读回原文并校验哈希，再用指定版本重新解析，逐字段对比基线与重放结果。已确认的发票只记录差异，不修改已确认结果。</p>
      </div>
      <div class="actions"><button class="btn btn-ghost" id="replay-page-btn">新建重放</button></div>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>开始时间</th><th>解析器</th><th>版本</th><th>触发</th><th>状态</th>
            <th class="num">扫描</th><th class="num">变化</th><th class="num">恢复</th><th class="num">隔离</th><th class="num">跳过</th><th class="num">失败</th>
          </tr></thead>
          <tbody>
            ${data.jobs.map((j) => `
              <tr>
                <td class="nowrap"><button class="linkbtn" data-replay="${esc(j.id)}">${ts(j.started_at)}</button></td>
                <td class="mono">${esc(j.parser_key)}</td>
                <td class="mono">${esc(j.from_version ?? '?')} → ${esc(j.to_version)}</td>
                <td>${esc(j.trigger)}</td>
                <td>${stateBadge(j.status)}</td>
                <td class="num">${j.documents_scanned}</td>
                <td class="num">${j.documents_changed}</td>
                <td class="num delta-pos">${j.documents_recovered}</td>
                <td class="num delta-neg">${j.documents_quarantined}</td>
                <td class="num">${j.documents_skipped}</td>
                <td class="num">${j.failures}</td>
              </tr>`).join('') || '<tr><td colspan="11" class="empty">尚未执行重放</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
  root.querySelectorAll('[data-replay]').forEach((el) =>
    el.addEventListener('click', () => showReplay(el.dataset.replay)));
  root.querySelector('#replay-page-btn').addEventListener('click', openReplayDialog);
};

async function showReplay(id) {
  const job = await api(`/api/replays/${encodeURIComponent(id)}`);
  const changed = job.items.filter((i) => i.outcome !== 'unchanged' && i.outcome !== 'confirmed_match');
  openDrawer(`
    <h2>重放 ${esc(job.parser_key)} v${esc(job.to_version)}</h2>
    <div class="subtitle">${ts(job.started_at)} · 触发 ${esc(job.trigger)} · 自 v${esc(job.from_version ?? '?')}</div>
    <dl class="kv">
      <div><dt>扫描</dt><dd>${job.documents_scanned}</dd></div>
      <div><dt>字段变化</dt><dd>${job.documents_changed}</dd></div>
      <div><dt>从隔离恢复</dt><dd class="delta-pos">${job.documents_recovered}</dd></div>
      <div><dt>新进入隔离</dt><dd class="delta-neg">${job.documents_quarantined}</dd></div>
      <div><dt>与确认一致（跳过）</dt><dd>${job.documents_skipped}</dd></div>
      <div><dt>失败</dt><dd>${job.failures}</dd></div>
    </dl>
    <h3>逐份发票结果</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>发票</th><th>结果</th><th>变化字段</th><th>说明</th></tr></thead>
        <tbody>
          ${job.items.map((i) => `
            <tr>
              <td><button class="linkbtn" data-doc="${esc(i.document_id)}">${esc(i.invoice_number ?? i.document_id)}</button></td>
              <td>${outcomeBadge(i.outcome)}</td>
              <td>${i.diff?.length ? i.diff.map((d) => `
                <div style="font-size:12.5px;margin:2px 0">
                  <span class="muted">${esc(fieldLabel(d.field))}</span>：
                  <span class="diff-before">${fieldValue(d.field, d.before)}</span>
                  <span class="arrow" aria-hidden="true">→</span>
                  <span class="diff-after">${fieldValue(d.field, d.after)}</span>
                </div>`).join('') : '<span class="muted">—</span>'}</td>
              <td class="secondary">${esc(i.reason ?? '—')}</td>
            </tr>`).join('') || '<tr><td colspan="4" class="empty">没有匹配的发票</td></tr>'}
        </tbody>
      </table>
    </div>
    ${changed.length ? `<div class="info-box">共 ${changed.length} 份发票受本次重放影响。已确认发票若出现差异会以「确认后差异」隔离项提示复核。</div>` : ''}
  `, {
    onMount(body) {
      body.querySelectorAll('[data-doc]').forEach((el) => el.addEventListener('click', () => showDocument(el.dataset.doc)));
    },
  });
}

async function openReplayDialog() {
  const { parsers } = await api('/api/parsers');
  openDrawer(`
    <h2>新建重放</h2>
    <div class="subtitle">对历史文件用指定解析器版本重新解析，并与基线逐字段比较。</div>
    <div class="card"><div class="card-body">
      <div class="note-form">
        <label>解析器
          <select id="replay-parser">${parsers.map((p) => `<option value="${esc(p.key)}">${esc(p.key)} · ${esc(p.supplierName)}（当前 v${esc(p.activeVersion)}）</option>`).join('')}</select>
        </label>
        <label>目标版本 <select id="replay-version"></select></label>
        <div class="form-actions"><button class="btn" id="replay-run">执行重放</button></div>
        <div class="muted" style="font-size:12px">重放不会改变已确认发票的字段；校验不通过的发票会保持或进入隔离队列。</div>
      </div>
    </div></div>
  `, {
    onMount(body) {
      const parserSel = body.querySelector('#replay-parser');
      const versionSel = body.querySelector('#replay-version');
      const fill = () => {
        const parser = parsers.find((p) => p.key === parserSel.value);
        versionSel.innerHTML = parser.versions.map((v) => `<option value="${esc(v)}" ${v === parser.activeVersion ? 'selected' : ''}>v${esc(v)}${v === parser.activeVersion ? '（当前）' : ''}</option>`).join('');
      };
      fill();
      parserSel.addEventListener('change', fill);
      body.querySelector('#replay-run').addEventListener('click', async (e) => {
        try {
          await withButton(e.currentTarget, () => api('/api/replays', {
            method: 'POST',
            body: { parserKey: parserSel.value, toVersion: versionSel.value },
          }));
          toast('重放完成');
          closeDrawer();
          render();
        } catch (err) { toast(err.message, { error: true }); }
      });
    },
  });
}

// ------------------------------------------------------------------ parsers

views.parsers = async (root) => {
  const { parsers } = await api('/api/parsers');
  root.innerHTML = `
    <div class="section-head">
      <div>
        <h2>解析器</h2>
        <p>每个供应商规则有独立版本。切换版本会按配置自动触发历史重放，并把解析器版本记录到每次解析结果上。</p>
      </div>
    </div>
    <div class="grid-2">
      ${parsers.map((p) => `
        <div class="card">
          <div class="card-head">
            <h3>${esc(p.supplierName)}</h3>
            <span class="badge info">v${esc(p.activeVersion)}</span>
          </div>
          <div class="card-body">
            <dl class="kv">
              <div><dt>标识</dt><dd class="mono">${esc(p.key)}</dd></div>
              <div><dt>通道</dt><dd>${p.channel.toUpperCase()}</dd></div>
              <div><dt>可用版本</dt><dd class="mono">${p.versions.map((v) => `v${v}`).join(' · ')}</dd></div>
            </dl>
            <div class="form-actions" style="margin-top:12px">
              ${p.versions.map((v) => `
                <button class="btn ${v === p.activeVersion ? 'btn-ghost' : ''} btn-sm" data-parser-key="${esc(p.key)}" data-version="${esc(v)}" ${v === p.activeVersion ? 'disabled' : ''}>
                  ${v === p.activeVersion ? `当前 v${esc(v)}` : `升级到 v${esc(v)} 并重放`}
                </button>`).join('')}
            </div>
          </div>
        </div>`).join('')}
    </div>
  `;
  root.querySelectorAll('[data-parser-key]').forEach((el) => el.addEventListener('click', async () => {
    const key = el.dataset.parserKey;
    const { version } = el.dataset;
    if (!confirm(`将 ${key} 切换到 v${version} 并重放所有历史文件？已确认发票不会被覆盖。`)) return;
    try {
      const result = await withButton(el, () => api(`/api/parsers/${encodeURIComponent(key)}/version`, {
        method: 'POST', body: { version },
      }));
      const job = result.replayJob;
      toast(`${key} 已切换到 v${version}${job ? `，重放 ${job.documents_scanned} 份，变化 ${job.documents_changed}，恢复 ${job.documents_recovered}` : ''}`);
      render();
    } catch (err) { toast(err.message, { error: true }); }
  }));
};

// ------------------------------------------------------------------ activity

views.activity = async (root) => {
  const [events, files] = await Promise.all([api('/api/events?limit=200'), api('/api/source-files?limit=100')]);
  root.innerHTML = `
    <div class="section-head">
      <div>
        <h2>事件日志</h2>
        <p>扫描、接入、重复、缺失与目录恢复、隔离与确认、解析器升级与重放都会留下事件。</p>
      </div>
    </div>
    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h3>最近事件</h3><span class="muted">${events.length} 条</span></div>
        <div class="table-wrap" style="max-height:640px;overflow:auto">
          <table>
            <thead><tr><th>时间</th><th>类型</th><th>说明</th></tr></thead>
            <tbody>${events.map((e) => `
              <tr>
                <td class="nowrap secondary">${ts(e.at)}</td>
                <td class="mono">${esc(e.kind)}</td>
                <td>${esc(e.message)}${e.ref_id ? `<div class="t-meta mono">${esc(e.ref_id)}</div>` : ''}</td>
              </tr>`).join('') || '<tr><td colspan="3" class="empty">暂无事件</td></tr>'}</tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>监控目录中的文件</h3><span class="muted">含历史缺失文件</span></div>
        <div class="table-wrap" style="max-height:640px;overflow:auto">
          <table>
            <thead><tr><th>文件</th><th>状态</th><th>最后处理哈希</th><th>更新时间</th></tr></thead>
            <tbody>${files.map((f) => `
              <tr>
                <td class="mono truncate" title="${esc(f.path)}">${esc(f.name)}</td>
                <td>${stateBadge(f.status)}</td>
                <td class="mono">${f.last_processed_hash ? `<span title="${esc(f.last_processed_hash)}">${esc(shortHash(f.last_processed_hash))}</span>` : '—'}</td>
                <td class="secondary nowrap">${ts(f.updated_at)}</td>
              </tr>`).join('') || '<tr><td colspan="4" class="empty">尚未观察到文件</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    </div>
  `;
};

// ------------------------------------------------------------------ toolbar

function bindScanButton() {
  const btn = document.getElementById('scan-now');
  if (btn.dataset.bound) return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', async () => {
    try {
      await withButton(btn, () => api('/api/scan', { method: 'POST', body: { trigger: 'manual' } }));
      toast('扫描完成');
      render();
    } catch (err) { toast(err.message, { error: true }); }
  });
}

document.getElementById('run-replay').addEventListener('click', openReplayDialog);

async function refreshHealth() {
  const pill = document.getElementById('watch-pill');
  try {
    health = await api('/api/health');
    pill.classList.remove('is-down');
    pill.innerHTML = `<span class="dot"></span>${esc(health.watchDir)}`;
    pill.title = `监控目录 ${health.watchDir}\n归档 ${health.archiveDir}`;
  } catch {
    pill.classList.add('is-down');
    pill.innerHTML = '<span class="dot"></span>服务不可用';
  }
}

// Light polling so new batches appear without a manual refresh.
let pollTimer = null;
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (document.hidden || !drawer.hidden) return;
    if (currentTab === 'overview' || currentTab === 'batches' || currentTab === 'quarantine') render();
  }, 15000);
}

await refreshHealth();
await render();
bindScanButton();
startPolling();
