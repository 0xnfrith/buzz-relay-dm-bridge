// Wiring: two relay connections, the gates between them, and the durable
// state that makes a restart uneventful.

import { randomUUID } from "node:crypto";
import { RelayConnection } from "./relay.mjs";
import { classifyFarEvent, classifyHomeEvent } from "./gates.mjs";
import { MediaCarrier, describeRefusal, imetaTag, mediaOrigin, rewriteContent } from "./media.mjs";
import { log } from "./log.mjs";

const KIND_MESSAGE = 9;
const KIND_PROFILE = 0;
const KIND_DM_OPEN = 41010;
const FORWARD_ATTEMPTS = 3;
const HEARTBEAT_MS = 60000;
const RESUBSCRIBE_MS = 60000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());

/**
 * Run tasks strictly one after another.
 *
 * Handling events concurrently would let two messages sent seconds apart
 * overtake each other on the way out — the retry backoff on the first is long
 * enough for the second to pass it. Order is the whole point of a chat
 * window, so each direction forwards serially.
 */
export function serializer(onError = () => {}) {
  let tail = Promise.resolve();
  return (task) => {
    // A failed task must not stall the queue behind it, and the queue's own
    // promise must never reject: nothing awaits it, so a rejection here would
    // surface only as an unhandled rejection.
    tail = tail.then(task, task).catch(onError);
    return tail;
  };
}

export class Bridge {
  constructor(config, state) {
    this.config = config;
    this.state = state;
    this.dmChannelId = state.cursor.dm_channel_id ?? null;
    this.lastUntaggedNoticeAt = 0;
    this.stopped = false;
    this.homeOrigin = mediaOrigin(config.homeRelayUrl);
    this.farOrigin = mediaOrigin(config.farRelayUrl);
    this.media = new MediaCarrier({ secretKey: config.secretKey, maxBytes: config.maxAttachmentBytes });
    this.outbound = serializer((err) => log.error("outbound.failed", { error: String(err?.message ?? err) }));
    this.inbound = serializer((err) => log.error("inbound.failed", { error: String(err?.message ?? err) }));

    this.home = new RelayConnection({
      name: "home",
      url: config.homeRelayUrl,
      secretKey: config.secretKey,
      filter: () => ({ kinds: [KIND_MESSAGE], "#h": [config.homeChannelId], since: state.since("home") }),
      onEvent: (event) => this.outbound(() => this.#onHomeEvent(event)),
    });

    this.far = new RelayConnection({
      name: "far",
      url: config.farRelayUrl,
      secretKey: config.secretKey,
      // Subscribing to nothing until the DM channel is known is deliberate:
      // a filter without `#h` would be a subscription to the whole relay.
      filter: () => (this.dmChannelId
        ? { kinds: [KIND_MESSAGE], "#h": [this.dmChannelId], since: state.since("far") }
        : null),
      onEvent: (event) => this.inbound(() => this.#onFarEvent(event)),
      onReady: () => { this.#bootstrapFar().catch((e) => log.error("far.bootstrap_failed", { error: e.message })); },
    });
  }

  async start() {
    log.info("bridge.start", {
      pubkey: this.config.botPubkey,
      home_relay: this.config.homeRelayUrl,
      far_relay: this.config.farRelayUrl,
      dm_channel: this.dmChannelId,
      cold_start: this.state.cold,
      dry_run: this.config.dryRun,
    });
    this.home.start();
    this.far.start();

    // Relay-side subscriptions have been observed to die while the socket
    // stays open, which looks exactly like a quiet channel. Re-asserting is
    // cheap and the seen-id set makes it harmless.
    this.timers = [
      setInterval(() => { this.home.subscribe(); this.far.subscribe(); }, RESUBSCRIBE_MS),
      setInterval(() => this.#heartbeat(), HEARTBEAT_MS),
    ];
    for (const t of this.timers) t.unref?.();
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers ?? []) clearInterval(t);
    this.home.stop();
    this.far.stop();
  }

  #heartbeat() {
    this.state.beat();
    log.info("bridge.heartbeat", {
      home_connected: this.home.ready,
      far_connected: this.far.ready,
      home_last: this.state.cursor.home_last,
      far_last: this.state.cursor.far_last,
      dm_channel: this.dmChannelId,
    });
  }

  // --- bootstrap ----------------------------------------------------------

  /**
   * Find (or create) the direct-message thread with the peer.
   *
   * The relay's open is idempotent on the participant set, so this runs on
   * every boot and is what makes a wiped state directory self-healing — the
   * channel id cannot be discovered by listing on this deployment.
   *
   * The `d` tag must be a fresh uuid each time: the relay treats a repeated
   * command event as a duplicate and answers without the channel id.
   */
  async #bootstrapFar() {
    // Once per process, not once per reconnect: a flapping socket should not
    // mean a command event per flap.
    if (this.bootstrapped) return;
    this.bootstrapped = true;
    if (this.config.publishProfile) await this.#publishProfile();

    const result = await this.far.publish({
      kind: KIND_DM_OPEN,
      tags: [["p", this.config.farPeerPubkey], ["d", randomUUID()]],
      content: "",
    });
    if (!result.ok) {
      log.error("far.dm_open_failed", { message: result.message });
      this.bootstrapped = false; // retry on the next successful auth
      return;
    }
    const parsed = parseCommandResponse(result.message);
    const channelId = parsed?.channel_id;
    if (!channelId) {
      log.error("far.dm_open_unparsable", { message: result.message });
      this.bootstrapped = false;
      return;
    }

    // The one place the two sides could quietly diverge. If the relay says it
    // *created* a thread when we already knew a different one, the peer is
    // still looking at the old thread and a silent switch would strand every
    // reply they send. Keep the known thread and say so out loud.
    if (this.dmChannelId && channelId !== this.dmChannelId) {
      log.error("far.dm_channel_diverged", { known: this.dmChannelId, returned: channelId, created: parsed.created });
      await this.#notifyHome(
        "The peer thread I am watching is not the one the relay just handed back. " +
        "I am staying on the thread I know and forwarding nothing new until this is looked at.",
      );
      return;
    }

    if (!this.dmChannelId) {
      this.dmChannelId = channelId;
      this.state.setDmChannel(channelId);
      log.info("far.dm_channel", { channel: channelId, created: parsed.created });
    }
    this.far.subscribe();
  }

