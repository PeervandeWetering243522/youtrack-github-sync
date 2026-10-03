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
  "YOUTRACK_EXCLUDE_PREFIX",
  "MAX_WRITES_PER_RUN",
  "DRY_RUN",
  "REOPEN_CLOSED_BY",
  "SYNC_ASSIGNEES",
  "ASSIGNEE_MAP",
] as const;

export type EnvKey = (typeof ENV_KEYS)[number];

/** Whatever the host provides; missing keys are `undefined`. */
export type EnvSource = Readonly<Partial<Record<EnvKey, string | undefined>>>;

/** YouTrack login (A-Z lowercased) -> GitHub login as written; null: "-", never assign (U14). */
export type AssigneeMap = ReadonlyMap<string, string | null>;

export type Config = {
  readonly githubToken: string;
  readonly githubOwner: string;
  readonly githubRepo: string;
  /** https URL without trailing slash, e.g. "https://youtrack.ai.buas.nl". */
  readonly youtrackBaseUrl: string;
  readonly youtrackToken: string;
  /** Project shortName, e.g. "CUI". */
  readonly youtrackProject: string;
  /**
   * Case-insensitive summary prefix that keeps an issue out of the mirror, e.g. "[individual]".
   * Every other issue is mirrored (decision F1).
   */
  readonly excludePrefix: string;
  readonly maxWritesPerRun: number;
  readonly dryRun: boolean;
  /**
   * GitHub login whose closes the sync undoes when the YouTrack issue is unresolved again,
   * e.g. "github-actions[bot]" (decision R10); null: closed mirrors are never reopened.
   */
  readonly reopenClosedBy: string | null;
  /** SYNC_ASSIGNEES (U1): sync GitHub assignees from YouTrack's Assignee field. */
  readonly syncAssignees: boolean;
  /** ASSIGNEE_MAP (U14): checked first by the matching chain; empty when unset. */
  readonly assigneeMap: AssigneeMap;
};

export const DEFAULT_EXCLUDE_PREFIX = "[individual]";
export const DEFAULT_MAX_WRITES_PER_RUN = 30;
/** Upper bound for MAX_WRITES_PER_RUN so reads always fit under the fetch guard. */
export const MAX_WRITES_LIMIT = 40;
/** The ASSIGNEE_MAP value that keeps a YouTrack user from ever being assigned (U14). */
export const ASSIGNEE_MAP_NEVER = "-";
export const DEFAULT_SYNC_ASSIGNEES = true;

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
 * - GITHUB_TOKEN, YOUTRACK_TOKEN: required; after trim, printable ASCII only
 *   (/^[\x21-\x7e]+$/: no whitespace, control or non-ASCII characters). Never echoed in errors.
 * - GITHUB_REPO: required, "owner/repo" (GitHub name charset).
 * - YOUTRACK_BASE_URL: required, absolute https URL; trailing slashes removed.
 * - YOUTRACK_PROJECT: required, /^[A-Za-z0-9][A-Za-z0-9_-]*$/. It is interpolated into a
 *   search query, and a leading "-" is YouTrack's minus (exclusion) operator (docs/01).
 * - YOUTRACK_EXCLUDE_PREFIX: optional, default DEFAULT_EXCLUDE_PREFIX; must be non-empty after
 *   trim if set.
 * - MAX_WRITES_PER_RUN: optional, default DEFAULT_MAX_WRITES_PER_RUN; integer 0..MAX_WRITES_LIMIT.
 * - DRY_RUN: optional; only the exact string "false" (case-insensitive, trimmed) disables it.
 * - REOPEN_CLOSED_BY: optional; blank means off; otherwise a GitHub login (decision R10).
 * - SYNC_ASSIGNEES: optional, default DEFAULT_SYNC_ASSIGNEES; if set, "true" or "false" (trimmed,
 *   A-Z case ignored); blank or anything else is a problem (U1).
 * - ASSIGNEE_MAP: optional; blank means no map; otherwise <youtrack-login>=<github-login>
 *   entries (U14, see parseAssigneeMap). Parsed even when SYNC_ASSIGNEES is off.
 * Keys outside ENV_KEYS, such as the retired YOUTRACK_TITLE_PREFIX, are ignored.
 */
