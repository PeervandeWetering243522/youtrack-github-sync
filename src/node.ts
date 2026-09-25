/**
 * Node entrypoint: `npm run sync` (node --env-file-if-exists=.env src/node.ts).
 * Also what the systemd timer runs on the fallback host (docs/05, README).
 * Only the error message is printed on failure, never an error object (it could hold headers).
 */

import { ENV_KEYS, parseConfig } from "./config.ts";
import type { EnvSource } from "./config.ts";
import { runSync } from "./sync.ts";
import type { Logger } from "./sync.ts";

const consoleLogger: Logger = {
  info: (message) => {
    console.log(message);
  },
  warn: (message) => {
    console.warn(message);
  },
  error: (message) => {
    console.error(message);
  },
};

/** Only the keys the config knows; nothing else from the environment is read. */
function readEnv(): EnvSource {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

try {
  await runSync(parseConfig(readEnv()), {
    fetch: (input, init) => globalThis.fetch(input, init),
    sleep,
    log: consoleLogger,
  });
} catch (error) {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : "Sync failed with a non-Error value");
  process.exitCode = 1;
}
