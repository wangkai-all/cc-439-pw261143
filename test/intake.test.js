import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, mkdir, rm, unlink, stat, copyFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, migrate } from '../src/db.js';
import { Engine } from '../src/engine/engine.js';
import { Watcher } from '../src/ingest/watcher.js';
import { makeTextPdf } from '../src/lib/pdfgen.js';

const ubl = (number) => `<?xml version="1.0"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">
  <ID>${number}</ID><IssueDate>2026-05-01</IssueDate><DocumentCurrencyCode>EUR</DocumentCurrencyCode>
  <AccountingSupplierParty><Party><PartyName><Name>ACME Industrial GmbH</Name></PartyName></Party></AccountingSupplierParty>
  <LegalMonetaryTotal><TaxExclusiveAmount>10.00</TaxExclusiveAmount><TaxAmount>1.90</TaxAmount><PayableAmount>11.90</PayableAmount></LegalMonetaryTotal>
</Invoice>`;

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'intake-'));
  const inbox = join(root, 'inbox');
  const data = join(root, 'data');
  await mkdir(inbox, { recursive: true });
  await mkdir(data, { recursive: true });
  const db = openDb(':memory:');
  migrate(db);
  let clock = Date.now();
  const engine = new Engine({
    db,
    watchDir: inbox,
    archiveDir: join(data, 'archive'),
    settleMs: 2000,
    now: () => clock,
    autoReplayOnVersionChange: false,
  });
  return {
    root, inbox, data, db, engine,
    advance: (ms) => { clock += ms; },
    now: () => clock,
    // Filesystem mtime has millisecond granularity and a rewrite of equal
    // length can land in the same tick as the previous write, which makes a
    // genuinely new file look like the old observation. Tests drive a fake
    // clock, so writes stamp the fake time explicitly: the pipeline then sees
    // the same ordering a real intake would.
    async write(path, content) {
      await writeFile(path, content);
      const when = new Date(clock);
      await utimes(path, when, when);
    },
    async cleanup() { await rm(root, { recursive: true, force: true }); db.close(); },
  };
}

const batchFile = (ws, batch, name) => batch.files.find((f) => f.name === name);

test('new files are deferred until observed stable on a later pass', async () => {
  const ws = await workspace();
  try {
    await ws.write(join(ws.inbox, 'a.xml'), ubl('A-1'));
    let batch = await ws.engine.scan();
    assert.equal(batchFile(ws, batch, 'a.xml').status, 'deferred');
    assert.equal(batch.intakes, 0);

    ws.advance(3000);
    batch = await ws.engine.scan();
    // Second pass sees identical size+mtime but the file must also be older
    // than settleMs relative to this pass; it is.
    assert.equal(batchFile(ws, batch, 'a.xml').status, 'ingested');
    assert.equal(batch.intakes, 1);
  } finally {
    await ws.cleanup();
  }
});

test('a file modified between passes resets stability', async () => {
  const ws = await workspace();
  try {
    const path = join(ws.inbox, 'a.xml');
    await ws.write(path, ubl('A-1'));
    ws.advance(3000);
    await ws.engine.scan();
    await appendFile(path, '\n');
    ws.advance(3000);
    let batch = await ws.engine.scan();
    assert.equal(batchFile(ws, batch, 'a.xml').status, 'deferred');
    assert.equal(batch.intakes, 0);
    ws.advance(3000);
    batch = await ws.engine.scan();
    assert.equal(batchFile(ws, batch, 'a.xml').status, 'ingested');
  } finally {
    await ws.cleanup();
  }
});

test('a file still being written (growing) never enters the pipeline', async () => {
  const ws = await workspace();
  try {
    const path = join(ws.inbox, 'half.xml');
    const full = ubl('A-HALF');
    await writeFile(path, full.slice(0, 40));
    ws.advance(3000);
    let batch = await ws.engine.scan();
    assert.equal(batchFile(ws, batch, 'half.xml').status, 'deferred');

    await appendFile(path, full.slice(40, 90));
    ws.advance(3000);
    batch = await ws.engine.scan();
    assert.equal(batchFile(ws, batch, 'half.xml').status, 'deferred');
    assert.equal(ws.db.prepare('SELECT COUNT(*) AS n FROM intakes WHERE status != \'duplicate\'').get().n, 0);

    await appendFile(path, full.slice(90));
    ws.advance(3000);
    await ws.engine.scan(); // stabilise
    ws.advance(3000);
    batch = await ws.engine.scan();
    assert.equal(batchFile(ws, batch, 'half.xml').status, 'ingested');
  } finally {
    await ws.cleanup();
  }
});

