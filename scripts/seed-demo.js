/**
 * Seed a demo workspace with a realistic intake history.
 *
 *   node scripts/seed-demo.js [--reset]
 *
 * Stages:
 *   1. First drop of supplier files (scanned twice: deferred -> ingested).
 *   2. A malformed drop containing corrupt, unknown-supplier and scanned PDFs.
 *   3. Two invoices confirmed by an operator.
 *   4. The same invoice arriving twice: byte-identical copy + re-exported PDF.
 *   5. A half-written XML that is completed while the watcher is running.
 *   6. A file removed and restored (directory recovery).
 *   7. Parser upgrades to v2 with automatic replay.
 */
import { mkdir, rm, writeFile, readFile, copyFile, appendFile, unlink } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';

import { buildSystem } from '../src/server/index.js';

const root = resolve(process.cwd());
const dataDir = resolve(root, 'data');
const inbox = resolve(root, 'inbox');
const fixtures = resolve(root, 'scripts/fixtures');
const reset = process.argv.includes('--reset');

if (reset) {
  await rm(dataDir, { recursive: true, force: true });
  await rm(inbox, { recursive: true, force: true });
}
await rm(inbox, { recursive: true, force: true });
await mkdir(inbox, { recursive: true });

const system = buildSystem({ dataDir, watchDir: inbox, settleMs: 0, autoReplayOnVersionChange: true });
const { engine } = system;

const scanTwice = async (trigger) => {
  await engine.scan({ trigger, force: false });
  return engine.scan({ trigger, force: false });
};

const place = async (name, source = name) => {
  await copyFile(join(fixtures, source), join(inbox, basename(name)));
};

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const log = (...args) => console.log('  ', ...args);

console.log('1. Initial supplier drop');
for (const name of [
  'acme-ubl-1001.xml',
  'acme-ubl-1003-mismatch.xml',
  'acme-ubl-1004-incomplete.xml',
  'nordwind-77120.xml',
  'acme-pdf-5501.pdf',
  'acme-pdf-5503-bad-total.pdf',
  'not-an-invoice.txt',
]) {
  await place(name);
}
let batch = await scanTwice('watch');
log(`batch ${batch.id}: ${batch.files_seen} files, ${batch.intakes} ingested, ${batch.quarantined} quarantined, ${batch.ignored} ignored`);

console.log('2. Broken drop: corrupt, unknown supplier, scanned PDF, XXE attempt');
for (const name of ['corrupt-truncated.xml', 'unknown-supplier.xml', 'xxe-attempt.xml', 'scanned-no-text.pdf', 'empty.xml']) {
  await place(name);
}
batch = await scanTwice('watch');
log(`batch ${batch.id}: ${batch.quarantined} quarantined`);

console.log('3. Operator confirms two clean invoices');
const docs = engine.db
  .prepare("SELECT id, invoice_number FROM documents WHERE invoice_number IN ('ACME-1001','NW-77120')")
  .all();
for (const doc of docs) {
  engine.confirm(doc.id, { by: 'ops.demo@example.com', note: 'Matched purchase order at intake review' });
  log(`confirmed ${doc.invoice_number}`);
}

console.log('4. Version-dependent files arrive under parser v1');
for (const name of ['acme-ubl-1002.xml', 'acme-pdf-5502.pdf', 'nordwind-77121.xml']) {
  await place(name);
}
batch = await scanTwice('watch');
log(`batch ${batch.id}: ${batch.quarantined} quarantined (expected: v1 cannot read these)`);
// Confirm the PDF under v1, whose date heuristic picks the delivery date.
// The v2 replay will disagree with this confirmed value.
const confirmedPdf = engine.db
  .prepare("SELECT id FROM documents WHERE invoice_number = 'ACME-5502'")
  .get();
if (confirmedPdf) {
  engine.confirm(confirmedPdf.id, {
    by: 'ops.demo@example.com',
    note: 'Confirmed under parser v1 at intake review',
  });
  log('confirmed ACME-5502 under v1 (date taken from delivery date heuristic)');
}

console.log('5. Duplicate arrivals');
await copyFile(join(inbox, 'acme-ubl-1001.xml'), join(inbox, 'acme-ubl-1001 copy.xml'));
await writeFile(
  join(inbox, 'acme-ubl-1001-reexport.xml'),
  (await readFile(join(fixtures, 'acme-ubl-1001.xml'), 'utf8')).replace(/ACME-1001/g, 'ACME-1001'),
);
// Change only the whitespace to get a different hash for the same invoice.
await appendFile(join(inbox, 'acme-ubl-1001-reexport.xml'), '\n');
await pause(10);
batch = await scanTwice('watch');
log(`batch ${batch.id}: ${batch.duplicates} duplicates`);

console.log('6. Half-written file is held back, then completed');
const halfSource = await readFile(join(fixtures, 'nordwind-77120.xml'), 'utf8');
const halfPath = join(inbox, 'nordwind-77122-partial.xml');
await writeFile(halfPath, halfSource.replace(/NW-77120/g, 'NW-77122').slice(0, 90));
batch = await engine.scan({ trigger: 'watch' });
log(`partial file -> ${batch.files.find((f) => f.name === 'nordwind-77122-partial.xml')?.status}`);
await pause(20);
await writeFile(halfPath, halfSource.replace(/NW-77120/g, 'NW-77122'));
await pause(20);
batch = await scanTwice('watch');
log(`completed file -> ${batch.files.find((f) => f.name === 'nordwind-77122-partial.xml')?.status}`);

console.log('7. File disappears, then the directory is restored');
await unlink(join(inbox, 'nordwind-77120.xml'));
await pause(20);
batch = await engine.scan({ trigger: 'watch' });
log(`after removal -> ${batch.missing} missing`);
await pause(20);
await place('nordwind-77120.xml');
// Reappearing restarts the two-observation protocol (the restored file may be
// a different copy), so recovery is reported on the pass that ingests it.
batch = await scanTwice('watch');
log(`after restore -> recovered=${batch.recovered}`);

console.log('8. Parser upgrade to v2 with automatic replay');
for (const parserKey of ['acme-ubl', 'acme-pdf', 'nordwind-xml']) {
  const result = await engine.setParserVersion(parserKey, '2.0.0');
  const job = result.replayJob;
  log(
    `${parserKey}: ${result.from} -> ${result.to}; replay scanned ${job?.documents_scanned ?? 0}, changed ${job?.documents_changed ?? 0}, recovered ${job?.documents_recovered ?? 0}, quarantined ${job?.documents_quarantined ?? 0}`,
  );
}
await scanTwice('watch');

const summary = engine.db
  .prepare('SELECT state, COUNT(*) AS n FROM documents GROUP BY state')
  .all();
const open = engine.db
  .prepare("SELECT kind, COUNT(*) AS n FROM quarantine_items WHERE status = 'open' GROUP BY kind")
  .all();
console.log('\nDemo workspace ready.');
console.log('Documents:', Object.fromEntries(summary.map((r) => [r.state, r.n])));
console.log('Open quarantine:', Object.fromEntries(open.map((r) => [r.kind, r.n])));
console.log(`\nRun "npm start" and open http://localhost:4477`);
system.stop();
