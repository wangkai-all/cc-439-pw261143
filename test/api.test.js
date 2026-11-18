import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, migrate } from '../src/db.js';
import { Engine } from '../src/engine/engine.js';
import { createApp } from '../src/server/app.js';

const ubl = (number = 'INV-1') => `<?xml version="1.0"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">
  <ID>${number}</ID><IssueDate>2026-06-01</IssueDate><DocumentCurrencyCode>EUR</DocumentCurrencyCode>
  <AccountingSupplierParty><Party><PartyName><Name>ACME Industrial GmbH</Name></PartyName></Party></AccountingSupplierParty>
  <LegalMonetaryTotal><TaxExclusiveAmount>10.00</TaxExclusiveAmount><TaxAmount>1.90</TaxAmount><PayableAmount>11.90</PayableAmount></LegalMonetaryTotal>
</Invoice>`;

async function boot() {
  const root = await mkdtemp(join(tmpdir(), 'intake-api-'));
  const db = openDb(':memory:');
  migrate(db);
  const engine = new Engine({ db, watchDir: join(root, 'inbox'), archiveDir: join(root, 'archive'), settleMs: 0 });
  const app = createApp({
    db,
    engine,
    watchDir: join(root, 'inbox'),
    archiveDir: join(root, 'archive'),
    publicDir: new URL('../public', import.meta.url).pathname,
  });
  await new Promise((resolve) => app.listen(0, resolve));
  const base = `http://localhost:${app.address().port}`;
  const call = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return {
    root, db, engine, app, call,
    async cleanup() {
      app.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('overview and document endpoints expose hashes, versions and issues', async () => {
  const ctx = await boot();
  try {
    const intake = await ctx.engine.ingestBuffer({
      buffer: Buffer.from(ubl('INV-9')),
      path: '/tmp/srv/a.xml',
      name: 'a.xml',
      extension: '.xml',
    });
    const overview = await ctx.call('/api/overview');
    assert.equal(overview.status, 200);
    assert.equal(overview.body.documents.received, 1);

    const list = await ctx.call('/api/documents');
    assert.equal(list.body.total, 1);
    assert.equal(list.body.items[0].content_hash.length, 64);
    assert.equal(list.body.items[0].parser_version, '1.0.0');

    const doc = await ctx.call(`/api/documents/${intake.documentId}`);
    assert.equal(doc.status, 200);
    assert.equal(doc.body.runs.length, 1);
    assert.equal(doc.body.document.fields.grossAmount, 1190);
  } finally {
    await ctx.cleanup();
  }
});

test('confirm is idempotent-safe and rejects double confirmation', async () => {
  const ctx = await boot();
  try {
    const { documentId } = await ctx.engine.ingestBuffer({
      buffer: Buffer.from(ubl()), path: '/tmp/srv/a.xml', name: 'a.xml', extension: '.xml',
    });
    const first = await ctx.call(`/api/documents/${documentId}/confirm`, { method: 'POST', body: { by: 'api-test' } });
    assert.equal(first.status, 200);
    assert.equal(first.body.document.state, 'confirmed');
    const second = await ctx.call(`/api/documents/${documentId}/confirm`, { method: 'POST', body: {} });
    assert.equal(second.status, 409);
  } finally {
    await ctx.cleanup();
  }
});

test('validation failures open quarantine items and can be accepted', async () => {
  const ctx = await boot();
  try {
    const bad = Buffer.from(ubl('INV-BAD').replace('<TaxAmount>1.90</TaxAmount>', '<TaxAmount>9.00</TaxAmount>'));
    const { documentId } = await ctx.engine.ingestBuffer({
      buffer: bad, path: '/tmp/srv/bad.xml', name: 'bad.xml', extension: '.xml',
    });
    const queue = await ctx.call('/api/quarantine');
    assert.equal(queue.body.length, 1);
    assert.equal(queue.body[0].kind, 'validation');
    assert.ok(queue.body[0].reasons.some((r) => r.code === 'AMOUNT_MISMATCH'));

    const accepted = await ctx.call(`/api/quarantine/${queue.body[0].id}/confirm-document`, {
      method: 'POST', body: { note: 'checked against paper copy' },
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.document.state, 'confirmed');

    const after = await ctx.call('/api/quarantine?status=all');
    assert.equal(after.body[0].status, 'resolved');
    assert.equal(after.body[0].resolution, 'accepted');
    assert.equal((await ctx.call(`/api/documents/${documentId}`)).body.document.state, 'confirmed');
  } finally {
    await ctx.cleanup();
  }
});

test('parser version endpoint triggers replay and records a job', async () => {
  const ctx = await boot();
  try {
    await ctx.engine.ingestBuffer({
      buffer: Buffer.from(ubl().replace('<PayableAmount>11.90</PayableAmount>', '<TaxInclusiveAmount>11.90</TaxInclusiveAmount>')),
      path: '/tmp/srv/v.xml', name: 'v.xml', extension: '.xml',
    });
    assert.equal((await ctx.call('/api/quarantine')).body.length, 1);

    const switched = await ctx.call('/api/parsers/acme-ubl/version', { method: 'POST', body: { version: '2.0.0' } });
    assert.equal(switched.status, 200);
    assert.equal(switched.body.to, '2.0.0');
    assert.equal(switched.body.replayJob.documents_recovered, 1);

    const jobs = await ctx.call('/api/replays');
    assert.equal(jobs.body.jobs.length, 1);
    const job = await ctx.call(`/api/replays/${jobs.body.jobs[0].id}`);
    assert.equal(job.body.items.length, 1);
    assert.equal(job.body.items[0].outcome, 'recovered');
    assert.deepEqual(job.body.items[0].diff.map((d) => d.field), ['grossAmount']);
  } finally {
    await ctx.cleanup();
  }
});

test('confirm applies validated field overrides and rejects invalid ones', async () => {
  const ctx = await boot();
  try {
    const { documentId } = await ctx.engine.ingestBuffer({
      buffer: Buffer.from(ubl('INV-OVR')),
      path: '/tmp/srv/ovr.xml',
      name: 'ovr.xml',
      extension: '.xml',
    });
    const bad = await ctx.call(`/api/documents/${documentId}/confirm`, {
      method: 'POST',
      body: { by: 'ops', fields: { grossAmount: 99999 } },
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /未通过校验/);
    assert.equal(ctx.db.prepare('SELECT state FROM documents WHERE id = ?').get(documentId).state, 'received');

    const notObject = await ctx.call(`/api/documents/${documentId}/confirm`, {
      method: 'POST',
      body: { by: 'ops', fields: 'nope' },
    });
    assert.equal(notObject.status, 400);

    const ok = await ctx.call(`/api/documents/${documentId}/confirm`, {
      method: 'POST',
      body: {
        by: 'ops',
        note: 'corrected totals',
        fields: { netAmount: 2000, taxAmount: 380, grossAmount: 2380, injected: '<script>' },
      },
    });
    assert.equal(ok.status, 200);
    const confirmed = JSON.parse(ctx.db.prepare('SELECT confirmed_fields_json FROM documents WHERE id = ?').get(documentId).confirmed_fields_json);
    assert.equal(confirmed.grossAmount, 2380);
    assert.equal(confirmed.invoiceNumber, 'INV-OVR', 'unspecified fields keep the parsed value');
    assert.equal(confirmed.injected, undefined, 'unknown keys are dropped');
  } finally {
    await ctx.cleanup();
  }
});

test('invalid inputs are rejected with useful status codes', async () => {
  const ctx = await boot();
  try {
    assert.equal((await ctx.call('/api/documents/nope')).status, 404);
    assert.equal((await ctx.call('/api/batches/nope')).status, 404);
    assert.equal((await ctx.call('/api/replays/nope')).status, 404);
    assert.equal((await ctx.call('/api/quarantine/nope/resolve', { method: 'POST', body: {} })).status, 404);
    assert.equal((await ctx.call('/api/parsers/nope/version', { method: 'POST', body: { version: '2.0.0' } })).status, 404);
    assert.equal((await ctx.call('/api/parsers/acme-ubl/version', { method: 'POST', body: { version: '9.9.9' } })).status, 400);
    assert.equal((await ctx.call('/api/replays', { method: 'POST', body: {} })).status, 400);
    const badJson = await fetch(`http://localhost:${ctx.app.address().port}/api/scan`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops',
    });
    assert.equal(badJson.status, 400);
  } finally {
    await ctx.cleanup();
  }
});

test('static files serve and path traversal is blocked', async () => {
  const ctx = await boot();
  try {
    const base = `http://localhost:${ctx.app.address().port}`;
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /发票接入/);
    const css = await fetch(`${base}/styles.css`);
    assert.equal(css.status, 200);
    const traversal = await fetch(`${base}/..%2f..%2fetc%2fpasswd`);
    assert.ok([403, 404].includes(traversal.status));
  } finally {
    await ctx.cleanup();
  }
});

test('document export returns the confirmed values with formatted amounts', async () => {
  const ctx = await boot();
  try {
    const { documentId } = await ctx.engine.ingestBuffer({
      buffer: Buffer.from(ubl('INV-EXPORT')), path: '/tmp/srv/e.xml', name: 'e.xml', extension: '.xml',
    });
    await ctx.call(`/api/documents/${documentId}/confirm`, { method: 'POST', body: { by: 'export-test' } });
    const exported = await ctx.call(`/api/documents/${documentId}/export`);
    assert.equal(exported.status, 200);
    assert.equal(exported.body.fields.grossAmount, '11.90');
    assert.equal(exported.body.document.state, 'confirmed');
    assert.equal(exported.body.document.parser.version, '1.0.0');
  } finally {
    await ctx.cleanup();
  }
});
