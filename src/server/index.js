import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { openDb, migrate } from '../db.js';
import { Engine } from '../engine/engine.js';
import { Watcher } from '../ingest/watcher.js';
import { createApp } from './app.js';

loadDotEnv();

function loadDotEnv() {
  // No dependency for this; a plain KEY=VALUE file is enough and keeps the
  // process startable with `npm start` after `cp .env.example .env`.
  for (const name of ['.env', '.env.local']) {
    let text;
    try {
      text = readFileSync(resolve(process.cwd(), name), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match || line.trim().startsWith('#')) continue;
      const [, key, raw] = match;
      if (process.env[key] !== undefined) continue;
      process.env[key] = raw.replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}

export function buildSystem({
  dataDir = process.env.DATA_DIR ?? resolve(process.cwd(), 'data'),
  watchDir = process.env.WATCH_DIR ?? resolve(process.cwd(), 'inbox'),
  dbFile = process.env.DB_FILE ?? null,
  settleMs = numberFromEnv('SETTLE_MS', 1200),
  pollMs = numberFromEnv('POLL_MS', 2000),
  maxFileBytes = numberFromEnv('MAX_FILE_BYTES', undefined),
  now = () => Date.now(),
  autoReplayOnVersionChange = true,
} = {}) {
  mkdirSync(watchDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const archiveDir = resolve(dataDir, 'archive');
  mkdirSync(archiveDir, { recursive: true });
  const actualDbFile = dbFile ?? resolve(dataDir, 'intake.db');

  const db = openDb(actualDbFile);
  migrate(db);
  const engine = new Engine({ db, watchDir, archiveDir, settleMs, now, autoReplayOnVersionChange, maxFileBytes });
  const watcher = new Watcher({ engine, dir: watchDir, intervalMs: pollMs });
  return {
    db,
    engine,
    watcher,
    watchDir,
    archiveDir,
    dataDir,
    async start() {
      watcher.start();
      // First pass on boot picks up anything dropped while we were down.
      return engine.scan({ trigger: 'startup' });
    },
    stop() {
      watcher.stop();
      db.close();
    },
  };
}

function numberFromEnv(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

const isEntrypoint = process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`;

if (isEntrypoint) {
  const system = buildSystem();
  const port = numberFromEnv('PORT', 4477);
  const app = createApp({
    db: system.db,
    engine: system.engine,
    watchDir: system.watchDir,
    archiveDir: system.archiveDir,
    publicDir: resolve(process.cwd(), 'public'),
  });

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`\n[${signal}] shutting down`);
    system.watcher.stop();
    // Let an in-flight scan finish before closing the connection: a database
    // closed mid-transaction would leave the last file processed twice on the
    // next boot.
    await system.engine.idle().catch(() => {});
    app.close(() => {
      system.db.close();
      process.exit(0);
    });
    // A hung connection must not block shutdown forever.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await system.start();
  app.listen(port, () => {
    console.log(`Invoice intake listening on http://localhost:${port}`);
    console.log(`Watching ${system.watchDir}  •  archive ${system.archiveDir}`);
  });
}