  async #publishProfile() {
    const content = JSON.stringify({
      name: this.config.displayName,
      display_name: this.config.displayName,
      ...(this.config.displayAbout ? { about: this.config.displayAbout } : {}),
    });
    for (const conn of [this.home, this.far]) {
      const r = await conn.publish({ kind: KIND_PROFILE, tags: [], content });
      log.info("profile.published", { relay: conn.name, ok: r.ok, message: r.message });
    }
  }

  // --- home side (operator -> peer) ---------------------------------------

  async #onHomeEvent(event) {
    if (this.state.has(event.id)) { log.debug("home.drop", { id: event.id, reason: "already-delivered" }); return; }
    const verdict = classifyHomeEvent(event, this.config);

    if (verdict.action === "drop") {
      log.debug("home.drop", { id: event.id, reason: verdict.reason });
      return;
    }

    if (verdict.action === "notice-untagged") {
      // Suppressed before the cooldown check, not after: an event the cooldown
      // swallows must still be recorded, or the in-memory cooldown resetting
      // on restart would let the replay window re-nag about it.
      this.state.suppress(event.id);
      const now = Date.now();
      if (now - this.lastUntaggedNoticeAt < this.config.untaggedNoticeCooldownMs) return;
      this.lastUntaggedNoticeAt = now;
      log.info("home.untagged_notice", { id: event.id });
      await this.#notifyHome(
        "That did not tag me, so nothing was sent. Pick me from the mention list and I will forward it.",
      );
      return;
    }

    if (verdict.action === "notice-empty") {
      this.state.suppress(event.id);
      await this.#notifyHome("Nothing to send — put the message after the mention.");
      return;
    }

    if (verdict.action === "notice-attachment-only") {
      this.state.suppress(event.id);
      await this.#notifyHome(
        "That was a file with no text, and files cannot cross — they live on the relay they were uploaded to. " +
        "Nothing was sent. Describe it in words and that will go.",
      );
      return;
    }

    if (verdict.action === "notice-too-long") {
      this.state.suppress(event.id);
      await this.#notifyHome(
        `That message is ${verdict.bytes} bytes, over this relay's limit of ${this.config.maxContentBytes}. ` +
        "I will not split it — send it in parts and they arrive as you wrote them.",
      );
      return;
    }

    if (!this.dmChannelId) {
      log.error("home.no_dm_channel", { id: event.id });
      await this.#notifyHome("I do not have the peer thread open yet — that message was not delivered. Try again shortly.");
      return;
    }

    const carriage = await this.#carry(verdict.attachments, verdict.text, this.homeOrigin, this.farOrigin);

    if (carriage.content.trim() === "") {
      // The whole message was one file, and the file did not cross. There is
      // nothing left to publish, so say what happened instead of sending an
      // empty line the peer would have to ask about.
      this.state.suppress(event.id);
      await this.#notifyHome(`Nothing was sent — ${carriage.failures[0] ?? "the file did not cross"}.`);
      return;
    }

    const sent = await this.#forward(this.far, {
      kind: KIND_MESSAGE,
      tags: [["h", this.dmChannelId], ["p", this.config.farPeerPubkey], ...carriage.tags],
      content: carriage.content,
    });

    if (!sent.ok) {
      // Suppressed, not left pending. The operator is being told to resend by
      // hand, so a later restart must not also deliver it and produce two.
      log.error("home.forward_failed", { id: event.id, message: sent.message });
      this.state.suppress(event.id);
      await this.#notifyHome(
        `I could not reach the other relay, so that was not delivered (${sent.message}). Resend it when you see this.`,
      );
      return;
    }

    this.state.commit(event.id, "home", event.created_at);
    log.info("forward", {
      direction: "out",
      src: event.id,
      dst: sent.id,
      bytes: Buffer.byteLength(carriage.content, "utf8"),
      files: carriage.tags.length,
    });
    log.debug("forward.body", { direction: "out", content: carriage.content });

    // Reported after the text is safely away, and only for the files that did
    // not make it: a message that half arrived is worth knowing about, and
    // the half that arrived is not worth a notification.
    for (const failure of carriage.failures) {
      await this.#notifyHome(`Your words went through. A file did not — ${failure}.`);
    }
  }

  // --- far side (peer -> operator) ----------------------------------------

  async #onFarEvent(event) {
    if (this.state.has(event.id)) { log.debug("far.drop", { id: event.id, reason: "already-delivered" }); return; }
    const verdict = classifyFarEvent(event, this.config, this.dmChannelId);

    if (verdict.action === "drop") {
      log.debug("far.drop", { id: event.id, reason: verdict.reason });
      return;
    }

    const carriage = await this.#carry(verdict.attachments, verdict.text, this.farOrigin, this.homeOrigin);
    const body = carriage.content.trim() === ""
      ? "(they sent a file that did not cross — no text with it)"
      : carriage.content;

    const sent = await this.#forward(this.home, {
      kind: KIND_MESSAGE,
      tags: [["h", this.config.homeChannelId], ["p", this.config.notifyPubkey], ...carriage.tags],
      content: body,
    });

    if (!sent.ok) {
      // The cursor deliberately does not advance. The reply stays unread from
      // the far relay's point of view, so a reconnect re-reads and re-posts it
      // rather than losing it to a home-side outage.
      log.error("far.forward_failed", { id: event.id, message: sent.message });
      return;
    }

    this.state.commit(event.id, "far", event.created_at);
    log.info("forward", {
      direction: "in",
      src: event.id,
      dst: sent.id,
      bytes: Buffer.byteLength(body, "utf8"),
      files: carriage.tags.length,
    });
    log.debug("forward.body", { direction: "in", content: body });

    for (const failure of carriage.failures) {
      await this.#notifyHome(`They also sent a file, which did not cross — ${failure}.`);
    }
  }

  // --- shared -------------------------------------------------------------

  /**
   * Re-host every attachment on the destination relay and point the message
   * body at the copies.
   *
   * Files are carried one at a time, inside the direction's serializer, so a
   * large one delays the messages behind it — which is why the size cap is a
   * bridge setting well below what either relay would accept. Anything that
   * refuses is reported and skipped; the words always travel, whatever
   * happens to the bytes.
   *
   * @returns {{content: string, tags: string[][], failures: string[]}}
   */
  async #carry(attachments, text, fromOrigin, toOrigin) {
    const list = attachments ?? [];
    if (list.length === 0 || !this.config.carryAttachments) {
      return { content: text, tags: [], failures: [] };
    }

    // An upload is a real write to a relay, which DRY_RUN's other two gates
    // do not cover. Without this line a dry run quietly pushes blobs across.
    if (this.config.dryRun) {
      for (const item of list) log.info("dry_run.carry", { url: item.url, sha: item.sha, size: item.size, to: toOrigin });
      return { content: text, tags: [], failures: [] };
    }

    const carried = [];
    const tags = [];
    const failures = [];
    for (const { attachment, ...result } of await this.media.carryAll(list, fromOrigin, toOrigin)) {
      if (!result.ok) {
        log.warn("media.refused", { url: attachment.url, reason: result.reason, detail: result.detail });
        failures.push(describeRefusal(result.reason, result.detail, this.config.maxAttachmentBytes));
        continue;
      }
      carried.push({
        from: attachment.url,
        to: result.descriptor.url,
        fromThumb: attachment.thumb,
        toThumb: result.descriptor.thumb ?? "",
        filename: attachment.filename,
      });
      tags.push(imetaTag(result.descriptor, attachment.filename));
      log.info("media.carried", { from: attachment.url, to: result.descriptor.url, bytes: result.descriptor.size });
    }

    return { content: rewriteContent(text, carried), tags, failures };
  }

  async #forward(connection, template) {
    let last = { ok: false, message: "not attempted" };
    for (let attempt = 1; attempt <= FORWARD_ATTEMPTS; attempt++) {
      if (this.config.dryRun) {
        log.info("dry_run.publish", { relay: connection.name, template });
        return { ok: true, id: "dry-run", message: "" };
      }
      last = await connection.publish(template);
      if (last.ok) return last;
      log.warn("publish.retry", { relay: connection.name, attempt, message: last.message });
      if (attempt < FORWARD_ATTEMPTS) await sleep(attempt * 2000 + Math.floor(Math.random() * 1000));
    }
    return last;
  }

  /** A line addressed to the operator in the home channel. Best effort. */
  async #notifyHome(text) {
    if (this.config.dryRun) {
      log.info("dry_run.notify", { text });
      return;
    }
    const r = await this.home.publish({
      kind: KIND_MESSAGE,
      tags: [["h", this.config.homeChannelId], ["p", this.config.notifyPubkey]],
      content: text,
    });
    if (!r.ok) log.error("notify_failed", { message: r.message });
  }
}

/**
 * Command kinds answer with their payload wrapped in the acknowledgement
 * message as `response:{...}`.
 */
export function parseCommandResponse(message) {
  const raw = String(message ?? "");
  const idx = raw.indexOf("response:");
  if (idx === -1) return null;
  try {
    return JSON.parse(raw.slice(idx + "response:".length));
  } catch {
    return null;
  }
}
