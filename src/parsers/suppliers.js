import { children, findAll, findFirst, textOf } from '../lib/xml.js';
import { parseAmount } from '../lib/util.js';

const UBL_NS = /urn:oasis:names:specification:ubl:schema:xsd:Invoice-2|urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2/;
const CUSTOM_NS = /http:\/\/www\.acme-industrial\.example\/invoice\/1\.0|urn:acme:invoice:1\.0/;

function normalizeUblNumber(el) {
  if (!el) return null;
  const value = (el.text ?? '').trim();
  if (value !== '') return value;
  // CustomizationID / IDs can live in nested structures.
  return textOf(el, 'ID');
}

function supplierFromParty(root) {
  const party = findFirst(root, 'AccountingSupplierParty');
  if (!party) return { name: null, taxId: null };
  const name =
    textOf(party, 'RegistrationName') ??
    textOf(party, 'Name') ??
    textOf(party, 'TradingName');
  const taxId =
    textOf(party, 'CompanyID') ??
    textOf(party, 'ID');
  return { name, taxId };
}

function lineAmounts(root) {
  const lines = findAll(root, 'InvoiceLine').concat(findAll(root, 'CreditNoteLine'));
  const out = [];
  for (const line of lines) {
    const raw =
      findFirst(line, 'LineExtensionAmount')?.text ??
      findFirst(line, 'LineExtensionAmount')?.text;
    const amount = parseAmount(raw);
    if (amount !== null) out.push(amount);
  }
  return out;
}

function parseAmountField(root, ...names) {
  for (const name of names) {
    const el = findFirst(root, name);
    if (!el) continue;
    const amount = parseAmount(el.text);
    if (amount !== null) return amount;
  }
  return null;
}

function parseCommon(root, version) {
  const warnings = [];
  const typeCode = textOf(root, 'InvoiceTypeCode') ?? textOf(root, 'CreditNoteTypeCode');
  const supplier = supplierFromParty(root);
  const currency = textOf(root, 'DocumentCurrencyCode');
  const issueDate = textOf(root, 'IssueDate');
  const invoiceNumber = normalizeUblNumber(findFirst(root, 'ID')) ?? textOf(root, 'ID');

  const net = parseAmountField(root, 'TaxExclusiveAmount', 'LineExtensionAmount');
  const tax = parseAmountField(root, 'TaxAmount');
  const payable = findFirst(root, 'PayableAmount');
  const taxInclusive = findFirst(root, 'TaxInclusiveAmount');

  let gross = payable ? parseAmount(payable.text) : null;
  let creditNote = typeCode === '381' || typeCode === '396';

  if (version === '2.0.0') {
    if (gross === null) {
      gross = taxInclusive ? parseAmount(taxInclusive.text) : null;
      if (gross !== null) warnings.push({ code: 'GROSS_FALLBACK', message: '缺少 PayableAmount，改由 TaxInclusiveAmount 推算' });
    }
    if (!creditNote && gross !== null && gross < 0) creditNote = true;
  } else if (payable === null) {
    // v1 only read PayableAmount and reported the missing field as an error.
    warnings.push({ code: 'LEGACY_STRICT_PAYABLE', message: 'v1 只读取 PayableAmount，忽略 TaxInclusiveAmount' });
  }

  return {
    fields: {
      invoiceNumber,
      supplierName: supplier.name,
      supplierTaxId: supplier.taxId,
      issueDate,
      currency,
      netAmount: net,
      taxAmount: tax,
      grossAmount: gross,
      lineAmounts: lineAmounts(root),
      creditNote,
    },
    warnings,
  };
}

export const acmeUbl = {
  key: 'acme-ubl',
  supplierName: 'ACME Industrial GmbH',
  channel: 'xml',
  detect(xmlRoot) {
    if (!xmlRoot) return false;
    if (!['Invoice', 'CreditNote'].includes(xmlRoot.local)) return false;
    const ns = Object.entries(xmlRoot.attrs).find(([k]) => k === 'xmlns' || k.startsWith('xmlns:'))?.[1] ?? '';
    if (CUSTOM_NS.test(ns) || UBL_NS.test(ns)) return true;
    // Some senders omit the namespace entirely but keep the UBL shape.
    return Boolean(findFirst(xmlRoot, 'AccountingSupplierParty'));
  },
  versions: {
    '1.0.0': { parse: (root) => parseCommon(root, '1.0.0') },
    '2.0.0': { parse: (root) => parseCommon(root, '2.0.0') },
  },
};

