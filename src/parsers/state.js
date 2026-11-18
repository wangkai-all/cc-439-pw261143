import { get, run } from '../db.js';

/**
 * Parser registry state. The SQLite table is the source of truth for the
 * active version per parser key, so a version bump survives restarts and a
 * replay always records exactly which parser version produced a run.
 */
export class ParserState {
  constructor(db, registry, clock) {
    this.db = db;
    this.registry = registry;
    this.clock = clock;
  }

  get(parserKey) {
    const supplier = this.registry.get(parserKey);
    if (!supplier) throw new Error(`未知解析器 ${parserKey}`);
    const row = get(this.db, 'SELECT active_version FROM parser_versions WHERE parser_key = ?', parserKey);
    const versions = Object.keys(supplier.versions);
    const active = row?.active_version && supplier.versions[row.active_version]
      ? row.active_version
      : supplier.defaultVersion ?? versions[0];
    return { supplier, activeVersion: active };
  }

  activeVersion(parserKey) {
    return this.get(parserKey).activeVersion;
  }

  ensureDefaults() {
    for (const supplier of this.registry.all) {
      const row = get(this.db, 'SELECT 1 AS ok FROM parser_versions WHERE parser_key = ?', supplier.key);
      if (!row) {
        const version = supplier.defaultVersion ?? Object.keys(supplier.versions)[0];
        this.set(supplier.key, version, { silent: true });
      }
    }
  }

  set(parserKey, version, { silent = false } = {}) {
    const { supplier } = this.get(parserKey);
    if (!supplier.versions[version]) {
      throw new Error(`解析器 ${parserKey} 没有版本 ${version}`);
    }
    const at = this.clock();
    run(
      this.db,
      `INSERT INTO parser_versions (parser_key, active_version, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(parser_key) DO UPDATE SET active_version = excluded.active_version, updated_at = excluded.updated_at`,
      parserKey,
      version,
      at,
    );
    if (!silent) {
      run(
        this.db,
        'INSERT INTO events (at, kind, ref_id, message) VALUES (?, ?, ?, ?)',
        at,
        'parser.version_changed',
        parserKey,
        `解析器 ${parserKey} 激活版本切换为 ${version}`,
      );
    }
    return { parserKey, version };
  }

  list() {
    return this.registry.all.map((supplier) => ({
      key: supplier.key,
      supplierName: supplier.supplierName,
      channel: supplier.channel,
      activeVersion: this.activeVersion(supplier.key),
      versions: Object.keys(supplier.versions),
    }));
  }
}