export function parseConfig(env: EnvSource): Config {
  const githubToken = requireToken("GITHUB_TOKEN", env.GITHUB_TOKEN);
  const repository = andThen(requireValue("GITHUB_REPO", env.GITHUB_REPO), parseRepository);
  const baseUrl = andThen(requireValue("YOUTRACK_BASE_URL", env.YOUTRACK_BASE_URL), parseBaseUrl);
  const youtrackToken = requireToken("YOUTRACK_TOKEN", env.YOUTRACK_TOKEN);
  const project = andThen(requireValue("YOUTRACK_PROJECT", env.YOUTRACK_PROJECT), parseProject);
  const excludePrefix = optionalValue(env.YOUTRACK_EXCLUDE_PREFIX, DEFAULT_EXCLUDE_PREFIX, parseExcludePrefix);
  const maxWrites = optionalValue(env.MAX_WRITES_PER_RUN, DEFAULT_MAX_WRITES_PER_RUN, parseMaxWrites);
  const reopenClosedBy = parseReopenClosedBy(env.REOPEN_CLOSED_BY);
  const syncAssignees = optionalValue(env.SYNC_ASSIGNEES, DEFAULT_SYNC_ASSIGNEES, parseSyncAssignees);
  const assigneeMap = parseAssigneeMap(env.ASSIGNEE_MAP);

  if (
    !githubToken.ok ||
    !repository.ok ||
    !baseUrl.ok ||
    !youtrackToken.ok ||
    !project.ok ||
    !excludePrefix.ok ||
    !maxWrites.ok ||
    !reopenClosedBy.ok ||
    !syncAssignees.ok ||
    !assigneeMap.ok
  ) {
    const results = [
      githubToken,
      repository,
      baseUrl,
      youtrackToken,
      project,
      excludePrefix,
      maxWrites,
      reopenClosedBy,
      syncAssignees,
      assigneeMap,
    ];
    throw new ConfigError(results.flatMap((result) => (result.ok ? [] : result.problems)));
  }

  return Object.freeze({
    githubToken: githubToken.value,
    githubOwner: repository.value.owner,
    githubRepo: repository.value.repo,
    youtrackBaseUrl: baseUrl.value,
    youtrackToken: youtrackToken.value,
    youtrackProject: project.value,
    excludePrefix: excludePrefix.value,
    maxWritesPerRun: maxWrites.value,
    dryRun: parseDryRun(env.DRY_RUN),
    reopenClosedBy: reopenClosedBy.value,
    syncAssignees: syncAssignees.value,
    assigneeMap: assigneeMap.value,
  });
}

/** Outcome of validating one setting; a failure carries every problem found for it. */
type FieldResult<T> = Valid<T> | Invalid;
type Valid<T> = { readonly ok: true; readonly value: T };
type Invalid = { readonly ok: false; readonly problems: readonly string[] };

type Repository = { readonly owner: string; readonly repo: string };
type TokenKey = Extract<EnvKey, "GITHUB_TOKEN" | "YOUTRACK_TOKEN">;

const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const YOUTRACK_PROJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/**
 * A user login (letters, digits, hyphens, and "_" for Enterprise Managed Users) or an app's bot
 * login such as "github-actions[bot]". Case-insensitive, like the R10 comparison.
 */
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,38})(?:\[bot\])?$/i;
/** An ASSIGNEE_MAP target: a user login, so GITHUB_LOGIN_PATTERN without the "[bot]" suffix. */
const GITHUB_USER_LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/;
/** ASSIGNEE_MAP entries are separated by commas and line breaks (CRLF, LF or a lone CR). */
const MAP_ENTRY_SEPARATOR = /[,\r\n]/;
/** Any whitespace String.prototype.trim would remove, anywhere in the text. */
const WHITESPACE_PATTERN = /\s/;
/** Printable ASCII, "!" (0x21) to "~" (0x7e): no space, control or non-ASCII characters. */
const TOKEN_PATTERN = /^[\x21-\x7e]+$/;
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

/**
 * Required token, sent verbatim in an `Authorization` header. Whitespace, control or
 * non-ASCII characters inside it are a paste error (and CR, LF or non-Latin-1 characters
 * make fetch throw), so they fail here. The problem names the key, never the value.
 */
