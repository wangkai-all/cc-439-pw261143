import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb, migrate } from '../src/db.js';
import { Engine } from '../src/engine/engine.js';
import { parseXml } from '../src/lib/xml.js';
import { acmeUbl, acmePdf, nordwindXml } from '../src/parsers/suppliers.js';
import { diffFields } from '../src/lib/diff.js';
import { validateFields } from '../src/lib/validate.js';

const ubl = ({ number = 'INV-1', date = '2026-01-05', net = '100.00', tax = '19.00', gross = '<PayableAmount>119.00</PayableAmount>' } = {}) => `<?xml version="1.0"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">
  <ID>${number}</ID><IssueDate>${date}</IssueDate><DocumentCurrencyCode>EUR</DocumentCurrencyCode>
  <AccountingSupplierParty><Party><PartyName><Name>ACME Industrial GmbH</Name></PartyName></Party></AccountingSupplierParty>
  <LegalMonetaryTotal><TaxExclusiveAmount>${net}</TaxExclusiveAmount><TaxAmount>${tax}</TaxAmount>${gross}</LegalMonetaryTotal>
</Invoice>`;

test('v1 requires PayableAmount while v2 falls back to TaxInclusiveAmount', () => {
  const root = parseXml(ubl({ gross: '<TaxInclusiveAmount>119.00</TaxInclusiveAmount>' }));
  const v1 = acmeUbl.versions['1.0.0'].parse(root).fields;
  const v2 = acmeUbl.versions['2.0.0'].parse(root).fields;
  assert.equal(v1.grossAmount, null);
  assert.equal(v2.grossAmount, 11900);
});

test('PDF v2 reads the invoice date, v1 takes the first date on the page', () => {
  const text = [
    'ACME Industrial GmbH',
    'Delivery date: 2026-01-01',
    'Invoice No. ACME-9',
    'Invoice date: 2026-01-09',
    'Currency: EUR',
    'Subtotal: 10.00',
    'VAT 19%: 1.90',
    'Total: 11.90',
  ].join('\n');
  assert.equal(acmePdf.versions['1.0.0'].parse(text).fields.issueDate, '2026-01-01');
  assert.equal(acmePdf.versions['2.0.0'].parse(text).fields.issueDate, '2026-01-09');
});

test('Total is not matched inside Subtotal', () => {
  const text = 'ACME Industrial GmbH\nInvoice No. A-1\nInvoice date: 2026-01-09\nSubtotal: 10.00\nVAT 19%: 1.90\nTotal: 11.90';
  assert.equal(acmePdf.versions['2.0.0'].parse(text).fields.grossAmount, 1190);
  assert.equal(acmePdf.versions['2.0.0'].parse(text).fields.netAmount, 1000);
});

test('validation reports missing fields and amount mismatch', () => {
  const issues = validateFields({
    invoiceNumber: null,
    supplierName: 'X',
    issueDate: '2026-01-01',
    currency: 'EUR',
    netAmount: 10000,
    taxAmount: 1900,
    grossAmount: 12000,
    lineAmounts: [],
    creditNote: false,
  });
  const codes = issues.map((i) => i.code);
  assert.ok(codes.includes('MISSING_FIELD'));
  assert.ok(codes.includes('AMOUNT_MISMATCH'));
  const mismatch = issues.find((i) => i.code === 'AMOUNT_MISMATCH');
  assert.equal(mismatch.meta.deltaCents, 100);
  assert.equal(mismatch.severity, 'error');
});

test('validation allows one cent tolerance for rounding', () => {
  const issues = validateFields({
    invoiceNumber: 'A', supplierName: 'X', issueDate: '2026-01-01', currency: 'EUR',
    netAmount: 10000, taxAmount: 1900, grossAmount: 11901, lineAmounts: [], creditNote: false,
  });
  assert.equal(issues.filter((i) => i.code === 'AMOUNT_MISMATCH').length, 0);
});

