import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_WRITES_LIMIT, parseConfig } from "../../src/config.ts";
import {
  ARABIC_INDIC_THREE,
  BOM,
  CYRILLIC_SMALL_A,
  EXPECTED_CONFIG,
  IDEOGRAPHIC_SPACE,
  LINE_SEPARATOR,
  MAX_WRITES_PROBLEM,
  NBSP,
  PARAGRAPH_SEPARATOR,
  PROJECT_PROBLEM,
  REOPEN_CLOSED_BY_PROBLEM,
  REPO_SHAPE_PROBLEM,
  ZERO_WIDTH_SPACE,
  char,
  envWith,
  fullwidth,
  problemsFor,
  visible,
} from "./fixtures.ts";

describe("parseConfig: MAX_WRITES_PER_RUN", () => {
  const accepted: readonly (readonly [string, number])[] = [
    ...([
      ["0", 0],
      ["1", 1],
      ["007", 7],
      ["010", 10],
      ["0040", 40],
    ] as const),
    [`${"0".repeat(400)}1`, 1],
    [String(MAX_WRITES_LIMIT), MAX_WRITES_LIMIT],
  ];
  for (const [value, expected] of accepted) {
    it(`accepts "${value.slice(-8)}" (length ${String(value.length)}) as ${String(expected)}, read as decimal`, () => {
      const config = parseConfig(envWith({ MAX_WRITES_PER_RUN: value }));

      assert.equal(config.maxWritesPerRun, expected);
    });
  }

  it("keeps an explicit, padded 0 instead of falling back to the default", () => {
    const config = parseConfig(envWith({ MAX_WRITES_PER_RUN: ` 0${LINE_SEPARATOR}` }));

    assert.equal(config.maxWritesPerRun, 0);
  });

  it("rejects values that are not plain non-negative integers", () => {
    const values = ["", " ", "-1", "+5", "1.5", "1e1", "0x10", "3 0", "abc", "Infinity", "NaN", ARABIC_INDIC_THREE];
    for (const value of values) {
      const problems = problemsFor(envWith({ MAX_WRITES_PER_RUN: value }));

      assert.deepEqual(problems, [MAX_WRITES_PROBLEM], visible(value));
    }
  });

  it("rejects look-alike digits, signs and separators", () => {
    const values = [
      fullwidth("30"),
      "-0",
      `4${ZERO_WIDTH_SPACE}0`,
      `4${NBSP}0`,
      "40.",
      ".5",
      "4_0",
      "4,0",
      `30${char(0)}`,
    ];
    for (const value of values) {
      assert.deepEqual(problemsFor(envWith({ MAX_WRITES_PER_RUN: value })), [MAX_WRITES_PROBLEM], visible(value));
    }
  });

  it("rejects values above MAX_WRITES_LIMIT, however large or zero-padded", () => {
    const values = [String(MAX_WRITES_LIMIT + 1), "00041", "1000", "9007199254740993", "99999999999999999999999"];
    for (const value of values) {
      assert.deepEqual(problemsFor(envWith({ MAX_WRITES_PER_RUN: value })), [MAX_WRITES_PROBLEM], value);
    }
  });
});

