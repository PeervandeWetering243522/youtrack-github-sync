import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ConfigError,
  DEFAULT_MAX_WRITES_PER_RUN,
  DEFAULT_TITLE_PREFIX,
  ENV_KEYS,
  MAX_WRITES_LIMIT,
  parseConfig,
  type Config,
  type EnvSource,
} from "../src/config.ts";

const GITHUB_TOKEN = "ghp_exampleGithubToken0123456789";
const YOUTRACK_TOKEN = "perm:exampleYoutrackToken.abc123==";

const VALID_ENV: EnvSource = {
  GITHUB_TOKEN,
  GITHUB_REPO: "BredaUniversityADSAI/2026-27s1-fai3-adsai-ComfyUI",
  YOUTRACK_BASE_URL: "https://youtrack.ai.buas.nl",
  YOUTRACK_TOKEN,
  YOUTRACK_PROJECT: "CUI",
  YOUTRACK_TITLE_PREFIX: "[team]",
  MAX_WRITES_PER_RUN: "30",
  DRY_RUN: "true",
};

const EXPECTED_CONFIG: Config = {
  githubToken: GITHUB_TOKEN,
  githubOwner: "BredaUniversityADSAI",
  githubRepo: "2026-27s1-fai3-adsai-ComfyUI",
  youtrackBaseUrl: "https://youtrack.ai.buas.nl",
  youtrackToken: YOUTRACK_TOKEN,
  youtrackProject: "CUI",
  titlePrefix: "[team]",
  maxWritesPerRun: 30,
  dryRun: true,
};

const REQUIRED_KEYS = ["GITHUB_TOKEN", "GITHUB_REPO", "YOUTRACK_BASE_URL", "YOUTRACK_TOKEN", "YOUTRACK_PROJECT"] as const;
const MISSING_PROBLEMS = REQUIRED_KEYS.map((key) => `${key} is missing`);

const OWNER_PROBLEM = "GITHUB_REPO owner must be 1-39 letters, digits or hyphens, starting with a letter or digit";
const REPO_PROBLEM = 'GITHUB_REPO repository must be 1-100 letters, digits, ".", "_" or "-", and not "." or ".."';
const REPO_SHAPE_PROBLEM = 'GITHUB_REPO must have the form "owner/repo"';
const URL_INVALID_PROBLEM = "YOUTRACK_BASE_URL is not a valid absolute URL";
const URL_HTTPS_PROBLEM = "YOUTRACK_BASE_URL must use https";
const URL_QUERY_PROBLEM = "YOUTRACK_BASE_URL must not contain a query string or fragment";
const URL_CREDENTIALS_PROBLEM = "YOUTRACK_BASE_URL must not contain credentials";
const PROJECT_PROBLEM = 'YOUTRACK_PROJECT must contain only letters, digits, "_" or "-"';
const PREFIX_PROBLEM = "YOUTRACK_TITLE_PREFIX must not be empty when set";
const MAX_WRITES_PROBLEM = `MAX_WRITES_PER_RUN must be a whole number from 0 to ${String(MAX_WRITES_LIMIT)}`;

/** Every message parseConfig can produce. None carries a configured value, so none can leak one. */
const KNOWN_PROBLEMS: ReadonlySet<string> = new Set([
  ...MISSING_PROBLEMS,
  ...[OWNER_PROBLEM, REPO_PROBLEM, REPO_SHAPE_PROBLEM, PROJECT_PROBLEM, PREFIX_PROBLEM, MAX_WRITES_PROBLEM],
  ...[URL_INVALID_PROBLEM, URL_HTTPS_PROBLEM, URL_QUERY_PROBLEM, URL_CREDENTIALS_PROBLEM],
]);

/** One character from its code point, so every odd character in these tests is named, not invisible. */
function char(codePoint: number): string {
  return String.fromCodePoint(codePoint);
}

/** ASCII text mapped to its FULLWIDTH look-alike, e.g. "CUI" -> U+FF23 U+FF35 U+FF29. */
function fullwidth(text: string): string {
  return Array.from(text, (c) => char((c.codePointAt(0) ?? 0) + 0xfee0)).join("");
}

const NBSP = char(0x00a0);
const BOM = char(0xfeff);
const LINE_SEPARATOR = char(0x2028);
const PARAGRAPH_SEPARATOR = char(0x2029);
const IDEOGRAPHIC_SPACE = char(0x3000);
const ZERO_WIDTH_SPACE = char(0x200b);
const ARABIC_INDIC_THREE = char(0x0663);
const ARABIC_INDIC_ONE = char(0x0661);
const CYRILLIC_SMALL_A = char(0x0430);

/** Every code point String.prototype.trim removes (ECMAScript WhiteSpace and LineTerminator), checked exhaustively. */
const ALL_TRIMMED_WHITESPACE = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
]
  .map(char)
  .join("");