test('diffFields covers scalars and line amounts', () => {
  const diff = diffFields(
    { invoiceNumber: 'A', grossAmount: 100, lineAmounts: [100] },
    { invoiceNumber: 'A', grossAmount: 200, lineAmounts: [100, 50] },
  );
  assert.deepEqual(diff.map((d) => d.field), ['grossAmount', 'lineAmounts']);
  assert.deepEqual(diffFields({ a: 1 }, { a: 1 }), []);
});

test('nordwind v2 resolves cost center from mixed shapes', () => {
  const root = parseXml('<NordwindInvoice><Number>N</Number><Seller><Name>Nordwind Handels AG</Name></Seller><CostCenter>CC-1</CostCenter></NordwindInvoice>');
  assert.equal(nordwindXml.versions['2.0.0'].parse(root).fields.costCenter, 'CC-1');
});

test('engine stores raw hash, structured fields and parser version', async () => {
  const { engine, buffer } = makeEngine();
  const result = await engine.ingestBuffer({
    buffer,
    path: '/tmp/inbox/a.xml',
    name: 'a.xml',
    extension: '.xml',
  });
  const doc = engine.db.prepare('SELECT * FROM documents WHERE id = ?').get(result.documentId);
  assert.equal(doc.state, 'received');
  assert.equal(doc.parser_version, '1.0.0');
  assert.equal(doc.content_hash.length, 64);
  const run = engine.db.prepare('SELECT * FROM parse_runs WHERE document_id = ?').get(doc.id);
  assert.equal(run.parser_version, '1.0.0');
  assert.equal(run.trigger, 'watch');
  const fields = JSON.parse(run.fields_json);
  assert.equal(fields.grossAmount, 11900);
});

test('engine never creates a second document for identical bytes', async () => {
  const { engine, buffer } = makeEngine();
  const first = await engine.ingestBuffer({ buffer, path: '/tmp/inbox/a.xml', name: 'a.xml', extension: '.xml' });
  const second = await engine.ingestBuffer({ buffer, path: '/tmp/inbox/copy.xml', name: 'copy.xml', extension: '.xml' });
  assert.equal(first.documentId, second.documentId);
  assert.equal(second.counters.duplicates, 1);
  assert.equal(engine.db.prepare('SELECT COUNT(*) AS n FROM documents').get().n, 1);
});

test('engine flags a re-export of the same invoice as a business duplicate', async () => {
  const { engine } = makeEngine();
  const first = await engine.ingestBuffer({
    buffer: Buffer.from(ubl()),
    path: '/tmp/inbox/a.xml', name: 'a.xml', extension: '.xml',
  });
  const reExport = Buffer.from(ubl().replace('</AccountingSupplierParty>', '</AccountingSupplierParty>\n  '));
  assert.notEqual(reExport.toString('utf8'), ubl().toString?.('utf8') ?? ubl());
  const second = await engine.ingestBuffer({
    buffer: reExport, path: '/tmp/inbox/a2.xml', name: 'a2.xml', extension: '.xml',
  });
  assert.equal(second.counters.duplicates, 1);
  assert.equal(second.documentId, first.documentId);
  const q = engine.db.prepare("SELECT * FROM quarantine_items WHERE kind = 'business_duplicate'").all();
  assert.equal(q.length, 1);
});

test('confirmed documents are never replaced by a later intake', async () => {
  const { engine } = makeEngine();
  const { documentId } = await engine.ingestBuffer({
    buffer: Buffer.from(ubl()), path: '/tmp/inbox/a.xml', name: 'a.xml', extension: '.xml',
  });
  engine.confirm(documentId, { by: 'tester' });
  const second = await engine.ingestBuffer({
    buffer: Buffer.from(ubl({ gross: '<PayableAmount>120.00</PayableAmount>' })),
    path: '/tmp/inbox/b.xml', name: 'b.xml', extension: '.xml',
  });
  assert.equal(second.counters.duplicates, 1);
  const doc = engine.db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId);
  assert.equal(doc.state, 'confirmed');
  assert.equal(doc.parser_version, '1.0.0');
  assert.equal(engine.db.prepare('SELECT COUNT(*) AS n FROM documents').get().n, 1);
});

