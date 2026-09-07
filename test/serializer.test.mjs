import test from "node:test";
import assert from "node:assert/strict";
import { serializer } from "../src/bridge.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("messages are forwarded in the order they arrived, not the order they finish", async () => {
  const run = serializer();
  const done = [];
  const slowFirst = run(async () => { await sleep(30); done.push("first"); });
  const fastSecond = run(async () => { done.push("second"); });
  await Promise.all([slowFirst, fastSecond]);
  assert.deepEqual(done, ["first", "second"]);
});

test("a failed task does not stall the queue behind it", async () => {
  const errors = [];
  const run = serializer((e) => errors.push(e.message));
  const done = [];
  run(async () => { throw new Error("relay said no"); });
  await run(async () => { done.push("still ran"); });
  assert.deepEqual(done, ["still ran"]);
  assert.deepEqual(errors, ["relay said no"]);
});
