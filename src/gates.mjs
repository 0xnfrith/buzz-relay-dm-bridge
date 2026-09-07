// Pure decision functions. Everything here is a function of an event and the
// config — no sockets, no state, no clock — so the whole routing policy is
// testable against fixtures without a relay.
//
// The gates read parsed tags, never message text. A bridge that decided what
// to forward by string-matching its own name in the body could be driven by
// anyone who could type that name.

export function tagValues(event, name) {
  return (event?.tags ?? [])
    .filter((t) => Array.isArray(t) && t[0] === name)
    .map((t) => t[1])
    .filter((v) => typeof v === "string");
}

/**
 * Pull the attachments out of an event's `imeta` tags.
 *
 * Each tag is `["imeta", "url …", "m image/png", "x <sha256>", …]` — one
 * space-separated key/value pair per element, per NIP-92. Values may contain
 * spaces, so only the first space separates.
 *
 * A tag without a `url` describes nothing that can be carried and is dropped.
 */
export function parseImeta(event) {
  const out = [];
  for (const tag of event?.tags ?? []) {
    if (!Array.isArray(tag) || tag[0] !== "imeta") continue;
    const fields = {};
    for (const entry of tag.slice(1)) {
      if (typeof entry !== "string") continue;
      const gap = entry.indexOf(" ");
      if (gap === -1) continue;
      const key = entry.slice(0, gap);
      if (!(key in fields)) fields[key] = entry.slice(gap + 1);
    }
    if (!fields.url) continue;
    out.push({
      url: fields.url,
      mime: fields.m ?? "",
      sha: (fields.x ?? shaFromUrl(fields.url) ?? "").toLowerCase(),
      size: Number(fields.size) || 0,
      filename: fields.filename ?? "",
      thumb: fields.thumb ?? "",
    });
  }
  return out;
}

/** The content-addressed hash in a `/media/<sha256>.<ext>` path, if there is one. */
export function shaFromUrl(url) {
  const match = /\/([0-9a-f]{64})(?:\.[a-z0-9.]+)?$/i.exec(String(url ?? ""));
  return match ? match[1].toLowerCase() : null;
}

/**
 * Remove the bridge's own `@Name` mention token from a message body and leave
 * everything else byte-identical. The product promise is that the recipient
 * reads the operator's exact words, so this deliberately does no trimming,
 * no case folding, and no unicode normalization beyond closing the gap the
 * removed token left behind.
 *
 * Only the first occurrence is removed. A second `@Name` further into the
 * sentence is the operator writing about the bridge, not addressing it.
 */
export function stripMention(content, displayName) {
  const token = `@${displayName}`;
  const haystack = content.toLowerCase();
  const needle = token.toLowerCase();
  const idx = haystack.indexOf(needle);
  if (idx === -1) return { text: content, found: false };

  const after = content.slice(idx + token.length);
  // Guard against a longer name that merely starts with ours: `@bot` must not
  // match inside `@bot-two`.
  if (/^[\w-]/.test(after)) return { text: content, found: false };

  const before = content.slice(0, idx);
  const seamBefore = before.replace(/[ \t]+$/, "");
  const seamAfter = after.replace(/^[ \t]+/, "");

  let text;
  if (seamBefore === "") text = seamAfter.replace(/^[\r\n]+/, "");
  else if (/\s$/.test(seamBefore)) text = seamBefore + seamAfter;
  else text = seamAfter ? `${seamBefore} ${seamAfter}` : seamBefore;

  return { text, found: true };
}

/**
 * Does the body open by addressing the bridge, with no tag behind it?
 *
 * Deliberately anchored to the start of the message, with or without the `@`,
 * because that is the shape of the mistake: you type the name, then what you
 * wanted to send, and nothing happens. Matching the name anywhere in the body
 * would turn every passing reference to the bridge into a correction.
 */
export function looksLikeUntaggedMention(content, displayName) {
  const body = String(content ?? "").trimStart().toLowerCase();
  const name = displayName.toLowerCase();
  const rest = body.startsWith(`@${name}`)
    ? body.slice(name.length + 1)
    : body.startsWith(name)
      ? body.slice(name.length)
      : null;
  // A longer name that merely starts with ours is a different identity.
  return rest !== null && !/^[\w-]/.test(rest);
}

/**
 * Home relay (operator side) → what should happen.
 *
 * `forward`         send the text on to the far peer
 * `notice-untagged` the operator named us without tagging us; say so, because
 *                   the alternative is that they believe a message was sent
 * `drop`            with a reason, always logged, never silent
 */
export function classifyHomeEvent(event, config) {
  if (event.kind !== 9) return { action: "drop", reason: "not-a-message" };
  if (event.pubkey === config.botPubkey) return { action: "drop", reason: "own-event" };

  const channel = tagValues(event, "h")[0];
  if (channel !== config.homeChannelId) return { action: "drop", reason: "wrong-channel" };

  const tagged = tagValues(event, "p").includes(config.botPubkey);
  const allowed = config.allowedAuthors.has(event.pubkey);

  if (!tagged) {
    // The notice is gated on the author allowlist too. Anyone else in the
    // channel may write the bridge's name in ordinary conversation, and
    // answering all of them would turn a helpful nudge into a heckle.
    if (allowed && looksLikeUntaggedMention(event.content, config.displayName)) {
      return { action: "notice-untagged", reason: "named-but-not-tagged" };
    }
    return { action: "drop", reason: "not-tagged" };
  }

  if (!allowed) return { action: "drop", reason: "author-not-allowed" };

  const { text } = stripMention(event.content ?? "", config.displayName);
  const attachments = parseImeta(event);
  if (text.trim() === "") {
    // A bare mention with a file attached is not an empty message. When the
    // bridge can carry the file, the file *is* the message. When carriage is
    // off, "put the message after the mention" would be answering a question
    // the operator did not ask and hiding what happened to their file.
    if (attachments.length === 0) return { action: "notice-empty", reason: "empty-after-strip" };
    if (!config.carryAttachments) return { action: "notice-attachment-only", reason: "attachment-with-no-text" };
  }

  if (Buffer.byteLength(text, "utf8") > config.maxContentBytes) {
    return { action: "notice-too-long", reason: "over-frame-limit", bytes: Buffer.byteLength(text, "utf8") };
  }

  return { action: "forward", text, attachments };
}

/** Far relay (peer side) → what should happen. */
export function classifyFarEvent(event, config, dmChannelId) {
  if (event.kind !== 9) return { action: "drop", reason: "not-a-message" };
  // Checked before the peer gate, not folded into it: if FAR_PEER_PUBKEY were
  // ever misconfigured to the bridge's own key, the peer gate alone would
  // happily loop the bridge's own outbound message back to the home channel.
  if (event.pubkey === config.botPubkey) return { action: "drop", reason: "own-event" };

  const channel = tagValues(event, "h")[0];
  if (channel !== dmChannelId) return { action: "drop", reason: "wrong-channel" };
  if (event.pubkey !== config.farPeerPubkey) return { action: "drop", reason: "not-the-peer" };

  const text = event.content ?? "";
  const attachments = parseImeta(event);
  if (text.trim() === "" && attachments.length === 0) return { action: "drop", reason: "empty" };

  return { action: "forward", text, attachments };
}
