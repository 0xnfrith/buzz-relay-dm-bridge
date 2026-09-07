import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parseImeta, shaFromUrl } from "../src/gates.mjs";
import { MediaCarrier, describeRefusal, imetaTag, mediaOrigin, rewriteContent } from "../src/media.mjs";

const KEY = Uint8Array.from(Buffer.from("11".repeat(32), "hex"));
const BYTES = Buffer.from("not really a png, but bytes are bytes");
const SHA = createHash("sha256").update(BYTES).digest("hex");
const FROM = "https://from.example";
const TO = "https://to.example";

const attachment = (over = {}) => ({
  url: `${FROM}/media/${SHA}.png`,
  mime: "image/png",
  sha: SHA,
  size: BYTES.length,
  filename: "shot.png",
  thumb: `${FROM}/media/${SHA}.thumb.jpg`,
  ...over,
});

const descriptor = {
  url: `${TO}/media/${SHA}.png`,
  sha256: SHA,
  size: BYTES.length,
  type: "image/png",
  dim: "964x594",
  blurhash: "L8Q]",
  thumb: `${TO}/media/${SHA}.thumb.jpg`,
};

/** A fetch whose every call is recorded, answering from a scripted list. */
function fakeFetch(script) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method ?? "GET", headers: opts.headers ?? {}, body: opts.body });
    const next = script.shift();
    if (!next) throw new Error(`unscripted fetch: ${url}`);
    return next;
  };
  impl.calls = calls;
  return impl;
}

const okBlob = (bytes = BYTES) => ({
  status: 200,
  headers: { get: (h) => (h === "content-length" ? String(bytes.length) : null) },
  arrayBuffer: async () => bytes,
});

const okJson = (body, status = 200) => ({
  status,
  headers: { get: () => null },
  json: async () => body,
});

const status = (code) => ({ status: code, headers: { get: () => null }, json: async () => ({}) });

test("mediaOrigin is derived from the websocket URL, not configured beside it", () => {
  assert.equal(mediaOrigin("wss://relay.example"), "https://relay.example");
  assert.equal(mediaOrigin("wss://relay.example/"), "https://relay.example");
  assert.equal(mediaOrigin("ws://localhost:3000"), "http://localhost:3000");
});

test("parseImeta reads one key/value per element and keeps values with spaces", () => {
  const event = { tags: [["imeta",
    `url ${FROM}/media/${SHA}.png`,
    "m image/png",
    `x ${SHA}`,
    "size 37",
    "filename my holiday photo.png",
  ]] };
  assert.deepEqual(parseImeta(event), [{
    url: `${FROM}/media/${SHA}.png`,
    mime: "image/png",
    sha: SHA,
    size: 37,
    filename: "my holiday photo.png",
    thumb: "",
  }]);
});

test("parseImeta drops a tag that describes no file, and falls back to the hash in the path", () => {
  const event = { tags: [
    ["imeta", "m image/png"],
    ["imeta", `url ${FROM}/media/${SHA}.png`, "m image/png"],
    ["p", "irrelevant"],
  ] };
  const got = parseImeta(event);
  assert.equal(got.length, 1);
  assert.equal(got[0].sha, SHA);
  assert.equal(shaFromUrl(`${FROM}/media/${SHA}.thumb.jpg`), SHA);
  assert.equal(shaFromUrl("https://example.invalid/logo.png"), null);
});

test("rewriteContent points the body at the copy, thumbnail included", () => {
  const carried = [{
    from: `${FROM}/media/${SHA}.png`,
    to: `${TO}/media/${SHA}.png`,
    fromThumb: `${FROM}/media/${SHA}.thumb.jpg`,
    toThumb: `${TO}/media/${SHA}.thumb.jpg`,
    filename: "shot.png",
  }];
  const body = `look at this ![image](${FROM}/media/${SHA}.png) and its thumb ${FROM}/media/${SHA}.thumb.jpg`;
  assert.equal(
    rewriteContent(body, carried),
    `look at this ![image](${TO}/media/${SHA}.png) and its thumb ${TO}/media/${SHA}.thumb.jpg`,
  );
});

test("a file the sender never wrote into the body is appended rather than hidden", () => {
  const carried = [{ from: `${FROM}/x.png`, to: `${TO}/y.png`, filename: "shot.png" }];
  assert.equal(rewriteContent("have a look", carried), "have a look\n\n![shot.png](https://to.example/y.png)");
  assert.equal(rewriteContent("", carried), "![shot.png](https://to.example/y.png)");
  assert.equal(rewriteContent("   ", carried), "![shot.png](https://to.example/y.png)");
});

test("imetaTag carries what the destination relay computed", () => {
  assert.deepEqual(imetaTag(descriptor, "shot.png"), ["imeta",
    `url ${TO}/media/${SHA}.png`,
    "m image/png",
    `x ${SHA}`,
    `size ${BYTES.length}`,
    "dim 964x594",
    "blurhash L8Q]",
    `thumb ${TO}/media/${SHA}.thumb.jpg`,
    "filename shot.png",
  ]);
});

test("a file is downloaded from one relay and uploaded to the other", async () => {
  const fetchImpl = fakeFetch([okBlob(), okJson(descriptor)]);
  const carrier = new MediaCarrier({ secretKey: KEY, maxBytes: 1024, fetchImpl });
  const result = await carrier.carry(attachment(), FROM, TO);

  assert.equal(result.ok, true);
  assert.deepEqual(result.descriptor, descriptor);

  const [get, put] = fetchImpl.calls;
  assert.equal(get.url, `${FROM}/media/${SHA}.png`);
  assert.match(get.headers.Authorization, /^Nostr /);
  assert.equal(put.url, `${TO}/upload`);
  assert.equal(put.method, "PUT");
  assert.equal(put.headers["X-SHA-256"], SHA);
  assert.equal(put.headers["Content-Type"], "image/png");

  // The auth events are per-leg: a get token must not be replayable as an upload.
  const verb = (header) => JSON.parse(Buffer.from(header.slice("Nostr ".length), "base64"))
    .tags.find((t) => t[0] === "t")[1];
  assert.equal(verb(get.headers.Authorization), "get");
  assert.equal(verb(put.headers.Authorization), "upload");
});

