/**
 * Validation rules for parsed invoice fields.
 *
 * Severities:
 *   error   - the document cannot be trusted; quarantine it.
 *   warning - record it, but the document may still be accepted.
 *
 * Amounts are integer minor units. Arithmetic checks allow a one-cent
 * tolerance, because suppliers legitimately round line items independently
 * from the tax total.
 */
import { isValidIsoDate } from './util.js';

export const REQUIRED_FIELDS = [
  ['invoiceNumber', '发票号'],
  ['supplierName', '供应商名称'],
  ['issueDate', '开票日期'],
  ['currency', '币种'],
  ['netAmount', '净额'],
  ['taxAmount', '税额'],
  ['grossAmount', '含税总额'],
];

const SUPPORTED_CURRENCIES = new Set(['EUR', 'USD', 'GBP', 'CHF', 'SEK', 'DKK', 'NOK', 'PLN']);

export function validateFields(fields, { supplierName = null, invoiceNumber = null } = {}) {
  const issues = [];
  const add = (severity, code, message, field = null, meta = null) =>
    issues.push({ severity, code, message, field, meta });

  for (const [field, label] of REQUIRED_FIELDS) {
    const value = fields[field];
    if (value === null || value === undefined || value === '') {
      add('error', 'MISSING_FIELD', `缺少${label}`, field);
    }
  }

  if (fields.issueDate && !isValidIsoDate(fields.issueDate)) {
    add('error', 'INVALID_DATE', `开票日期「${fields.issueDate}」不是有效的 ISO 日期`, 'issueDate');
  } else if (fields.issueDate) {
    const date = new Date(`${fields.issueDate}T00:00:00Z`).getTime();
    if (date > Date.now() + 2 * 86_400_000) {
      add('warning', 'FUTURE_DATE', `开票日期 ${fields.issueDate} 晚于今天`, 'issueDate');
    }
  }

  if (fields.currency && !SUPPORTED_CURRENCIES.has(fields.currency)) {
    add('warning', 'UNSUPPORTED_CURRENCY', `币种 ${fields.currency} 不在账套支持范围内`, 'currency');
  }

  for (const key of ['netAmount', 'taxAmount', 'grossAmount']) {
    const value = fields[key];
    if (value === null || value === undefined) continue;
    if (!Number.isSafeInteger(value)) {
      add('error', 'INVALID_AMOUNT', `${key} 不是有效金额`, key);
    }
  }

  const { netAmount, taxAmount, grossAmount } = fields;
  if (Number.isInteger(netAmount) && Number.isInteger(taxAmount) && Number.isInteger(grossAmount)) {
    const computed = netAmount + taxAmount;
    if (Math.abs(computed - grossAmount) > 1) {
      add(
        'error',
        'AMOUNT_MISMATCH',
        `净额 + 税额（${fmt(computed)}）与含税总额（${fmt(grossAmount)}）不一致`,
        'grossAmount',
        { netAmount, taxAmount, grossAmount, computed, deltaCents: grossAmount - computed },
      );
    }
  }

  if (Array.isArray(fields.lineAmounts) && fields.lineAmounts.length > 0 && Number.isInteger(fields.netAmount)) {
    const badLine = fields.lineAmounts.find((v) => !Number.isInteger(v));
    if (badLine !== undefined) {
      add('error', 'INVALID_LINE_AMOUNT', '存在无法解析的行金额', 'lineAmounts');
    } else {
      const sum = fields.lineAmounts.reduce((a, b) => a + b, 0);
      if (Math.abs(sum - fields.netAmount) > 1) {
        add(
          'warning',
          'LINE_SUM_MISMATCH',
          `行金额合计 ${fmt(sum)}，净额为 ${fmt(fields.netAmount)}`,
          'netAmount',
          { lineSum: sum, netAmount: fields.netAmount, deltaCents: fields.netAmount - sum },
        );
      }
    }
  }

  if (fields.invoiceNumber && invoiceNumber && fields.invoiceNumber !== invoiceNumber) {
    add(
      'warning',
      'INVOICE_NUMBER_CHANGED',
      `发票号由 ${invoiceNumber} 变为 ${fields.invoiceNumber}`,
      'invoiceNumber',
    );
  }

  if (fields.supplierName && supplierName && normalizeName(fields.supplierName) !== normalizeName(supplierName)) {
    add(
      'warning',
      'SUPPLIER_NAME_CHANGED',
      `供应商名称由「${supplierName}」变为「${fields.supplierName}」`,
      'supplierName',
    );
  }

  return issues;
}

function normalizeName(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function fmt(cents) {
  return (cents / 100).toFixed(2);
}

export function hasErrors(issues) {
  return issues.some((i) => i.severity === 'error');
}