describe("parseConfig: DRY_RUN", () => {
  const offValues = ["false", "FALSE", "False", " false ", "FALSE ", "\tfAlSe\n", `${NBSP}false${NBSP}`, `${BOM}false`];
  for (const value of [...offValues, `${LINE_SEPARATOR}FALSE${PARAGRAPH_SEPARATOR}`, `${IDEOGRAPHIC_SPACE}False`]) {
    it(`turns dry-run off for "${visible(value)}"`, () => {
      const config = parseConfig(envWith({ DRY_RUN: value }));

      assert.equal(config.dryRun, false);
    });
  }

  it('turns dry-run off for every one of the 32 ASCII casings of "false"', () => {
    const casings = Array.from({ length: 32 }, (_, mask) =>
      Array.from("false", (letter, index) => (((mask >> index) & 1) === 1 ? letter.toUpperCase() : letter)).join(""),
    );

    assert.equal(new Set(casings).size, 32);
    for (const value of casings) {
      assert.equal(parseConfig(envWith({ DRY_RUN: value })).dryRun, false, value);
    }
  });

  const onValues = [undefined, "", " ", "true", "0", "no", "off", "f", "falsey", "false false", '"false"'];
  for (const value of onValues) {
    it(`keeps dry-run on for ${value === undefined ? "undefined" : JSON.stringify(value)}`, () => {
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
    it(`keeps dry-run on for the look-alike "${visible(value)}"`, () => {
      const config = parseConfig(envWith({ DRY_RUN: value }));

      assert.equal(config.dryRun, true);
    });
  }

  it('keeps dry-run on when any letter of "false" is swapped for a Unicode case-mapping hazard', () => {
    // Each maps onto ASCII letters under toUpperCase, toLowerCase or Unicode case folding,
    // e.g. U+017F -> "S", U+FB02 -> "FL", U+212A -> "k", so a /iu regex or toUpperCase() would be unsafe.
    const hazards = [0x00df, 0x017f, 0x0130, 0x0131, 0x1e9a, 0x212a, 0xfb00, 0xfb01, 0xfb02, 0xfb05, 0xfb06].map(char);
    const values = ["false", "FALSE"].flatMap((word) =>
      hazards.flatMap((hazard) =>
        Array.from(word, (_, index) => `${word.slice(0, index)}${hazard}${word.slice(index + 1)}`),
      ),
    );

    for (const value of values) {
      assert.equal(parseConfig(envWith({ DRY_RUN: value })).dryRun, true, visible(value));
    }
  });
});

describe("parseConfig: REOPEN_CLOSED_BY", () => {
  const offValues = [undefined, "", "  ", "\t\n", `${NBSP}${BOM}`, LINE_SEPARATOR];
  for (const value of offValues) {
    it(`turns reopening off (null) for ${value === undefined ? "undefined" : `"${visible(value)}"`}`, () => {
      const config = parseConfig(envWith({ REOPEN_CLOSED_BY: value }));

      assert.equal(config.reopenClosedBy, null);
    });
  }

  const accepted: readonly (readonly [string, string])[] = [
    ["github-actions[bot]", "github-actions[bot]"],
    ["some-user", "some-user"],
    ["My-Bot[bot]", "My-Bot[bot]"],
    [" github-actions[bot]\n", "github-actions[bot]"],
    [`${NBSP}Some-User\t`, "Some-User"],
    ["a", "a"],
    ["9", "9"],
    ["a-", "a-"],
    ["a--b", "a--b"],
    ["a".repeat(39), "a".repeat(39)],
    [`${"b".repeat(39)}[bot]`, `${"b".repeat(39)}[bot]`],
    // Enterprise Managed Users logins have an underscore; GitHub compares logins case-insensitively.
    ["octocat_acme", "octocat_acme"],
    ["GitHub-Actions[BOT]", "GitHub-Actions[BOT]"],
  ];
  for (const [value, expected] of accepted) {
    it(`accepts "${visible(value).slice(0, 48)}" as the login "${expected.slice(0, 48)}", trimmed and case kept`, () => {
      const config = parseConfig(envWith({ REOPEN_CLOSED_BY: value }));

      assert.equal(config.reopenClosedBy, expected);
    });
  }

  it("rejects values that are not a GitHub login, naming only the key", () => {
    const values = [
      ...["a b", "-x", "-", "x[bot]extra", "[bot]", "x[bot][bot]", "x[bot", "xbot]", "x[ bot]", "x [bot]"],
      ...["a".repeat(40), `${"a".repeat(40)}[bot]`, "user@example.com", "owner/repo", "_x", "x.y", "@user"],
      ...["github-actions[bot],other", "github-actions[bot]\nother", `user${char(0)}`, '"github-actions[bot]"'],
    ];
    for (const value of values) {
      assert.deepEqual(problemsFor(envWith({ REOPEN_CLOSED_BY: value })), [REOPEN_CLOSED_BY_PROBLEM], visible(value));
    }
  });

  it("rejects non-ASCII look-alikes and invisible characters inside the login", () => {
    const values = [
      fullwidth("github-actions"),
      `user${fullwidth("bot")}`,
      `github-${CYRILLIC_SMALL_A}ctions[bot]`,
      `github-actions${fullwidth("[bot]")}`,
      `git${ZERO_WIDTH_SPACE}hub`,
      `some${NBSP}user`,
      `some${char(0x2010)}user`,
      `us${char(0x00e9)}r`,
      `user${ARABIC_INDIC_THREE}`,
      `kelvin${char(0x212a)}`,
      `user${BOM}name`,
    ];
    for (const value of values) {
      assert.deepEqual(problemsFor(envWith({ REOPEN_CLOSED_BY: value })), [REOPEN_CLOSED_BY_PROBLEM], visible(value));
    }
  });

  it("reports its problem after the other keys' problems, without echoing the value", () => {
    const marker = "Zq9EchoMarker";
    const env = envWith({ GITHUB_REPO: "owner", YOUTRACK_PROJECT: "C U I", REOPEN_CLOSED_BY: `${marker} ${marker}` });

    const problems = problemsFor(env);

    assert.deepEqual(problems, [REPO_SHAPE_PROBLEM, PROJECT_PROBLEM, REOPEN_CLOSED_BY_PROBLEM]);
    for (const problem of problems) {
      assert.equal(problem.toLowerCase().includes(marker.toLowerCase()), false, problem);
    }
  });

  it("reports its problem together with MAX_WRITES_PER_RUN, in key order", () => {
    const problems = problemsFor(envWith({ MAX_WRITES_PER_RUN: "41", REOPEN_CLOSED_BY: "-x" }));

    assert.deepEqual(problems, [MAX_WRITES_PROBLEM, REOPEN_CLOSED_BY_PROBLEM]);
  });

  it("changes no other field, and never turns DRY_RUN off", () => {
    const config = parseConfig(envWith({ REOPEN_CLOSED_BY: "github-actions[bot]" }));

    assert.deepEqual(config, { ...EXPECTED_CONFIG, reopenClosedBy: "github-actions[bot]" });
    assert.equal(config.dryRun, true);
  });
});
