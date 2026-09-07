import test from "node:test";
import assert from "node:assert/strict";
import { classifyFarEvent, classifyHomeEvent, parseImeta, shaFromUrl, stripMention } from "../src/gates.mjs";

const BOT = "a".repeat(64);
const OPERATOR = "b".repeat(64);
const PEER = "c".repeat(64);
const STRANGER = "d".repeat(64);
const HOME = "11111111-1111-1111-1111-111111111111";
const DM = "22222222-2222-2222-2222-222222222222";

const config = {
  botPubkey: BOT,
  homeChannelId: HOME,
  farPeerPubkey: PEER,
  allowedAuthors: new Set([OPERATOR]),
  displayName: "the-bridge",
  maxContentBytes: 100,
  carryAttachments: true,
};

const message = (over = {}) => ({
  kind: 9,
  id: "e".repeat(64),
  pubkey: OPERATOR,
  created_at: 1,
  content: "@the-bridge hello",
  tags: [["h", HOME], ["p", BOT]],
  ...over,
});

test("stripMention removes a leading mention and nothing else", () => {
  assert.deepEqual(stripMention("@the-bridge hello there", "the-bridge"), { text: "hello there", found: true });
  assert.deepEqual(stripMention("@The-Bridge  Hello  There ", "the-bridge"), { text: "Hello  There ", found: true });
});

test("stripMention preserves interior text verbatim", () => {
  const body = "@the-bridge line one\n\n  line two  \nline three";
  assert.equal(stripMention(body, "the-bridge").text, "line one\n\n  line two  \nline three");
});

test("stripMention closes the gap for a mid-sentence mention", () => {
  assert.equal(stripMention("hey @the-bridge there", "the-bridge").text, "hey there");
  assert.equal(stripMention("hey @the-bridge", "the-bridge").text, "hey");
});

test("stripMention only removes the first occurrence", () => {
  assert.equal(stripMention("@the-bridge tell them @the-bridge sent it", "the-bridge").text, "tell them @the-bridge sent it");
});

test("stripMention does not match a longer name that starts with ours", () => {
  assert.deepEqual(stripMention("@the-bridge-two hi", "the-bridge"), { text: "@the-bridge-two hi", found: false });
});

test("stripMention is a no-op when the token is absent", () => {
  assert.deepEqual(stripMention("plain words", "the-bridge"), { text: "plain words", found: false });
});

test("a tagged message from the operator forwards", () => {
  const v = classifyHomeEvent(message(), config);
  assert.equal(v.action, "forward");
  assert.equal(v.text, "hello");
});

test("a tagged message from anyone else is dropped", () => {
  const v = classifyHomeEvent(message({ pubkey: STRANGER }), config);
  assert.deepEqual(v, { action: "drop", reason: "author-not-allowed" });
});

test("an untagged message is dropped, not forwarded", () => {
  const v = classifyHomeEvent(message({ tags: [["h", HOME]], content: "just talking" }), config);
  assert.deepEqual(v, { action: "drop", reason: "not-tagged" });
});

test("the operator naming the bridge without tagging it gets a notice", () => {
  const v = classifyHomeEvent(message({ tags: [["h", HOME]], content: "@the-bridge send this" }), config);
  assert.equal(v.action, "notice-untagged");
});

test("someone else naming the bridge in conversation gets nothing", () => {
  const v = classifyHomeEvent(message({ pubkey: STRANGER, tags: [["h", HOME]], content: "ask @the-bridge about it" }), config);
  assert.deepEqual(v, { action: "drop", reason: "not-tagged" });
});

test("the bridge never reacts to its own message", () => {
  const v = classifyHomeEvent(message({ pubkey: BOT }), config);
  assert.deepEqual(v, { action: "drop", reason: "own-event" });
});

test("a message in another channel is dropped", () => {
  const v = classifyHomeEvent(message({ tags: [["h", DM], ["p", BOT]] }), config);
  assert.deepEqual(v, { action: "drop", reason: "wrong-channel" });
});

test("a mention with no words after it is refused, not published empty", () => {
  const v = classifyHomeEvent(message({ content: "@the-bridge   " }), config);
  assert.equal(v.action, "notice-empty");
});

test("an over-long message is refused rather than split", () => {
  const v = classifyHomeEvent(message({ content: `@the-bridge ${"x".repeat(200)}` }), config);
  assert.equal(v.action, "notice-too-long");
  assert.equal(v.bytes, 200);
});

test("an attachment rides along with the text it was sent with", () => {
  const v = classifyHomeEvent(message({ tags: [["h", HOME], ["p", BOT], ["imeta", "url https://example/x.png"]] }), config);
  assert.equal(v.action, "forward");
  assert.equal(v.attachments.length, 1);
  assert.deepEqual(classifyHomeEvent(message(), config).attachments, []);
});

