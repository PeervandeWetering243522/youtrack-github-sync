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
  const githubToken = requireValue("GITHUB_TOKEN", env.GITHUB_TOKEN);
  const repository = andThen(requireValue("GITHUB_REPO", env.GITHUB_REPO), parseRepository);
  const baseUrl = andThen(requireValue("YOUTRACK_BASE_URL", env.YOUTRACK_BASE_URL), parseBaseUrl);
  const youtrackToken = requireValue("YOUTRACK_TOKEN", env.YOUTRACK_TOKEN);
  const project = andThen(requireValue("YOUTRACK_PROJECT", env.YOUTRACK_PROJECT), parseProject);
  const titlePrefix = optionalValue(env.YOUTRACK_TITLE_PREFIX, DEFAULT_TITLE_PREFIX, parseTitlePrefix);
  const maxWrites = optionalValue(env.MAX_WRITES_PER_RUN, DEFAULT_MAX_WRITES_PER_RUN, parseMaxWrites);

  if (
    !githubToken.ok ||
    !repository.ok ||
    !baseUrl.ok ||
    !youtrackToken.ok ||
    !project.ok ||
    !titlePrefix.ok ||
    !maxWrites.ok
  ) {
    const results = [githubToken, repository, baseUrl, youtrackToken, project, titlePrefix, maxWrites];
    throw new ConfigError(results.flatMap((result) => (result.ok ? [] : result.problems)));
  }

  return Object.freeze({
    githubToken: githubToken.value,
    githubOwner: repository.value.owner,
    githubRepo: repository.value.repo,
    youtrackBaseUrl: baseUrl.value,
    youtrackToken: youtrackToken.value,
    youtrackProject: project.value,
    titlePrefix: titlePrefix.value,
    maxWritesPerRun: maxWrites.value,
    dryRun: parseDryRun(env.DRY_RUN),
  });
}

/** Outcome of validating one setting; a failure carries every problem found for it. */
type FieldResult<T> = Valid<T> | Invalid;
type Valid<T> = { readonly ok: true; readonly value: T };
type Invalid = { readonly ok: false; readonly problems: readonly string[] };

type Repository = { readonly owner: string; readonly repo: string };

const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const YOUTRACK_PROJECT_PATTERN = /^[A-Za-z0-9_-]+$/;
const DIGITS_PATTERN = /^\d+$/;

function valid<T>(value: T): Valid<T> {
  return { ok: true, value };
}

function invalid(...problems: readonly string[]): Invalid {
  return { ok: false, problems };
}

function andThen<T, U>(result: FieldResult<T>, next: (value: T) => FieldResult<U>): FieldResult<U> {
  return result.ok ? next(result.value) : result;
}

/** Required setting: trimmed, and blank counts as missing. The value is never echoed. */
function requireValue(key: EnvKey, raw: string | undefined): FieldResult<string> {
  const value = raw?.trim() ?? "";
  return value === "" ? invalid(`${key} is missing`) : valid(value);
}

/** Optional setting: `undefined` means the default; anything set is trimmed and validated. */
function optionalValue<T>(
  raw: string | undefined,
  fallback: T,
  parse: (value: string) => FieldResult<T>,
): FieldResult<T> {
  return raw === undefined ? valid(fallback) : parse(raw.trim());
}

function parseRepository(value: string): FieldResult<Repository> {
  const [owner, repo, ...extra] = value.split("/");
  if (owner === undefined || repo === undefined || extra.length > 0) {
    return invalid('GITHUB_REPO must have the form "owner/repo"');
  }
  const problems = [
    ...(GITHUB_OWNER_PATTERN.test(owner)
      ? []
      : ["GITHUB_REPO owner must be 1-39 letters, digits or hyphens, starting with a letter or digit"]),
    ...(isValidRepoName(repo)
      ? []
      : ['GITHUB_REPO repository must be 1-100 letters, digits, ".", "_" or "-", and not "." or ".."']),
  ];
  return problems.length > 0 ? invalid(...problems) : valid({ owner, repo });
}

function isValidRepoName(repo: string): boolean {
  return GITHUB_REPO_PATTERN.test(repo) && repo !== "." && repo !== "..";
}

/**
 * Absolute https URL without query, fragment or credentials. Returns origin +
 * path without trailing slashes. The value is not echoed: it could hold credentials.
 */
function parseBaseUrl(value: string): FieldResult<string> {
  const url = URL.parse(value);
  if (url === null) {
    return invalid("YOUTRACK_BASE_URL is not a valid absolute URL");
  }
  const problems = [
    ...(url.protocol === "https:" ? [] : ["YOUTRACK_BASE_URL must use https"]),
    ...(hasQueryOrFragment(url) ? ["YOUTRACK_BASE_URL must not contain a query string or fragment"] : []),
    ...(url.username !== "" || url.password !== "" ? ["YOUTRACK_BASE_URL must not contain credentials"] : []),
  ];
  return problems.length > 0 ? invalid(...problems) : valid(stripTrailingSlashes(url.origin + url.pathname));
}

/** A bare "?" or "#" leaves `search`/`hash` empty but still shows in `href`. */
function hasQueryOrFragment(url: URL): boolean {
  return url.href.includes("?") || url.href.includes("#");
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") {
    end -= 1;
  }
  return value.slice(0, end);
}

function parseProject(value: string): FieldResult<string> {
  return YOUTRACK_PROJECT_PATTERN.test(value)
    ? valid(value)
    : invalid('YOUTRACK_PROJECT must contain only letters, digits, "_" or "-"');
}

function parseTitlePrefix(value: string): FieldResult<string> {
  return value === "" ? invalid("YOUTRACK_TITLE_PREFIX must not be empty when set") : valid(value);
}

function parseMaxWrites(value: string): FieldResult<number> {
  const count = Number(value);
  // Digits only, so `count` is a non-negative integer (or huge, which the bound rejects).
  const isInRange = DIGITS_PATTERN.test(value) && count <= MAX_WRITES_LIMIT;
  return isInRange
    ? valid(count)
    : invalid(`MAX_WRITES_PER_RUN must be a whole number from 0 to ${String(MAX_WRITES_LIMIT)}`);
}

/** Dry-run stays on unless the value is exactly "false" (trimmed, case-insensitive). */
function parseDryRun(raw: string | undefined): boolean {
  return raw?.trim().toLowerCase() !== "false";
}
