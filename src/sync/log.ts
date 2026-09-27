/**
 * The run's log sink: every line a run logs passes through a redactor, whatever produced
 * it (error bodies, issue titles). The redaction itself lives in src/utils/redact.ts.
 */

import type { Redact } from "../utils/redact.ts";

export type Logger = {
  readonly info: (message: string) => void;
  readonly warn: (message: string) => void;
  readonly error: (message: string) => void;
};

/** Every line passes through `redact`, whatever produced it (error bodies, issue titles). */
export function redactingLogger(log: Logger, redact: Redact): Logger {
  return {
    info: (message) => {
      log.info(redact(message));
    },
    warn: (message) => {
      log.warn(redact(message));
    },
    error: (message) => {
      log.error(redact(message));
    },
  };
}
