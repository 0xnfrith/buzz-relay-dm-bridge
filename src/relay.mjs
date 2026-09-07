// One relay socket: NIP-42 authentication, one subscription, and publishing
// that waits for the relay's acknowledgement of the specific event.
//
// Each instance owns its own reconnect loop. That independence is the point:
// the far relay going down must not disturb the home side, and a supervisor
// restarting the whole process on either outage would take both halves with
// it. `Restart=always` in the unit file is the outer net, not the mechanism.

import { finalizeEvent } from "nostr-tools";
import WebSocket from "ws";
import { log } from "./log.mjs";

const AUTH_GRACE_MS = 3000;
const PUBLISH_TIMEOUT_MS = 20000;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60000;

export class RelayConnection {
  /**
   * @param {object} opts
   * @param {string} opts.name          label used in logs ("home" / "far")
   * @param {string} opts.url           ws:// or wss:// endpoint
   * @param {Uint8Array} opts.secretKey signing key
   * @param {() => object|null} opts.filter  called on every (re)subscribe, so
   *        the `since` cursor is recomputed rather than frozen at boot
   * @param {(event: object) => void} opts.onEvent
   * @param {() => void} [opts.onReady]  fired after each successful auth
   */
  constructor({ name, url, secretKey, filter, onEvent, onReady }) {
    this.name = name;
    this.url = url;
    this.secretKey = secretKey;
    this.filter = filter;
    this.onEvent = onEvent;
    this.onReady = onReady;
    this.subId = `${name}-sub`;
    this.ws = null;
    this.authed = false;
    this.authEventId = null;
    this.pending = new Map(); // event id -> {resolve}
    this.backoff = BACKOFF_MIN_MS;
    this.stopped = false;
    this.lastEventAt = 0;
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get ready() {
    return this.connected && this.authed;
  }

  start() {
    this.stopped = false;
    this.#connect();
  }

  stop() {
    this.stopped = true;
    try { this.ws?.close(); } catch { /* already gone */ }
  }

  #connect() {
    if (this.stopped) return;
    this.authed = false;
    this.authEventId = null;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.#scheduleReconnect(err.message);
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      log.info("relay.open", { relay: this.name });
      // An open relay never sends a challenge. Subscribe anyway after a short
      // grace period so the bridge works against gated and ungated relays
      // without being told which is which.
      setTimeout(() => {
        if (this.ws === ws && !this.authed && ws.readyState === WebSocket.OPEN) {
          this.authed = true;
          this.subscribe();
          this.onReady?.();
        }
      }, AUTH_GRACE_MS);
    });

    ws.on("message", (raw) => this.#onMessage(raw));
    ws.on("error", (err) => log.warn("relay.error", { relay: this.name, error: err.message }));
    ws.on("close", (code) => {
      if (this.ws !== ws) return;
      this.#failPending(`socket closed (${code})`);
      this.#scheduleReconnect(`closed ${code}`);
    });
  }

  #scheduleReconnect(why) {
    if (this.stopped) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    log.warn("relay.reconnect", { relay: this.name, why, in_ms: delay });
    setTimeout(() => this.#connect(), delay).unref?.();
  }

  #failPending(reason) {
    for (const [, waiter] of this.pending) waiter.resolve({ ok: false, message: reason });
    this.pending.clear();
  }

  #onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg[0] === "AUTH") {
      const event = finalizeEvent(
        {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["relay", this.url], ["challenge", msg[1]]],
          content: "",
        },
        this.secretKey,
      );
      this.authEventId = event.id;
      this.ws.send(JSON.stringify(["AUTH", event]));
      return;
    }

    if (msg[0] === "OK") {
      const [, id, accepted, message] = msg;
      // The relay's first OK answers the AUTH event, not the message just
      // published. Matching on the id keeps those two apart.
      if (id === this.authEventId) {
        this.authEventId = null;
        if (accepted) {
          this.authed = true;
          this.backoff = BACKOFF_MIN_MS;
          log.info("relay.authed", { relay: this.name });
          this.subscribe();
          this.onReady?.();
        } else {
          log.error("relay.auth_failed", { relay: this.name, message });
          try { this.ws.close(); } catch { /* closing anyway */ }
        }
        return;
      }
      const waiter = this.pending.get(id);
      if (waiter) {
        this.pending.delete(id);
        waiter.resolve({ ok: accepted === true, message: message ?? "" });
      }
      return;
    }

    if (msg[0] === "CLOSED") {
      log.warn("relay.sub_closed", { relay: this.name, reason: msg[2] });
      return;
    }

    if (msg[0] === "EVENT" && msg[1] === this.subId) {
      this.lastEventAt = Date.now();
      try {
        this.onEvent(msg[2]);
      } catch (err) {
        log.error("relay.handler_failed", { relay: this.name, error: err.message });
      }
    }
  }

  /** (Re)assert the subscription. Safe to call repeatedly. */
  subscribe() {
    if (!this.connected) return;
    const filter = this.filter();
    if (!filter) return;
    this.ws.send(JSON.stringify(["REQ", this.subId, filter]));
    log.debug("relay.subscribe", { relay: this.name, filter });
  }

  /**
   * Sign, publish, and resolve with the relay's own acknowledgement. Callers
   * treat a false `ok` as "not delivered" — nothing downstream advances a
   * cursor or records a seen id without a true one.
   */
  async publish(template, { timeoutMs = PUBLISH_TIMEOUT_MS } = {}) {
    if (!this.ready) return { ok: false, message: `${this.name} relay not connected` };
    const event = finalizeEvent(
      { created_at: Math.floor(Date.now() / 1000), tags: [], content: "", ...template },
      this.secretKey,
    );
    const result = await new Promise((resolve) => {
      this.pending.set(event.id, { resolve });
      const timer = setTimeout(() => {
        if (this.pending.delete(event.id)) resolve({ ok: false, message: `no acknowledgement in ${timeoutMs}ms` });
      }, timeoutMs);
      timer.unref?.();
      try {
        this.ws.send(JSON.stringify(["EVENT", event]));
      } catch (err) {
        this.pending.delete(event.id);
        resolve({ ok: false, message: err.message });
      }
    });
    return { ...result, id: event.id };
  }
}
