/**
 * Shared fixtures for the test/config/*.test.ts files: a valid environment, every
 * problem message parseConfig can produce, named odd characters and small helpers.
 * Not a test file itself (the runner only picks up *.test.ts).
 */

import assert from "node:assert/strict";

import { ConfigError, MAX_WRITES_LIMIT, parseConfig } from "../../src/config.ts";
import type { Config, EnvSource } from "../../src/config.ts";

export const GITHUB_TOKEN = "ghp_exampleGithubToken0123456789";
export const YOUTRACK_TOKEN = "perm:exampleYoutrackToken.abc123==";

export const VALID_ENV: EnvSource = {
  GITHUB_TOKEN,
  GITHUB_REPO: "BredaUniversityADSAI/2026-27s1-fai3-adsai-ComfyUI",
  YOUTRACK_BASE_URL: "https://youtrack.ai.buas.nl",
  YOUTRACK_TOKEN,
  YOUTRACK_PROJECT: "CUI",
  YOUTRACK_EXCLUDE_PREFIX: "[individual]",
  MAX_WRITES_PER_RUN: "30",
  DRY_RUN: "true",
};

export const EXPECTED_CONFIG: Config = {
  githubToken: GITHUB_TOKEN,
  githubOwner: "BredaUniversityADSAI",
  githubRepo: "2026-27s1-fai3-adsai-ComfyUI",
  youtrackBaseUrl: "https://youtrack.ai.buas.nl",
  youtrackToken: YOUTRACK_TOKEN,
  youtrackProject: "CUI",
  excludePrefix: "[individual]",
  maxWritesPerRun: 30,
  dryRun: true,
};

const REQUIRED_KEYS = [
  "GITHUB_TOKEN",
  "GITHUB_REPO",
  "YOUTRACK_BASE_URL",
  "YOUTRACK_TOKEN",
  "YOUTRACK_PROJECT",
] as const;
export const MISSING_PROBLEMS = REQUIRED_KEYS.map((key) => `${key} is missing`);

const TOKEN_RULE = "must contain only printable ASCII characters (no spaces or control characters)";
export const GITHUB_TOKEN_PROBLEM = `GITHUB_TOKEN ${TOKEN_RULE}`;
export const YOUTRACK_TOKEN_PROBLEM = `YOUTRACK_TOKEN ${TOKEN_RULE}`;
export const OWNER_PROBLEM =
  "GITHUB_REPO owner must be 1-39 letters, digits or hyphens, starting with a letter or digit";
export const REPO_PROBLEM =
  'GITHUB_REPO repository must be 1-100 letters, digits, ".", "_" or "-", and not "." or ".."';
export const REPO_SHAPE_PROBLEM = 'GITHUB_REPO must have the form "owner/repo"';
export const URL_INVALID_PROBLEM = "YOUTRACK_BASE_URL is not a valid absolute URL";
export const URL_HTTPS_PROBLEM = "YOUTRACK_BASE_URL must use https";
export const URL_QUERY_PROBLEM = "YOUTRACK_BASE_URL must not contain a query string or fragment";
export const URL_CREDENTIALS_PROBLEM = "YOUTRACK_BASE_URL must not contain credentials";
export const PROJECT_PROBLEM =
  'YOUTRACK_PROJECT must start with a letter or digit and contain only letters, digits, "_" or "-"';
export const PREFIX_PROBLEM = "YOUTRACK_EXCLUDE_PREFIX must not be empty when set";
export const MAX_WRITES_PROBLEM = `MAX_WRITES_PER_RUN must be a whole number from 0 to ${String(MAX_WRITES_LIMIT)}`;

/** One character from its code point, so every odd character in these tests is named, not invisible. */
export function char(codePoint: number): string {
  return String.fromCodePoint(codePoint);
}

/** ASCII text mapped to its FULLWIDTH look-alike, e.g. "CUI" -> U+FF23 U+FF35 U+FF29. */
export function fullwidth(text: string): string {
  return Array.from(text, (c) => char((c.codePointAt(0) ?? 0) + 0xfee0)).join("");
}

export const NBSP = char(0x00a0);
export const BOM = char(0xfeff);
export const LINE_SEPARATOR = char(0x2028);
export const PARAGRAPH_SEPARATOR = char(0x2029);
export const IDEOGRAPHIC_SPACE = char(0x3000);
export const ZERO_WIDTH_SPACE = char(0x200b);
export const ARABIC_INDIC_THREE = char(0x0663);
export const ARABIC_INDIC_ONE = char(0x0661);
export const CYRILLIC_SMALL_A = char(0x0430);

/** Every code point String.prototype.trim removes (ECMAScript WhiteSpace and LineTerminator), checked exhaustively. */
export const ALL_TRIMMED_WHITESPACE = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
]
  .map(char)
  .join("");

/** Test-name helper: shows invisible and non-ASCII characters as U+XXXX. */
export function visible(value: string): string {
  return value.replace(/[^ -~]/gu, (c) => `<U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}>`);
}

/** VALID_ENV with some keys replaced (an explicit `undefined` removes the key's value). */
export function envWith(overrides: EnvSource): EnvSource {
  return { ...VALID_ENV, ...overrides };
}

/** The Config, or the ConfigError parseConfig threw; any other error fails the test. */
export function outcome(env: EnvSource): Config | ConfigError {
  try {
    return parseConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      return error;
    }
    throw error;
  }
}

/** Runs parseConfig and returns the ConfigError; fails the test if it does not throw one. */
export function captureConfigError(env: EnvSource): ConfigError {
  const result = outcome(env);
  if (result instanceof ConfigError) {
    return result;
  }
  assert.fail("expected parseConfig to throw a ConfigError");
}

export function problemsFor(env: EnvSource): readonly string[] {
  return captureConfigError(env).problems;
}
