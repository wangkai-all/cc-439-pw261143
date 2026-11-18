/* Fetches and small formatting helpers shared by all views. */

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { error: text }; }
  }
  if (!res.ok) {
    const err = new Error(data?.error ?? `请求失败 (${res.status})`);
    err.status = res.status;
    err.details = data?.details;
    throw err;
  }
  return data;
}

export function esc(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function money(cents) {
  if (cents === null || cents === undefined) return '—';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

export function shortHash(hash) {
  if (!hash) return '—';
  return `${hash.slice(0, 10)}…${hash.slice(-4)}`;
}

export function ts(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
 return formatLocal(d);
}

function formatLocal(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function relTime(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return esc(iso);
  const abs = Math.abs(diff);
  const units = [
    [86_400_000, '天'], [3_600_000, '小时'], [60_000, '分钟'], [1_000, '秒'],
  ];
  for (const [ms, label] of units) {
    if (abs >= ms) return `${Math.floor(abs / ms)} ${label}${diff < 0 ? '后' : '前'}`;
  }
  return '刚刚';
}

const STATE_LABELS = {
  received: ['已接收', 'good'],
  confirmed: ['已确认', 'good'],
  quarantined: ['隔离中', 'warn'],
  rejected: ['已拒绝', 'crit'],
  active: ['在目录中', 'good'],
  missing: ['已缺失', 'warn'],
  open: ['待处理', 'warn'],
  resolved: ['已处理', 'neutral'],
  running: ['进行中', 'info'],
  completed: ['完成', 'neutral'],
  failed: ['失败', 'crit'],
};

export function stateBadge(state, labelOverride) {
  const [label, tone] = STATE_LABELS[state] ?? [state ?? '—', 'neutral'];
  const icon = tone === 'good' ? '●' : tone === 'warn' ? '▲' : tone === 'crit' ? '■' : tone === 'info' ? '◆' : '○';
  return `<span class="badge ${tone}"><span class="ico" aria-hidden="true">${icon}</span>${esc(labelOverride ?? label)}</span>`;
}

const FILE_STATUS = {
  ingested: ['已入库', 'good'],
  quarantined: ['隔离', 'warn'],
  duplicate: ['重复', 'info'],
  deferred: ['等待稳定', 'neutral'],
  unchanged: ['无变化', 'neutral'],
  ignored: ['未监控', 'neutral'],
  missing: ['缺失', 'warn'],
  error: ['错误', 'crit'],
};

export function fileStatusBadge(status) {
  const [label, tone] = FILE_STATUS[status] ?? [status, 'neutral'];
  const icon = tone === 'good' ? '●' : tone === 'warn' ? '▲' : tone === 'crit' ? '■' : tone === 'info' ? '◆' : '○';
  return `<span class="badge ${tone}"><span class="ico" aria-hidden="true">${icon}</span>${esc(label)}</span>`;
}

const OUTCOME = {
  parsed: ['解析成功', 'good'],
  quarantined: ['校验未通过', 'warn'],
  updated: ['已更新', 'info'],
  unchanged: ['无变化', 'neutral'],
  recovered: ['已恢复', 'good'],
  confirmed_match: ['与确认一致', 'good'],
  confirmed_drift: ['与确认不一致', 'crit'],
  parse_failed: ['解析失败', 'crit'],
  integrity_error: ['原文完整性错误', 'crit'],
  failed: ['执行失败', 'crit'],
};

export function outcomeBadge(outcome) {
  const [label, tone] = OUTCOME[outcome] ?? [outcome, 'neutral'];
  const icon = tone === 'good' ? '●' : tone === 'warn' ? '▲' : tone === 'crit' ? '■' : tone === 'info' ? '◆' : '○';
  return `<span class="badge ${tone}"><span class="ico" aria-hidden="true">${icon}</span>${esc(label)}</span>`;
}

const KIND = {
  validation: ['字段校验', 'warn'],
  confirmed_drift: ['确认后差异', 'crit'],
  business_duplicate: ['业务重复', 'info'],
  corrupt_file: ['损坏文件', 'crit'],
  unknown_supplier: ['未知供应商', 'crit'],
  unreadable_pdf: ['PDF 不可读', 'crit'],
  unsupported_file: ['不支持的文件', 'neutral'],
  replay_failed: ['重放失败', 'crit'],
};

export function kindLabel(kind) {
  return KIND[kind]?.[0] ?? kind;
}

export function kindBadge(kind) {
  const [label, tone] = KIND[kind] ?? [kind, 'neutral'];
  const icon = tone === 'crit' ? '■' : tone === 'warn' ? '▲' : tone === 'info' ? '◆' : '○';
  return `<span class="badge ${tone}"><span class="ico" aria-hidden="true">${icon}</span>${esc(label)}</span>`;
}

export function severityBadge(severity) {
  if (severity === 'error') return '<span class="badge crit"><span class="ico" aria-hidden="true">■</span>错误</span>';
  if (severity === 'warning') return '<span class="badge warn"><span class="ico" aria-hidden="true">▲</span>警告</span>';
  return '<span class="badge neutral">信息</span>';
}

export function fieldLabel(field) {
  return {
    invoiceNumber: '发票号',
    supplierName: '供应商名称',
    supplierTaxId: '供应商税号',
    issueDate: '开票日期',
    currency: '币种',
    netAmount: '净额',
    taxAmount: '税额',
    grossAmount: '含税总额',
    creditNote: '红字发票',
    costCenter: '成本中心',
    lineAmounts: '行金额',
  }[field] ?? field;
}

export function fieldValue(field, value) {
  if (value === null || value === undefined || value === '') return '<span class="muted">（空）</span>';
  if (field === 'creditNote') return value ? '是' : '否';
  if (field === 'netAmount' || field === 'taxAmount' || field === 'grossAmount') return esc(money(value));
  if (field === 'lineAmounts') {
    return `<span class="mono">[${value.map((v) => (v === null ? '?' : money(v))).join(', ')}]</span>`;
  }
  return esc(value);
}

export function toast(message, { error = false } = {}) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.toggle('is-error', error);
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3600);
}