test("the legacy upload path is tried only when the modern one is not there", async () => {
  const fetchImpl = fakeFetch([okBlob(), status(404), okJson(descriptor)]);
  const carrier = new MediaCarrier({ secretKey: KEY, maxBytes: 1024, fetchImpl });
  assert.equal((await carrier.carry(attachment(), FROM, TO)).ok, true);
  assert.equal(fetchImpl.calls[2].url, `${TO}/media/upload`);

  const refused = fakeFetch([okBlob(), status(413)]);
  const strict = new MediaCarrier({ secretKey: KEY, maxBytes: 1024, fetchImpl: refused });
  const result = await strict.carry(attachment(), FROM, TO);
  assert.deepEqual({ ok: result.ok, reason: result.reason }, { ok: false, reason: "upload-failed" });
  assert.equal(refused.calls.length, 2, "413 is an answer, not a missing endpoint");
});

test("a URL on any other host is refused without being fetched", async () => {
  const fetchImpl = fakeFetch([]);
  const carrier = new MediaCarrier({ secretKey: KEY, maxBytes: 1024, fetchImpl });
  const result = await carrier.carry(attachment({ url: "https://elsewhere.example/x.png" }), FROM, TO);
  assert.equal(result.reason, "foreign-host");
  assert.equal(fetchImpl.calls.length, 0);
});

test("size is refused on the sender's claim, and again on the bytes", async () => {
  const claimed = fakeFetch([]);
  const onClaim = new MediaCarrier({ secretKey: KEY, maxBytes: 10, fetchImpl: claimed });
  assert.equal((await onClaim.carry(attachment({ size: 999 }), FROM, TO)).reason, "too-large");
  assert.equal(claimed.calls.length, 0, "a declared size over the cap costs no download");

  const lying = fakeFetch([okBlob()]);
  const onBytes = new MediaCarrier({ secretKey: KEY, maxBytes: 10, fetchImpl: lying });
  assert.equal((await onBytes.carry(attachment({ size: 0 }), FROM, TO)).reason, "too-large");
  assert.equal(lying.calls.length, 1, "nothing is uploaded when the bytes are over the cap");
});

test("bytes that do not match the hash are not republished", async () => {
  const fetchImpl = fakeFetch([okBlob(Buffer.from("different bytes entirely"))]);
  const carrier = new MediaCarrier({ secretKey: KEY, maxBytes: 1024, fetchImpl });
  const result = await carrier.carry(attachment(), FROM, TO);
  assert.equal(result.reason, "hash-mismatch");
  assert.equal(fetchImpl.calls.length, 1);
});

test("a download the source relay refuses is reported, not thrown", async () => {
  const fetchImpl = fakeFetch([status(401)]);
  const carrier = new MediaCarrier({ secretKey: KEY, maxBytes: 1024, fetchImpl });
  const result = await carrier.carry(attachment(), FROM, TO);
  assert.deepEqual({ ok: result.ok, reason: result.reason, detail: result.detail },
    { ok: false, reason: "download-failed", detail: "HTTP 401" });
});

test("a thrown fetch becomes a refusal like any other", async () => {
  const carrier = new MediaCarrier({
    secretKey: KEY,
    maxBytes: 1024,
    fetchImpl: async () => { throw new Error("socket hang up"); },
  });
  const result = await carrier.carry(attachment(), FROM, TO);
  assert.equal(result.ok, false);
  assert.equal(result.detail, "socket hang up");
});

test("every refusal has words for the person whose file it was", () => {
  assert.match(describeRefusal("too-large", "40000000 bytes", 25 * 1024 * 1024), /25 MB/);
  assert.match(describeRefusal("hash-mismatch", "abc", 1), /did not match/);
  assert.match(describeRefusal("something-new", "why", 1), /why/);
});

test("the cap is on the message, not on each file in it", async () => {
  const second = Buffer.from("a second file, also small");
  const secondSha = createHash("sha256").update(second).digest("hex");
  const fetchImpl = fakeFetch([
    okBlob(),
    okJson({ ...descriptor, size: 30 }),
    okBlob(second),
  ]);
  // A cap big enough for either file alone, too small for both together.
  const carrier = new MediaCarrier({ secretKey: KEY, maxBytes: 40, fetchImpl });
  const results = await carrier.carryAll(
    [attachment({ size: 0 }), attachment({ url: `${FROM}/media/${secondSha}.png`, sha: secondSha, size: 0 })],
    FROM,
    TO,
  );

  assert.equal(results[0].ok, true);
  assert.deepEqual(
    { ok: results[1].ok, reason: results[1].reason },
    { ok: false, reason: "over-message-budget" },
    "the second file is refused for the message's sake, not its own size",
  );
  assert.equal(fetchImpl.calls.length, 3, "the second file is downloaded but never uploaded");
  assert.match(describeRefusal("over-message-budget", "", 40), /add up to more than/);
});

test("a cap smaller than a megabyte is described in units that exist", () => {
  assert.match(describeRefusal("too-large", "2048 bytes", 1024), /1 KB/);
  assert.match(describeRefusal("too-large", "80 bytes", 64), /64 bytes/);
});
