/**
 * Cloudflare Workers entrypoint: a scheduled() handler only, no fetch route (docs/04).
 * Errors propagate, so a failed run shows as an error in Cron Events and Logs (decision A10).
 */

import { parseConfig } from "./config.ts";
import { consoleLogger, sleep } from "./runtime.ts";
import { RUN_DEADLINE_MS, runSync } from "./sync.ts";

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await runSync(parseConfig(env), {
      // A wrapper, not the bare global: fetch called with a foreign `this` throws "Illegal invocation".
      fetch: (input, init) => fetch(input, init),
      sleep,
      log: consoleLogger,
      // Workers advance Date.now() only across I/O, which is where the writes wait anyway.
      now: () => Date.now(),
      // Anchored to the scheduled time, so a late start still ends inside its slot (decision R8).
      deadline: controller.scheduledTime + RUN_DEADLINE_MS,
    });
  },
} satisfies ExportedHandler<Env>;
