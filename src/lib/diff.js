// Labels are stored with each diff entry so a replay report can be audited
// without the UI translating field names after the fact.
const FIELD_LABELS = {
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
};

export function fieldLabel(field) {
  return FIELD_LABELS[field] ?? field;
}

const SCALAR_FIELDS = ['invoiceNumber', 'supplierName', 'supplierTaxId', 'issueDate', 'currency', 'netAmount', 'taxAmount', 'grossAmount', 'creditNote', 'costCenter'];

/**
 * Compare two sets of parsed fields. Returns one entry per difference with the
 * before/after values, so the UI can render a before/after table and replay
 * reports can be audited without replaying again.
 */
export function diffFields(before, after) {
  const a = before ?? {};
  const b = after ?? {};
  const out = [];
  for (const field of SCALAR_FIELDS) {
    const prev = a[field] ?? null;
    const next = b[field] ?? null;
    if (JSON.stringify(prev) !== JSON.stringify(next)) {
      out.push({ field, label: fieldLabel(field), before: prev, after: next, kind: 'field' });
    }
  }
  const prevLines = Array.isArray(a.lineAmounts) ? a.lineAmounts : [];
  const nextLines = Array.isArray(b.lineAmounts) ? b.lineAmounts : [];
  if (JSON.stringify(prevLines) !== JSON.stringify(nextLines)) {
    out.push({
      field: 'lineAmounts',
      label: '行金额',
      before: prevLines,
      after: nextLines,
      kind: 'list',
    });
  }
  return out;
}

export function isEmptyDiff(diff) {
  return !diff || diff.length === 0;
}
