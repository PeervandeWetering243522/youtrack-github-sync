/**
 * The run's log sink and token redaction: every line a run logs passes through a
 * redactor, whatever produced it (error bodies, issue titles).
 */

export type Logger = {
  readonly info: (message: string) => void;
  readonly warn: (message: string) => void;
  readonly error: (message: string) => void;
};

export type Redact = (text: string) => string;

/** Shorter "secrets" are not redacted, so a junk value cannot garble every log line; real tokens are far longer. */
const MIN_SECRET_CHARS = 8;
const REDACTED = "[redacted]";

/** Replaces every occurrence of each secret, longest first (one may contain another). */
export function secretRedactor(secrets: readonly string[]): Redact {
  const redactable = secrets
    .filter((secret) => secret.length >= MIN_SECRET_CHARS)
    .toSorted((a, b) => b.length - a.length);
  return (text) => redactable.reduce((result, secret) => result.replaceAll(secret, REDACTED), text);
}

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
