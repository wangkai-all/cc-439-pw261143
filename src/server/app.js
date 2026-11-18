import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

import * as q from './queries.js';
import { all, get } from '../db.js';
import { formatAmount } from '../lib/util.js';
import { validateFields, hasErrors, REQUIRED_FIELDS } from '../lib/validate.js';

const EDITABLE_FIELDS = new Set([
  ...REQUIRED_FIELDS.map(([field]) => field),
  'supplierTaxId',
  'lineAmounts',
  'costCenter',
  'creditNote',
]);

/**
 * Operator-supplied field overrides are written into the confirmed record, so
 * they are re-validated exactly like parser output. Unknown keys are dropped:
 * an override is for correcting known fields, not for injecting arbitrary JSON
 * into the audit record.
 */
function sanitizeOverride(fields) {
  if (fields === null || fields === undefined) return null;
  if (typeof fields !== 'object' || Array.isArray(fields)) {
    throw new HttpError(400, 'fields 必须是对象');
  }
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (EDITABLE_FIELDS.has(key)) out[key] = value;
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new HttpError(413, '请求体过大');
    chunks.push(chunk);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, '请求体必须是合法 JSON');
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function createApp({ db, engine, watchDir, archiveDir, publicDir, version = '1.0.0' }) {
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(
      `^${pattern.replace(/:([a-zA-Z]+)/g, (_, k) => {
        keys.push(k);
        return '([^/]+)';
      })}$`,
    );
    routes.push({ method, re, keys, handler });
  };

  route('GET', '/api/health', () => ({
    ok: true,
    version,
    watchDir,
    archiveDir,
    now: new Date().toISOString(),
  }));

  route('GET', '/api/overview', () => q.overview(db));

  route('GET', '/api/batches', (ctx) =>
    q.listBatches(db, {
      limit: clampInt(ctx.query.get('limit'), 30, 1, 200),
      before: ctx.query.get('before'),
    }),
  );
  route('GET', '/api/batches/:id', (ctx) => {
    const batch = q.getBatch(db, ctx.params.id);
    if (!batch) throw new HttpError(404, '批次不存在');
    return batch;
  });

  route('GET', '/api/documents', (ctx) =>
    q.listDocuments(db, {
      state: ctx.query.get('state'),
      supplier: ctx.query.get('supplier'),
      q: ctx.query.get('q'),
      limit: clampInt(ctx.query.get('limit'), 50, 1, 200),
      offset: clampInt(ctx.query.get('offset'), 0, 0, 1_000_000),
    }),
  );
  route('GET', '/api/documents/:id', (ctx) => {
    const result = q.getDocument(db, ctx.params.id);
    if (!result) throw new HttpError(404, '发票不存在');
    return result;
  });

  route('POST', '/api/documents/:id/confirm', async (ctx) => {
    const body = await readBody(ctx.req);
    const doc = q.getDocument(db, ctx.params.id);
    if (!doc) throw new HttpError(404, '发票不存在');
    if (doc.document.state === 'confirmed') throw new HttpError(409, '发票已确认，不能重复确认');
    const override = sanitizeOverride(body.fields);
    if (override) {
      // Only fields the caller actually changed are overridden; the rest keep
      // the parsed values, so a partial correction cannot blank other fields.
      const merged = { ...(doc.document.fields ?? {}), ...override };
      const issues = validateFields(merged);
      if (hasErrors(issues)) {
        throw new HttpError(
          400,
          `修改后的字段未通过校验：${issues.filter((i) => i.severity === 'error').map((i) => i.message).join('；')}`,
          { issues },
        );
      }
      body.fields = merged;
    }
    const updated = engine.confirm(ctx.params.id, {
      by: body.by ?? 'operator',
      note: body.note ?? null,
      fields: body.fields ?? null,
    });
    return { document: updated };
  });

  route('POST', '/api/documents/:id/reject', async (ctx) => {
    const body = await readBody(ctx.req);
    const doc = q.getDocument(db, ctx.params.id);
    if (!doc) throw new HttpError(404, '发票不存在');
    if (doc.document.state === 'confirmed') throw new HttpError(409, '已确认的发票不能拒绝');
    return { document: engine.reject(ctx.params.id, { by: body.by ?? 'operator', note: body.note ?? null }) };
  });

  route('GET', '/api/quarantine', (ctx) =>
    q.listQuarantine(db, {
      status: ctx.query.get('status') ?? 'open',
      kind: ctx.query.get('kind'),
      limit: clampInt(ctx.query.get('limit'), 100, 1, 500),
    }),
  );
  route('GET', '/api/quarantine/:id', (ctx) => {
    const item = q.getQuarantine(db, ctx.params.id);
    if (!item) throw new HttpError(404, '隔离项不存在');
    return item;
  });
  route('POST', '/api/quarantine/:id/resolve', async (ctx) => {
    const body = await readBody(ctx.req);
    return { item: engine.resolveQuarantine(ctx.params.id, {
      resolution: body.resolution ?? 'dismissed',
      by: body.by ?? 'operator',
      note: body.note ?? null,
    }) };
  });
  route('POST', '/api/quarantine/:id/reopen', async (ctx) => {
    const body = await readBody(ctx.req);
    return { item: engine.reopenQuarantine(ctx.params.id, { by: body.by ?? 'operator', note: body.note ?? null }) };
  });
  route('POST', '/api/quarantine/:id/confirm-document', async (ctx) => {
    const body = await readBody(ctx.req);
    const item = q.getQuarantine(db, ctx.params.id);
    if (!item) throw new HttpError(404, '隔离项不存在');
    if (!item.document_id) throw new HttpError(409, '该隔离项没有关联发票');
    if (item.kind === 'confirmed_drift') {
      throw new HttpError(409, '确认后差异需要逐字段复核，请通过发票确认操作处理');
    }
    if (item.kind !== 'validation') {
      throw new HttpError(409, `「${item.kind}」类型需要按接入记录处理，不能直接确认发票`);
    }
    const doc = q.getDocument(db, item.document_id);
    if (doc.document.state === 'confirmed') throw new HttpError(409, '发票已确认，不能重复确认');
    const updated = engine.confirm(item.document_id, {
      by: body.by ?? 'operator',
      note: body.note ?? `Accepted from quarantine ${item.id}`,
    });
    return { document: updated };
  });

  route('GET', '/api/parsers', () => ({
    parsers: engine.parsers.list(),
    stored: q.listParsers(db),
  }));
  route('POST', '/api/parsers/:key/version', async (ctx) => {
    const body = await readBody(ctx.req);
    if (!body.version) throw new HttpError(400, '缺少 version 参数');
    const known = engine.parsers.list().find((p) => p.key === ctx.params.key);
    if (!known) throw new HttpError(404, '解析器不存在');
    if (!known.versions.includes(body.version)) {
      throw new HttpError(400, `${ctx.params.key} 没有版本 ${body.version}`);
    }
    const result = await engine.setParserVersion(ctx.params.key, body.version);
    return result;
  });

  route('GET', '/api/replays', (ctx) => ({
    jobs: q.listReplayJobs(db, { limit: clampInt(ctx.query.get('limit'), 30, 1, 200) }),
  }));
  route('GET', '/api/replays/:id', (ctx) => {
    const job = q.getReplayJob(db, ctx.params.id);
    if (!job) throw new HttpError(404, '重放任务不存在');
    return job;
  });
  route('POST', '/api/replays', async (ctx) => {
    const body = await readBody(ctx.req);
    if (!body.parserKey || !body.toVersion) throw new HttpError(400, '缺少 parserKey 或 toVersion');
    const job = await engine.replay({
      parserKey: body.parserKey,
      toVersion: body.toVersion,
      fromVersion: body.fromVersion ?? null,
      trigger: 'manual',
      documentIds: Array.isArray(body.documentIds) ? body.documentIds : null,
    });
    return { job };
  });

  route('POST', '/api/scan', async (ctx) => {
    const body = await readBody(ctx.req);
    const batch = await engine.scan({ trigger: body.trigger ?? 'manual', force: Boolean(body.force) });
    return { batch };
  });

  route('GET', '/api/events', (ctx) =>
    q.listEvents(db, {
      limit: clampInt(ctx.query.get('limit'), 100, 1, 500),
      kind: ctx.query.get('kind'),
    }),
  );
  route('GET', '/api/source-files', (ctx) =>
    q.listSourceFiles(db, {
      status: ctx.query.get('status'),
      limit: clampInt(ctx.query.get('limit'), 100, 1, 500),
    }),
  );

  route('GET', '/api/intakes/:id', (ctx) => {
    const intake = get(db, 'SELECT * FROM intakes WHERE id = ?', ctx.params.id);
    if (!intake) throw new HttpError(404, '接入记录不存在');
    return {
      intake,
      attempts: all(db, 'SELECT * FROM intakes WHERE content_hash = ? ORDER BY created_at', intake.content_hash),
      document: intake.document_id ? q.getDocument(db, intake.document_id) : null,
    };
  });

  route('GET', '/api/documents/:id/export', (ctx) => {
    const doc = q.getDocument(db, ctx.params.id);
    if (!doc) throw new HttpError(404, '发票不存在');
    const fields = doc.document.confirmed_fields ?? doc.document.fields;
    return {
      document: {
        id: doc.document.id,
        state: doc.document.state,
        parser: { key: doc.document.parser_key, version: doc.document.parser_version },
        contentHash: doc.document.content_hash,
        confirmedAt: doc.document.confirmed_at,
        confirmedBy: doc.document.confirmed_by,
      },
      fields: {
        ...fields,
        netAmount: formatAmount(fields?.netAmount),
        taxAmount: formatAmount(fields?.taxAmount),
        grossAmount: formatAmount(fields?.grossAmount),
      },
      issues: doc.latest_run_id ? doc.runs.find((r) => r.id === doc.latest_run_id)?.issues ?? [] : [],
    };
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        return await serveStatic(req, res, url.pathname, publicDir);
      }
      const matched = routes
        .filter((r) => r.method === req.method)
        .map((r) => ({ r, m: r.re.exec(url.pathname) }))
        .find((x) => x.m);
      if (!matched) {
        if (url.pathname.startsWith('/api/')) throw new HttpError(404, '未找到');
        return await serveStatic(req, res, url.pathname, publicDir);
      }
      const ctx = {
        req,
        res,
        query: url.searchParams,
        params: Object.fromEntries(matched.r.keys.map((k, i) => [k, decodeURIComponent(matched.m[i + 1])])),
      };
      const result = await matched.r.handler(ctx);
      if (result === undefined) return;
      json(res, 200, result);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err.statusCode ?? 500;
      if (status >= 500) console.error(err);
      json(res, status, {
        error: err.message ?? 'Internal server error',
        code: err.code ?? null,
        details: err.details ?? null,
      });
    }
  });

  return server;
}

async function serveStatic(req, res, pathname, publicDir) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const root = resolve(publicDir);
  const target = resolve(join(root, normalize(rel)));
  // Compare with the separator so a sibling directory whose name merely starts
  // with the same characters (`public-private`) is not treated as inside root.
  if (target !== root && !target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('未找到');
      return;
    }
    throw err;
  }
}

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export { HttpError };
