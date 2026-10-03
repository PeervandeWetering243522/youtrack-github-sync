// Fuzzing parseConfig: seeded, so a failure reproduces from FUZZ_SEED.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConfigError, DEFAULT_EXCLUDE_PREFIX, ENV_KEYS, MAX_WRITES_LIMIT } from "../../src/config.ts";
import type { Config, EnvSource } from "../../src/config.ts";
import {
  BOM,
  GITHUB_TOKEN,
  GITHUB_TOKEN_PROBLEM,
  LINE_SEPARATOR,
  MAP_PROBLEM_PATTERN,
  MAX_WRITES_PROBLEM,
  MISSING_PROBLEMS,
  NBSP,
  OWNER_PROBLEM,
  PREFIX_PROBLEM,
  PROJECT_PROBLEM,
  REOPEN_CLOSED_BY_PROBLEM,
  REPO_PROBLEM,
  REPO_SHAPE_PROBLEM,
  SYNC_ASSIGNEES_PROBLEM,
  URL_CREDENTIALS_PROBLEM,
  URL_HTTPS_PROBLEM,
  URL_INVALID_PROBLEM,
  URL_QUERY_PROBLEM,
  VALID_ENV,
  YOUTRACK_TOKEN,
  YOUTRACK_TOKEN_PROBLEM,
  ZERO_WIDTH_SPACE,
  char,
  fullwidth,
  outcome,
  visible,
} from "./fixtures.ts";

const FUZZ_SEED = 0x5eed;
const FUZZ_ROUNDS = 2_000;
const FUZZ_REPLACE_CHANCE = 0.35;
const FUZZ_UNDEFINED_CHANCE = 0.1;
const FUZZ_MAX_FRAGMENTS = 5;

/** Every message parseConfig can produce. None carries a configured value, so none can leak one. */
const KNOWN_PROBLEMS: ReadonlySet<string> = new Set([
  ...MISSING_PROBLEMS,
  ...[GITHUB_TOKEN_PROBLEM, YOUTRACK_TOKEN_PROBLEM],
  ...[OWNER_PROBLEM, REPO_PROBLEM, REPO_SHAPE_PROBLEM, PROJECT_PROBLEM, PREFIX_PROBLEM, MAX_WRITES_PROBLEM],
  ...[URL_INVALID_PROBLEM, URL_HTTPS_PROBLEM, URL_QUERY_PROBLEM, URL_CREDENTIALS_PROBLEM],
  ...[REOPEN_CLOSED_BY_PROBLEM, SYNC_ASSIGNEES_PROBLEM],
]);

/** A known message, or an ASSIGNEE_MAP one, which names entry positions only. */
function isKnownProblem(problem: string): boolean {
  return KNOWN_PROBLEMS.has(problem) || MAP_PROBLEM_PATTERN.test(problem);
}

/** Building blocks for fuzzed values: separators, URL syntax, numbers, look-alikes, invisibles, tokens. */
const FUZZ_FRAGMENTS: readonly string[] = [
  ...["", " ", "/", "//", "\\", "?", "#", "@", ":", ".", "..", "-", "_", "%2F", "%40", ",", "{", "}"],
  ...["https://", "http://", "HTTPS:", "example.com", "[::1]", ":443", "user:pw@"],
  ...["false", "FALSE", "true", "0", "40", "41", "-1", "007", "[individual]", "a", "Z", "9", "CUI"],
  ...[NBSP, BOM, ZERO_WIDTH_SPACE, LINE_SEPARATOR, "\n", "\t", char(0), char(0xd800), char(0x1f600)],
  ...[char(0x017f), char(0xff0f), fullwidth("CUI"), GITHUB_TOKEN, YOUTRACK_TOKEN],
  ...["[bot]", "github-actions[bot]", "[", "]"],
  ...["=", "\r\n", "True", "jdoe123456=", "=JaneDoe123456", "staffuser=-", "JDOE123456"],
];

/** Deterministic PRNG (mulberry32) returning floats in [0, 1). */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 2 ** 32;
  };
}

function fuzzValue(random: () => number): string | undefined {
  if (random() < FUZZ_UNDEFINED_CHANCE) {
    return undefined;
  }
  const length = Math.floor(random() * (FUZZ_MAX_FRAGMENTS + 1));
  return Array.from({ length }, () => FUZZ_FRAGMENTS[Math.floor(random() * FUZZ_FRAGMENTS.length)] ?? "").join("");
}

/** VALID_ENV with each key independently replaced by a fuzzed value, so both outcomes occur. */
function fuzzEnv(random: () => number): EnvSource {
  return Object.fromEntries(
    ENV_KEYS.map((key) => [key, random() < FUZZ_REPLACE_CHANCE ? fuzzValue(random) : VALID_ENV[key]]),
  );
}

/** Independent oracle for tokens: non-empty, every character strictly between " " and DEL (0x7f). */
function isPrintableAsciiToken(token: string): boolean {
  return token.length > 0 && Array.from(token).every((c) => c > " " && c <= "~");
}

const LOGIN_CHARACTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
const BOT_SUFFIX = "[bot]";
const MAX_LOGIN_LENGTH = 39;

/**
 * Independent oracle for REOPEN_CLOSED_BY: 1-39 login characters, not starting with "-" or
 * "_", then an optional "[bot]" in any ASCII case.
 */
