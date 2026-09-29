import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ConfigError,
  DEFAULT_EXCLUDE_PREFIX,
  DEFAULT_MAX_WRITES_PER_RUN,
  ENV_KEYS,
  parseConfig,
  type EnvSource,
} from "../../src/config.ts";
import {
  ALL_TRIMMED_WHITESPACE,
  BOM,
  CYRILLIC_SMALL_A,
  EXPECTED_CONFIG,
  GITHUB_TOKEN,
  GITHUB_TOKEN_PROBLEM,
  LINE_SEPARATOR,
  MAX_WRITES_PROBLEM,
  MISSING_PROBLEMS,
  NBSP,
  OWNER_PROBLEM,
  PREFIX_PROBLEM,
  PROJECT_PROBLEM,
  REPO_PROBLEM,
  REPO_SHAPE_PROBLEM,
  URL_CREDENTIALS_PROBLEM,
  URL_HTTPS_PROBLEM,
  URL_QUERY_PROBLEM,
  VALID_ENV,
  YOUTRACK_TOKEN,
  YOUTRACK_TOKEN_PROBLEM,
  ZERO_WIDTH_SPACE,
  captureConfigError,
  char,
  envWith,
  fullwidth,
  problemsFor,
  visible,
} from "./fixtures.ts";

const TOKEN_KEYS = ["GITHUB_TOKEN", "YOUTRACK_TOKEN"] as const;
const TOKEN_PROBLEMS = { GITHUB_TOKEN: GITHUB_TOKEN_PROBLEM, YOUTRACK_TOKEN: YOUTRACK_TOKEN_PROBLEM } as const;

describe("parseConfig: valid environment", () => {
  it("builds the full config from a complete environment", () => {
    const config = parseConfig(VALID_ENV);

    assert.deepEqual(config, EXPECTED_CONFIG);
  });

  it("returns a frozen config that refuses writes at runtime", () => {
    const config = parseConfig(VALID_ENV);

    const didWrite = Reflect.set(config, "dryRun", false);

    assert.equal(Object.isFrozen(config), true);
    assert.equal(didWrite, false);
    assert.equal(config.dryRun, true);
  });

  it("leaves frozen and mutable input environments unchanged", () => {
    const frozenEnv = Object.freeze({ ...VALID_ENV });
    const mutableEnv: EnvSource = {
      ...VALID_ENV,
      GITHUB_REPO: " owner/repo ",
      MAX_WRITES_PER_RUN: " 007 ",
      DRY_RUN: " FALSE ",
    };
    const snapshots = [{ ...frozenEnv }, { ...mutableEnv }];

    parseConfig(frozenEnv);
    parseConfig(mutableEnv);

    assert.deepEqual([frozenEnv, mutableEnv], snapshots);
  });

  it("gives identical results on repeated calls (no hidden state such as a regex lastIndex)", () => {
    const invalidEnv = envWith({ GITHUB_REPO: "-bad/..", YOUTRACK_PROJECT: "C U I", MAX_WRITES_PER_RUN: "41" });

    for (let round = 0; round < 3; round += 1) {
      assert.deepEqual(parseConfig(VALID_ENV), EXPECTED_CONFIG);
      assert.deepEqual(problemsFor(invalidEnv), [OWNER_PROBLEM, REPO_PROBLEM, PROJECT_PROBLEM, MAX_WRITES_PROBLEM]);
    }
  });

  it("strips every trimmable whitespace character (ASCII and Unicode) from both ends of every value", () => {
    const env = Object.fromEntries(
      ENV_KEYS.map((key) => [key, `${ALL_TRIMMED_WHITESPACE}${VALID_ENV[key] ?? ""}${ALL_TRIMMED_WHITESPACE}`]),
    );

    const config = parseConfig(env);

    assert.deepEqual(config, EXPECTED_CONFIG);
  });

  it("applies defaults when optional keys are absent or explicitly undefined", () => {
    const requiredOnly: EnvSource = {
      GITHUB_TOKEN,
      GITHUB_REPO: VALID_ENV.GITHUB_REPO,
      YOUTRACK_BASE_URL: VALID_ENV.YOUTRACK_BASE_URL,
      YOUTRACK_TOKEN,
      YOUTRACK_PROJECT: VALID_ENV.YOUTRACK_PROJECT,
    };
    const explicitUndefined = envWith({
      YOUTRACK_EXCLUDE_PREFIX: undefined,
      MAX_WRITES_PER_RUN: undefined,
      DRY_RUN: undefined,
    });
    const expected = {
      ...EXPECTED_CONFIG,
      excludePrefix: DEFAULT_EXCLUDE_PREFIX,
      maxWritesPerRun: DEFAULT_MAX_WRITES_PER_RUN,
    };

    assert.deepEqual(parseConfig(requiredOnly), expected);
    assert.deepEqual(parseConfig(explicitUndefined), expected);
  });
});

