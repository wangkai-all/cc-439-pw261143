import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS parser_versions (
  parser_key TEXT PRIMARY KEY,
  active_version TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL,
  dir TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  files_seen INTEGER NOT NULL DEFAULT 0,
  intakes INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  quarantined INTEGER NOT NULL DEFAULT 0,
  deferred INTEGER NOT NULL DEFAULT 0,
  unchanged INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  missing INTEGER NOT NULL DEFAULT 0,
  recovered INTEGER NOT NULL DEFAULT 0,
  ignored INTEGER NOT NULL DEFAULT 0,
  note TEXT
);

CREATE TABLE IF NOT EXISTS source_files (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  extension TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_size INTEGER,
  last_mtime_ms REAL,
  stable_checks INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  current_hash TEXT,
  last_processed_hash TEXT,
  last_intake_id TEXT,
  missing_at TEXT,
  recovered_from_missing INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  parser_key TEXT,
  parser_version TEXT,
  supplier_key TEXT,
  supplier_name TEXT,
  business_key TEXT,
  invoice_number TEXT,
  issue_date TEXT,
  currency TEXT,
  is_credit_note INTEGER NOT NULL DEFAULT 0,
  fields_json TEXT,
  confirmed_fields_json TEXT,
  content_hash TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  accepted_run_id TEXT,
  latest_run_id TEXT,
  confirmed_at TEXT,
  confirmed_by TEXT,
  confirmed_note TEXT,
  duplicate_of_document_id TEXT,
  source_file_id TEXT,
  archive_path TEXT,
  original_size INTEGER,
  original_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_business
  ON documents (business_key);
CREATE INDEX IF NOT EXISTS idx_documents_state ON documents (state);

CREATE TABLE IF NOT EXISTS batch_files (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  source_file_id TEXT,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  size INTEGER,
  hash TEXT,
  intake_id TEXT,
  seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_batch_files_batch ON batch_files (batch_id);

CREATE TABLE IF NOT EXISTS parse_runs (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  parser_key TEXT,
  parser_version TEXT,
  trigger TEXT NOT NULL,
  replay_job_id TEXT,
  content_hash TEXT,
  outcome TEXT NOT NULL,
  fields_json TEXT,
  issues_json TEXT,
  diff_json TEXT,
  error_code TEXT,
  error_message TEXT,
  raw_excerpt TEXT,
  compared_run_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_parse_runs_document ON parse_runs (document_id, created_at);
CREATE INDEX IF NOT EXISTS idx_parse_runs_outcome ON parse_runs (outcome);

CREATE TABLE IF NOT EXISTS quarantine_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  document_id TEXT,
  parse_run_id TEXT,
  baseline_run_id TEXT,
  prior_state TEXT,
  source_file_id TEXT,
  intake_id TEXT,
  reasons_json TEXT NOT NULL,
  status TEXT NOT NULL,
  resolution TEXT,
  resolution_note TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quarantine_status ON quarantine_items (status, created_at);
CREATE INDEX IF NOT EXISTS idx_quarantine_document ON quarantine_items (document_id);

CREATE TABLE IF NOT EXISTS intakes (
  id TEXT PRIMARY KEY,
  batch_id TEXT,
  source_file_id TEXT,
  document_id TEXT,
  content_hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms REAL,
  status TEXT NOT NULL,
  reason TEXT,
  parser_key TEXT,
  parser_version TEXT,
  duplicate_of_document_id TEXT,
  duplicate_of_intake_id TEXT,
  archive_path TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intakes_hash ON intakes (content_hash);
CREATE INDEX IF NOT EXISTS idx_intakes_batch ON intakes (batch_id);
CREATE INDEX IF NOT EXISTS idx_intakes_file ON intakes (source_file_id, created_at);
CREATE INDEX IF NOT EXISTS idx_intakes_document ON intakes (document_id);

CREATE TABLE IF NOT EXISTS replay_jobs (
  id TEXT PRIMARY KEY,
  parser_key TEXT NOT NULL,
  from_version TEXT,
  to_version TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  documents_scanned INTEGER NOT NULL DEFAULT 0,
  documents_changed INTEGER NOT NULL DEFAULT 0,
  documents_quarantined INTEGER NOT NULL DEFAULT 0,
  documents_recovered INTEGER NOT NULL DEFAULT 0,
  documents_skipped INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  note TEXT
);

CREATE TABLE IF NOT EXISTS replay_items (
  id TEXT PRIMARY KEY,
  replay_job_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  parse_run_id TEXT,
  outcome TEXT NOT NULL,
  diff_json TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_replay_items_job ON replay_items (replay_job_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref_id TEXT,
  message TEXT NOT NULL,
  meta_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_at ON events (at);
`;

export function migrate(db) {
  db.exec(SCHEMA);
  db.exec('PRAGMA user_version = 1');
}

export function all(db, sql, ...params) {
  return db.prepare(sql).all(...params).map((row) => ({ ...row }));
}

export function get(db, sql, ...params) {
  const row = db.prepare(sql).get(...params);
  return row ? { ...row } : null;
}

export function run(db, sql, ...params) {
  return db.prepare(sql).run(...params);
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The transaction may already be rolled back by SQLite.
    }
    throw err;
  }
}

export function recordEvent(db, at, kind, message, { refId = null, meta = null } = {}) {
  run(
    db,
    'INSERT INTO events (at, kind, ref_id, message, meta_json) VALUES (?, ?, ?, ?, ?)',
    at,
    kind,
    refId,
    message,
    meta === null ? null : JSON.stringify(meta),
  );
}