test('a rejected document can be rejected without clearing a confirmation guard', async () => {
  const { engine, buffer } = makeEngine();
  const { documentId } = await engine.ingestBuffer({ buffer, path: '/tmp/inbox/a.xml', name: 'a.xml', extension: '.xml' });
  engine.confirm(documentId, { by: 'tester' });
  assert.throws(() => engine.reject(documentId, { by: 'tester' }), /不能拒绝/);
  const doc = engine.db.prepare('SELECT state FROM documents WHERE id = ?').get(documentId);
  assert.equal(doc.state, 'confirmed');
});

test('identical corrupt bytes are re-attempted but do not flood the queue', async () => {
  const { engine } = makeEngine();
  const bad = Buffer.from('<?xml version="1.0"?><Invoice><ID>A-9</ID>');
  const first = await engine.ingestBuffer({ buffer: bad, path: '/tmp/inbox/a.xml', name: 'a.xml', extension: '.xml' });
  assert.equal(first.counters.quarantined, 1);
  // There is no document to dedupe against, so the parser is run again (it may
  // have changed); the open file-level item is reused instead of duplicated.
  const second = await engine.ingestBuffer({ buffer: bad, path: '/tmp/inbox/a.xml', name: 'a.xml', extension: '.xml' });
  assert.equal(second.counters.quarantined, 1);
  assert.equal(engine.db.prepare('SELECT COUNT(*) AS n FROM documents').get().n, 0);
  assert.equal(engine.db.prepare('SELECT COUNT(*) AS n FROM intakes').get().n, 2);
  assert.equal(engine.db.prepare("SELECT COUNT(*) AS n FROM quarantine_items WHERE status = 'open'").get().n, 1);
});

test('a changed file replacing a rejected one produces a document', async () => {
  const { engine } = makeEngine();
  const bad = Buffer.from('<?xml version="1.0"?><Invoice><ID>A-8</ID>');
  await engine.ingestBuffer({ buffer: bad, path: '/tmp/inbox/a.xml', name: 'a.xml', extension: '.xml' });
  const fixed = await engine.ingestBuffer({ buffer: Buffer.from(ubl({ number: 'A-8' })), path: '/tmp/inbox/a.xml', name: 'a.xml', extension: '.xml', sourceFileId: null });
  assert.equal(fixed.counters.intakes, 1);
  const docs = engine.db.prepare('SELECT invoice_number, state FROM documents').all();
  assert.deepEqual(docs.map((d) => [d.invoice_number, d.state]), [['A-8', 'received']]);
});

test('replay uses the target version, not the active one', async () => {
  const { engine } = makeEngine();
  await engine.ingestBuffer({
    buffer: Buffer.from(ubl({ gross: '<TaxInclusiveAmount>119.00</TaxInclusiveAmount>' })),
    path: '/tmp/inbox/a.xml', name: 'a.xml', extension: '.xml',
  });
  assert.equal(engine.db.prepare("SELECT state FROM documents").get().state, 'quarantined');
  const job = await engine.replay({ parserKey: 'acme-ubl', toVersion: '2.0.0' });
  assert.equal(job.documents_recovered, 1);
  const doc = engine.db.prepare('SELECT * FROM documents').get();
  assert.equal(doc.state, 'received');
  assert.equal(doc.parser_version, '2.0.0');
  const fields = JSON.parse(doc.fields_json);
  assert.equal(fields.grossAmount, 11900);
});