export const nordwindXml = {
  key: 'nordwind-xml',
  supplierName: 'Nordwind Handels AG',
  channel: 'xml',
  detect(xmlRoot) {
    return Boolean(xmlRoot) && ['NordwindInvoice', 'Invoice'].includes(xmlRoot.local) && Boolean(findFirst(xmlRoot, 'Seller'));
  },
  versions: {
    '1.0.0': {
      parse(root) {
        const seller = findFirst(root, 'Seller');
        const totals = findFirst(root, 'Totals');
        const cost = findFirst(root, 'CostCenter');
        return {
          fields: {
            invoiceNumber: textOf(root, 'Number'),
            supplierName: textOf(seller, 'Name'),
            supplierTaxId: textOf(seller, 'VatId'),
            issueDate: textOf(root, 'Date'),
            currency: textOf(root, 'Currency'),
            netAmount: parseAmount(textOf(totals, 'Net')),
            taxAmount: parseAmount(textOf(totals, 'Tax')),
            grossAmount: parseAmount(textOf(totals, 'Gross')),
            lineAmounts: children(findFirst(root, 'Items'), 'Item').map((item) => parseAmount(item.attrs.Amount)),
            creditNote: (textOf(root, 'Type') ?? '').toLowerCase() === 'credit',
            costCenter: textOf(cost, 'Code'),
          },
          warnings: cost ? [] : [{ code: 'MISSING_COST_CENTER', message: '未提供成本中心' }],
        };
      },
    },
    '2.0.0': {
      parse(root) {
        const seller = findFirst(root, 'Seller');
        const totals = findFirst(root, 'Totals');
        const cost = findFirst(root, 'CostCenter');
        const type = (textOf(root, 'Type') ?? '').toLowerCase();
        return {
          fields: {
            invoiceNumber: textOf(root, 'Number'),
            supplierName: textOf(seller, 'Name'),
            supplierTaxId: textOf(seller, 'VatId'),
            issueDate: textOf(root, 'Date'),
            currency: textOf(root, 'Currency'),
            netAmount: parseAmount(textOf(totals, 'Net')),
            taxAmount: parseAmount(textOf(totals, 'Tax')),
            grossAmount: parseAmount(textOf(totals, 'Gross')),
            lineAmounts: children(findFirst(root, 'Items'), 'Item').map((item) => parseAmount(item.attrs.Amount)),
            creditNote: type === 'credit' || type === 'creditnote' || type === 'credit-note',
            costCenter: textOf(findFirst(root, 'CostCenter'), 'Code') ?? textOf(root, 'CostCenter'),
          },
          warnings: [],
        };
      },
    },
  },
};

export const acmePdf = {
  key: 'acme-pdf',
  supplierName: 'ACME Industrial GmbH',
  channel: 'pdf',
  detect(text) {
    return /ACME Industrial GmbH/i.test(text);
  },
  versions: {
    '1.0.0': { parse: (text) => parseAcmePdfText(text, '1.0.0') },
    '2.0.0': { parse: (text) => parseAcmePdfText(text, '2.0.0') },
  },
};

function parseAcmePdfText(text, version) {
  const warnings = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const joined = lines.join('\n');

  const numberPattern =
    version === '2.0.0'
      ? /(?:Invoice|Credit Note|Credit note)\s*(?:No|Number|#)\.?\s*:?\s*([A-Z0-9][A-Z0-9/-]*)/i
      : /Invoice No\.\s*([A-Z0-9][A-Z0-9/-]*)/;
  const invoiceNumber = joined.match(numberPattern)?.[1] ?? null;

  let issueDate = null;
  if (version === '2.0.0') {
    issueDate = joined.match(/Invoice\s+date\s*:?\s*(\d{4}-\d{2}-\d{2})/i)?.[1] ?? null;
    if (!issueDate) {
      const m = joined.match(/(?:Date|Datum)\s*:?\s*(\d{4}-\d{2}-\d{2})/i);
      issueDate = m?.[1] ?? null;
      if (m) warnings.push({ code: 'DATE_LABEL_FALLBACK', message: '缺少发票日期标签，使用第一个带标签的日期' });
    }
  } else {
    // v1 took the first date on the page, which is the delivery date on ACME PDFs.
    issueDate = joined.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
    if (/Delivery\s+date/i.test(joined)) {
      warnings.push({ code: 'DATE_HEURISTIC', message: 'v1 取页面上的第一个日期' });
    }
  }

  const amountAfter = (label) => {
    // Labels must start a line: "Total" must not match inside "Subtotal".
    const re = new RegExp(`(?:^|\\n)\\s*${label}\\s*:?[ \\t]*(-?[\\d.,]+)`, 'i');
    return parseAmount(joined.match(re)?.[1]);
  };

  const net = amountAfter('Subtotal');
  const tax = amountAfter('VAT(?:\\s*\\d+%?)?');
  const gross = amountAfter('Total(?!\\s+due)');
  const currency = joined.match(/Currency\s*:?\s*([A-Z]{3})\b/)?.[1] ?? null;
  const supplierName = lines.find((l) => /GmbH|AG|Ltd|LLC/i.test(l)) ?? null;
  const isCredit = /credit note/i.test(joined);
  const itemAmounts = [];
  for (const line of lines) {
    const m = line.match(/^\s*[A-Za-z][A-Za-z0-9 &/.-]*?\s+(-?\d+(?:\.\d+)?)\s+(-?\d+\.\d{2})\s+(-?\d+\.\d{2})\s*$/);
    if (m) {
      const amount = parseAmount(m[3]);
      if (amount !== null) itemAmounts.push(amount);
    }
  }
  return {
    fields: {
      invoiceNumber,
      supplierName,
      supplierTaxId: null,
      issueDate,
      currency,
      netAmount: net,
      taxAmount: tax,
      grossAmount: gross,
      lineAmounts: itemAmounts,
      creditNote: version === '2.0.0' ? isCredit : false,
    },
    warnings,
  };
}

export const suppliers = [acmeUbl, nordwindXml, acmePdf];

export function supplierByKey(key) {
  return suppliers.find((s) => s.key === key) ?? null;
}

export function detectSupplier({ xmlRoot, pdfText }) {
  if (xmlRoot) {
    // Order matters: Nordwind's root is generic, so test shape before ACME.
    for (const supplier of suppliers.filter((s) => s.channel === 'xml')) {
      if (supplier.detect(xmlRoot)) return supplier;
    }
    return null;
  }
  if (pdfText != null) {
    for (const supplier of suppliers.filter((s) => s.channel === 'pdf')) {
      if (supplier.detect(pdfText)) return supplier;
    }
  }
  return null;
}
