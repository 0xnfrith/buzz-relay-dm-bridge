#!/usr/bin/env node
// Set the bridge's relay profile (kind 0) without losing what is already on it.
//
//   node src/set-profile.mjs            print what would change, publish nothing
//   node src/set-profile.mjs --commit   publish it
//   node src/set-profile.mjs --far      also target the far relay
//
// Why this exists as a separate entry point rather than a flag on the bridge:
// kind 0 is replaceable, so publishing a profile assembled only from
// BOT_DISPLAY_NAME and BOT_ABOUT deletes every other field — the avatar most
// visibly. This reads the profile the relay already holds, changes only the
// fields it was given, and writes the whole thing back.
//
// It also needs the same NIP-42 handshake the bridge does: a gated relay
// answers ["AUTH", …] and drops an unauthenticated EVENT on the floor, so a
// generic nostr client cannot publish here at all. Reusing RelayConnection is
// the point of the file.
//
// Refusing is always safe; overwriting is not. Every uncertain outcome here —
// no end-of-stored-events inside the timeout, a stored profile whose content
// is not JSON — exits non-zero having published nothing.

import { argv, exit } from "node:process";
import { loadConfig, ConfigError } from "./config.mjs";
import { RelayConnection } from "./relay.mjs";
import { setLevel, log } from "./log.mjs";

const KIND_PROFILE = 0;
const FETCH_TIMEOUT_MS = 15000;

class ProfileError extends Error {}

/**
 * Read the profile the relay currently holds for the bridge's own key.
 *
 * Resolves only on the relay's end-of-stored-events; a timeout throws. The
 * distinction matters: "the relay told me it has no profile" is a safe base
 * to publish from, and "the relay has not answered yet" is not, and a plain
 * wait-and-see cannot tell them apart.
 */
function fetchProfile(conn, pubkey) {
  return new Promise((resolve, reject) => {
    let newest = null;
    conn.onEvent = (event) => {
      if (event.kind !== KIND_PROFILE || event.pubkey !== pubkey) return;
      if (!newest || event.created_at > newest.created_at) newest = event;
    };
    conn.onEose = () => resolve(newest);
    const timer = setTimeout(
      () => reject(new ProfileError(`${conn.name} relay sent no end-of-stored-events in ${FETCH_TIMEOUT_MS}ms`)),
      FETCH_TIMEOUT_MS,
    );
    timer.unref?.();
  });
}

/**
 * The existing profile with the configured fields laid over it.
 *
 * `name` and `display_name` are both written from the one variable. Clients
 * disagree about which they index for a mention picker, and the bridge's whole
 * contract is that BOT_DISPLAY_NAME matches what the picker inserts, so the
 * two must not be allowed to drift apart.
 *
 * An unset BOT_ABOUT leaves any existing about line alone rather than
 * clearing it — this script only ever adds or replaces named fields.
 */
export function mergeProfile(existingContent, { displayName, about }) {
  let base = {};
  if (existingContent != null && existingContent !== "") {
    try {
      base = JSON.parse(existingContent);
    } catch {
      throw new ProfileError("the stored profile is not valid JSON; refusing to replace it");
    }
    if (base === null || typeof base !== "object" || Array.isArray(base)) {
      throw new ProfileError("the stored profile is not a JSON object; refusing to replace it");
    }
  }
  return {
    ...base,
    name: displayName,
    display_name: displayName,
    ...(about ? { about } : {}),
  };
}

async function applyTo({ name, url, config, commit }) {
  const conn = new RelayConnection({
    name,
    url,
    secretKey: config.secretKey,
    filter: () => ({ kinds: [KIND_PROFILE], authors: [config.botPubkey], limit: 1 }),
    onEvent: () => {},
  });
  const settled = fetchProfile(conn, config.botPubkey);
  conn.start();

  try {
    const existing = await settled;
    log.info("profile.existing", { relay: name, found: Boolean(existing), content: existing?.content ?? null });

    const merged = mergeProfile(existing?.content, {
      displayName: config.displayName,
      about: config.displayAbout,
    });
    const content = JSON.stringify(merged);
    log.info("profile.merged", { relay: name, content });

    if (!commit) {
      log.info("profile.not_published", { relay: name, why: "--commit was not given" });
      return true;
    }

    // The tags of a kind 0 are almost always empty, but they are part of the
    // event being replaced, so they are carried across like any other field.
    const result = await conn.publish({ kind: KIND_PROFILE, tags: existing?.tags ?? [], content });
    log.info("profile.published", { relay: name, ok: result.ok, id: result.id, message: result.message });
    return result.ok;
  } finally {
    conn.stop();
  }
}

async function main() {
  const flags = argv.slice(2);
  const commit = flags.includes("--commit");
  const includeFar = flags.includes("--far");

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`configuration error: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
  setLevel(config.logLevel);

  // DRY_RUN is deliberately not consulted. It is the bridge's "do not speak to
  // the far peer" switch, and a deployment sitting in dry run still needs its
  // own profile set. --commit is this script's only safety catch.
  log.info("set_profile.start", {
    pubkey: config.botPubkey,
    display_name: config.displayName,
    about: config.displayAbout || null,
    commit,
    far: includeFar,
  });

  // The far side is opt-in. Nothing over there routes on the name — the
  // inbound gate matches on pubkey and thread id alone — so renaming it is a
  // choice about how the bridge reads to the person on the other end, not a
  // requirement of the rename.
  const targets = [{ name: "home", url: config.homeRelayUrl }];
  if (includeFar) targets.push({ name: "far", url: config.farRelayUrl });

  let ok = true;
  for (const target of targets) {
    ok = (await applyTo({ ...target, config, commit })) && ok;
  }
  process.exit(ok ? 0 : 1);
}

// Guarded so the test suite can import `mergeProfile` — the one piece of real
// decision-making here — without the file trying to reach a relay.
if (import.meta.url === `file://${argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof ProfileError ? err.message : err.stack ?? err.message}\n`);
    exit(1);
  });
}
