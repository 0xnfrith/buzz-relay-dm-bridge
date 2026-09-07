import test from "node:test";
import assert from "node:assert/strict";
import { mergeProfile } from "../src/set-profile.mjs";

const fields = { displayName: "far-side-dm-bot", about: "" };

test("mergeProfile keeps every field it was not given", () => {
  const existing = JSON.stringify({
    name: "old-name",
    display_name: "old-name",
    about: "what it does",
    picture: "https://relay.example/media/abc.png",
    nip05: "bot@relay.example",
  });
  assert.deepEqual(mergeProfile(existing, fields), {
    name: "far-side-dm-bot",
    display_name: "far-side-dm-bot",
    about: "what it does",
    picture: "https://relay.example/media/abc.png",
    nip05: "bot@relay.example",
  });
});

test("mergeProfile writes name and display_name from the one variable", () => {
  const merged = mergeProfile(JSON.stringify({ name: "a", display_name: "b" }), fields);
  assert.equal(merged.name, "far-side-dm-bot");
  assert.equal(merged.display_name, "far-side-dm-bot");
});

test("mergeProfile replaces the about line only when one is configured", () => {
  const existing = JSON.stringify({ about: "the old line" });
  assert.equal(mergeProfile(existing, { displayName: "x", about: "" }).about, "the old line");
  assert.equal(mergeProfile(existing, { displayName: "x", about: "a new line" }).about, "a new line");
});

test("mergeProfile builds from nothing when the relay holds no profile", () => {
  assert.deepEqual(mergeProfile(undefined, fields), { name: "far-side-dm-bot", display_name: "far-side-dm-bot" });
  assert.deepEqual(mergeProfile("", fields), { name: "far-side-dm-bot", display_name: "far-side-dm-bot" });
});

// The failure this whole file exists to prevent is a profile silently losing
// its avatar. Unparsable content is exactly when we know least about what is
// there, so it refuses rather than starting from an empty object.
test("mergeProfile refuses to replace a profile it cannot read", () => {
  assert.throws(() => mergeProfile("not json", fields), /not valid JSON/);
  assert.throws(() => mergeProfile('"a string"', fields), /not a JSON object/);
  assert.throws(() => mergeProfile("[1,2]", fields), /not a JSON object/);
  assert.throws(() => mergeProfile("null", fields), /not a JSON object/);
});
