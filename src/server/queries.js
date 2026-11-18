import { all, get } from '../db.js';

function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function decorateDocument(row) {
  if (!row) return null;
  const doc = { ...row, fields: parseJson(row.fields_json), confirmed_fields: parseJson(row.confirmed_fields_json) };
  delete doc.fields_json;
  delete doc.confirmed_fields_json;
  return doc;
}

function decorateRun(row) {
  if (!row) return null;
  return {
    ...row,
    fields: parseJson(row.fields_json),
    issues: parseJson(row.issues_json, []),
    diff: parseJson(row.diff_json, []),
    fields_json: undefined,
    issues_json: undefined,
    diff_json: undefined,
  };
}

function decorateQuarantine(row) {
  if (!row) return null;
  return { ...row, reasons: parseJson(row.reasons_json, []), reasons_json: undefined };
}

export function overview(db) {
  const now = new Date();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();

  const docStates = all(db, 'SELECT state, COUNT(*) AS n FROM documents GROUP BY state');
  const counts = Object.fromEntries(docStates.map((r) => [r.state, r.n]));
  const totalDocs = docStates.reduce((acc, r) => acc + r.n, 0);

  const openQuarantine = get(db, "SELECT COUNT(*) AS n FROM quarantine_items WHERE status = 'open'").n;
  const quarantineByKind = all(
    db,
    "SELECT kind, COUNT(*) AS n FROM quarantine_items WHERE status = 'open' GROUP BY kind ORDER BY n DESC",
  );
  const batchesToday = get(db, 'SELECT COUNT(*) AS n FROM batches WHERE started_at >= ?', startOfDay).n;
  const intakesToday = get(db, 'SELECT COUNT(*) AS n FROM intakes WHERE created_at >= ?', startOfDay).n;
  const duplicates = get(db, "SELECT COUNT(*) AS n FROM intakes WHERE status = 'duplicate'").n;
  const deferredLast = get(
    db,
    'SELECT deferred FROM batches ORDER BY started_at DESC LIMIT 1',
  )?.deferred ?? 0;
  const lastBatch = get(db, 'SELECT * FROM batches ORDER BY started_at DESC LIMIT 1');
  const openQuarantineNew = get(
    db,
    "SELECT COUNT(*) AS n FROM quarantine_items WHERE status = 'open' AND created_at >= ?",
    startOfDay,
  ).n;

  const dayExpr = (col) => `substr(${col}, 1, 10)`;
  const recentDays = all(
    db,
    `SELECT ${dayExpr('created_at')} AS day, status, COUNT(*) AS n FROM intakes
     WHERE created_at >= datetime('now', '-13 days')
     GROUP BY day, status ORDER BY day`,
  );

  return {
    documents: {
      total: totalDocs,
      received: counts.received ?? 0,
      quarantined: counts.quarantined ?? 0,
      confirmed: counts.confirmed ?? 0,
      rejected: counts.rejected ?? 0,
    },
    quarantine: { open: openQuarantine, openedToday: openQuarantineNew, byKind: quarantineByKind },
    intake: { duplicates, deferredLast, today: intakesToday, batchesToday, lastBatch },
    recentDays,
    parsers: all(db, 'SELECT * FROM parser_versions ORDER BY parser_key'),
    latestReplay: get(db, 'SELECT * FROM replay_jobs ORDER BY started_at DESC LIMIT 1'),
    sourceFiles: {
      active: get(db, "SELECT COUNT(*) AS n FROM source_files WHERE status = 'active'").n,
      missing: get(db, "SELECT COUNT(*) AS n FROM source_files WHERE status = 'missing'").n,
    },
  };
}

export function listBatches(db, { limit = 30, before = null } = {}) {
  const rows = before
    ? all(db, 'SELECT * FROM batches WHERE started_at < ? ORDER BY started_at DESC LIMIT ?', before, limit)
    : all(db, 'SELECT * FROM batches ORDER BY started_at DESC LIMIT ?', limit);
  return rows.map((batch) => ({
    ...batch,
    files: all(db, 'SELECT * FROM batch_files WHERE batch_id = ? ORDER BY rowid', batch.id),
  }));
}

export function getBatch(db, id) {
  const batch = get(db, 'SELECT * FROM batches WHERE id = ?', id);
  if (!batch) return null;
  return {
    ...batch,
    files: all(db, 'SELECT * FROM batch_files WHERE batch_id = ? ORDER BY rowid', id),
  };
}

