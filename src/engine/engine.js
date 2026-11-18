import { randomUUID } from 'node:crypto';
import { mkdir, rename, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import { all, get, run, recordEvent, transaction } from '../db.js';
import { parseXml } from '../lib/xml.js';
import { extractPdfText } from '../lib/pdf.js';
import { sha256, stableStringify } from '../lib/util.js';
import { diffFields } from '../lib/diff.js';
import { validateFields } from '../lib/validate.js';
import { ParserState } from '../parsers/state.js';
import { registry } from '../parsers/index.js';
import { listCandidateFiles, readFileSafe, classifyExtension, isStable, MAX_FILE_BYTES } from '../ingest/scanner.js';

function nowIso(ms) {
  return new Date(ms).toISOString();
}

function makeId(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

export class Engine {
  constructor({
    db,
    watchDir,
    archiveDir,
    settleMs = 1000,
    now = () => Date.now(),
    parserRegistry = registry,
    autoReplayOnVersionChange = true,
    maxFileBytes = MAX_FILE_BYTES,
    io = {},
  }) {
    this.db = db;
    this.watchDir = watchDir;
    this.archiveDir = archiveDir;
    this.settleMs = settleMs;
    this.now = now;
    this.registry = parserRegistry;
    this.autoReplayOnVersionChange = autoReplayOnVersionChange;
    this.maxFileBytes = maxFileBytes;
    // Injectable for tests that need to simulate a writer touching the file
    // between the pre-read stat and the read itself.
    this.io = { readFileSafe, stat, ...io };
    this.parsers = new ParserState(db, parserRegistry, () => this.iso());
    this._scanChain = Promise.resolve();
    this.parsers.ensureDefaults();
  }

  iso(ms = this.now()) {
    return nowIso(ms);
  }

  // ---------------------------------------------------------------- scanning

  /** Serialize scans: a second trigger joins the in-flight pass. */
  scan(options = {}) {
    const next = this._scanChain.then(() => this._scan(options));
    this._scanChain = next.catch(() => {});
    return next;
  }

  async _scan({ trigger = 'watch', force = false, dir = this.watchDir } = {}) {
    const batchId = makeId('bat');
    const startedMs = this.now();
    run(
      this.db,
      'INSERT INTO batches (id, trigger, dir, status, started_at) VALUES (?, ?, ?, ?, ?)',
      batchId,
      trigger,
      dir,
      'running',
      nowIso(startedMs),
    );

    let files;
    try {
      files = await listCandidateFiles(dir);
    } catch (err) {
      run(
        this.db,
        'UPDATE batches SET status = ?, finished_at = ?, note = ? WHERE id = ?',
        'failed',
        this.iso(),
        `目录无法读取：${err.message}`,
        batchId,
      );
      recordEvent(this.db, this.iso(), 'scan.failed', `扫描失败：${dir}：${err.message}`, { refId: batchId });
      return this.getBatch(batchId);
    }

    const seenPaths = new Set();
    const counts = { files_seen: files.length, intakes: 0, duplicates: 0, quarantined: 0, deferred: 0, unchanged: 0, errors: 0, missing: 0, recovered: 0, ignored: 0 };

    for (const file of files) {
      seenPaths.add(file.path);
      try {
        const result = await this._handleFile(batchId, file, { force });
        for (const [key, value] of Object.entries(result.counters ?? {})) {
          counts[key] = (counts[key] ?? 0) + value;
        }
      } catch (err) {
        counts.errors += 1;
        this._batchFile(batchId, file.path, file.name, 'error', err.message, {
          size: file.size,
          sourceFileId: null,
        });
        recordEvent(this.db, this.iso(), 'file.error', `处理 ${file.name} 时发生未捕获错误：${err.message}`, {
          refId: batchId,
          meta: { path: file.path },
        });
      }
    }

    // Files that were known before but are no longer in the directory. Only
    // safe to conclude "missing" because the listing above succeeded.
    const known = all(this.db, 'SELECT * FROM source_files WHERE status = ?', 'active');
    for (const source of known) {
      if (seenPaths.has(source.path)) continue;
      const root = resolve(dir);
      if (!source.path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) continue;
      transaction(this.db, () => {
        run(
          this.db,
          'UPDATE source_files SET status = ?, missing_at = ?, recovered_from_missing = 1, updated_at = ? WHERE id = ?',
          'missing',
          this.iso(),
          this.iso(),
          source.id,
        );
        this._batchFile(batchId, source.path, source.name, 'missing', '文件已不在监控目录中', {
          size: source.last_size,
          sourceFileId: source.id,
        });
      });
      counts.missing += 1;
      recordEvent(this.db, this.iso(), 'file.missing', `${source.name} 已从监控目录缺失`, {
        refId: source.id,
      });
    }

    const note = counts.deferred
      ? `${counts.deferred} 个文件等待第二次稳定观察`
      : counts.missing
        ? `${counts.missing} 个已接入文件已缺失`
        : null;

    run(
      this.db,
      `UPDATE batches SET status = ?, finished_at = ?, files_seen = ?, intakes = ?, duplicates = ?,
         quarantined = ?, deferred = ?, unchanged = ?, errors = ?, missing = ?, recovered = ?, ignored = ?, note = ?
       WHERE id = ?`,
      'completed',
      this.iso(),
      counts.files_seen,
      counts.intakes,
      counts.duplicates,
      counts.quarantined,
      counts.deferred,
      counts.unchanged,
      counts.errors,
      counts.missing,
      counts.recovered,
      counts.ignored,
      note,
      batchId,
    );
    return this.getBatch(batchId);
  }

  async _handleFile(batchId, file, { force }) {
    const before = get(this.db, 'SELECT * FROM source_files WHERE path = ?', file.path);
    const channel = classifyExtension(file.name);
    const ts = this.iso();

    if (!channel) {
      this._batchFile(batchId, file.path, file.name, 'ignored', '扩展名不在监控范围内', { size: file.size });
      return { counters: { ignored: 1 } };
    }

    // A file that disappeared and came back is a new observation: whatever the
    // old size/mtime said, the old stability count says nothing about the file
    // that is on disk now (it may have been replaced by a same-size copy).
    // Restart the two-observation protocol instead of trusting the old count.
    const recovered = Boolean(before) && (before.status === 'missing' || before.recovered_from_missing === 1);
    const prev = before && !recovered
      ? { size: Number(before.last_size), mtimeMs: Number(before.last_mtime_ms), checks: before.stable_checks }
      : null;
    const sameAsBefore = prev !== null && prev.size === file.size && Math.abs(prev.mtimeMs - file.mtimeMs) < 1;
    const stableChecks = sameAsBefore ? prev.checks + 1 : 1;

    const sourceFileId = before?.id ?? makeId('src');

    transaction(this.db, () => {
      if (!before) {
        run(
          this.db,
          `INSERT INTO source_files (id, path, name, extension, first_seen_at, last_seen_at, last_size, last_mtime_ms,
             stable_checks, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          sourceFileId,
          file.path,
          file.name,
          file.extension,
          ts,
          ts,
          file.size,
          file.mtimeMs,
          stableChecks,
          'active',
          ts,
          ts,
        );
      } else {
        run(
          this.db,
          `UPDATE source_files SET last_seen_at = ?, last_size = ?, last_mtime_ms = ?, stable_checks = ?,
             status = 'active', missing_at = NULL, recovered_from_missing = ?, updated_at = ? WHERE id = ?`,
          ts,
          file.size,
          file.mtimeMs,
          stableChecks,
          recovered ? 1 : before.recovered_from_missing,
          ts,
          sourceFileId,
        );
      }
    });

    if (recovered) {
      recordEvent(this.db, ts, 'file.recovered', `${file.name} reappeared in the watched directory`, {
        refId: sourceFileId,
      });
    }

    const prior = before
      ? { last_seen_at: before.last_seen_at, last_size: before.last_size, last_mtime_ms: before.last_mtime_ms, stable_checks: before.stable_checks }
      : null;

    if (!force && !isStable(prior, file, { settleMs: this.settleMs, now: this.now() })) {
      const why =
        prior === null
          ? '新文件：等待第二次观察后再读取'
          : sameAsBefore
            ? `等待文件写入结束（最后写入后 ${this.settleMs} ms）`
            : '文件自上次扫描后发生变化，稳定计数已重置';
      this._batchFile(batchId, file.path, file.name, 'deferred', why, { size: file.size, sourceFileId });
      return { counters: { deferred: 1, ...(recovered ? { recovered: 1 } : {}) } };
    }

    const opened = await this.io.readFileSafe(file.path, { maxBytes: this.maxFileBytes });
    if (opened.error) {
      const missingNow = opened.error.code === 'ENOENT';
      const tooLarge = opened.error.code === 'EFBIG';
      if (tooLarge) {
        this._quarantine({
          kind: 'unsupported_file',
          sourceFileId,
          reasons: [{
            severity: 'error',
            code: 'FILE_TOO_LARGE',
            message: opened.error.message,
            field: null,
            meta: { size: file.size },
          }],
        });
        this._batchFile(batchId, file.path, file.name, 'quarantined', opened.error.message, {
          size: file.size,
          sourceFileId,
        });
        return { counters: { quarantined: 1, ...(recovered ? { recovered: 1 } : {}) } };
      }
      this._batchFile(batchId, file.path, file.name, missingNow ? 'missing' : 'error', opened.error.message, {
        size: file.size,
        sourceFileId,
      });
      if (missingNow) {
        run(
          this.db,
          'UPDATE source_files SET status = ?, missing_at = ?, updated_at = ? WHERE id = ?',
          'missing',
          this.iso(),
          this.iso(),
          sourceFileId,
        );
        return { counters: { missing: 1, ...(recovered ? { recovered: 1 } : {}) } };
      }
      return { counters: { errors: 1, ...(recovered ? { recovered: 1 } : {}) } };
    }

    // Guard against a writer that touched the file while we were reading it:
    // the bytes on disk were not the bytes we just hashed.
    let after = null;
    try {
      after = await this.io.stat(file.path);
    } catch {
      after = null;
    }
    if (!after || after.size !== file.size || Math.abs(after.mtimeMs - file.mtimeMs) >= 1) {
      run(this.db, 'UPDATE source_files SET stable_checks = 0, updated_at = ? WHERE id = ?', this.iso(), sourceFileId);
      this._batchFile(batchId, file.path, file.name, 'deferred', '读取期间文件被改写，将在下一轮重试', {
        size: file.size,
        sourceFileId,
      });
      return { counters: { deferred: 1 } };
    }

    const buffer = opened.buffer;
    const hash = sha256(buffer);
    const current = get(this.db, 'SELECT * FROM source_files WHERE id = ?', sourceFileId);
    if (current.last_processed_hash === hash) {
      transaction(this.db, () => {
        run(
          this.db,
          'UPDATE source_files SET recovered_from_missing = 0, updated_at = ? WHERE id = ?',
          this.iso(),
          sourceFileId,
        );
        this._batchFile(batchId, file.path, file.name, 'unchanged', '内容哈希与上次处理版本一致', {
          size: file.size,
          hash,
          sourceFileId,
        });
      });
      return { counters: { unchanged: 1, ...(recovered ? { recovered: 1 } : {}) } };
    }

    const result = await this.ingestBuffer({
      buffer,
      hash,
      path: file.path,
      name: file.name,
      size: file.size,
      extension: file.extension,
      sourceFileId,
      batchId,
      trigger: 'watch',
      recovered,
    });
    return result;
  }

  // ---------------------------------------------------------------- ingest

  async ingestBuffer({
    buffer,
    hash = sha256(buffer),
    path,
    name,
    size = buffer.length,
    extension = '',
    sourceFileId = null,
    batchId = null,
    trigger = 'watch',
    recovered = false,
  }) {
    const at = this.iso();
    const intakeId = makeId('int');
    const channel = classifyExtension(name || `.${extension.replace(/^\./, '')}`);
    const archivePath = this._archiveRelative(hash, name);
    let status = 'ingested';
    let reason = null;
    let documentId = null;
    let quarantineIds = [];
    let parserKey = null;
    let parserVersion = null;
    let duplicateOfDocumentId = null;
    let duplicateOfIntakeId = null;

    // Existing document with identical bytes: a duplicate file, never a new
    // document and never an overwrite of an existing (possibly confirmed) one.
    const sameContent = get(this.db, 'SELECT * FROM documents WHERE content_hash = ?', hash);
    const previousIntake = get(
      this.db,
      `SELECT * FROM intakes WHERE content_hash = ? AND id != ? ORDER BY created_at LIMIT 1`,
      hash,
      intakeId,
    );

    if (sameContent) {
      status = 'duplicate';
      reason = '原文哈希已存在';
      documentId = sameContent.id;
      duplicateOfDocumentId = sameContent.id;
      duplicateOfIntakeId = previousIntake?.id ?? null;
    } else if (!channel) {
      status = 'rejected';
      reason = '不支持的文件扩展名';
      const q = this._quarantine({
        kind: 'unsupported_file',
        sourceFileId,
        contentHash: hash,
        reasons: [{ severity: 'error', code: 'UNSUPPORTED_EXTENSION', message: `扩展名「${extension}」不在内容解析范围内`, field: null }],
        priorState: null,
      });
      quarantineIds.push(q.id);
      reason = '不支持的文件扩展名';
    }

    let parsed = null;
    if (!documentId && channel) {
      parsed = this._parseBuffer({ buffer, channel, name });

      if (!parsed.ok) {
        status = 'rejected';
        reason = parsed.error_message;
        const q = this._quarantine({
          kind: parsed.error_code === 'UNKNOWN_SUPPLIER' ? 'unknown_supplier' : channel === 'pdf' ? 'unreadable_pdf' : 'corrupt_file',
          sourceFileId,
          contentHash: hash,
          reasons: [{
            severity: 'error',
            code: parsed.error_code,
            message: parsed.error_message,
            field: null,
          }],
          priorState: null,
        });
        quarantineIds.push(q.id);
      } else {
        parserKey = parsed.parser_key;
        parserVersion = parsed.parser_version;
        const fields = parsed.fields;
        const issues = [
          ...validateFields(fields),
          ...(parsed.warnings ?? []).map((w) => ({ severity: 'warning', field: null, meta: null, ...w })),
        ];
        const errors = issues.filter((i) => i.severity === 'error');
        const docId = makeId('doc');

        // A different byte sequence for the same business invoice is a
        // business duplicate; it must not silently replace anything.
        const businessKey = this._businessKey(parsed.parser_key, fields);
        const existingBusiness = businessKey
          ? get(
              this.db,
              'SELECT * FROM documents WHERE business_key = ? AND state != ? ORDER BY created_at LIMIT 1',
              businessKey,
              'rejected',
            )
          : null;

        await this._archive(hash, buffer, name);

        if (existingBusiness) {
          status = 'duplicate';
          reason = '同一张发票已存在但文件内容不同';
          documentId = existingBusiness.id;
          duplicateOfDocumentId = existingBusiness.id;
          const q = this._quarantine({
            kind: 'business_duplicate',
            documentId: existingBusiness.id,
            sourceFileId,
            priorState: existingBusiness.state,
            reasons: [{
              severity: 'warning',
              code: 'BUSINESS_DUPLICATE',
              message: `发票 ${fields.invoiceNumber ?? '（无发票号）'}（${fields.supplierName ?? parsed.parser_key}）已存在，但本次文件内容不同`,
              field: 'invoiceNumber',
              meta: { businessKey, existingDocumentId: existingBusiness.id },
            }],
          });
          quarantineIds.push(q.id);
          run(
            this.db,
            'INSERT INTO intakes (id, batch_id, source_file_id, document_id, content_hash, size, mtime_ms, status, reason, parser_key, parser_version, duplicate_of_document_id, duplicate_of_intake_id, archive_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            intakeId, batchId, sourceFileId, existingBusiness.id, hash, size, null, status, reason, parserKey, parserVersion,
            existingBusiness.id, previousIntake?.id ?? null, this._archiveRelative(hash, name), at,
          );
          this._markProcessed(sourceFileId, hash, intakeId, at);
          if (batchId) this._batchFile(batchId, path, name, 'duplicate', reason, { size, hash, sourceFileId, intakeId });
          recordEvent(this.db, at, 'intake.duplicate', `${name} 与已有发票 ${fields.invoiceNumber} 业务键相同、内容不同`, {
            refId: intakeId,
            meta: { existingDocumentId: existingBusiness.id },
          });
          return {
            counters: { duplicates: 1, quarantined: 1, ...(recovered ? { recovered: 1 } : {}) },
            documentId: existingBusiness.id,
            intakeId,
          };
        }

        const runId = makeId('run');
        const outcome = errors.length ? 'quarantined' : 'parsed';
        transaction(this.db, () => {
          run(
            this.db,
            `INSERT INTO documents (id, parser_key, parser_version, supplier_key, supplier_name, business_key, invoice_number,
               issue_date, currency, is_credit_note, fields_json, content_hash, state, latest_run_id, accepted_run_id,
               archive_path, original_size, original_name, source_file_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            docId,
            parserKey,
            parserVersion,
            parserKey,
            fields.supplierName ?? parsed.parser_key,
            businessKey,
            fields.invoiceNumber ?? null,
            fields.issueDate ?? null,
            fields.currency ?? null,
            fields.creditNote ? 1 : 0,
            stableStringify(fields),
            hash,
            errors.length ? 'quarantined' : 'received',
            runId,
            null,
            this._archiveRelative(hash, name),
            size,
            name,
            sourceFileId,
            at,
            at,
          );
          run(
            this.db,
            `INSERT INTO parse_runs (id, document_id, parser_key, parser_version, trigger, content_hash, outcome,
               fields_json, issues_json, diff_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            runId, docId, parserKey, parserVersion, trigger, hash, outcome,
            stableStringify(fields), JSON.stringify(issues), null, at,
          );
          run(
            this.db,
            'INSERT INTO intakes (id, batch_id, source_file_id, document_id, content_hash, size, mtime_ms, status, reason, parser_key, parser_version, duplicate_of_document_id, duplicate_of_intake_id, archive_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            intakeId, batchId, sourceFileId, docId, hash, size, null, status, reason, parserKey, parserVersion, null, null, this._archiveRelative(hash, name), at,
          );
        });

        documentId = docId;
        if (errors.length) {
          const q = this._quarantine({
            kind: 'validation',
            documentId: docId,
            parseRunId: runId,
            baselineRunId: null,
            priorState: 'received',
            sourceFileId,
            intakeId,
            reasons: errors,
          });
          quarantineIds.push(q.id);
          status = 'quarantined';
          reason = errors.map((e) => e.message).join('; ');
        }
        this._markProcessed(sourceFileId, hash, intakeId, at);
        this._supersedeFileQuarantine(sourceFileId, intakeId, quarantineIds);
        if (batchId) {
          this._batchFile(batchId, path, name, errors.length ? 'quarantined' : 'ingested', errors.length ? reason : null, {
            size, hash, sourceFileId, intakeId,
          });
        }
        recordEvent(
          this.db,
          at,
          errors.length ? 'intake.quarantined' : 'intake.ingested',
          errors.length
            ? `${name} 已进入隔离：${reason}`
            : `${name} 解析为发票 ${fields.invoiceNumber ?? '（无发票号）'}`,
          { refId: docId, meta: { parserKey, parserVersion, intakeId } },
        );
        return {
          counters: errors.length
            ? { intakes: 1, quarantined: 1, ...(recovered ? { recovered: 1 } : {}) }
            : { intakes: 1, ...(recovered ? { recovered: 1 } : {}) },
          documentId,
          intakeId,
        };
      }
    }

    // Rejected or duplicate path: still record the intake attempt.
    if (!documentId && status === 'rejected') {
      await this._archive(hash, buffer, name).catch(() => {});
    }
    transaction(this.db, () => {
      run(
        this.db,
        'INSERT INTO intakes (id, batch_id, source_file_id, document_id, content_hash, size, mtime_ms, status, reason, parser_key, parser_version, duplicate_of_document_id, duplicate_of_intake_id, archive_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        intakeId, batchId, sourceFileId, documentId, hash, size, null, status, reason, parserKey, parserVersion,
        duplicateOfDocumentId, duplicateOfIntakeId, archivePath, at,
      );
      this._markProcessed(sourceFileId, hash, intakeId, at);
    });
    // The intake row is inserted after parsing fails, so file-level quarantine
    // items can only be linked to it now. The link is what lets the queue show
    // the originating batch and lets a re-drop of the same bytes reuse the item.
    for (const id of quarantineIds) {
      run(this.db, 'UPDATE quarantine_items SET intake_id = ? WHERE id = ? AND intake_id IS NULL', intakeId, id);
    }
    if (batchId) {
      const batchStatus = status === 'duplicate' ? 'duplicate' : 'quarantined';
      this._batchFile(batchId, path, name, batchStatus, reason, { size, hash, sourceFileId, intakeId });
    }
    recordEvent(
      this.db,
      at,
      status === 'duplicate' ? 'intake.duplicate' : 'intake.rejected',
      status === 'duplicate' ? `${name} 与已有文档重复` : `${name} 被拒绝：${reason}`,
      { refId: intakeId },
    );
    if (status === 'rejected') {
      // A newer, valid version of the same path supersedes file-level errors.
      this._supersedeFileQuarantine(sourceFileId, intakeId, quarantineIds);
    }
    return {
      counters: status === 'duplicate'
        ? { duplicates: 1, ...(recovered ? { recovered: 1 } : {}) }
        : { quarantined: 1, ...(recovered ? { recovered: 1 } : {}) },
      documentId,
      intakeId,
    };
  }

  _markProcessed(sourceFileId, hash, intakeId, at) {
    if (!sourceFileId) return;
    // Do not reset stable_checks: the bytes just processed are stable by
    // construction. Resetting would push the next pass back into `deferred`.
    run(
      this.db,
      `UPDATE source_files SET last_processed_hash = ?, last_intake_id = ?, recovered_from_missing = 0,
         updated_at = ? WHERE id = ?`,
      hash,
      intakeId,
      at,
      sourceFileId,
    );
  }

  _supersedeFileQuarantine(sourceFileId, intakeId, keepIds) {
    if (!sourceFileId) return;
    const open = all(
      this.db,
      `SELECT * FROM quarantine_items WHERE source_file_id = ? AND status = 'open' AND document_id IS NULL`,
      sourceFileId,
    );
    for (const item of open) {
      if (keepIds.includes(item.id)) continue;
      run(
        this.db,
        `UPDATE quarantine_items SET status = 'resolved', resolution = 'superseded',
           resolution_note = ?, resolved_by = 'system', resolved_at = ? WHERE id = ?`,
        '同一文件的新版本已成功接入，替代了这次失败',
        this.iso(),
        item.id,
      );
    }
  }

  async _archive(hash, buffer, name) {
    const dir = join(this.archiveDir, hash.slice(0, 2));
    await mkdir(dir, { recursive: true });
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
    const target = join(dir, `${hash}${ext}`);
    const exists = get(this.db, 'SELECT 1 AS ok FROM documents WHERE content_hash = ?', hash);
    if (exists) return target;
    const tmp = `${target}.${randomUUID()}.tmp`;
    await writeFile(tmp, buffer);
    await rename(tmp, target);
    return target;
  }

  _archiveRelative(hash, name) {
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
    return join(hash.slice(0, 2), `${hash}${ext}`);
  }

  _businessKey(parserKey, fields) {
    if (!fields.invoiceNumber) return null;
    const supplier = String(parserKey ?? '').toLowerCase();
    const number = String(fields.invoiceNumber).trim().toLowerCase();
    const date = fields.issueDate ?? '';
    return `${supplier}|${number}|${date}`;
  }

  // ---------------------------------------------------------------- parsing

  _parseBuffer({ buffer, channel, name, parserKey = null, versionOverride = null }) {
    let supplier = null;
    let version = null;
    let fields = null;
    let warnings = [];

    try {
      if (channel === 'xml') {
        const text = buffer.toString('utf8').replace(/^﻿/, '');
        if (text.trim() === '') {
          return this._parseError('EMPTY_FILE', '文件为空', 'EMPTY_FILE', name);
        }
        let root;
        try {
          root = parseXml(text);
        } catch (err) {
          return this._parseError('CORRUPT_XML', `XML 格式错误：${err.message}`, 'CORRUPT_FILE', name);
        }
        supplier = parserKey ? this.registry.get(parserKey) : this.registry.detect({ xmlRoot: root });
        if (!supplier) {
          return this._parseError('UNKNOWN_SUPPLIER', '没有匹配该 XML 的供应商解析规则', 'UNKNOWN_SUPPLIER', name);
        }
        version = versionOverride ?? this.parsers.activeVersion(supplier.key);
        const impl = supplier.versions[version];
        const result = impl.parse(root);
        fields = result.fields;
        warnings = result.warnings ?? [];
      } else {
        if (buffer.length === 0) {
          return this._parseError('EMPTY_FILE', '文件为空', 'EMPTY_FILE', name);
        }
        let text;
        try {
          text = extractPdfText(buffer);
        } catch (err) {
          return this._parseError(
            err.code ?? 'PDF_UNREADABLE',
            `无法抽取 PDF 文本：${err.message}`,
            'PDF',
            name,
          );
        }
        supplier = parserKey ? this.registry.get(parserKey) : this.registry.detect({ pdfText: text });
        if (!supplier) {
          return this._parseError('UNKNOWN_SUPPLIER', '没有匹配该 PDF 的供应商解析规则', 'UNKNOWN_SUPPLIER', name);
        }
        version = versionOverride ?? this.parsers.activeVersion(supplier.key);
        const result = supplier.versions[version].parse(text);
        fields = result.fields;
        warnings = result.warnings ?? [];
      }
    } catch (err) {
      return this._parseError('PARSE_FAILED', `解析器 ${supplier?.key ?? ''} v${version ?? '?'} 执行失败：${err.message}`, 'PARSE', name);
    }

    const normalized = this._normalizeFields(fields);
    return {
      ok: true,
      parser_key: supplier.key,
      parser_version: version,
      fields: normalized,
      warnings,
    };
  }

  _normalizeFields(fields) {
    const out = { ...fields };
    for (const key of ['netAmount', 'taxAmount', 'grossAmount']) {
      if (!(key in out)) out[key] = null;
    }
    out.lineAmounts = Array.isArray(out.lineAmounts) ? out.lineAmounts.map((v) => (Number.isInteger(v) ? v : null)) : [];
    out.creditNote = Boolean(out.creditNote);
    for (const key of ['invoiceNumber', 'supplierName', 'supplierTaxId', 'issueDate', 'currency']) {
      out[key] = out[key] ?? null;
    }
    return out;
  }

  _parseError(code, message, category, name) {
    return {
      ok: false,
      error_code: code,
      error_message: message,
      error_category: category,
      parser_key: null,
      parser_version: null,
      name,
    };
  }

  // ------------------------------------------------------------ quarantine

  _quarantine({
    kind,
    documentId = null,
    parseRunId = null,
    baselineRunId = null,
    priorState = null,
    sourceFileId = null,
    intakeId = null,
    contentHash = null,
    reasons,
    dedupe = true,
  }) {
    // Repeated scans of the same unchanged problem must not flood the queue:
    // refresh the existing open item instead of opening a twin.
    if (dedupe) {
      const existing = documentId
        ? get(this.db, "SELECT id FROM quarantine_items WHERE document_id = ? AND kind = ? AND status = 'open'", documentId, kind)
        : sourceFileId
          ? get(this.db, "SELECT id FROM quarantine_items WHERE source_file_id = ? AND kind = ? AND status = 'open' AND document_id IS NULL", sourceFileId, kind)
          : contentHash
            // No file or document identity (direct ingestion): the same bytes
            // failing the same way is still one problem for the operator.
            ? get(
                this.db,
                `SELECT q.id FROM quarantine_items q JOIN intakes i ON i.id = q.intake_id
                 WHERE q.kind = ? AND q.status = 'open' AND q.document_id IS NULL AND i.content_hash = ?`,
                kind,
                contentHash,
              )
            : null;
      if (existing) {
        run(
          this.db,
          'UPDATE quarantine_items SET reasons_json = ?, parse_run_id = COALESCE(?, parse_run_id), intake_id = COALESCE(?, intake_id) WHERE id = ?',
          JSON.stringify(reasons),
          parseRunId,
          intakeId,
          existing.id,
        );
        return { id: existing.id, reused: true };
      }
    }
    const id = makeId('qtn');
    const at = this.iso();
    run(
      this.db,
      `INSERT INTO quarantine_items (id, kind, document_id, parse_run_id, baseline_run_id, prior_state, source_file_id,
         intake_id, reasons_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      kind,
      documentId,
      parseRunId,
      baselineRunId,
      priorState,
      sourceFileId,
      intakeId,
      JSON.stringify(reasons),
      'open',
      at,
    );
    recordEvent(
      this.db,
      at,
      'quarantine.opened',
      documentId
        ? `进入隔离：${reasons.map((r) => r.message).join('；')}`
        : `文件已隔离：${reasons.map((r) => r.message).join('；')}`,
      { refId: documentId ?? sourceFileId ?? id, meta: { quarantineId: id, kind } },
    );
    return { id };
  }

  // ------------------------------------------------------------- batch log

  _batchFile(batchId, path, name, status, detail, { size = null, hash = null, sourceFileId = null, intakeId = null } = {}) {
    if (!batchId) return;
    run(
      this.db,
      `INSERT INTO batch_files (id, batch_id, source_file_id, path, name, status, detail, size, hash, intake_id, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      makeId('bf'), batchId, sourceFileId, path, name, status, detail, size, hash, intakeId, this.iso(),
    );
  }

  // ------------------------------------------------ confirmations & replay

  confirm(documentId, { by = 'operator', note = null, fields = null } = {}) {
    const doc = this._document(documentId);
    const at = this.iso();
    const runId = doc.latest_run_id;
    const chosen = fields ?? this._fields(doc);
    transaction(this.db, () => {
      run(
        this.db,
        `UPDATE documents SET state = 'confirmed', accepted_run_id = ?, latest_run_id = ?, confirmed_fields_json = ?,
           confirmed_at = ?, confirmed_by = ?, confirmed_note = ?, updated_at = ? WHERE id = ?`,
        runId,
        runId,
        stableStringify(chosen),
        at,
        by,
        note,
        at,
        documentId,
      );
      run(
        this.db,
        `UPDATE quarantine_items SET status = 'resolved', resolution = 'accepted', resolution_note = ?,
           resolved_by = ?, resolved_at = ? WHERE document_id = ? AND status = 'open'`,
        note ?? '操作员人工接受',
        by,
        at,
        documentId,
      );
    });
    recordEvent(this.db, at, 'document.confirmed', `发票 ${doc.invoice_number ?? doc.id} 已确认`, {
      refId: documentId,
      meta: { by },
    });
    return this._document(documentId);
  }

  reject(documentId, { by = 'operator', note = null } = {}) {
    const doc = this._document(documentId);
    if (doc.state === 'confirmed') {
      throw Object.assign(new Error('已确认的发票不能拒绝'), { statusCode: 409 });
    }
    const at = this.iso();
    transaction(this.db, () => {
      run(
        this.db,
        `UPDATE documents SET state = 'rejected', confirmed_at = ?, confirmed_by = ?, confirmed_note = ?, updated_at = ?
         WHERE id = ? AND state != 'confirmed'`,
        at,
        by,
        note,
        at,
        documentId,
      );
      run(
        this.db,
        `UPDATE quarantine_items SET status = 'resolved', resolution = 'rejected', resolution_note = ?,
           resolved_by = ?, resolved_at = ? WHERE document_id = ? AND status = 'open'`,
        note ?? '操作员拒绝',
        by,
        at,
        documentId,
      );
    });
    recordEvent(this.db, at, 'document.rejected', `发票 ${doc.invoice_number ?? doc.id} 已拒绝`, { refId: documentId });
    return this._document(documentId);
  }

  resolveQuarantine(id, { resolution = 'dismissed', by = 'operator', note = null } = {}) {
    const item = get(this.db, 'SELECT * FROM quarantine_items WHERE id = ?', id);
    if (!item) throw Object.assign(new Error('隔离项不存在'), { statusCode: 404 });
    const at = this.iso();
    run(
      this.db,
      `UPDATE quarantine_items SET status = 'resolved', resolution = ?, resolution_note = ?, resolved_by = ?, resolved_at = ?
       WHERE id = ?`,
      resolution,
      note,
      by,
      at,
      id,
    );
    recordEvent(this.db, at, 'quarantine.resolved', `隔离项 ${id} 处理为 ${resolution}`, { refId: id });
    return get(this.db, 'SELECT * FROM quarantine_items WHERE id = ?', id);
  }

  reopenQuarantine(id, { by = 'operator', note = null } = {}) {
    const item = get(this.db, 'SELECT * FROM quarantine_items WHERE id = ?', id);
    if (!item) throw Object.assign(new Error('隔离项不存在'), { statusCode: 404 });
    const at = this.iso();
    run(
      this.db,
      `UPDATE quarantine_items SET status = 'open', resolution = NULL, resolution_note = ?, resolved_by = NULL,
         resolved_at = NULL WHERE id = ?`,
      note,
      id,
    );
    recordEvent(this.db, at, 'quarantine.reopened', `隔离项 ${id} 已重新打开`, { refId: id });
    return get(this.db, 'SELECT * FROM quarantine_items WHERE id = ?', id);
  }

  /**
   * Replay historical documents through a parser version.
   *
   * The original bytes are read from the archive, their hash is verified, and
   * the replay is compared against the document's baseline run. Confirmed
   * documents are never modified: differing results are surfaced as a
   * `confirmed_drift` quarantine item for human review.
   */
  async replay({ parserKey, toVersion, fromVersion = null, trigger = 'manual', documentIds = null } = {}) {
    const supplier = this.registry.get(parserKey);
    if (!supplier) throw Object.assign(new Error(`未知解析器 ${parserKey}`), { statusCode: 400 });
    if (!supplier.versions[toVersion]) {
      throw Object.assign(new Error(`解析器 ${parserKey} 没有版本 ${toVersion}`), { statusCode: 400 });
    }
    const jobId = makeId('rpl');
    const startedAt = this.iso();
    const activeBefore = this.parsers.activeVersion(parserKey);
    run(
      this.db,
      `INSERT INTO replay_jobs (id, parser_key, from_version, to_version, trigger, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      jobId,
      parserKey,
      fromVersion ?? activeBefore,
      toVersion,
      trigger,
      'running',
      startedAt,
    );

    let docs;
    if (documentIds?.length) {
      docs = documentIds
        .map((id) => get(this.db, 'SELECT * FROM documents WHERE id = ?', id))
        .filter((d) => d && d.parser_key === parserKey);
    } else {
      docs = all(
        this.db,
        `SELECT * FROM documents WHERE parser_key = ? AND state != 'rejected' ORDER BY created_at, id`,
        parserKey,
      );
    }

    const counters = {
      scanned: 0,
      changed: 0,
      quarantined: 0,
      recovered: 0,
      skipped: 0,
      failures: 0,
    };

    for (const doc of docs) {
      counters.scanned += 1;
      const itemId = makeId('rpi');
      const baseline = this._baselineRun(doc);
      let outcome = 'unchanged';
      let diff = [];
      let parseRunId = null;
      let reason = null;

      try {
        const archiveFile = join(this.archiveDir, doc.archive_path);
        const buffer = await readFile(archiveFile);
        const actualHash = sha256(buffer);
        if (actualHash !== doc.content_hash) {
          outcome = 'integrity_error';
          reason = '归档原文与记录的内容哈希不一致';
          counters.failures += 1;
          this._recordReplayItem(itemId, jobId, doc.id, null, outcome, [], reason);
          continue;
        }

        const parsed = this._parseBuffer({
          buffer,
          channel: classifyExtension(doc.original_name ?? archiveFile) ?? (doc.parser_key === 'acme-pdf' ? 'pdf' : 'xml'),
          name: doc.original_name ?? doc.id,
          parserKey,
          versionOverride: toVersion,
        });

        if (!parsed.ok) {
          outcome = 'parse_failed';
          reason = parsed.error_message;
          counters.failures += 1;
          const runId = this._insertRun(doc.id, {
            parserKey,
            parserVersion: toVersion,
            trigger: 'replay',
            replayJobId: jobId,
            contentHash: doc.content_hash,
            outcome,
            errorCode: parsed.error_code,
            errorMessage: parsed.error_message,
          });
          parseRunId = runId;
          this._handleReplayFailure(doc, runId, baseline, [{ severity: 'error', code: parsed.error_code, message: parsed.error_message, field: null }], jobId);
          this._recordReplayItem(itemId, jobId, doc.id, runId, outcome, [], reason);
          continue;
        }

        const fields = parsed.fields;
        const issues = validateFields(fields, {
          supplierName: doc.supplier_name,
          invoiceNumber: doc.invoice_number,
        });
        const errors = issues.filter((i) => i.severity === 'error');
        const baselineFields = baseline ? this._runFields(baseline) : null;
        diff = diffFields(baselineFields, fields);
        const confirmed = doc.state === 'confirmed';
        const previousFields = confirmed ? this._confirmedFields(doc) : baselineFields;

        if (confirmed) {
          const confirmedDiff = diffFields(previousFields, fields);
          if (confirmedDiff.length > 0) {
            outcome = 'confirmed_drift';
            counters.changed += 1;
            counters.quarantined += 1;
            const runId = this._insertRun(doc.id, {
              parserKey,
              parserVersion: toVersion,
              trigger: 'replay',
              replayJobId: jobId,
              contentHash: doc.content_hash,
              outcome,
              fields,
              issues,
              diff: confirmedDiff,
              comparedRunId: baseline?.id ?? null,
            });
            parseRunId = runId;
            this._quarantine({
              kind: 'confirmed_drift',
              documentId: doc.id,
              parseRunId: runId,
              baselineRunId: baseline?.id ?? null,
              priorState: 'confirmed',
              reasons: [{
                severity: 'error',
                code: 'CONFIRMED_DRIFT',
                message: `用 ${parserKey} v${toVersion} 重放的结果与已确认字段有 ${confirmedDiff.length} 处不一致；已确认文档未被修改`,
                field: null,
                meta: { diff: confirmedDiff },
              }],
            });
            this._recordReplayItem(itemId, jobId, doc.id, runId, outcome, confirmedDiff, reason);
          } else {
            outcome = 'confirmed_match';
            counters.skipped += 1;
            const runId = this._insertRun(doc.id, {
              parserKey,
              parserVersion: toVersion,
              trigger: 'replay',
              replayJobId: jobId,
              contentHash: doc.content_hash,
              outcome,
              fields,
              issues,
              diff,
              comparedRunId: baseline?.id ?? null,
            });
            parseRunId = runId;
            this._recordReplayItem(itemId, jobId, doc.id, runId, outcome, [], null);
          }
          continue;
        }

        const runId = this._insertRun(doc.id, {
          parserKey,
          parserVersion: toVersion,
          trigger: 'replay',
          replayJobId: jobId,
          contentHash: doc.content_hash,
          outcome: errors.length ? 'quarantined' : 'parsed',
          fields,
          issues,
          diff,
          comparedRunId: baseline?.id ?? null,
        });
        parseRunId = runId;

        if (errors.length) {
          outcome = 'quarantined';
          counters.quarantined += 1;
          const wasQuarantined = doc.state === 'quarantined';
          transaction(this.db, () => {
            run(
              this.db,
              `UPDATE documents SET parser_version = ?, fields_json = ?, state = 'quarantined', latest_run_id = ?,
                 updated_at = ? WHERE id = ?`,
              toVersion,
              stableStringify(fields),
              runId,
              this.iso(),
              doc.id,
            );
            run(this.db, 'UPDATE parse_runs SET diff_json = ? WHERE id = ?', JSON.stringify(diff), runId);
          });
          // Refreshes the open item when one exists, so the queue shows the
          // errors of the version that actually produced this run.
          this._quarantine({
            kind: 'validation',
            documentId: doc.id,
            parseRunId: runId,
            baselineRunId: baseline?.id ?? null,
            priorState: wasQuarantined ? doc.state : doc.state,
            reasons: errors,
          });
        } else {
          const wasQuarantined = doc.state === 'quarantined';
          const changed = diff.length > 0 || doc.parser_version !== toVersion;
          outcome = wasQuarantined ? 'recovered' : changed ? 'updated' : 'unchanged';
          if (wasQuarantined) counters.recovered += 1;
          if (changed) counters.changed += 1;
          transaction(this.db, () => {
            run(
              this.db,
              `UPDATE documents SET parser_version = ?, fields_json = ?, state = 'received', supplier_name = ?,
                 invoice_number = ?, issue_date = ?, currency = ?, is_credit_note = ?, business_key = ?,
                 latest_run_id = ?, updated_at = ? WHERE id = ? AND state != 'confirmed'`,
              toVersion,
              stableStringify(fields),
              fields.supplierName ?? doc.supplier_name,
              fields.invoiceNumber ?? null,
              fields.issueDate ?? null,
              fields.currency ?? null,
              fields.creditNote ? 1 : 0,
              this._businessKey(parserKey, fields),
              runId,
              this.iso(),
              doc.id,
            );
            run(this.db, 'UPDATE parse_runs SET diff_json = ? WHERE id = ?', JSON.stringify(diff), runId);
          });
          if (wasQuarantined) {
            run(
              this.db,
              `UPDATE quarantine_items SET status = 'resolved', resolution = 'replay_fixed', resolution_note = ?,
                 resolved_by = 'system', resolved_at = ? WHERE document_id = ? AND status = 'open'`,
              `用 ${parserKey} v${toVersion} 重放后校验通过`,
              this.iso(),
              doc.id,
            );
          }
        }
        this._recordReplayItem(itemId, jobId, doc.id, runId, outcome, diff, null);
      } catch (err) {
        outcome = 'failed';
        reason = err.message;
        counters.failures += 1;
        this._quarantine({
          kind: 'replay_failed',
          documentId: doc.id,
          baselineRunId: baseline?.id ?? null,
          priorState: doc.state,
          reasons: [{ severity: 'error', code: 'REPLAY_FAILED', message: `重放失败：${err.message}`, field: null }],
        });
        this._recordReplayItem(itemId, jobId, doc.id, null, outcome, [], reason);
      }
    }

    const finishedAt = this.iso();
    run(
      this.db,
      `UPDATE replay_jobs SET status = ?, finished_at = ?, documents_scanned = ?, documents_changed = ?,
         documents_quarantined = ?, documents_recovered = ?, documents_skipped = ?, failures = ? WHERE id = ?`,
      'completed',
      finishedAt,
      counters.scanned,
      counters.changed,
      counters.quarantined,
      counters.recovered,
      counters.skipped,
      counters.failures,
      jobId,
    );
    recordEvent(
      this.db,
      finishedAt,
      'replay.completed',
      `用 ${parserKey} v${toVersion} 重放 ${counters.scanned} 份发票：变化 ${counters.changed}、进入隔离 ${counters.quarantined}、恢复 ${counters.recovered}`,
      { refId: jobId, meta: { parserKey, toVersion, ...counters } },
    );
    return this.getReplayJob(jobId);
  }

  _handleReplayFailure(doc, runId, baseline, reasons, jobId) {
    if (doc.state === 'confirmed') {
      this._quarantine({
        kind: 'confirmed_drift',
        documentId: doc.id,
        parseRunId: runId,
        baselineRunId: baseline?.id ?? null,
        priorState: 'confirmed',
        reasons: reasons.map((r) => ({
          ...r,
          code: 'CONFIRMED_DRIFT',
          message: `已确认发票重放失败：${r.message}`,
        })),
      });
      return;
    }
    run(
      this.db,
      `UPDATE documents SET state = 'quarantined', latest_run_id = ?, updated_at = ? WHERE id = ? AND state != 'confirmed'`,
      runId,
      this.iso(),
      doc.id,
    );
    this._quarantine({
      kind: 'validation',
      documentId: doc.id,
      parseRunId: runId,
      baselineRunId: baseline?.id ?? null,
      priorState: doc.state,
      reasons,
    });
  }

  _insertRun(documentId, {
    parserKey,
    parserVersion,
    trigger,
    replayJobId = null,
    contentHash = null,
    outcome,
    fields = null,
    issues = [],
    diff = [],
    errorCode = null,
    errorMessage = null,
    comparedRunId = null,
  }) {
    const id = makeId('run');
    run(
      this.db,
      `INSERT INTO parse_runs (id, document_id, parser_key, parser_version, trigger, replay_job_id, content_hash, outcome,
         fields_json, issues_json, diff_json, error_code, error_message, compared_run_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      documentId,
      parserKey,
      parserVersion,
      trigger,
      replayJobId,
      contentHash,
      outcome,
      fields === null ? null : stableStringify(fields),
      JSON.stringify(issues),
      JSON.stringify(diff),
      errorCode,
      errorMessage,
      comparedRunId,
      this.iso(),
    );
    return id;
  }

  _recordReplayItem(id, jobId, documentId, parseRunId, outcome, diff, reason) {
    run(
      this.db,
      `INSERT INTO replay_items (id, replay_job_id, document_id, parse_run_id, outcome, diff_json, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      jobId,
      documentId,
      parseRunId,
      outcome,
      JSON.stringify(diff ?? []),
      reason,
      this.iso(),
    );
  }

  async setParserVersion(parserKey, version) {
    const before = this.parsers.activeVersion(parserKey);
    this.parsers.set(parserKey, version);
    const after = this.parsers.activeVersion(parserKey);
    let replayJob = null;
    if (this.autoReplayOnVersionChange && before !== after) {
      replayJob = await this.replay({ parserKey, toVersion: after, fromVersion: before, trigger: 'parser_upgrade' });
    }
    return { parserKey, from: before, to: after, replayJob };
  }

  // ---------------------------------------------------------------- reads

  _baselineRun(doc) {
    const runId = doc.accepted_run_id ?? doc.latest_run_id;
    if (runId) {
      const runRow = get(this.db, 'SELECT * FROM parse_runs WHERE id = ?', runId);
      if (runRow) return runRow;
    }
    return get(
      this.db,
      `SELECT * FROM parse_runs WHERE document_id = ? AND outcome IN ('parsed','quarantined')
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      doc.id,
    );
  }

  _runFields(runRow) {
    if (!runRow?.fields_json) return null;
    try {
      return JSON.parse(runRow.fields_json);
    } catch {
      return null;
    }
  }

  _fields(doc) {
    const row = get(this.db, 'SELECT * FROM documents WHERE id = ?', doc.id ?? doc);
    if (!row?.fields_json) return null;
    return JSON.parse(row.fields_json);
  }

  _confirmedFields(doc) {
    const row = get(this.db, 'SELECT * FROM documents WHERE id = ?', doc.id ?? doc);
    if (!row?.confirmed_fields_json) return this._fields(row);
    return JSON.parse(row.confirmed_fields_json);
  }

  _document(id) {
    const doc = get(this.db, 'SELECT * FROM documents WHERE id = ?', id);
    if (!doc) throw Object.assign(new Error('发票不存在'), { statusCode: 404 });
    return doc;
  }

  /** Resolves once every queued scan has finished (used during shutdown). */
  idle() {
    return this._scanChain;
  }

  /** True when files are waiting for a second stable observation. */
  hasPendingStability() {
    const last = get(this.db, 'SELECT deferred FROM batches WHERE status = \'completed\' ORDER BY started_at DESC, rowid DESC LIMIT 1');
    return Boolean(last && last.deferred > 0);
  }

  getBatch(id) {
    const batch = get(this.db, 'SELECT * FROM batches WHERE id = ?', id);
    if (!batch) return null;
    return {
      ...batch,
      files: all(this.db, 'SELECT * FROM batch_files WHERE batch_id = ? ORDER BY rowid', id),
    };
  }

  getReplayJob(id) {
    const job = get(this.db, 'SELECT * FROM replay_jobs WHERE id = ?', id);
    if (!job) return null;
    const items = all(
      this.db,
      `SELECT ri.*, d.invoice_number, d.supplier_name FROM replay_items ri
       LEFT JOIN documents d ON d.id = ri.document_id WHERE ri.replay_job_id = ? ORDER BY ri.rowid`,
      id,
    ).map((item) => ({ ...item, diff: safeParse(item.diff_json) }));
    return { ...job, items };
  }
}

function safeParse(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
