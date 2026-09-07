// Carrying bytes between two relays that do not share media storage.
//
// A relay's blobs are auth-gated to that relay's members, so forwarding a URL
// forwards a link the recipient cannot open. The only thing that crosses is
// the file itself: download it from the source relay with the bridge's key,
// upload it to the destination relay with the same key, and publish the
// message with the destination's URL in place of the source's.
//
// Both legs are Blossom (BUD-01/BUD-02) over HTTPS, authorized by a kind-24242
// event signed with the bridge's key. Membership of both relays is what makes
// this possible at all, and it is the same membership the websocket already
// proves — no separate credential is involved.

import { createHash } from "node:crypto";
import { finalizeEvent } from "nostr-tools";

const AUTH_TTL_SECONDS = 300;
const DOWNLOAD_TIMEOUT_MS = 120000;
const UPLOAD_TIMEOUT_MS = 120000;

/**
 * The HTTP origin that serves a relay's media, derived from its websocket URL.
 *
 * Derived rather than configured on purpose: the pair cannot drift, and the
 * result doubles as the allowlist a download is checked against.
 */
export function mediaOrigin(relayUrl) {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === "ws:" ? "http:" : "https:";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.origin;
}

/**
 * Point a message body at the blobs that were actually carried.
 *
 * Buzz Desktop renders images from the markdown in the body and reads `imeta`
 * only as metadata for a URL already written there. Rewriting the tag without
 * the body would therefore ship a message that still displays the source
 * relay's unreachable URL — the tag alone renders nothing.
 *
 * A URL the sender never wrote into the body (an attachment their client put
 * only in the tags) is appended, so it is visible rather than silently
 * carried.
 */
export function rewriteContent(content, carried) {
  let text = String(content ?? "");
  const appended = [];
  for (const item of carried) {
    const before = text;
    text = text.split(item.from).join(item.to);
    if (item.fromThumb && item.toThumb) text = text.split(item.fromThumb).join(item.toThumb);
    if (text === before) appended.push(`![${item.filename || "attachment"}](${item.to})`);
  }
  if (appended.length === 0) return text;
  const body = text.trim() === "" ? "" : `${text.replace(/\s+$/, "")}\n\n`;
  return body + appended.join("\n");
}

/** The `imeta` tag for a blob descriptor the destination relay just returned. */
export function imetaTag(descriptor, filename) {
  const parts = [
    `url ${descriptor.url}`,
    `m ${descriptor.type}`,
    `x ${descriptor.sha256}`,
    `size ${descriptor.size}`,
  ];
  if (descriptor.dim) parts.push(`dim ${descriptor.dim}`);
  if (descriptor.blurhash) parts.push(`blurhash ${descriptor.blurhash}`);
  if (descriptor.thumb) parts.push(`thumb ${descriptor.thumb}`);
  if (filename) parts.push(`filename ${filename}`);
  return ["imeta", ...parts];
}

/**
 * One reason a file did not cross, phrased for the operator rather than for a
 * log line. Every path that gives up produces one of these, because a file
 * that vanishes without a word is the failure this whole feature exists to
 * end.
 */
function refusal(reason, detail) {
  return { ok: false, reason, detail };
}

export class MediaCarrier {
  /**
   * @param {object} opts
   * @param {Uint8Array} opts.secretKey  the bridge's signing key
   * @param {number} opts.maxBytes       refuse anything larger, in either direction
   * @param {typeof fetch} [opts.fetchImpl]
   */
  constructor({ secretKey, maxBytes, fetchImpl = fetch }) {
    this.secretKey = secretKey;
    this.maxBytes = maxBytes;
    this.fetch = fetchImpl;
  }

