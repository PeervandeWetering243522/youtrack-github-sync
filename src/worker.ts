/**
 * Cloudflare Workers entrypoint: a scheduled() handler only, no fetch route (docs/04).
 * Errors propagate, so a failed run shows as an error in Cron Events and Logs (decision A10).
 */

import { parseConfig } from "./config.ts";
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await runSync(parseConfig(env), {
      // A wrapper, not the bare global: fetch called with a foreign `this` throws "Illegal invocation".
      fetch: (input, init) => fetch(input, init),
      sleep,
      log: consoleLogger,
    });
  },
} satisfies ExportedHandler<Env>;