describe("parseConfig: tokens", () => {
  for (const key of TOKEN_KEYS) {
    it(`reports ${key} as missing when absent, empty or whitespace-only`, () => {
      for (const blank of [undefined, "", "   ", "\t\n"]) {
        const problems = problemsFor(envWith({ [key]: blank }));

        assert.deepEqual(problems, [`${key} is missing`]);
      }
    });
  }

  it("treats a value made of every trimmable whitespace character as blank, for every key", () => {
    const env = Object.fromEntries(ENV_KEYS.map((key) => [key, ALL_TRIMMED_WHITESPACE]));

    const error = captureConfigError(env);

    assert.deepEqual(error.problems, [...MISSING_PROBLEMS, PREFIX_PROBLEM, MAX_WRITES_PROBLEM]);
  });

  it("never echoes token values, even when pasted into the wrong variable", () => {
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

  it("never echoes any configured value, in any casing, in problems or the message", () => {
    const marker = "Zq9EchoMarker";
    const leakyEnvs: readonly EnvSource[] = [
      envWith({ GITHUB_TOKEN: `${marker} ${marker}` }),
      envWith({ YOUTRACK_TOKEN: `${marker}\n${marker}${char(0x00e9)}` }),
      envWith({ GITHUB_REPO: marker }),
      envWith({ GITHUB_REPO: `${marker}!/${marker}!` }),
      envWith({ YOUTRACK_BASE_URL: `${marker} is not a url` }),
      envWith({ YOUTRACK_BASE_URL: `http://${marker}:${marker}@example.com/${marker}?${marker}#${marker}` }),
      envWith({ YOUTRACK_PROJECT: `${marker} OR project: X` }),
      envWith({ YOUTRACK_PROJECT: `-${marker}` }),
      envWith({ YOUTRACK_EXCLUDE_PREFIX: " ", MAX_WRITES_PER_RUN: marker }),
    ];

    for (const env of leakyEnvs) {
      const error = captureConfigError(env);

      assert.ok(error.problems.length > 0);
      for (const text of [error.message, error.stack ?? "", ...error.problems]) {
        assert.equal(text.toLowerCase().includes(marker.toLowerCase()), false, text);
      }
    }
  });

  it("accepts every printable ASCII character, verbatim, in both tokens", () => {
    const everyPrintable = Array.from({ length: 0x7e - 0x21 + 1 }, (_, offset) => char(0x21 + offset)).join("");

    const config = parseConfig(envWith({ GITHUB_TOKEN: everyPrintable, YOUTRACK_TOKEN: everyPrintable }));

    assert.equal(everyPrintable.length, 94);
    assert.equal(config.githubToken, everyPrintable);
    assert.equal(config.youtrackToken, everyPrintable);
  });

  it("accepts real token formats and trims a Windows line ending", () => {
    const tokens = [
      `ghp_${"A1b2".repeat(9)}`,
      `github_pat_11AB_${"x".repeat(20)}`,
      "perm-cm9vdA==.dG9r+ZW4=.rNZ38ije7uiW",
    ];
    for (const token of tokens) {
      const config = parseConfig(envWith({ GITHUB_TOKEN: `${token}\r\n`, YOUTRACK_TOKEN: ` ${token}\r` }));

      assert.equal(config.githubToken, token);
      assert.equal(config.youtrackToken, token);
    }
  });

  const whitespaceAndControl = [
    ...["tok en", "tok\ten", "tok\ren", "tok\nen", "tok\r\nen", "Bearer abc123", "abc\u000bdef", "abc\u000cdef"],
    ...[`tok${char(0)}en`, `tok${char(0x1b)}en`, `tok${char(0x7f)}en`, `tok${char(0x85)}en`],
    ...[`tok${NBSP}en`, `tok${ZERO_WIDTH_SPACE}en`, `tok${LINE_SEPARATOR}en`, `tok${BOM}en`],
  ];
  const nonAscii = [
    `tok${char(0x00e9)}n`,
    fullwidth("token"),
    `t${CYRILLIC_SMALL_A}ken`,
    `token${char(0x1f511)}`,
    `token${char(0xd800)}`,
    `${char(0x00ff)}token`,
  ];
  for (const key of TOKEN_KEYS) {
    it(`rejects ${key} with inner whitespace or control characters, naming only the key`, () => {
      for (const value of whitespaceAndControl) {
        assert.deepEqual(problemsFor(envWith({ [key]: value })), [TOKEN_PROBLEMS[key]], visible(value));
      }
    });

    it(`rejects ${key} with non-ASCII characters, naming only the key`, () => {
      for (const value of nonAscii) {
        assert.deepEqual(problemsFor(envWith({ [key]: value })), [TOKEN_PROBLEMS[key]], visible(value));
      }
    });
  }

  it("reports both token problems in key order among the other problems, without either value", () => {
    const env = envWith({ GITHUB_TOKEN: "gh secret", GITHUB_REPO: "owner", YOUTRACK_TOKEN: "yt\tsecret" });

    const error = captureConfigError(env);

    assert.deepEqual(error.problems, [GITHUB_TOKEN_PROBLEM, REPO_SHAPE_PROBLEM, YOUTRACK_TOKEN_PROBLEM]);
    for (const text of [error.message, error.stack ?? "", ...error.problems]) {
      assert.equal(text.includes("secret"), false, text);
    }
  });

  it("checks very long tokens quickly", { timeout: 5_000 }, () => {
    const long = "a".repeat(200_000);

    const config = parseConfig(envWith({ GITHUB_TOKEN: long }));
    const problems = problemsFor(envWith({ YOUTRACK_TOKEN: `${long} ${long}` }));

    assert.equal(config.githubToken, long);
    assert.deepEqual(problems, [YOUTRACK_TOKEN_PROBLEM]);
  });
});

describe("ConfigError", () => {
  it("keeps the problems and joins them into the message", () => {
    const problems = ["A is missing", "B is wrong"];

    const error = new ConfigError(problems);

    assert.ok(error instanceof Error);
    assert.equal(error.name, "ConfigError");
    assert.equal(error.message, "Invalid configuration: A is missing; B is wrong");
    assert.deepEqual(error.problems, problems);
  });
});

describe("parseConfig: collecting problems", () => {
  it("reports every missing required key in one ConfigError, in key order", () => {
    const error = captureConfigError({});

    assert.deepEqual(error.problems, MISSING_PROBLEMS);
  });

  it("combines problems from every invalid key into the error message", () => {
    const env: EnvSource = {
      GITHUB_TOKEN: " ",
      GITHUB_REPO: "owner",
      YOUTRACK_BASE_URL: "http://example.com",
      YOUTRACK_TOKEN: undefined,
      YOUTRACK_PROJECT: "C U I",
      YOUTRACK_EXCLUDE_PREFIX: "",
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

  it("flattens keys with several problems in key order when every key is invalid", () => {
    const env: EnvSource = {
      GITHUB_TOKEN: "",
      GITHUB_REPO: "-bad/..",
      YOUTRACK_BASE_URL: "http://user:pw@example.com/?q=1#x",
      YOUTRACK_TOKEN: NBSP,
      YOUTRACK_PROJECT: "C U I",
      YOUTRACK_EXCLUDE_PREFIX: "\t",
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

  it(
    "stays fast and leak-free on very long values, including long runs of slashes",
    {
      timeout: 5_000,
    },
    () => {
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

      assert.deepEqual(error.problems, [
        OWNER_PROBLEM,
        REPO_PROBLEM,
        URL_QUERY_PROBLEM,
        PROJECT_PROBLEM,
        MAX_WRITES_PROBLEM,
      ]);
      assert.ok(error.message.length < 1_000);
      assert.equal(trailing.youtrackBaseUrl, "https://example.com/yt");
      assert.equal(inner.youtrackBaseUrl, `https://example.com${slashes}x`);
    },
  );
});
