import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../src/state.mjs";

function scratch() {
  return mkdtempSync(join(tmpdir(), "bridge-state-"));
}

test("a cold start never looks backwards", () => {
  const dir = scratch();
  const s = new State(dir).load();
  const now = 1_000_000;
  assert.equal(s.since("home", now), now);
  assert.equal(s.since("far", now), now);
  assert.equal(s.cold, true);
  rmSync(dir, { recursive: true, force: true });
});

test("a restart resumes with a one-minute overlap", () => {
  const dir = scratch();
  const first = new State(dir).load();
  first.commit("a".repeat(64), "home", 500_000);
  const second = new State(dir).load();
  assert.equal(second.since("home", 1_000_000), 499_940);
  assert.equal(second.cold, false);
  rmSync(dir, { recursive: true, force: true });
});

test("a committed id is remembered across a restart", () => {
  const dir = scratch();
  const id = "b".repeat(64);
  new State(dir).load().commit(id, "far", 42);
  const reloaded = new State(dir).load();
  assert.equal(reloaded.has(id), true);
  assert.equal(reloaded.cursor.far_last, 42);
  rmSync(dir, { recursive: true, force: true });
});

test("the peer thread id survives a restart", () => {
  const dir = scratch();
  new State(dir).load().setDmChannel("33333333-3333-3333-3333-333333333333");
  assert.equal(new State(dir).load().cursor.dm_channel_id, "33333333-3333-3333-3333-333333333333");
  rmSync(dir, { recursive: true, force: true });
});

test("a wiped state directory recovers to a clean cold start", () => {
  const dir = scratch();
  const s = new State(dir).load();
  s.commit("c".repeat(64), "home", 900);
  rmSync(dir, { recursive: true, force: true });
  const fresh = new State(dir).load();
  assert.equal(fresh.has("c".repeat(64)), false);
  assert.equal(fresh.since("home", 777), 777);
  rmSync(dir, { recursive: true, force: true });
});

test("an out-of-order event never rewinds the cursor", () => {
  const dir = scratch();
  const s = new State(dir).load();
  s.commit("d".repeat(64), "home", 500);
  s.commit("e".repeat(64), "home", 400);
  assert.equal(s.cursor.home_last, 500);
  rmSync(dir, { recursive: true, force: true });
});

test("a truncated cursor file does not stop the bridge from starting", () => {
  const dir = scratch();
  const s = new State(dir).load();
  s.commit("f".repeat(64), "home", 100);
  writeFileSync(join(dir, "cursor.json"), "{not json");
  const reloaded = new State(dir).load();
  assert.equal(reloaded.cursor.home_last, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("the seen file is trimmed rather than growing without bound", () => {
  const dir = scratch();
  const s = new State(dir).load();
  for (let i = 0; i < 5_200; i++) s.commit(i.toString(16).padStart(64, "0"), "home", i);
  const lines = readFileSync(join(dir, "seen.txt"), "utf8").trim().split("\n");
  assert.ok(lines.length <= 5000, `expected trimming, saw ${lines.length}`);
  assert.equal(existsSync(join(dir, "seen.txt.tmp")), false);
  rmSync(dir, { recursive: true, force: true });
});

test("a suppressed event is not resurrected by a restart's replay window", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-state-"));
  const id = "9".repeat(64);
  const s = new State(dir).load();
  s.suppress(id);
  assert.equal(new State(dir).load().has(id), true);
  rmSync(dir, { recursive: true, force: true });
});