test("only the peer's messages come back from the far side", () => {
  const far = (over = {}) => ({ kind: 9, id: "f".repeat(64), pubkey: PEER, created_at: 1, content: "hi", tags: [["h", DM]], ...over });
  assert.equal(classifyFarEvent(far(), config, DM).action, "forward");
  assert.deepEqual(classifyFarEvent(far({ pubkey: STRANGER }), config, DM), { action: "drop", reason: "not-the-peer" });
  assert.deepEqual(classifyFarEvent(far({ pubkey: BOT }), config, DM), { action: "drop", reason: "own-event" });
  assert.deepEqual(classifyFarEvent(far({ tags: [["h", HOME]] }), config, DM), { action: "drop", reason: "wrong-channel" });
});

test("the own-event gate wins even if the peer is misconfigured to our own key", () => {
  const broken = { ...config, farPeerPubkey: BOT };
  const event = { kind: 9, id: "f".repeat(64), pubkey: BOT, created_at: 1, content: "loop", tags: [["h", DM]] };
  assert.deepEqual(classifyFarEvent(event, broken, DM), { action: "drop", reason: "own-event" });
});

test("a system event in the peer thread is not forwarded", () => {
  const event = { kind: 44100, id: "f".repeat(64), pubkey: PEER, created_at: 1, content: "{}", tags: [["h", DM]] };
  assert.deepEqual(classifyFarEvent(event, config, DM), { action: "drop", reason: "not-a-message" });
});

test("a bare mention with a file attached is the file, when files can cross", () => {
  const bare = message({ content: "@the-bridge ", tags: [["h", HOME], ["p", BOT], ["imeta", "url https://example/x.png"]] });
  const v = classifyHomeEvent(bare, config);
  assert.equal(v.action, "forward");
  assert.equal(v.attachments.length, 1);
});

test("with carriage switched off, a bare file is told what really happened", () => {
  const bare = message({ content: "@the-bridge ", tags: [["h", HOME], ["p", BOT], ["imeta", "url https://example/x.png"]] });
  assert.deepEqual(
    classifyHomeEvent(bare, { ...config, carryAttachments: false }),
    { action: "notice-attachment-only", reason: "attachment-with-no-text" },
  );
});

test("the near-miss warning fires on a message that opens with the name, tagged or not", () => {
  const untagged = (content) => classifyHomeEvent(message({ tags: [["h", HOME]], content }), config);
  assert.equal(untagged("@the-bridge can you make thursday 2pm").action, "notice-untagged");
  assert.equal(untagged("the-bridge can you make thursday 2pm").action, "notice-untagged");
  assert.equal(untagged("  @The-Bridge ok").action, "notice-untagged");
});

test("the near-miss warning stays quiet on a passing reference", () => {
  const untagged = (content) => classifyHomeEvent(message({ tags: [["h", HOME]], content }), config);
  assert.deepEqual(untagged("I'll ask @the-bridge about it later"), { action: "drop", reason: "not-tagged" });
  assert.deepEqual(untagged("@the-bridge-two is a different thing"), { action: "drop", reason: "not-tagged" });
});

// A deployment renamed the bridge to a three-segment hyphenated name and asked
// whether the near-miss detector survived it. Both name-shaped functions split
// on the configured name and then guard with /^[\w-]/, which treats a hyphen
// as part of a word — so a name whose own hyphens sit inside the match is
// exactly where that guard could go wrong. It does not, and this pins it.
test("a multi-segment hyphenated name works in both directions", () => {
  const named = { ...config, displayName: "far-side-dm-bot" };
  const event = (over) => message({ ...over });
  const untagged = (content) => classifyHomeEvent(event({ tags: [["h", HOME]], content }), named);

  assert.equal(untagged("@far-side-dm-bot yo").action, "notice-untagged");
  assert.equal(untagged("far-side-dm-bot yo").action, "notice-untagged");
  assert.equal(untagged("@Far-Side-DM-Bot yo").action, "notice-untagged");
  assert.equal(untagged("far-side-dm-bot").action, "notice-untagged");

  // The near name and the passing reference must still be left alone.
  assert.deepEqual(untagged("far-side-dm-bot-two yo"), { action: "drop", reason: "not-tagged" });
  assert.deepEqual(untagged("ask far-side-dm-bot later"), { action: "drop", reason: "not-tagged" });
  // A prefix of the new name that used to be a whole name of its own.
  assert.deepEqual(untagged("far-side yo"), { action: "drop", reason: "not-tagged" });

  assert.deepEqual(
    classifyHomeEvent(event({ content: "@far-side-dm-bot yo" }), named),
    { action: "forward", text: "yo", attachments: [] },
  );
  assert.deepEqual(stripMention("@far-side-dm-bot yo", "far-side-dm-bot"), { text: "yo", found: true });
});
