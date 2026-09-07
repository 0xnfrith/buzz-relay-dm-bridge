#!/usr/bin/env node
// Entry point.
//
//   relay-dm-bridge                 run the bridge
//   relay-dm-bridge --healthcheck   exit non-zero if the state looks stalled
//
// All configuration is environment-driven; see README.md and .env.example.

import { loadConfig, ConfigError } from "./config.mjs";
import { setLevel, log } from "./log.mjs";
import { State } from "./state.mjs";
import { Bridge } from "./bridge.mjs";

const HEALTH_STALE_SECONDS = Number(process.env.HEALTH_STALE_SECONDS || 900);

function healthcheck() {
  const dir = (process.env.STATE_DIR ?? "./state").trim() || "./state";
  const state = new State(dir).load();
  if (!state.cursor.dm_channel_id) {
    process.stderr.write("no peer thread recorded yet\n");
    process.exit(1);
  }
  const stamp = Number(state.cursor.heartbeat ?? 0);
  const age = Math.floor(Date.now() / 1000) - stamp;
  if (!stamp || age > HEALTH_STALE_SECONDS) {
    process.stderr.write(`heartbeat is ${stamp ? `${age}s old` : "missing"}\n`);
    process.exit(1);
  }
  process.stdout.write(`ok, heartbeat ${age}s old\n`);
}

async function main() {
  if (process.argv.includes("--healthcheck")) return healthcheck();

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

  const state = new State(config.stateDir).load();
  const bridge = new Bridge(config, state);

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      log.info("bridge.stop", { signal });
      bridge.stop();
      process.exit(0);
    });
  }
  process.on("unhandledRejection", (reason) => {
    // Never fatal. A rejected publish on one side must not take the other
    // side's socket down with it.
    log.error("unhandled_rejection", { error: String(reason?.message ?? reason) });
  });

  await bridge.start();
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