function isGitHubLogin(value: string): boolean {
  const hasSuffix = value.slice(-BOT_SUFFIX.length).toLowerCase() === BOT_SUFFIX && value.length > BOT_SUFFIX.length;
  const name = hasSuffix ? value.slice(0, -BOT_SUFFIX.length) : value;
  const characters = Array.from(name);
  return (
    characters.length >= 1 &&
    characters.length <= MAX_LOGIN_LENGTH &&
    characters[0] !== "-" &&
    characters[0] !== "_" &&
    characters.every((c) => LOGIN_CHARACTERS.includes(c))
  );
}

/** Properties every accepted config must have, checked against the raw environment. */
function assertAcceptedConfig(env: EnvSource, config: Config, context: string): void {
  assert.equal(Object.isFrozen(config), true, context);
  assert.equal(config.githubToken, env.GITHUB_TOKEN?.trim(), context);
  assert.equal(config.youtrackToken, env.YOUTRACK_TOKEN?.trim(), context);
  assert.ok(isPrintableAsciiToken(config.githubToken) && isPrintableAsciiToken(config.youtrackToken), context);
  assert.equal(`${config.githubOwner}/${config.githubRepo}`, env.GITHUB_REPO?.trim(), context);
  assert.match(config.youtrackBaseUrl, /^https:\/\/[^/?#@\s]+(?:\/[^?#\s]*[^/?#\s])?$/u, context);
  assert.equal(config.youtrackProject, env.YOUTRACK_PROJECT?.trim(), context);
  assert.match(config.youtrackProject, /^[A-Za-z0-9_-]+$/, context);
  assert.doesNotMatch(config.youtrackProject, /^[-_]/, context);
  assert.equal(config.excludePrefix, env.YOUTRACK_EXCLUDE_PREFIX?.trim() ?? DEFAULT_EXCLUDE_PREFIX, context);
  assert.notEqual(config.excludePrefix, "", context);
  assert.ok(Number.isSafeInteger(config.maxWritesPerRun), context);
  assert.ok(config.maxWritesPerRun >= 0 && config.maxWritesPerRun <= MAX_WRITES_LIMIT, context);
  // Independent oracle: a regex `i` flag without `u` folds ASCII only, so U+017F never matches "s".
  assert.equal(config.dryRun, !/^false$/i.test(env.DRY_RUN?.trim() ?? ""), context);
  const reopenClosedBy = env.REOPEN_CLOSED_BY?.trim() ?? "";
  assert.equal(config.reopenClosedBy, reopenClosedBy === "" ? null : reopenClosedBy, context);
  assert.ok(config.reopenClosedBy === null || isGitHubLogin(config.reopenClosedBy), context);
  const syncAssignees = env.SYNC_ASSIGNEES?.trim();
  assert.ok(syncAssignees === undefined || /^(?:true|false)$/i.test(syncAssignees), context);
  assert.equal(config.syncAssignees, syncAssignees === undefined || /^true$/i.test(syncAssignees), context);
  assertAcceptedMap(env.ASSIGNEE_MAP, config.assigneeMap, context);
}

/** Independent oracle for ASSIGNEE_MAP: every non-blank entry is one key=value pair, keys distinct ignoring A-Z case. */
function assertAcceptedMap(raw: string | undefined, map: Config["assigneeMap"], context: string): void {
  const entries = (raw ?? "")
    .split(/,|\r|\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const pairs = entries.map((entry) => entry.split("=").map((side) => side.trim()));

  assert.equal(map.size, entries.length, context);
  for (const [key, value] of pairs) {
    assert.ok(key !== undefined && value !== undefined, context);
    assert.equal(
      map.get(key.replace(/[A-Z]/g, (letter) => letter.toLowerCase())),
      value === "-" ? null : value,
      context,
    );
    assert.ok(value === "-" || (isGitHubLogin(value) && !value.endsWith("]")), context);
  }
  for (const key of map.keys()) {
    assert.ok(key !== "" && !/\s|[A-Z]/.test(key), context);
  }
}

/** Every problem is a known, value-free message; no duplicates; ordered by ENV_KEYS. */
function assertRejectedConfig(error: ConfigError, context: string): void {
  const keyOrder = error.problems.map((problem) => ENV_KEYS.findIndex((key) => problem.startsWith(`${key} `)));

  assert.ok(error.problems.length > 0, context);
  assert.ok(error.problems.every(isKnownProblem), context);
  assert.equal(new Set(error.problems).size, error.problems.length, context);
  assert.deepEqual(
    keyOrder,
    keyOrder.toSorted((a, b) => a - b),
    context,
  );
  assert.equal(error.message, `Invalid configuration: ${error.problems.join("; ")}`, context);
}

describe("parseConfig: fuzzed environments", () => {
  it("returns a consistent config or throws a ConfigError built only from known messages", () => {
    const random = seededRandom(FUZZ_SEED);
    let accepted = 0;

    for (let round = 0; round < FUZZ_ROUNDS; round += 1) {
      const env = fuzzEnv(random);
      const context = `round ${String(round)}: ${visible(JSON.stringify(env))}`;
      const result = outcome(env);

      if (result instanceof ConfigError) {
        assertRejectedConfig(result, context);
      } else {
        assertAcceptedConfig(env, result, context);
        accepted += 1;
      }
    }

    assert.ok(accepted > 0 && accepted < FUZZ_ROUNDS, `accepted ${String(accepted)} of ${String(FUZZ_ROUNDS)}`);
  });
});