export function listDocuments(db, { state = null, supplier = null, q = null, limit = 50, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (state) { where.push('state = ?'); params.push(state); }
  if (supplier) { where.push('supplier_key = ?'); params.push(supplier); }
  if (q) {
    where.push('(invoice_number LIKE ? OR supplier_name LIKE ? OR content_hash LIKE ? OR original_name LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = get(db, `SELECT COUNT(*) AS n FROM documents ${clause}`, ...params).n;
  const rows = all(
    db,
    `SELECT * FROM documents ${clause} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset,
  ).map((row) => {
    const openQ = get(
      db,
      "SELECT COUNT(*) AS n FROM quarantine_items WHERE document_id = ? AND status = 'open'",
      row.id,
    ).n;
    return { ...decorateDocument(row), open_quarantine: openQ };
  });
  return { total, items: rows };
}

export function getDocument(db, id) {
  const doc = get(db, 'SELECT * FROM documents WHERE id = ?', id);
  if (!doc) return null;
  const runs = all(db, 'SELECT * FROM parse_runs WHERE document_id = ? ORDER BY created_at DESC, rowid DESC', id)
    .map(decorateRun);
  const intakes = all(
    db,
    'SELECT i.*, b.trigger AS batch_trigger, b.started_at AS batch_started_at FROM intakes i LEFT JOIN batches b ON b.id = i.batch_id WHERE i.document_id = ? ORDER BY i.created_at DESC',
    id,
  );
  const quarantine = all(
    db,
    'SELECT * FROM quarantine_items WHERE document_id = ? ORDER BY created_at DESC',
    id,
  ).map(decorateQuarantine);
  const source = doc.source_file_id
    ? get(db, 'SELECT * FROM source_files WHERE id = ?', doc.source_file_id)
    : null;
  const baseline = runs.find((r) => r.id === (doc.accepted_run_id ?? doc.latest_run_id)) ?? runs[0] ?? null;
  const latest = runs[0] ?? null;
  return {
    document: decorateDocument(doc),
    runs,
    baseline_run_id: baseline?.id ?? null,
    latest_run_id: latest?.id ?? null,
    intakes,
    quarantine,
    source_file: source,
  };
}

export function listQuarantine(db, { status = 'open', kind = null, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (status && status !== 'all') { where.push('q.status = ?'); params.push(status); }
  if (kind) { where.push('q.kind = ?'); params.push(kind); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = all(
    db,
    `SELECT q.*, d.invoice_number, d.supplier_name, d.state AS document_state, d.content_hash,
            sf.name AS file_name, sf.path AS file_path, sf.status AS file_status,
            b.trigger AS batch_trigger, b.started_at AS batch_started_at, i.status AS intake_status
     FROM quarantine_items q
     LEFT JOIN documents d ON d.id = q.document_id
     LEFT JOIN source_files sf ON sf.id = COALESCE(q.source_file_id, d.source_file_id)
     LEFT JOIN intakes i ON i.id = COALESCE(q.intake_id,
            (SELECT id FROM intakes WHERE document_id = q.document_id ORDER BY created_at DESC LIMIT 1),
            (SELECT id FROM intakes WHERE source_file_id = q.source_file_id ORDER BY created_at DESC LIMIT 1))
     LEFT JOIN batches b ON b.id = i.batch_id
     ${clause}
     ORDER BY q.created_at DESC LIMIT ?`,
    ...params,
    limit,
  );
  return rows.map(decorateQuarantine);
}

export function getQuarantine(db, id) {
  const row = get(
    db,
    `SELECT q.*, d.invoice_number, d.supplier_name, d.state AS document_state, d.content_hash,
            sf.name AS file_name, sf.path AS file_path, sf.status AS file_status,
            i.status AS intake_status, b.trigger AS batch_trigger, b.started_at AS batch_started_at
     FROM quarantine_items q
     LEFT JOIN documents d ON d.id = q.document_id
     LEFT JOIN source_files sf ON sf.id = COALESCE(q.source_file_id, d.source_file_id)
     LEFT JOIN intakes i ON i.id = COALESCE(q.intake_id,
            (SELECT id FROM intakes WHERE document_id = q.document_id ORDER BY created_at DESC LIMIT 1),
            (SELECT id FROM intakes WHERE source_file_id = q.source_file_id ORDER BY created_at DESC LIMIT 1))
     LEFT JOIN batches b ON b.id = i.batch_id
     WHERE q.id = ?`,
    id,
  );
  if (!row) return null;
  const runs = row.document_id
    ? all(db, 'SELECT * FROM parse_runs WHERE document_id = ? ORDER BY created_at DESC, rowid DESC', row.document_id)
        .map(decorateRun)
    : [];
  return { ...decorateQuarantine(row), runs };
}

export function listReplayJobs(db, { limit = 30 } = {}) {
  return all(db, 'SELECT * FROM replay_jobs ORDER BY started_at DESC LIMIT ?', limit);
}

export function getReplayJob(db, id) {
  const job = get(db, 'SELECT * FROM replay_jobs WHERE id = ?', id);
  if (!job) return null;
  const items = all(
    db,
    `SELECT ri.*, d.invoice_number, d.supplier_name, d.state AS document_state
     FROM replay_items ri LEFT JOIN documents d ON d.id = ri.document_id
     WHERE ri.replay_job_id = ? ORDER BY ri.rowid`,
    id,
  ).map((item) => ({ ...item, diff: parseJson(item.diff_json, []), diff_json: undefined }));
  return { ...job, items };
}

export function listEvents(db, { limit = 100, kind = null } = {}) {
  const rows = kind
    ? all(db, 'SELECT * FROM events WHERE kind = ? ORDER BY at DESC, id DESC LIMIT ?', kind, limit)
    : all(db, 'SELECT * FROM events ORDER BY at DESC, id DESC LIMIT ?', limit);
  return rows.map((row) => ({ ...row, meta: parseJson(row.meta_json) }));
}

export function listSourceFiles(db, { status = null, limit = 100 } = {}) {
  const rows = status
    ? all(db, 'SELECT * FROM source_files WHERE status = ? ORDER BY updated_at DESC LIMIT ?', status, limit)
    : all(db, 'SELECT * FROM source_files ORDER BY updated_at DESC LIMIT ?', limit);
  return rows;
}

export function listParsers(db) {
  return all(db, 'SELECT * FROM parser_versions ORDER BY parser_key');
}

export function findIntakeByHash(db, hash) {
  return all(db, 'SELECT * FROM intakes WHERE content_hash = ? ORDER BY created_at', hash);
}