  #auth(verb, sha, origin) {
    const now = Math.floor(Date.now() / 1000);
    const event = finalizeEvent(
      {
        kind: 24242,
        created_at: now,
        tags: [
          ["t", verb],
          ["x", sha],
          ["expiration", String(now + AUTH_TTL_SECONDS)],
          ["server", origin],
        ],
        content: `bridge media ${verb}`,
      },
      this.secretKey,
    );
    return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
  }

  /**
   * Move one attachment from `fromOrigin` to `toOrigin`.
   *
   * Resolves `{ok: true, descriptor}` or `{ok: false, reason, detail}`. It
   * never throws: a failed file must still leave the operator's words on their
   * way, so the caller decides what to do with a refusal rather than losing
   * the whole message to it.
   */
  async carry(attachment, fromOrigin, toOrigin, cap = this.maxBytes) {
    try {
      return await this.#carry(attachment, fromOrigin, toOrigin, cap);
    } catch (err) {
      return refusal("error", String(err?.message ?? err));
    }
  }

  /**
   * Carry every attachment on one message, newest refusal and all.
   *
   * The size cap applies to the message, not only to each file in it: it
   * exists to bound how long one message can block the queue behind it, and
   * ten files just under the per-file limit block it just as long as one
   * enormous one. Whatever fits, crosses; the rest is reported.
   */
  async carryAll(attachments, fromOrigin, toOrigin) {
    const results = [];
    let budget = this.maxBytes;
    for (const attachment of attachments) {
      const result = await this.carry(attachment, fromOrigin, toOrigin, budget);
      if (result.ok) budget -= result.descriptor.size;
      else if (result.reason === "too-large" && budget < this.maxBytes) {
        results.push({ attachment, ...refusal("over-message-budget", result.detail) });
        continue;
      }
      results.push({ attachment, ...result });
    }
    return results;
  }

  async #carry(attachment, fromOrigin, toOrigin, cap) {
    // The URL comes from an event the bridge did not write. Without this the
    // bridge is a fetcher of attacker-chosen URLs that republishes whatever
    // comes back under its own key, on a relay that trusts its key.
    let origin;
    try {
      origin = new URL(attachment.url).origin;
    } catch {
      return refusal("bad-url", attachment.url);
    }
    if (origin !== fromOrigin) return refusal("foreign-host", origin);

    if (!/^[0-9a-f]{64}$/.test(attachment.sha)) return refusal("no-hash", attachment.url);

    // Refuse on the declared size before spending the download. The bytes are
    // checked again below, because the declaration is the sender's claim.
    if (attachment.size && attachment.size > cap) {
      return refusal("too-large", `${attachment.size} bytes`);
    }

    const got = await this.#download(attachment, fromOrigin, cap);
    if (!got.ok) return got;

    return await this.#upload(got.bytes, attachment, toOrigin);
  }

  async #download(attachment, fromOrigin, cap) {
    const res = await this.fetch(attachment.url, {
      headers: { Authorization: this.#auth("get", attachment.sha, fromOrigin) },
      redirect: "manual",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (res.status !== 200) return refusal("download-failed", `HTTP ${res.status}`);

    const declared = Number(res.headers.get("content-length")) || 0;
    if (declared > cap) return refusal("too-large", `${declared} bytes`);

    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > cap) return refusal("too-large", `${bytes.length} bytes`);

    // The hash is the whole basis for calling this the same file. A mismatch
    // means the bytes are not what the message described, so they are not what
    // gets republished under the bridge's key.
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== attachment.sha) return refusal("hash-mismatch", digest);

    return { ok: true, bytes };
  }

  async #upload(bytes, attachment, toOrigin) {
    const headers = {
      Authorization: this.#auth("upload", attachment.sha, toOrigin),
      "Content-Type": attachment.mime || "application/octet-stream",
      "X-SHA-256": attachment.sha,
    };
    const put = (url) => this.fetch(url, {
      method: "PUT",
      headers,
      body: bytes,
      redirect: "manual",
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });

    let res = await put(`${toOrigin}/upload`);
    // Older relays serve the same endpoint at the legacy path only. The switch
    // is on 404/405 alone: any other status is this relay answering.
    if (res.status === 404 || res.status === 405) res = await put(`${toOrigin}/media/upload`);
    if (res.status !== 200 && res.status !== 201) {
      return refusal("upload-failed", `HTTP ${res.status}`);
    }

    let descriptor;
    try {
      descriptor = await res.json();
    } catch {
      return refusal("upload-unparsable", "response was not JSON");
    }
    if (!descriptor?.url || !descriptor?.sha256) return refusal("upload-unparsable", "no url in descriptor");
    if (descriptor.sha256.toLowerCase() !== attachment.sha) {
      return refusal("upload-mismatch", descriptor.sha256);
    }

    return { ok: true, descriptor };
  }
}

/**
 * A refusal, phrased for the person whose file it was.
 *
 * Every failure path ends here rather than in a log line alone: a file that
 * disappears without a word is precisely the failure this feature exists to
 * end, and "it did not go" without "why" only moves the confusion.
 */
export function describeRefusal(reason, detail, maxBytes) {
  const cap = humanBytes(maxBytes);
  switch (reason) {
    case "too-large":
      return `it is over the ${cap} this bridge will carry (${detail})`;
    case "over-message-budget":
      return `the files in that message add up to more than the ${cap} the bridge carries at once`;
    case "foreign-host":
      return `it is hosted on ${detail}, which is not the relay it came from`;
    case "bad-url":
    case "no-hash":
      return "its address is not one I can fetch by content hash";
    case "hash-mismatch":
      return "the bytes did not match the hash the message claimed";
    case "download-failed":
      return `I could not download it (${detail})`;
    case "upload-failed":
    case "upload-unparsable":
    case "upload-mismatch":
      return `the other relay would not accept it (${detail})`;
    default:
      return `carrying it failed (${detail})`;
  }
}

/** A byte count in the unit a person would have used for it. */
export function humanBytes(n) {
  if (n >= 1024 * 1024) return `${Math.round(n / (1024 * 1024))} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}