test('a write during read is deferred rather than ingested', async () => {
  const root = await mkdtemp(join(tmpdir(), 'intake-race-'));
  const inbox = join(root, 'inbox');
  await mkdir(inbox, { recursive: true });
  const db = openDb(':memory:');
  migrate(db);
  const path = join(inbox, 'a.xml');
  await writeFile(path, ubl('A-RACE'));

  const { stat } = await import('node:fs/promises');
  let injected = false;
  const engine = new Engine({
    db,
    watchDir: inbox,
    archiveDir: join(root, 'archive'),
    settleMs: 0,
    autoReplayOnVersionChange: false,
    io: {
      async readFileSafe(target) {
        const { readFile } = await import('node:fs/promises');
        const buffer = await readFile(target);
        if (!injected) {
          // The writer appends after our size check but before this read
          // returns to the caller; the post-read stat then disagrees.
          injected = true;
          await appendFile(target, ' ');
        }
        return { buffer, error: null };
      },
      stat,
    },
  });
  try {
    // First pass stabilises, second pass hits the injected race.
    await engine.scan();
    const batch = await engine.scan();
    const file = batch.files.find((f) => f.name === 'a.xml');
    assert.equal(file.status, 'deferred');
    assert.match(file.detail, /读取期间文件被改写/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM documents').get().n, 0);

    // Next pass, no injection: the append reset stability, so observe once
    // more before the file is read.
    const next = await engine.scan();
    assert.equal(next.files.find((f) => f.name === 'a.xml').status, 'deferred');
    const final = await engine.scan();
    assert.equal(final.files.find((f) => f.name === 'a.xml').status, 'ingested');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM documents').get().n, 1);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('duplicate copy under a new name is recorded as duplicate, not a new document', async () => {
  const ws = await workspace();
  try {
    await ws.write(join(ws.inbox, 'a.xml'), ubl('A-1'));
    ws.advance(3000);
    await ws.engine.scan();
    ws.advance(3000);
    await ws.engine.scan();

    await copyFile(join(ws.inbox, 'a.xml'), join(ws.inbox, 'a-copy.xml'));
    ws.advance(3000);
    await ws.engine.scan();
    ws.advance(3000);
    const batch = await ws.engine.scan();
    assert.equal(batchFile(ws, batch, 'a-copy.xml').status, 'duplicate');
    assert.equal(ws.db.prepare('SELECT COUNT(*) AS n FROM documents').get().n, 1);
    assert.equal(ws.db.prepare('SELECT COUNT(*) AS n FROM intakes WHERE status = \'duplicate\'').get().n, 1);
  } finally {
    await ws.cleanup();
  }
});

test('changed content at the same path is a new intake, and prior confirmed stays', async () => {
  const ws = await workspace();
  try {
    const path = join(ws.inbox, 'a.xml');
    await ws.write(path, ubl('A-1'));
    ws.advance(3000);
    await ws.engine.scan();
    ws.advance(3000);
    await ws.engine.scan();
    const doc = ws.db.prepare('SELECT * FROM documents').get();
    ws.engine.confirm(doc.id, { by: 'tester' });

    await ws.write(path, ubl('A-2'));
    ws.advance(3000);
    await ws.engine.scan();
    ws.advance(3000);
    const batch = await ws.engine.scan();
    assert.equal(batchFile(ws, batch, 'a.xml').status, 'ingested');
    const docs = ws.db.prepare('SELECT invoice_number, state FROM documents ORDER BY invoice_number').all();
    assert.equal(docs.length, 2);
    assert.deepEqual(docs.map((d) => [d.invoice_number, d.state]), [['A-1', 'confirmed'], ['A-2', 'received']]);
  } finally {
    await ws.cleanup();
  }
});

test('missing files are reported and restored files recover', async () => {
  const ws = await workspace();
  try {
    await ws.write(join(ws.inbox, 'a.xml'), ubl('A-1'));
    ws.advance(3000);
    await ws.engine.scan();
    ws.advance(3000);
    await ws.engine.scan();

    await unlink(join(ws.inbox, 'a.xml'));
    ws.advance(3000);
    let batch = await ws.engine.scan();
    assert.equal(batch.missing, 1);
    assert.equal(batchFile(ws, batch, 'a.xml').status, 'missing');
    assert.equal(ws.db.prepare('SELECT status FROM source_files').get().status, 'missing');

    await ws.write(join(ws.inbox, 'a.xml'), ubl('A-1'));
    ws.advance(3000);
    batch = await ws.engine.scan();
    assert.equal(batch.recovered, 1);
    assert.equal(batchFile(ws, batch, 'a.xml').status, 'deferred');
    ws.advance(3000);
    batch = await ws.engine.scan();
    assert.equal(batch.recovered, 1, 'recovery is counted for the file, even when content is unchanged');
    assert.equal(batchFile(ws, batch, 'a.xml').status, 'unchanged');
    assert.equal(batch.unchanged, 1);
    assert.equal(ws.db.prepare('SELECT status FROM source_files').get().status, 'active');
  } finally {
    await ws.cleanup();
  }
});

test('a deleted and recreated inbox recovers without losing state', async () => {
  const ws = await workspace();
  try {
    await ws.write(join(ws.inbox, 'a.xml'), ubl('A-1'));
    await writeFile(join(ws.inbox, 'b.pdf'), makeTextPdf([
      'ACME Industrial GmbH', 'Invoice No. ACME-PDF', 'Invoice date: 2026-05-02',
      'Subtotal: 20.00', 'VAT 19%: 3.80', 'Total: 23.80',
    ]));
    ws.advance(3000);
    await ws.engine.scan();
    ws.advance(3000);
    await ws.engine.scan();
    assert.equal(ws.db.prepare('SELECT COUNT(*) AS n FROM documents').get().n, 2);

    await rm(ws.inbox, { recursive: true, force: true });
    ws.advance(3000);
    let batch = await ws.engine.scan();
    assert.equal(batch.missing, 2);

    await mkdir(ws.inbox, { recursive: true });
    ws.advance(3000);
    await ws.engine.scan(); // directory back, files not yet
    await ws.write(join(ws.inbox, 'a.xml'), ubl('A-1'));
    ws.advance(3000);
    batch = await ws.engine.scan();
    assert.equal(batch.recovered, 1);
    ws.advance(3000);
    batch = await ws.engine.scan();
    assert.equal(batch.status, 'completed');
    assert.equal(batch.unchanged, 1);
    assert.equal(ws.db.prepare('SELECT COUNT(*) AS n FROM documents').get().n, 2);
  } finally {
    await ws.cleanup();
  }
});

test('an oversized file is quarantined without being read into memory', async () => {
  const ws = await workspace();
  try {
    // Write just over the configured cap; the engine must refuse it by stat,
    // before readFile allocates the bytes.
    await writeFile(join(ws.inbox, 'huge.xml'), Buffer.alloc(2048, 0x41));
    ws.engine.maxFileBytes = 512;
    ws.advance(3000);
    await ws.engine.scan();
    ws.advance(3000);
    const batch = await ws.engine.scan();
    assert.equal(batchFile(ws, batch, 'huge.xml').status, 'quarantined');
    assert.match(batchFile(ws, batch, 'huge.xml').detail, /超过上限/);
    const item = ws.db.prepare("SELECT * FROM quarantine_items WHERE kind = 'unsupported_file'").get();
    assert.ok(item, 'oversize file is visible in the quarantine queue');
    assert.match(JSON.parse(item.reasons_json)[0].message, /超过上限/);
    assert.equal(ws.db.prepare('SELECT COUNT(*) AS n FROM intakes').get().n, 0);
  } finally {
    await ws.cleanup();
  }
});

test('a fixed file supersedes the file-level quarantine of the broken version', async () => {
  const ws = await workspace();
  try {
    const path = join(ws.inbox, 'broken.xml');
    await ws.write(path, '<?xml version="1.0"?><Invoice><ID>A-1</ID>');
    ws.advance(3000);
    await ws.engine.scan();
    ws.advance(3000);
    let batch = await ws.engine.scan();
    assert.equal(batchFile(ws, batch, 'broken.xml').status, 'quarantined');
    const open = () => ws.db.prepare("SELECT COUNT(*) AS n FROM quarantine_items WHERE status = 'open'").get().n;
    assert.equal(open(), 1);

    await ws.write(path, ubl('A-1'));
    ws.advance(3000);
    await ws.engine.scan();
    ws.advance(3000);
    batch = await ws.engine.scan();
    assert.equal(batchFile(ws, batch, 'broken.xml').status, 'ingested');
    assert.equal(open(), 0, 'the earlier failure is resolved as superseded');
    const resolved = ws.db.prepare("SELECT resolution FROM quarantine_items WHERE status = 'resolved'").get();
    assert.equal(resolved.resolution, 'superseded');
    assert.equal(ws.db.prepare('SELECT COUNT(*) AS n FROM documents').get().n, 1);
  } finally {
    await ws.cleanup();
  }
});

test('idle watcher does not create a batch on every poll', async () => {
  const ws = await workspace();
  const watcher = new Watcher({ engine: ws.engine, dir: ws.inbox, intervalMs: 50, debounceMs: 10 });
  try {
    watcher.start();
    await new Promise((r) => setTimeout(r, 500));
    const before = ws.db.prepare('SELECT COUNT(*) AS n FROM batches').get().n;
    await new Promise((r) => setTimeout(r, 400));
    const after = ws.db.prepare('SELECT COUNT(*) AS n FROM batches').get().n;
    assert.equal(after, before, 'no directory change and nothing pending → no new batch');
  } finally {
    watcher.stop();
    await ws.cleanup();
  }
});

test('watcher polls a directory that does not exist yet', async () => {
  const root = await mkdtemp(join(tmpdir(), 'intake-w-'));
  const inbox = join(root, 'late');
  const db = openDb(':memory:');
  migrate(db);
  const engine = new Engine({ db, watchDir: inbox, archiveDir: join(root, 'archive'), settleMs: 0 });
  const watcher = new Watcher({ engine, dir: inbox, intervalMs: 50, debounceMs: 10 });
  try {
    watcher.start();
    await mkdir(inbox, { recursive: true });
    await writeFile(join(inbox, 'a.xml'), ubl('A-LATE'));
    // First pass defers; a later poll picks it up.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (db.prepare('SELECT COUNT(*) AS n FROM documents').get().n === 1) break;
      await new Promise((r) => setTimeout(r, 50));
      await writeFile(join(inbox, 'a.xml'), ubl('A-LATE'));
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM documents').get().n, 1);
  } finally {
    watcher.stop();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