function requireToken(key: TokenKey, raw: string | undefined): FieldResult<string> {
  return andThen(requireValue(key, raw), (value) =>
    TOKEN_PATTERN.test(value)
      ? valid(value)
      : invalid(`${key} must contain only printable ASCII characters (no spaces or control characters)`),
  );
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

/** A leading "-" would turn `project: -CUI` into an exclusion, so the first character is a letter or digit. */
function parseProject(value: string): FieldResult<string> {
  return YOUTRACK_PROJECT_PATTERN.test(value)
    ? valid(value)
    : invalid('YOUTRACK_PROJECT must start with a letter or digit and contain only letters, digits, "_" or "-"');
}

/** An empty prefix would match every summary and so keep every issue out of the mirror. */
function parseExcludePrefix(value: string): FieldResult<string> {
  return value === "" ? invalid("YOUTRACK_EXCLUDE_PREFIX must not be empty when set") : valid(value);
}

function parseMaxWrites(value: string): FieldResult<number> {
  const count = Number(value);
  // Digits only, so `count` is a non-negative integer (or huge, which the bound rejects).
  const isInRange = DIGITS_PATTERN.test(value) && count <= MAX_WRITES_LIMIT;
  return isInRange
    ? valid(count)
    : invalid(`MAX_WRITES_PER_RUN must be a whole number from 0 to ${String(MAX_WRITES_LIMIT)}`);
}

/**
 * Unset or blank: null, never reopen (the default everywhere but the GitHub Action, whose
 * input sets "github-actions[bot]"). Otherwise a GitHub login, trimmed.
 */
function parseReopenClosedBy(raw: string | undefined): FieldResult<string | null> {
  const value = raw?.trim() ?? "";
  if (value === "") return valid(null);
  return GITHUB_LOGIN_PATTERN.test(value)
    ? valid(value)
    : invalid('REOPEN_CLOSED_BY must be a GitHub login, such as "github-actions[bot]", or empty');
}

/** Dry-run stays on unless the value is exactly "false" (trimmed, case-insensitive). */
function parseDryRun(raw: string | undefined): boolean {
  return raw?.trim().toLowerCase() !== "false";
}

/**
 * "true" or "false", A-Z case ignored (the value arrives trimmed). Strict, unlike DRY_RUN: a
 * typo must not silently keep on a feature that notifies people, and blank is a typo too.
 */
function parseSyncAssignees(value: string): FieldResult<boolean> {
  const word = asciiLowercase(value);
  if (word === "true") return valid(true);
  if (word === "false") return valid(false);
  return invalid('SYNC_ASSIGNEES must be "true" or "false"');
}

/** One non-blank ASSIGNEE_MAP entry; `key` is null when the entry's form or key is bad. */
type MapEntry = {
  /** 1-based, among the non-blank entries: problems name this, never the entry's text. */
  readonly position: number;
  /** The YouTrack login, A-Z lowercased. */
  readonly key: string | null;
  /** The GitHub login as written; null for ASSIGNEE_MAP_NEVER. */
  readonly login: string | null;
  readonly problems: readonly string[];
};

/**
 * Unset or blank: an empty map. Otherwise entries split on commas and line breaks, trimmed,
 * blank ones skipped. Each is `<youtrack-login>=<github-login>` with exactly one "=", both sides
 * trimmed: the key non-empty without whitespace, the value a user login or "-". A key repeated
 * in another A-Z case is a problem; two keys may share a value. The map holds personal data, so
 * every problem names entry positions only.
 */
function parseAssigneeMap(raw: string | undefined): FieldResult<AssigneeMap> {
  const entries = (raw ?? "")
    .split(MAP_ENTRY_SEPARATOR)
    .map((text) => text.trim())
    .filter((text) => text !== "")
    .map((text, index) => parseMapEntry(text, index + 1));
  // A Map built from the reversed entries keeps each key's first position.
  const firstPositions = new Map(
    entries.toReversed().flatMap((entry) => (entry.key === null ? [] : [[entry.key, entry.position] as const])),
  );
  const problems = entries.flatMap((entry) => [...entry.problems, ...repeatProblems(entry, firstPositions)]);
  if (problems.length > 0) {
    // Not invalid(...problems): a huge map must not spread thousands of arguments.
    return { ok: false, problems };
  }
  return valid(new Map(entries.flatMap((entry) => (entry.key === null ? [] : [[entry.key, entry.login] as const]))));
}

function parseMapEntry(text: string, position: number): MapEntry {
  const sides = text.split("=");
  const [rawKey, rawLogin] = sides;
  if (sides.length !== 2 || rawKey === undefined || rawLogin === undefined) {
    const problem = `ASSIGNEE_MAP entry ${String(position)} must have the form <youtrack-login>=<github-login>`;
    return { position, key: null, login: null, problems: [problem] };
  }
  const key = rawKey.trim();
  const login = rawLogin.trim();
  const isKeyValid = key !== "" && !WHITESPACE_PATTERN.test(key);
  const isLoginValid = login === ASSIGNEE_MAP_NEVER || GITHUB_USER_LOGIN_PATTERN.test(login);
  return {
    position,
    key: isKeyValid ? asciiLowercase(key) : null,
    login: login === ASSIGNEE_MAP_NEVER ? null : login,
    problems: [
      ...(isKeyValid
        ? []
        : [`ASSIGNEE_MAP entry ${String(position)}: the YouTrack login must not be empty or contain spaces`]),
      ...(isLoginValid ? [] : [`ASSIGNEE_MAP entry ${String(position)}: the GitHub login must be a user login or "-"`]),
    ],
  };
}

/** The repeat problem of an entry whose key an earlier entry already has, naming both positions. */
function repeatProblems(entry: MapEntry, firstPositions: ReadonlyMap<string, number>): readonly string[] {
  const first = entry.key === null ? undefined : firstPositions.get(entry.key);
  return first === undefined || first === entry.position
    ? []
    : [`ASSIGNEE_MAP entries ${String(first)} and ${String(entry.position)} have the same YouTrack login`];
}

/** A-Z lowercased, nothing else: no Unicode case mapping, so no look-alike folds onto ASCII. */
function asciiLowercase(text: string): string {
  return text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}
