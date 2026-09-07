import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Run in a child process: the redactor is module-level state, and the point of
// the test is what actually reaches the stream.
function capture(script) {
  return execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
}

test("a registered secret never reaches the output", () => {
  const out = capture(`
    import { log, redact, setLevel } from "${new URL("../src/log.mjs", import.meta.url).pathname}";
    setLevel("debug");
    redact("nsec1supersecretvalue");
    log.info("test", { config: "key=nsec1supersecretvalue", body: "he pasted nsec1supersecretvalue by mistake" });
  `);
  assert.equal(out.includes("nsec1supersecretvalue"), false);
  assert.equal(out.includes("[redacted]"), true);
});

test("message bodies are held back below debug level", () => {
  const out = capture(`
    import { log, setLevel } from "${new URL("../src/log.mjs", import.meta.url).pathname}";
    setLevel("info");
    log.info("forward", { direction: "out", bytes: 12 });
    log.debug("forward.body", { content: "the private message text" });
  `);
  assert.equal(out.includes("the private message text"), false);
  assert.equal(out.includes('"event":"forward"'), true);
});
