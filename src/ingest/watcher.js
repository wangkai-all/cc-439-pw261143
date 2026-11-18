import { watch, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Poll-based watcher. Directory events are debounced into a scan; the engine
 * itself is idempotent, so missed events (or a provider without recursive
 * watch on Linux) do not lose files. The interval is the recovery path: a file
 * dropped while the directory was missing, or an event that never fired,
 * is picked up on the next tick.
 */
export class Watcher {
  constructor({ engine, dir, intervalMs = 2000, debounceMs = 250, log = () => {} }) {
    this.engine = engine;
    this.dir = resolve(dir);
    this.intervalMs = intervalMs;
    this.debounceMs = debounceMs;
    this.log = log;
    this.timer = null;
    this.poll = null;
    this.watcher = null;
    this.scanning = false;
    this.pending = false;
    this.stopped = true;
    this.lastSignature = null;
  }

  start() {
    if (!this.stopped) return this;
    this.stopped = false;
    this.lastSignature = this._signature();
    this._attach();
    // Polling is a fallback for missed events and for stability re-checks.
    // It only starts a scan when the directory content actually changed or a
    // file is still waiting for its second stable observation; otherwise every
    // tick would create an empty batch.
    this.poll = setInterval(() => this._poll(), this.intervalMs);
    this.poll.unref?.();
    return this;
  }

  _attach() {
    try {
      this.watcher = watch(this.dir, { persistent: false }, () => this.requestScan('event'));
      this.watcher.on('error', (err) => {
        this.log(`Directory watcher error: ${err.message}`);
        this.watcher?.close();
        this.watcher = null;
        // Retry attachment on the next poll; the poller keeps working without it.
        setTimeout(() => {
          if (!this.stopped) this._attach();
        }, Math.max(this.intervalMs, 1000)).unref?.();
      });
    } catch (err) {
      this.log(`Directory is not watchable yet (${err.code ?? err.message}); polling until it appears`);
      setTimeout(() => {
        if (!this.stopped) this._attach();
      }, Math.max(this.intervalMs, 1000)).unref?.();
    }
  }

  _signature() {
    try {
      return readdirSync(this.dir)
        .sort()
        .map((name) => {
          try {
            const st = statSync(resolve(this.dir, name));
            return `${name}:${st.size}:${Math.round(st.mtimeMs)}`;
          } catch {
            return `${name}:?`;
          }
        })
        .join('|');
    } catch {
      // Missing directory: still scan so the engine can mark files missing.
      return null;
    }
  }

  _poll() {
    const signature = this._signature();
    const changed = signature !== this.lastSignature;
    if (changed || this.engine.hasPendingStability()) {
      this.lastSignature = signature;
      this.requestScan('poll');
    }
  }

  requestScan(trigger = 'watch') {
    if (this.stopped) return;
    this.pending = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this._drain(trigger), this.debounceMs);
    this.timer.unref?.();
  }

  async _drain(trigger) {
    if (this.scanning || this.stopped) return;
    this.pending = false;
    this.scanning = true;
    try {
      this.lastSignature = this._signature();
      const batch = await this.engine.scan({ trigger });
      if (batch && batch.status !== 'completed') {
        this.log(`Scan ${batch.id} finished with status ${batch.status}${batch.note ? `: ${batch.note}` : ''}`);
      }
    } catch (err) {
      this.log(`Scan failed: ${err.message}`);
    } finally {
      this.scanning = false;
      if (this.pending && !this.stopped) this.requestScan(trigger);
    }
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.poll) clearInterval(this.poll);
    this.watcher?.close();
    this.watcher = null;
  }
}