/** Test-name helper: shows invisible and non-ASCII characters as U+XXXX. */
function visible(value: string): string {
  return value.replace(/[^ -~]/gu, (c) => `<U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}>`);
}

/** VALID_ENV with some keys replaced (an explicit `undefined` removes the key's value). */
function envWith(overrides: EnvSource): EnvSource {
  return { ...VALID_ENV, ...overrides };
}

/** The Config, or the ConfigError parseConfig threw; any other error fails the test. */
function outcome(env: EnvSource): Config | ConfigError {
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
function captureConfigError(env: EnvSource): ConfigError {
  const result = outcome(env);
  if (result instanceof ConfigError) {
    return result;
  }
  assert.fail("expected parseConfig to throw a ConfigError");
}

function problemsFor(env: EnvSource): readonly string[] {
  return captureConfigError(env).problems;
}

void describe("parseConfig: valid environment", () => {
  void it("builds the full config from a complete environment", () => {
    const config = parseConfig(VALID_ENV);

    assert.deepEqual(config, EXPECTED_CONFIG);
  });

  void it("returns a frozen config that refuses writes at runtime", () => {
    const config = parseConfig(VALID_ENV);

    const didWrite = Reflect.set(config, "dryRun", false);

    assert.equal(Object.isFrozen(config), true);
    assert.equal(didWrite, false);
    assert.equal(config.dryRun, true);
  });

  void it("leaves frozen and mutable input environments unchanged", () => {
    const frozenEnv = Object.freeze({ ...VALID_ENV });
    const mutableEnv: EnvSource = { ...VALID_ENV, GITHUB_REPO: " owner/repo ", MAX_WRITES_PER_RUN: " 007 ", DRY_RUN: " FALSE " };
    const snapshots = [{ ...frozenEnv }, { ...mutableEnv }];

    parseConfig(frozenEnv);
    parseConfig(mutableEnv);

    assert.deepEqual([frozenEnv, mutableEnv], snapshots);
  });

  void it("gives identical results on repeated calls (no hidden state such as a regex lastIndex)", () => {
    const invalidEnv = envWith({ GITHUB_REPO: "-bad/..", YOUTRACK_PROJECT: "C U I", MAX_WRITES_PER_RUN: "41" });

    for (let round = 0; round < 3; round += 1) {
      assert.deepEqual(parseConfig(VALID_ENV), EXPECTED_CONFIG);
      assert.deepEqual(problemsFor(invalidEnv), [OWNER_PROBLEM, REPO_PROBLEM, PROJECT_PROBLEM, MAX_WRITES_PROBLEM]);
    }
  });

  void it("strips every trimmable whitespace character (ASCII and Unicode) from both ends of every value", () => {
    const env = Object.fromEntries(
      ENV_KEYS.map((key) => [key, `${ALL_TRIMMED_WHITESPACE}${VALID_ENV[key] ?? ""}${ALL_TRIMMED_WHITESPACE}`]),
    );

    const config = parseConfig(env);

    assert.deepEqual(config, EXPECTED_CONFIG);
  });

  void it("applies defaults when optional keys are absent or explicitly undefined", () => {
    const requiredOnly: EnvSource = {
      GITHUB_TOKEN,
      GITHUB_REPO: VALID_ENV.GITHUB_REPO,
      YOUTRACK_BASE_URL: VALID_ENV.YOUTRACK_BASE_URL,
      YOUTRACK_TOKEN,
      YOUTRACK_PROJECT: VALID_ENV.YOUTRACK_PROJECT,
    };
    const explicitUndefined = envWith({ YOUTRACK_TITLE_PREFIX: undefined, MAX_WRITES_PER_RUN: undefined, DRY_RUN: undefined });
    const expected = { ...EXPECTED_CONFIG, titlePrefix: DEFAULT_TITLE_PREFIX, maxWritesPerRun: DEFAULT_MAX_WRITES_PER_RUN };

    assert.deepEqual(parseConfig(requiredOnly), expected);
    assert.deepEqual(parseConfig(explicitUndefined), expected);
  });
});

void describe("parseConfig: tokens", () => {
  for (const key of ["GITHUB_TOKEN", "YOUTRACK_TOKEN"] as const) {
    void it(`reports ${key} as missing when absent, empty or whitespace-only`, () => {
      for (const blank of [undefined, "", "   ", "\t\n"]) {
        const problems = problemsFor(envWith({ [key]: blank }));

        assert.deepEqual(problems, [`${key} is missing`]);
      }
    });
  }

  void it("treats a value made of every trimmable whitespace character as blank, for every key", () => {
    const env = Object.fromEntries(ENV_KEYS.map((key) => [key, ALL_TRIMMED_WHITESPACE]));

    const error = captureConfigError(env);

    assert.deepEqual(error.problems, [...MISSING_PROBLEMS, PREFIX_PROBLEM, MAX_WRITES_PROBLEM]);
  });

  void it("never echoes token values, even when pasted into the wrong variable", () => {
    const env = envWith({
      GITHUB_REPO: GITHUB_TOKEN,
      YOUTRACK_BASE_URL: YOUTRACK_TOKEN,
      YOUTRACK_PROJECT: YOUTRACK_TOKEN,
      MAX_WRITES_PER_RUN: GITHUB_TOKEN,
    });

    const error = captureConfigError(env);

    assert.equal(error.problems.length, 4);
    for (const text of [error.message, error.stack ?? "", ...error.problems]) {
      assert.equal(text.includes(GITHUB_TOKEN), false, text);
      assert.equal(text.includes(YOUTRACK_TOKEN), false, text);
    }
  });

  void it("never echoes any configured value, in any casing, in problems or the message", () => {
    const marker = "Zq9EchoMarker";
    const leakyEnvs: readonly EnvSource[] = [
      envWith({ GITHUB_REPO: marker }),
      envWith({ GITHUB_REPO: `${marker}!/${marker}!` }),
      envWith({ YOUTRACK_BASE_URL: `${marker} is not a url` }),
      envWith({ YOUTRACK_BASE_URL: `http://${marker}:${marker}@example.com/${marker}?${marker}#${marker}` }),
      envWith({ YOUTRACK_PROJECT: `${marker} OR project: X` }),
      envWith({ YOUTRACK_TITLE_PREFIX: " ", MAX_WRITES_PER_RUN: marker }),
    ];

    for (const env of leakyEnvs) {
      const error = captureConfigError(env);

      assert.ok(error.problems.length > 0);
      for (const text of [error.message, ...error.problems]) {
        assert.equal(text.toLowerCase().includes(marker.toLowerCase()), false, text);
      }
    }
  });
});

void describe("parseConfig: GITHUB_REPO", () => {
  const accepted: readonly (readonly [string, string, string])[] = [
    ["a/b", "a", "b"],
    ["Owner-1/repo.name_x-y", "Owner-1", "repo.name_x-y"],
    ["9lives/.github", "9lives", ".github"],
    ["owner/...", "owner", "..."],
    [`${"a".repeat(39)}/repo`, "a".repeat(39), "repo"],
    [`owner/${"r".repeat(100)}`, "owner", "r".repeat(100)],
  ];
  for (const [value, owner, repo] of accepted) {
    void it(`splits "${value.slice(0, 40)}" into owner and repo`, () => {
      const config = parseConfig(envWith({ GITHUB_REPO: value }));

      assert.equal(config.githubOwner, owner);
      assert.equal(config.githubRepo, repo);
    });
  }

  void it("accepts every owner the spec regex allows, including trailing and doubled hyphens", () => {
    for (const owner of ["a-", "a--b", "0", `9${"-".repeat(38)}`]) {
      const config = parseConfig(envWith({ GITHUB_REPO: `${owner}/repo` }));

      assert.equal(config.githubOwner, owner, owner);
    }
  });

  void it('rejects only the exact repository names "." and ".."', () => {
    for (const repo of [".git", "..a", "a..b", "a."]) {
      const config = parseConfig(envWith({ GITHUB_REPO: `owner/${repo}` }));

      assert.equal(config.githubRepo, repo, repo);
    }
  });

  void it("reports GITHUB_REPO as missing when absent or blank", () => {
    assert.deepEqual(problemsFor(envWith({ GITHUB_REPO: undefined })), ["GITHUB_REPO is missing"]);
    assert.deepEqual(problemsFor(envWith({ GITHUB_REPO: "  " })), ["GITHUB_REPO is missing"]);
  });

  void it('rejects values that are not exactly "owner/repo"', () => {
    for (const value of ["owner", "owner/repo/extra", "owner/repo/", "owner//repo", "https://github.com/owner/repo"]) {
      assert.deepEqual(problemsFor(envWith({ GITHUB_REPO: value })), [REPO_SHAPE_PROBLEM], value);
    }
  });

  void it('requires an ASCII "/" separator; look-alike slashes are a shape error', () => {
    for (const value of [`owner${char(0x2215)}repo`, `owner${fullwidth("/")}repo`, "owner\\repo"]) {
      assert.deepEqual(problemsFor(envWith({ GITHUB_REPO: value })), [REPO_SHAPE_PROBLEM], visible(value));
    }
  });

  void it("rejects invalid owner names", () => {
    for (const owner of ["", "-owner", "own_er", "own.er", "own er", "a".repeat(40)]) {
      assert.deepEqual(problemsFor(envWith({ GITHUB_REPO: `${owner}/repo` })), [OWNER_PROBLEM], owner);
    }
  });

  void it("rejects invalid repository names", () => {
    for (const repo of ["", ".", "..", "re po", "repo!", "r".repeat(101)]) {
      assert.deepEqual(problemsFor(envWith({ GITHUB_REPO: `owner/${repo}` })), [REPO_PROBLEM], repo);
    }
  });

  void it("rejects non-ASCII, multi-line and space-padded parts (the patterns anchor each whole part)", () => {
    const cases: readonly (readonly [string, readonly string[]])[] = [
      [`${char(0x00f3)}wner/repo`, [OWNER_PROBLEM]],
      [`${fullwidth("o")}wner/repo`, [OWNER_PROBLEM]],
      [`own${ZERO_WIDTH_SPACE}er/repo`, [OWNER_PROBLEM]],
      ["owner\n/repo", [OWNER_PROBLEM]],
      ["owner\nevil/repo", [OWNER_PROBLEM]],
      [`owner/r${char(0x00e9)}po`, [REPO_PROBLEM]],
      [`owner/${ARABIC_INDIC_ONE}`, [REPO_PROBLEM]],
      ["owner/repo\nevil", [REPO_PROBLEM]],
      [`owner/repo${char(0)}`, [REPO_PROBLEM]],
      ["owner / repo", [OWNER_PROBLEM, REPO_PROBLEM]],
      ["/", [OWNER_PROBLEM, REPO_PROBLEM]],
    ];
    for (const [value, expected] of cases) {
      assert.deepEqual(problemsFor(envWith({ GITHUB_REPO: value })), expected, visible(value));
    }
  });

  void it("reports both owner and repository problems at once", () => {
    const problems = problemsFor(envWith({ GITHUB_REPO: "-bad/.." }));

    assert.deepEqual(problems, [OWNER_PROBLEM, REPO_PROBLEM]);
  });
});

void describe("parseConfig: YOUTRACK_BASE_URL", () => {
  const normalized: readonly (readonly [string, string])[] = [
    ["https://youtrack.ai.buas.nl/", "https://youtrack.ai.buas.nl"],
    ["https://youtrack.ai.buas.nl///", "https://youtrack.ai.buas.nl"],
    ["https://example.com/youtrack/", "https://example.com/youtrack"],
    ["https://example.com/youtrack//", "https://example.com/youtrack"],
    ["HTTPS://YouTrack.Example.COM", "https://youtrack.example.com"],
    ["https://example.com:443/", "https://example.com"],
    ["https://example.com:8443/yt", "https://example.com:8443/yt"],
    // Encoded "?", "#" and "/" are path characters: kept as they are, never read as a query or stripped.
    ["https://example.com/yt%3F", "https://example.com/yt%3F"],
    ["https://example.com/%23/", "https://example.com/%23"],
    ["https://example.com/yt%2F", "https://example.com/yt%2F"],
    // "@" in the path is not userinfo.
    ["https://example.com/@user/", "https://example.com/@user"],
  ];
  for (const [value, expected] of normalized) {
    void it(`normalizes "${value}" to "${expected}"`, () => {
      const config = parseConfig(envWith({ YOUTRACK_BASE_URL: value }));

      assert.equal(config.youtrackBaseUrl, expected);
    });
  }

  // Lenient WHATWG inputs: the result is always canonical origin + path, and
  // feeding it back in yields the same value.
  const canonical: readonly (readonly [string, string])[] = [
    ["https:example.com", "https://example.com"],
    ["https:\\\\example.com\\yt\\", "https://example.com/yt"],
    ["https://@example.com", "https://example.com"],
    ["https://:@example.com/", "https://example.com"],
    [`https://b${char(0x00fc)}cher.example/`, "https://xn--bcher-kva.example"],
    [`https://${fullwidth("example")}.com`, "https://example.com"],
    ["https://example.com/a/../b/", "https://example.com/b"],
    ["https://example.com/%2e%2e/yt/./", "https://example.com/yt"],
    ["https://example.com/you track/", "https://example.com/you%20track"],
    ["https://Example.com/Path/", "https://example.com/Path"],
    ["https://[::1]:8443/", "https://[::1]:8443"],
    ["https://exa\tmple.com/y\nt/", "https://example.com/yt"],
  ];
  for (const [value, expected] of canonical) {
    void it(`canonicalizes "${visible(value)}" to "${expected}", idempotently`, () => {
      const once = parseConfig(envWith({ YOUTRACK_BASE_URL: value })).youtrackBaseUrl;
      const twice = parseConfig(envWith({ YOUTRACK_BASE_URL: once })).youtrackBaseUrl;

      assert.equal(once, expected);
      assert.equal(twice, once);
    });
  }

  void it("reports YOUTRACK_BASE_URL as missing when absent or blank", () => {
    assert.deepEqual(problemsFor(envWith({ YOUTRACK_BASE_URL: undefined })), ["YOUTRACK_BASE_URL is missing"]);
    assert.deepEqual(problemsFor(envWith({ YOUTRACK_BASE_URL: " " })), ["YOUTRACK_BASE_URL is missing"]);
  });

  void it("rejects values the WHATWG parser refuses (relative, no host, bad port, bad host)", () => {
    const values = ["youtrack.ai.buas.nl", "/api", "https://", "https://exa mple.com", "https://example.com:99999"];
    for (const value of [...values, "https://example.com:443:443", "https://xn--/", "https://[::1", "https://user@"]) {
      assert.deepEqual(problemsFor(envWith({ YOUTRACK_BASE_URL: value })), [URL_INVALID_PROBLEM], value);
    }
  });

  void it("rejects every protocol other than https, including an upper-case http and look-alikes", () => {
    const values = ["http://youtrack.ai.buas.nl", "HTTP://example.com", "ftp://youtrack.ai.buas.nl", "file:///etc/passwd"];
    for (const value of [...values, "wss://example.com", "blob:https://example.com/x"]) {
      assert.deepEqual(problemsFor(envWith({ YOUTRACK_BASE_URL: value })), [URL_HTTPS_PROBLEM], value);
    }
  });

  void it("rejects query strings and fragments, including empty ones, wherever the parser finds them", () => {
    const values = ["https://example.com/?a=1", "https://example.com/#top", "https://example.com?", "https://example.com#"];
    for (const value of [...values, "https://example.com\\?x", "https://example.com/yt?#", "https://example.com/yt/#?a"]) {
      assert.deepEqual(problemsFor(envWith({ YOUTRACK_BASE_URL: value })), [URL_QUERY_PROBLEM], value);
    }
  });

  void it("rejects credentials, even with one half empty or percent-encoded, without echoing them", () => {
    const secrets = ["https://user:hunter2secret@example.com", "https://:hunter2secret@example.com"];
    const values = ["https://user@example.com", "https://user:@example.com", "https://%40@example.com", "https://:p@example.com/yt/"];
    for (const value of [...secrets, ...values]) {
      const error = captureConfigError(envWith({ YOUTRACK_BASE_URL: value }));

      assert.deepEqual(error.problems, [URL_CREDENTIALS_PROBLEM], value);
      assert.equal(error.message.includes("hunter2secret"), false);
    }
  });

  void it("reports every URL problem at once", () => {
    const problems = problemsFor(envWith({ YOUTRACK_BASE_URL: "http://user:pw@example.com/?q=1#x" }));

    assert.deepEqual(problems, [URL_HTTPS_PROBLEM, URL_QUERY_PROBLEM, URL_CREDENTIALS_PROBLEM]);
  });

  void it("keeps the host fixed when a path is appended to the result", () => {
    for (const value of ["https://example.com//evil.com/", "https://example.com\\@evil.com", "https:///evil.com//"]) {
      const base = parseConfig(envWith({ YOUTRACK_BASE_URL: value })).youtrackBaseUrl;

      assert.equal(new URL(`${base}/api/issues`).origin, new URL(value).origin, value);
    }
  });
});

void describe("parseConfig: YOUTRACK_PROJECT", () => {
  void it("accepts letters, digits, underscores and hyphens", () => {
    const config = parseConfig(envWith({ YOUTRACK_PROJECT: "My_Proj-2" }));

    assert.equal(config.youtrackProject, "My_Proj-2");
  });

  void it("reports YOUTRACK_PROJECT as missing when absent or blank", () => {
    assert.deepEqual(problemsFor(envWith({ YOUTRACK_PROJECT: undefined })), ["YOUTRACK_PROJECT is missing"]);
    assert.deepEqual(problemsFor(envWith({ YOUTRACK_PROJECT: "" })), ["YOUTRACK_PROJECT is missing"]);
  });

  void it("rejects characters that could alter the search query", () => {
    for (const value of ["CUI OTHER", "CUI,OTHER", "{CUI}", "CUI:", "project: CUI", "#CUI", `CU${char(0x00cd)}`]) {
      assert.deepEqual(problemsFor(envWith({ YOUTRACK_PROJECT: value })), [PROJECT_PROBLEM], visible(value));
    }
  });

  void it("rejects Unicode look-alikes and embedded invisible characters", () => {
    const values = [fullwidth("CUI"), "C\nUI", `CU${char(0x0406)}`, `CUI${ZERO_WIDTH_SPACE}`, ARABIC_INDIC_ONE];
    for (const value of values) {
      assert.deepEqual(problemsFor(envWith({ YOUTRACK_PROJECT: value })), [PROJECT_PROBLEM], visible(value));
    }
  });
});

void describe("parseConfig: YOUTRACK_TITLE_PREFIX", () => {
  void it("uses a custom prefix, trimmed", () => {
    const config = parseConfig(envWith({ YOUTRACK_TITLE_PREFIX: "  [ops] " }));

    assert.equal(config.titlePrefix, "[ops]");
  });

  void it("keeps the prefix's case, inner whitespace and non-ASCII characters (surrogate pairs intact)", () => {
    for (const prefix of ["[My Team]", "[team]  x", `${char(0x1f680)} [team]`, `[${char(0x00e9)}quipe]${char(0x1f600)}`]) {
      const config = parseConfig(envWith({ YOUTRACK_TITLE_PREFIX: `${NBSP}${prefix}\t` }));

      assert.equal(config.titlePrefix, prefix, visible(prefix));
    }
  });

  void it("rejects a prefix that is set but empty or whitespace-only", () => {
    for (const value of ["", "   ", `${NBSP}${BOM}`, ALL_TRIMMED_WHITESPACE]) {
      const problems = problemsFor(envWith({ YOUTRACK_TITLE_PREFIX: value }));

      assert.deepEqual(problems, [PREFIX_PROBLEM], visible(value));
    }
  });
});

void describe("parseConfig: MAX_WRITES_PER_RUN", () => {
  const accepted: readonly (readonly [string, number])[] = [
    ...[["0", 0], ["1", 1], ["007", 7], ["010", 10], ["0040", 40]] as const,
    [`${"0".repeat(400)}1`, 1],
    [String(MAX_WRITES_LIMIT), MAX_WRITES_LIMIT],
  ];
  for (const [value, expected] of accepted) {
    void it(`accepts "${value.slice(-8)}" (length ${String(value.length)}) as ${String(expected)}, read as decimal`, () => {
      const config = parseConfig(envWith({ MAX_WRITES_PER_RUN: value }));

      assert.equal(config.maxWritesPerRun, expected);
    });
  }

  void it("keeps an explicit, padded 0 instead of falling back to the default", () => {
    const config = parseConfig(envWith({ MAX_WRITES_PER_RUN: ` 0${LINE_SEPARATOR}` }));

    assert.equal(config.maxWritesPerRun, 0);
  });

  void it("rejects values that are not plain non-negative integers", () => {
    const values = ["", " ", "-1", "+5", "1.5", "1e1", "0x10", "3 0", "abc", "Infinity", "NaN", ARABIC_INDIC_THREE];
    for (const value of values) {
      const problems = problemsFor(envWith({ MAX_WRITES_PER_RUN: value }));

      assert.deepEqual(problems, [MAX_WRITES_PROBLEM], visible(value));
    }
  });

  void it("rejects look-alike digits, signs and separators", () => {
    const values = [fullwidth("30"), "-0", `4${ZERO_WIDTH_SPACE}0`, `4${NBSP}0`, "40.", ".5", "4_0", "4,0", `30${char(0)}`];
    for (const value of values) {
      assert.deepEqual(problemsFor(envWith({ MAX_WRITES_PER_RUN: value })), [MAX_WRITES_PROBLEM], visible(value));
    }
  });

  void it("rejects values above MAX_WRITES_LIMIT, however large or zero-padded", () => {
    const values = [String(MAX_WRITES_LIMIT + 1), "00041", "1000", "9007199254740993", "99999999999999999999999"];
    for (const value of values) {
      assert.deepEqual(problemsFor(envWith({ MAX_WRITES_PER_RUN: value })), [MAX_WRITES_PROBLEM], value);
    }
  });
});

void describe("parseConfig: DRY_RUN", () => {
  const offValues = ["false", "FALSE", "False", " false ", "FALSE ", "\tfAlSe\n", `${NBSP}false${NBSP}`, `${BOM}false`];
  for (const value of [...offValues, `${LINE_SEPARATOR}FALSE${PARAGRAPH_SEPARATOR}`, `${IDEOGRAPHIC_SPACE}False`]) {
    void it(`turns dry-run off for "${visible(value)}"`, () => {
      const config = parseConfig(envWith({ DRY_RUN: value }));

      assert.equal(config.dryRun, false);
    });
  }

  void it('turns dry-run off for every one of the 32 ASCII casings of "false"', () => {
    const casings = Array.from({ length: 32 }, (_, mask) =>
      Array.from("false", (letter, index) => (((mask >> index) & 1) === 1 ? letter.toUpperCase() : letter)).join(""),
    );

    assert.equal(new Set(casings).size, 32);
    for (const value of casings) {
      assert.equal(parseConfig(envWith({ DRY_RUN: value })).dryRun, false, value);
    }
  });

  const onValues = [undefined, "", " ", "true", "0", "no", "off", "f", "falsey", "false false", "\"false\""];
  for (const value of onValues) {
    void it(`keeps dry-run on for ${value === undefined ? "undefined" : JSON.stringify(value)}`, () => {
      const config = parseConfig(envWith({ DRY_RUN: value }));

      assert.equal(config.dryRun, true);
    });
  }

  // Invisible or look-alike characters must never switch real writes on.
  const lookalikes = [
    ...[`false${ZERO_WIDTH_SPACE}`, `${ZERO_WIDTH_SPACE}false`, `fal${char(0x017f)}e`, fullwidth("false")],
    ...[`f${CYRILLIC_SMALL_A}lse`, `false${char(0)}`, "false\n1", "false;", "'false'", "null", "undefined"],
  ];
  for (const value of lookalikes) {
    void it(`keeps dry-run on for the look-alike "${visible(value)}"`, () => {
      const config = parseConfig(envWith({ DRY_RUN: value }));

      assert.equal(config.dryRun, true);
    });
  }

  void it('keeps dry-run on when any letter of "false" is swapped for a Unicode case-mapping hazard', () => {
    // Each maps onto ASCII letters under toUpperCase, toLowerCase or Unicode case folding,
    // e.g. U+017F -> "S", U+FB02 -> "FL", U+212A -> "k", so a /iu regex or toUpperCase() would be unsafe.
    const hazards = [0x00df, 0x017f, 0x0130, 0x0131, 0x1e9a, 0x212a, 0xfb00, 0xfb01, 0xfb02, 0xfb05, 0xfb06].map(char);
    const values = ["false", "FALSE"].flatMap((word) =>
      hazards.flatMap((hazard) => Array.from(word, (_, index) => `${word.slice(0, index)}${hazard}${word.slice(index + 1)}`)),
    );

    for (const value of values) {
      assert.equal(parseConfig(envWith({ DRY_RUN: value })).dryRun, true, visible(value));
    }
  });
});

void describe("ConfigError", () => {
  void it("keeps the problems and joins them into the message", () => {
    const problems = ["A is missing", "B is wrong"];

    const error = new ConfigError(problems);

    assert.ok(error instanceof Error);
    assert.equal(error.name, "ConfigError");
    assert.equal(error.message, "Invalid configuration: A is missing; B is wrong");
    assert.deepEqual(error.problems, problems);
  });
});

void describe("parseConfig: collecting problems", () => {
  void it("reports every missing required key in one ConfigError, in key order", () => {
    const error = captureConfigError({});

    assert.deepEqual(error.problems, MISSING_PROBLEMS);
  });

  void it("combines problems from every invalid key into the error message", () => {
    const env: EnvSource = {
      GITHUB_TOKEN: " ",
      GITHUB_REPO: "owner",
      YOUTRACK_BASE_URL: "http://example.com",
      YOUTRACK_TOKEN: undefined,
      YOUTRACK_PROJECT: "C U I",
      YOUTRACK_TITLE_PREFIX: "",
      MAX_WRITES_PER_RUN: "41",
      DRY_RUN: "false",
    };
    const expectedProblems = [
      "GITHUB_TOKEN is missing",
      REPO_SHAPE_PROBLEM,
      URL_HTTPS_PROBLEM,
      "YOUTRACK_TOKEN is missing",
      PROJECT_PROBLEM,
      PREFIX_PROBLEM,
      MAX_WRITES_PROBLEM,
    ];

    const error = captureConfigError(env);

    assert.equal(error.name, "ConfigError");
    assert.ok(error instanceof Error);
    assert.deepEqual(error.problems, expectedProblems);
    assert.equal(error.message, `Invalid configuration: ${expectedProblems.join("; ")}`);
  });

  void it("flattens keys with several problems in key order when every key is invalid", () => {
    const env: EnvSource = {
      GITHUB_TOKEN: "",
      GITHUB_REPO: "-bad/..",
      YOUTRACK_BASE_URL: "http://user:pw@example.com/?q=1#x",
      YOUTRACK_TOKEN: NBSP,
      YOUTRACK_PROJECT: "C U I",
      YOUTRACK_TITLE_PREFIX: "\t",
      MAX_WRITES_PER_RUN: "-1",
      DRY_RUN: "false",
    };

    const problems = problemsFor(env);

    assert.deepEqual(problems, [
      "GITHUB_TOKEN is missing",
      OWNER_PROBLEM,
      REPO_PROBLEM,
      URL_HTTPS_PROBLEM,
      URL_QUERY_PROBLEM,
      URL_CREDENTIALS_PROBLEM,
      "YOUTRACK_TOKEN is missing",
      PROJECT_PROBLEM,
      PREFIX_PROBLEM,
      MAX_WRITES_PROBLEM,
    ]);
  });

  void it("stays fast and leak-free on very long values, including long runs of slashes", {
    timeout: 5_000,
  }, () => {
    const long = "a".repeat(200_000);
    const slashes = "/".repeat(200_000);
    const env = envWith({
      GITHUB_REPO: `${long}/${long}!`,
      YOUTRACK_BASE_URL: `https://example.com/${long}?`,
      YOUTRACK_PROJECT: `${"-".repeat(200_000)}!`,
      MAX_WRITES_PER_RUN: "9".repeat(200_000),
    });

    const error = captureConfigError(env);
    const trailing = parseConfig(envWith({ YOUTRACK_BASE_URL: `https://example.com/yt${slashes}` }));
    const inner = parseConfig(envWith({ YOUTRACK_BASE_URL: `https://example.com${slashes}x` }));

    assert.deepEqual(error.problems, [OWNER_PROBLEM, REPO_PROBLEM, URL_QUERY_PROBLEM, PROJECT_PROBLEM, MAX_WRITES_PROBLEM]);
    assert.ok(error.message.length < 1_000);
    assert.equal(trailing.youtrackBaseUrl, "https://example.com/yt");
    assert.equal(inner.youtrackBaseUrl, `https://example.com${slashes}x`);
  });
});

// ---------------------------------------------------------------------------
// Fuzzing: seeded, so a failure reproduces from FUZZ_SEED.

const FUZZ_SEED = 0x5eed;
const FUZZ_ROUNDS = 2_000;
const FUZZ_REPLACE_CHANCE = 0.35;
const FUZZ_UNDEFINED_CHANCE = 0.1;
const FUZZ_MAX_FRAGMENTS = 5;

/** Building blocks for fuzzed values: separators, URL syntax, numbers, look-alikes, invisibles, tokens. */
const FUZZ_FRAGMENTS: readonly string[] = [
  ...["", " ", "/", "//", "\\", "?", "#", "@", ":", ".", "..", "-", "_", "%2F", "%40", ",", "{", "}"],
  ...["https://", "http://", "HTTPS:", "example.com", "[::1]", ":443", "user:pw@"],
  ...["false", "FALSE", "true", "0", "40", "41", "-1", "007", "[team]", "a", "Z", "9", "CUI"],
  ...[NBSP, BOM, ZERO_WIDTH_SPACE, LINE_SEPARATOR, "\n", "\t", char(0), char(0xd800), char(0x1f600)],
  ...[char(0x017f), char(0xff0f), fullwidth("CUI"), GITHUB_TOKEN, YOUTRACK_TOKEN],
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

/** Properties every accepted config must have, checked against the raw environment. */
function assertAcceptedConfig(env: EnvSource, config: Config, context: string): void {
  assert.equal(Object.isFrozen(config), true, context);
  assert.equal(config.githubToken, env.GITHUB_TOKEN?.trim(), context);
  assert.equal(config.youtrackToken, env.YOUTRACK_TOKEN?.trim(), context);
  assert.equal(`${config.githubOwner}/${config.githubRepo}`, env.GITHUB_REPO?.trim(), context);
  assert.match(config.youtrackBaseUrl, /^https:\/\/[^/?#@\s]+(?:\/[^?#\s]*[^/?#\s])?$/u, context);
  assert.equal(config.youtrackProject, env.YOUTRACK_PROJECT?.trim(), context);
  assert.match(config.youtrackProject, /^[A-Za-z0-9_-]+$/, context);
  assert.equal(config.titlePrefix, env.YOUTRACK_TITLE_PREFIX?.trim() ?? DEFAULT_TITLE_PREFIX, context);
  assert.notEqual(config.titlePrefix, "", context);
  assert.ok(Number.isSafeInteger(config.maxWritesPerRun), context);
  assert.ok(config.maxWritesPerRun >= 0 && config.maxWritesPerRun <= MAX_WRITES_LIMIT, context);
  // Independent oracle: a regex `i` flag without `u` folds ASCII only, so U+017F never matches "s".
  assert.equal(config.dryRun, !/^false$/i.test(env.DRY_RUN?.trim() ?? ""), context);
}

/** Every problem is a known, value-free message; no duplicates; ordered by ENV_KEYS. */
function assertRejectedConfig(error: ConfigError, context: string): void {
  const keyOrder = error.problems.map((problem) => ENV_KEYS.findIndex((key) => problem.startsWith(`${key} `)));

  assert.ok(error.problems.length > 0, context);
  assert.ok(error.problems.every((problem) => KNOWN_PROBLEMS.has(problem)), context);
  assert.equal(new Set(error.problems).size, error.problems.length, context);
  assert.deepEqual(keyOrder, keyOrder.toSorted((a, b) => a - b), context);
  assert.equal(error.message, `Invalid configuration: ${error.problems.join("; ")}`, context);
}

void describe("parseConfig: fuzzed environments", () => {
  void it("returns a consistent config or throws a ConfigError built only from known messages", () => {
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
