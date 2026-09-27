/**
 * Host pieces shared by the two entrypoints (src/worker.ts, src/node.ts): a console logger
 * and a timer-based sleep. Uses only `console` and `setTimeout`, which both the Workers and
 * the Node type sets provide. The sync core (src/sync.ts and what it imports) must not
 * import this file; it gets these through SyncDeps.
 */

import type { Logger } from "./sync.ts";

export const consoleLogger: Logger = {
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
