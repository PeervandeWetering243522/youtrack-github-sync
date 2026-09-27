/**
 * Node entrypoint: `npm run sync` (node --env-file-if-exists=.env src/node.ts).
 * Also what the systemd timer runs on the fallback host (docs/05, README).
 * Only the error message is printed on failure, never an error object (it could hold headers).
 */

import { ENV_KEYS, parseConfig } from "./config.ts";
import type { EnvSource } from "./config.ts";
import { consoleLogger, sleep } from "./runtime.ts";
import { RUN_DEADLINE_MS, runSync } from "./sync.ts";

/** Process start; systemd TimeoutStartSec is the hard backstop behind this deadline (decision R8). */
const startedAt = Date.now();

/** Only the keys the config knows; nothing else from the environment is read. */
function readEnv(): EnvSource {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

try {
  await runSync(parseConfig(readEnv()), {
    fetch: (input, init) => globalThis.fetch(input, init),
    sleep,
    log: consoleLogger,
    now: () => Date.now(),
    deadline: startedAt + RUN_DEADLINE_MS,
  });
} catch (error) {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : "Sync failed with a non-Error value");
  process.exitCode = 1;
}
