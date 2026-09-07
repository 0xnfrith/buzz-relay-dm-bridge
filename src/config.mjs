// Configuration is entirely environment-driven. There is no default for any
// site-specific value: a missing required variable refuses to start rather
// than falling back to something plausible. That is what keeps the repo free
// of any deployment's identifiers.

import { nip19, getPublicKey } from "nostr-tools";
import { redact } from "./log.mjs";

const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class ConfigError extends Error {}

function required(env, name) {
  const value = (env[name] ?? "").trim();
  if (!value) throw new ConfigError(`${name} is required and unset`);
  return value;
}

function optional(env, name, fallback) {
  const value = (env[name] ?? "").trim();
  return value === "" ? fallback : value;
}

function hex64(name, value) {
  const v = value.toLowerCase();
  if (!HEX64.test(v)) throw new ConfigError(`${name} must be a 64-character hex pubkey`);
  return v;
}

function uuid(name, value) {
  if (!UUID.test(value)) throw new ConfigError(`${name} must be a uuid`);
  return value.toLowerCase();
}

function wss(name, value) {
  if (!/^wss?:\/\//.test(value)) throw new ConfigError(`${name} must be a ws:// or wss:// URL`);
  return value.replace(/\/+$/, "");
}

// An avatar URL is fetched by every client that renders the bot, none of which
// share this relay's credentials, so an http(s) URL is the only shape that can
// work. A typo here is a broken image in front of the person the bridge talks
// to, which is worth refusing to start over.
function http(name, value) {
  if (!/^https?:\/\//.test(value)) throw new ConfigError(`${name} must be an http:// or https:// URL`);
  return value;
}

// Accepts either 64-hex or a bech32 nsec. The decoded bytes never leave this
// function as a string, and the raw input is registered with the redactor.
export function decodeSecretKey(raw) {
  const trimmed = raw.trim();
  let bytes;
  if (trimmed.startsWith("nsec1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "nsec") throw new ConfigError("private key is not an nsec");
    bytes = decoded.data;
  } else if (HEX64.test(trimmed.toLowerCase())) {
    bytes = Uint8Array.from(Buffer.from(trimmed.toLowerCase(), "hex"));
  } else {
    throw new ConfigError("private key must be 64-hex or an nsec");
  }
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
    throw new ConfigError("private key did not decode to 32 bytes");
  }
  return bytes;
}

export function loadConfig(env = process.env) {
  const rawKey = required(env, "BRIDGE_PRIVATE_KEY");
  redact(rawKey);
  const secretKey = decodeSecretKey(rawKey);
  const botPubkey = getPublicKey(secretKey);

  const allowedAuthors = optional(env, "ALLOWED_AUTHORS", "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((pk) => hex64("ALLOWED_AUTHORS", pk));
  // An empty allowlist is refused rather than read as allow-all. The failure
  // mode of the permissive reading is a stranger's words delivered under the
  // operator's name, which is not a failure worth risking on a typo.
  if (allowedAuthors.length === 0) throw new ConfigError("ALLOWED_AUTHORS is required and must list at least one pubkey");

  const farPeerPubkey = hex64("FAR_PEER_PUBKEY", required(env, "FAR_PEER_PUBKEY"));
  if (farPeerPubkey === botPubkey) throw new ConfigError("FAR_PEER_PUBKEY is the bridge's own pubkey");

  const notifyPubkey = hex64("NOTIFY_PUBKEY", optional(env, "NOTIFY_PUBKEY", allowedAuthors[0]));

  const displayName = required(env, "BOT_DISPLAY_NAME");

  return {
    secretKey,
    botPubkey,
    homeRelayUrl: wss("HOME_RELAY_URL", required(env, "HOME_RELAY_URL")),
    homeChannelId: uuid("HOME_CHANNEL_ID", required(env, "HOME_CHANNEL_ID")),
    farRelayUrl: wss("FAR_RELAY_URL", required(env, "FAR_RELAY_URL")),
    farPeerPubkey,
    allowedAuthors: new Set(allowedAuthors),
    notifyPubkey,
    displayName,
    displayAbout: optional(env, "BOT_ABOUT", ""),
    // Unset leaves whatever avatar the relay already holds alone; set-profile
    // only ever writes the fields it was given a value for.
    displayPicture: (() => {
      const value = optional(env, "BOT_PICTURE", "");
      return value === "" ? "" : http("BOT_PICTURE", value);
    })(),
    // Off by default. Kind 0 is replaceable, so publishing a profile built
    // only from these two variables would silently drop an avatar or any
    // other field an operator set through another client.
    publishProfile: optional(env, "PUBLISH_PROFILE", "") === "1",
    stateDir: optional(env, "STATE_DIR", "./state"),
    // Files are carried by default. `DROP_ATTACHMENTS=true` is the kill
    // switch: it puts the bridge back to text-only, saying so in the channel
    // in both directions rather than dropping a file in silence.
    carryAttachments: optional(env, "DROP_ATTACHMENTS", "false") !== "true",
    // Well under either relay's own limit, because carriage happens inside
    // the direction's serializer: a file this size delays every message
    // behind it, and one that took minutes would look like an outage.
    maxAttachmentBytes: Number(optional(env, "MAX_ATTACHMENT_BYTES", String(25 * 1024 * 1024))),
    dryRun: optional(env, "DRY_RUN", "") === "1",
    logLevel: optional(env, "LOG_LEVEL", "info"),
    // The relay's default frame limit. Overridable because it is a relay
    // setting, not a protocol constant; read it from the NIP-11 document
    // (`limitation.max_message_length`) if a deployment differs.
    maxContentBytes: Number(optional(env, "MAX_CONTENT_BYTES", "200000")),
    // How often the bridge is willing to tell the operator that a message
    // failed to tag it. One reminder is help; a reminder per message is noise.
    untaggedNoticeCooldownMs: Number(optional(env, "UNTAGGED_NOTICE_COOLDOWN_MS", String(10 * 60 * 1000))),
  };
}

export { ConfigError };
