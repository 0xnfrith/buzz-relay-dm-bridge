// Durable state: which source events have already been delivered, and how far
// each subscription has read.
//
// The ordering rule this file exists to support: a source event id is recorded
// only *after* the destination relay acknowledges the forwarded event. A crash
// between publish and record therefore costs at most one duplicate on restart,
// which is visible and self-correcting. Recording first would instead lose a
// message whose publish had failed, silently — the worse of the two failures.

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";

const SEEN_LIMIT = 5000;

export class State {
  constructor(dir) {
    this.dir = dir;
    this.seenPath = join(dir, "seen.txt");
    this.cursorPath = join(dir, "cursor.json");
    this.seen = new Set();
    this.cursor = { home_last: 0, far_last: 0, dm_channel_id: null };
  }

  load() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (existsSync(this.seenPath)) {
      for (const line of readFileSync(this.seenPath, "utf8").split("\n")) {
        const id = line.trim();
        if (/^[0-9a-f]{64}$/.test(id)) this.seen.add(id);
      }
    }
    if (existsSync(this.cursorPath)) {
      try {
        Object.assign(this.cursor, JSON.parse(readFileSync(this.cursorPath, "utf8")));
      } catch {
        // A truncated cursor file is not worth refusing to start over: the
        // cold-start rules below are safe, they just forward nothing old.
      }
    }
    this.cold = !existsSync(this.cursorPath);
    return this;
  }

  has(id) {
    return this.seen.has(id);
  }

  /** Record a delivered source event. Call only after the destination OK. */
  commit(id, side, createdAt) {
    this.seen.add(id);
    if (this.seen.size > SEEN_LIMIT * 2) {
      this.seen = new Set([...this.seen].slice(-SEEN_LIMIT));
    }
    const key = side === "home" ? "home_last" : "far_last";
    if (createdAt > (this.cursor[key] ?? 0)) this.cursor[key] = createdAt;
    this.persist();
  }

  /** Liveness stamp, read by `--healthcheck` from a separate process. */
  beat(now = Math.floor(Date.now() / 1000)) {
    this.cursor.heartbeat = now;
    this.persist();
  }

  /**
   * Record a source event that will never be forwarded — one the bridge
   * answered with a notice, or gave up on after exhausting its retries.
   *
   * Without this, a restart's replay window would resurrect it: the operator
   * would be told a second time that their message did not tag the bridge, or
   * a message they were told was undelivered would arrive hours later, after
   * they had already resent it by hand.
   */
  suppress(id) {
    this.seen.add(id);
    this.persist();
  }

  setDmChannel(id) {
    this.cursor.dm_channel_id = id;
    this.persist();
  }

  persist() {
    writeAtomic(this.seenPath, [...this.seen].slice(-SEEN_LIMIT).join("\n") + "\n");
    writeAtomic(this.cursorPath, JSON.stringify(this.cursor, null, 2) + "\n");
  }

  /**
   * Where a subscription should start reading.
   *
   * A first boot never looks backwards: replaying a channel's back-scroll on
   * a cold start would mean delivering its history to the far side as if the
   * operator had just typed it. On a restart a 60-second overlap is taken,
   * because `created_at` is second-granular and a relay may order same-second
   * events differently across a reconnect. The overlap is only safe because
   * the seen-id set absorbs it.
   */
  since(side, now = Math.floor(Date.now() / 1000)) {
    const last = side === "home" ? this.cursor.home_last : this.cursor.far_last;
    if (!last) return now;
    return Math.max(0, last - 60);
  }
}

function writeAtomic(path, contents) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, path);
}
