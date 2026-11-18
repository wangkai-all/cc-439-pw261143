import { createHash } from 'node:crypto';

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Stable JSON stringify: sorted object keys, so hashes are reproducible. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * Money is stored as integer minor units to avoid float drift. Returns null
 * rather than a partial number when the input is not a clean decimal.
 */
export function parseAmount(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim().replace(/\s/g, '');
  if (text === '') return null;
  const n = text.replace(/[€$£¥]/g, '').replace(/,(?=\d{3}\b)/g, '');
  if (!/^[-+]?\d+(\.\d{1,4})?$/.test(n)) return null;
  const negative = n.startsWith('-');
  const unsigned = n.replace(/^[-+]/, '');
  const [whole, frac = ''] = unsigned.split('.');
  const cents = Number.parseInt(whole, 10) * 100 + Number.parseInt(frac.padEnd(2, '0').slice(0, 2) || '0', 10);
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

export function formatAmount(cents) {
  if (cents === null || cents === undefined) return null;
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Deterministic short id (no external uuid dependency required). */
export function shortId(prefix, seed) {
  return `${prefix}_${sha256(seed).slice(0, 12)}`;
}
