/**
 * Environment -> validated, immutable Config. Shared by the Worker (env
 * bindings) and Node (process.env). Every value arrives as a string.
 */

export const ENV_KEYS = [
  "GITHUB_TOKEN",
  "GITHUB_REPO",
  "YOUTRACK_BASE_URL",
  "YOUTRACK_TOKEN",
  "YOUTRACK_PROJECT",
  "YOUTRACK_TITLE_PREFIX",
  "MAX_WRITES_PER_RUN",
  "DRY_RUN",
] as const;

export type EnvKey = (typeof ENV_KEYS)[number];

/** Whatever the host provides; missing keys are `undefined`. */
export type EnvSource = Readonly<Partial<Record<EnvKey, string | undefined>>>;

export type Config = {
  readonly githubToken: string;
  readonly githubOwner: string;
  readonly githubRepo: string;
  /** https URL without trailing slash, e.g. "https://youtrack.ai.buas.nl". */
  readonly youtrackBaseUrl: string;
  readonly youtrackToken: string;
  /** Project shortName, e.g. "CUI". */
  readonly youtrackProject: string;
  /** Case-insensitive summary prefix that marks an issue for mirroring, e.g. "[team]". */
  readonly titlePrefix: string;
  readonly maxWritesPerRun: number;
  readonly dryRun: boolean;
};

export const DEFAULT_TITLE_PREFIX = "[team]";
export const DEFAULT_MAX_WRITES_PER_RUN = 30;
/** Upper bound for MAX_WRITES_PER_RUN so reads always fit under the fetch guard. */
export const MAX_WRITES_LIMIT = 40;

/** Thrown with every problem found, so one run reports all config mistakes at once. */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid configuration: ${problems.join("; ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/**
 * Rules:
 * - GITHUB_TOKEN, YOUTRACK_TOKEN: required, non-empty after trim; never echoed in errors.
 * - GITHUB_REPO: required, "owner/repo" (GitHub name charset).
 * - YOUTRACK_BASE_URL: required, absolute https URL; trailing slashes removed.
 * - YOUTRACK_PROJECT: required, /^[A-Za-z0-9_-]+$/ (it is interpolated into a search query).
 * - YOUTRACK_TITLE_PREFIX: optional, default DEFAULT_TITLE_PREFIX; must be non-empty if set.
 * - MAX_WRITES_PER_RUN: optional, default DEFAULT_MAX_WRITES_PER_RUN; integer 0..MAX_WRITES_LIMIT.
 * - DRY_RUN: optional; only the exact string "false" (case-insensitive, trimmed) disables it.
 */
export function parseConfig(env: EnvSource): Config {
  void env;
  throw new Error("not implemented");
}