test('replay leaves confirmed results untouched and opens confirmed_drift', async () => {
  const { engine } = makeEngine();
  const { documentId } = await engine.ingestBuffer({
    buffer: Buffer.from(ubl()), path: '/tmp/inbox/a.xml', name: 'a.xml', extension: '.xml',
  });
  engine.confirm(documentId, { by: 'tester' });
  const before = engine.db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId);

  const job = await engine.replay({ parserKey: 'acme-ubl', toVersion: '2.0.0' });
  const after = engine.db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId);
  assert.equal(after.fields_json, before.fields_json);
  assert.equal(after.confirmed_fields_json, before.confirmed_fields_json);
  assert.equal(after.parser_version, '1.0.0');
  assert.equal(after.state, 'confirmed');

  // v2 agrees on this document, so no drift is expected.
  assert.equal(job.items[0].outcome, 'confirmed_match');

  // Now produce genuine drift via a parser whose output differs.
  const { driftDocumentId } = await seedDrift(engine);
  const driftBefore = engine.db.prepare('SELECT * FROM documents WHERE id = ?').get(driftDocumentId);
  const job2 = await engine.replay({ parserKey: 'acme-pdf', toVersion: '2.0.0' });
  const driftAfter = engine.db.prepare('SELECT * FROM documents WHERE id = ?').get(driftDocumentId);
  assert.equal(driftAfter.fields_json, driftBefore.fields_json);
  assert.equal(driftAfter.state, 'confirmed');
  const driftItem = job2.items.find((i) => i.document_id === driftDocumentId);
  assert.equal(driftItem.outcome, 'confirmed_drift');
  assert.ok(driftItem.diff.some((d) => d.field === 'issueDate'));
  const q = engine.db.prepare("SELECT * FROM quarantine_items WHERE kind = 'confirmed_drift'").all();
  assert.equal(q.length, 1);
});

test('replay verifies archive integrity', async () => {
  const { engine, buffer } = makeEngine();
  const { documentId } = await engine.ingestBuffer({
    buffer, path: '/tmp/inbox/a.xml', name: 'a.xml', extension: '.xml',
  });
  // Corrupt the archived copy under a hash that is still recorded.
  const doc = engine.db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId);
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await writeFile(join(engine.archiveDir, doc.archive_path), Buffer.from('tampered'));
  const job = await engine.replay({ parserKey: 'acme-ubl', toVersion: '2.0.0' });
  assert.equal(job.failures, 1);
  assert.equal(job.items[0].outcome, 'integrity_error');
});

test('parser upgrade can auto-replay', async () => {
  const { engine } = makeEngine({ autoReplayOnVersionChange: true });
  await engine.ingestBuffer({
    buffer: Buffer.from(ubl({ gross: '<TaxInclusiveAmount>119.00</TaxInclusiveAmount>' })),
    path: '/tmp/inbox/a.xml', name: 'a.xml', extension: '.xml',
  });
  const result = await engine.setParserVersion('acme-ubl', '2.0.0');
  assert.equal(result.from, '1.0.0');
  assert.equal(result.to, '2.0.0');
  assert.equal(result.replayJob.documents_recovered, 1);
});

// ------------------------------------------------------------------ helpers

let seq = 0;
function makeEngine({ autoReplayOnVersionChange = false } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  seq += 1;
  const engine = new Engine({
    db,
    watchDir: `/tmp/inbox-${seq}`,
    archiveDir: `/tmp/archive-${seq}`,
    settleMs: 0,
    autoReplayOnVersionChange,
  });
  const buffer = Buffer.from(ubl());
  return { engine, db, buffer };
}

async function seedDrift(engine) {
  const { makeTextPdf } = await import('../src/lib/pdfgen.js');
  const pdf = makeTextPdf([
    'ACME Industrial GmbH',
    'Delivery date: 2026-09-01',
    'Invoice No. ACME-DRIFT',
    'Invoice date: 2026-09-09',
    'Currency: EUR',
    'Subtotal: 10.00',
    'VAT 19%: 1.90',
    'Total: 11.90',
  ]);
  const { documentId } = await engine.ingestBuffer({
    buffer: pdf, path: '/tmp/inbox/drift.pdf', name: 'drift.pdf', extension: '.pdf',
  });
  engine.confirm(documentId, { by: 'tester' });
  return { driftDocumentId: documentId };
}
