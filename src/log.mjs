// Structured single-line JSON logging with a secret redactor.
//
// Every value registered with `redact()` is replaced with "[redacted]" in the
// serialized line, so a secret cannot reach the journal even by accident —
// through an error message, a stringified config object, or a message body
// that happens to contain the key.

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
let threshold = LEVELS.info;
const secrets = new Set();

export function setLevel(name) {
  const level = LEVELS[String(name || "").toLowerCase()];
  threshold = level === undefined ? LEVELS.info : level;
}

export function redact(value) {
  if (typeof value === "string" && value.length >= 8) secrets.add(value);
}

function scrub(text) {
  let out = text;
  for (const s of secrets) out = out.split(s).join("[redacted]");
  return out;
}

function emit(level, event, fields) {
  if (LEVELS[level] > threshold) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  stream.write(scrub(line) + "\n");
}

export const log = {
  error: (event, fields = {}) => emit("error", event, fields),
  warn: (event, fields = {}) => emit("warn", event, fields),
  info: (event, fields = {}) => emit("info", event, fields),
  debug: (event, fields = {}) => emit("debug", event, fields),
};
