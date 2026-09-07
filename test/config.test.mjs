import test from "node:test";
import assert from "node:assert/strict";
import { getPublicKey, nip19 } from "nostr-tools";
import { ConfigError, loadConfig } from "../src/config.mjs";
import { parseCommandResponse } from "../src/bridge.mjs";

const KEY = "11".repeat(32);
const SELF = getPublicKey(Uint8Array.from(Buffer.from(KEY, "hex")));

const base = {
  BRIDGE_PRIVATE_KEY: KEY,
  HOME_RELAY_URL: "wss://relay.example",
  HOME_CHANNEL_ID: "11111111-1111-1111-1111-111111111111",
  FAR_RELAY_URL: "wss://other.example",
  FAR_PEER_PUBKEY: "c".repeat(64),
  ALLOWED_AUTHORS: "b".repeat(64),
  BOT_DISPLAY_NAME: "the-bridge",
};

test("a complete environment loads", () => {
  const c = loadConfig({ ...base });
  assert.equal(c.botPubkey, SELF);
  assert.equal(c.allowedAuthors.has("b".repeat(64)), true);
  assert.equal(c.notifyPubkey, "b".repeat(64), "notify defaults to the first allowed author");
  assert.equal(c.dropAttachments, true);
});

test("every site-specific value is required — nothing has a default", () => {
  for (const key of Object.keys(base)) {
    const env = { ...base };
    delete env[key];
    assert.throws(() => loadConfig(env), ConfigError, `${key} should be required`);
  }
});

test("an empty author allowlist is refused, not read as allow-all", () => {
  assert.throws(() => loadConfig({ ...base, ALLOWED_AUTHORS: "" }), ConfigError);
});

test("the peer cannot be the bridge itself", () => {
  assert.throws(() => loadConfig({ ...base, FAR_PEER_PUBKEY: SELF }), ConfigError);
});

test("malformed values are rejected at startup, not at first use", () => {
  assert.throws(() => loadConfig({ ...base, HOME_CHANNEL_ID: "not-a-uuid" }), ConfigError);
  assert.throws(() => loadConfig({ ...base, FAR_RELAY_URL: "https://relay.example" }), ConfigError);
  assert.throws(() => loadConfig({ ...base, ALLOWED_AUTHORS: "xyz" }), ConfigError);
  assert.throws(() => loadConfig({ ...base, BRIDGE_PRIVATE_KEY: "short" }), ConfigError);
});

test("an nsec is accepted as well as raw hex", () => {
  const nsec = nip19.nsecEncode(Uint8Array.from(Buffer.from(KEY, "hex")));
  assert.equal(loadConfig({ ...base, BRIDGE_PRIVATE_KEY: nsec }).botPubkey, SELF);
});

test("a command acknowledgement yields the relay's payload", () => {
  const msg = 'response:{"channel_id":"44444444-4444-4444-4444-444444444444","created":false}';
  assert.deepEqual(parseCommandResponse(msg), { channel_id: "44444444-4444-4444-4444-444444444444", created: false });
  assert.equal(parseCommandResponse("duplicate: already processed"), null);
  assert.equal(parseCommandResponse(""), null);
  assert.equal(parseCommandResponse("response:not-json"), null);
});
