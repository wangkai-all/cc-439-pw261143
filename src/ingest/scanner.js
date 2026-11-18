import { readdir, stat, readFile } from 'node:fs/promises';
import { join, extname, basename, resolve } from 'node:path';

/**
 * Directory scanner.
 *
 * A file is only eligible once it has looked identical on two consecutive
 * passes (same size and mtime) and its mtime is older than `settleMs`. This is
 * how half-written files are kept out of the pipeline: a copy that is still
 * growing changes size between passes, and a file is never read on the same
 * pass it first appears. Files that disappear or shrink are reported as
 * `missing` so the caller can stop treating them as current.
 */

// Files above this size are not read into memory at all. An invoice is a few
// hundred kilobytes; anything in the hundreds of megabytes is either not an
// invoice or an attempt to exhaust memory.
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

const SUPPORTED = new Map([
  ['.xml', 'xml'],
  ['.pdf', 'pdf'],
]);

export function classifyExtension(name) {
  return SUPPORTED.get(extname(name).toLowerCase()) ?? null;
}

export async function readDirectory(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isFile());
}

export function describeStat(st) {
  return { size: st.size, mtimeMs: st.mtimeMs };
}

export function isStable(candidate, observation, { settleMs, now }) {
  if (!candidate) return false;
  if (candidate.last_seen_at === null) return false;
  const sameSize = Number(candidate.last_size) === observation.size;
  const sameMtime = Math.abs(Number(candidate.last_mtime_ms) - observation.mtimeMs) < 1;
  const oldEnough = now - observation.mtimeMs >= settleMs;
  const enoughPasses = candidate.stable_checks >= 1;
  return sameSize && sameMtime && oldEnough && enoughPasses;
}

/**
 * Walk one directory (non-recursive) and call `onFile` for each file.
 * Kept as a generator-like helper so tests can drive a single pass.
 */
export async function listCandidateFiles(dir) {
  let entries;
  try {
    entries = await readDirectory(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const path = resolve(join(dir, entry.name));
    let st;
    try {
      st = await stat(path);
    } catch {
      continue; // vanished between readdir and stat
    }
    if (!st.isFile()) continue;
    files.push({
      path,
      name: basename(path),
      extension: extname(entry.name).toLowerCase(),
      size: st.size,
      mtimeMs: st.mtimeMs,
      channel: classifyExtension(entry.name),
    });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readFileSafe(path, { maxBytes = MAX_FILE_BYTES } = {}) {
  try {
    // Size is checked before reading so an oversized file never enters memory.
    const st = await stat(path);
    if (st.size > maxBytes) {
      const err = new Error(
        `文件大小 ${formatBytes(st.size)} 超过上限 ${formatBytes(maxBytes)}，未读取`,
      );
      err.code = 'EFBIG';
      return { buffer: null, error: err };
    }
    return { buffer: await readFile(path), error: null };
  } catch (err) {
    return { buffer: null, error: err };
  }
}

function formatBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
