// SYNC_ASSIGNEES (U1) and ASSIGNEE_MAP (U14): the config surface of docs/13, section 3.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ASSIGNEE_MAP_NEVER, DEFAULT_SYNC_ASSIGNEES, parseConfig } from "../../src/config.ts";
import {
  BOM,
  CYRILLIC_SMALL_A,
  EXPECTED_CONFIG,
  LINE_SEPARATOR,
  NBSP,
  REOPEN_CLOSED_BY_PROBLEM,
  SYNC_ASSIGNEES_PROBLEM,
  ZERO_WIDTH_SPACE,
  captureConfigError,
  char,
  envWith,
  fullwidth,
  mapFormProblem,
  mapKeyProblem,
  mapRepeatProblem,
  mapValueProblem,
  problemsFor,
  visible,
} from "./fixtures.ts";

/** Placeholder people (docs/13): never real logins or emails. */
const YOUTRACK_LOGIN = "jdoe123456";
const GITHUB_LOGIN = "JaneDoe123456";
const STAFF_LOGIN = "staffuser";

function mapOf(value: string): ReadonlyMap<string, string | null> {
  return parseConfig(envWith({ ASSIGNEE_MAP: value })).assigneeMap;
}

describe("parseConfig: SYNC_ASSIGNEES", () => {
  it("is on by default", () => {
    assert.equal(DEFAULT_SYNC_ASSIGNEES, true);
    assert.equal(parseConfig(envWith({ SYNC_ASSIGNEES: undefined })).syncAssignees, true);
  });

  const accepted: readonly (readonly [string, boolean])[] = [
    ["true", true],
    ["TRUE", true],
    ["True", true],
    [" true\n", true],
    ["false", false],
    ["False", false],
    [" FALSE ", false],
    ["\tfAlSe\r\n", false],
    [`${NBSP}false${BOM}`, false],
    [`${LINE_SEPARATOR}TRUE`, true],
  ];
  for (const [value, expected] of accepted) {
    it(`reads "${visible(value)}" as ${String(expected)}, trimmed and A-Z case ignored`, () => {
      const config = parseConfig(envWith({ SYNC_ASSIGNEES: value }));

      assert.equal(config.syncAssignees, expected);
    });
  }

  it("rejects a blank value and anything that is not true or false, naming only the key", () => {
    const values = [
      ...["", " ", "\t\n", "no", "yes", "0", "1", "on", "off", "t", "f", "falsey", "true false", '"false"', "'true'"],
      ...[`fal${char(0x017f)}e`, `tru${char(0x0435)}`, fullwidth("true"), `f${CYRILLIC_SMALL_A}lse`],
      ...[`true${ZERO_WIDTH_SPACE}`, `${ZERO_WIDTH_SPACE}false`, `false${char(0)}`, "true\nfalse", "true,"],
    ];
    for (const value of values) {
      assert.deepEqual(problemsFor(envWith({ SYNC_ASSIGNEES: value })), [SYNC_ASSIGNEES_PROBLEM], visible(value));
    }
  });

  it("changes no other field, and never turns DRY_RUN off", () => {
    const config = parseConfig(envWith({ SYNC_ASSIGNEES: "false" }));

    assert.deepEqual(config, { ...EXPECTED_CONFIG, syncAssignees: false });
    assert.equal(config.dryRun, true);
  });

  it("reports its problem after REOPEN_CLOSED_BY's and before ASSIGNEE_MAP's", () => {
    const env = envWith({ REOPEN_CLOSED_BY: "-x", SYNC_ASSIGNEES: "no", ASSIGNEE_MAP: "nope" });

    assert.deepEqual(problemsFor(env), [REOPEN_CLOSED_BY_PROBLEM, SYNC_ASSIGNEES_PROBLEM, mapFormProblem(1)]);
  });
});

describe("parseConfig: ASSIGNEE_MAP, accepted", () => {
  it("is an empty map when unset or blank", () => {
    for (const value of [undefined, "", "  ", "\t\r\n", `${NBSP}${BOM}`, LINE_SEPARATOR]) {
      const config = parseConfig(envWith({ ASSIGNEE_MAP: value }));

      assert.equal(config.assigneeMap.size, 0, value === undefined ? "undefined" : visible(value));
    }
  });

  it("is an empty map when every entry is blank", () => {
    for (const value of [",", ",,,", " , \n , ", "\r\n\r\n", ",\n,\r,"]) {
      assert.equal(mapOf(value).size, 0, visible(value));
    }
  });

  it("reads one entry, keyed by the YouTrack login, the GitHub login as written", () => {
    assert.deepEqual(mapOf(`${YOUTRACK_LOGIN}=${GITHUB_LOGIN}`), new Map([[YOUTRACK_LOGIN, GITHUB_LOGIN]]));
  });

  it("trims each entry and both sides of its =", () => {
    const map = mapOf(` ${YOUTRACK_LOGIN} =\t${GITHUB_LOGIN}${NBSP} `);

    assert.deepEqual(map, new Map([[YOUTRACK_LOGIN, GITHUB_LOGIN]]));
  });

  it("splits entries on commas, line feeds and carriage returns, CRLF included", () => {
    const expected = new Map([
      ["jdoe111111", "JaneDoe111111"],
      ["jdoe222222", "JaneDoe222222"],
      ["jdoe333333", "JaneDoe333333"],
      ["jdoe444444", "JaneDoe444444"],
      ["jdoe555555", null],
    ]);
    const value =
      "jdoe111111=JaneDoe111111,jdoe222222=JaneDoe222222\njdoe333333=JaneDoe333333\r\n" +
      "jdoe444444=JaneDoe444444\rjdoe555555=-";

    assert.deepEqual(mapOf(value), expected);
  });

  it("skips blank entries", () => {
    const map = mapOf(`,, ,\n${YOUTRACK_LOGIN}=${GITHUB_LOGIN},\r\n,${STAFF_LOGIN}=-,`);

    assert.deepEqual(
      map,
      new Map([
        [YOUTRACK_LOGIN, GITHUB_LOGIN],
        [STAFF_LOGIN, null],
      ]),
    );
  });

  it("lowercases A-Z in the key and keeps the GitHub login's case", () => {
    const map = mapOf(`JDoe123456=${GITHUB_LOGIN},STAFFUSER=staffUser`);

    assert.deepEqual(
      map,
      new Map([
        [YOUTRACK_LOGIN, GITHUB_LOGIN],
        [STAFF_LOGIN, "staffUser"],
      ]),
    );
  });

  it("lowercases only A-Z in the key, never other letters (no Unicode case mapping)", () => {
    const kelvin = char(0x212a);
    const dotted = char(0x0130);
    const map = mapOf(`A${kelvin}${dotted}Z=${GITHUB_LOGIN}`);

    assert.deepEqual([...map.keys()], [`a${kelvin}${dotted}z`]);
  });

  it(`reads "${ASSIGNEE_MAP_NEVER}" as null: never assign that person`, () => {
    assert.equal(ASSIGNEE_MAP_NEVER, "-");
    assert.deepEqual(mapOf(`${STAFF_LOGIN} = - `), new Map([[STAFF_LOGIN, null]]));
  });

  it("allows two YouTrack logins to map to the same GitHub login", () => {
    const map = mapOf(`${YOUTRACK_LOGIN}=${GITHUB_LOGIN},jdoe654321=${GITHUB_LOGIN.toLowerCase()}`);

    assert.deepEqual(
      map,
      new Map([
        [YOUTRACK_LOGIN, GITHUB_LOGIN],
        ["jdoe654321", "janedoe123456"],
      ]),
    );
  });

  it("accepts every user login shape GitHub allows, up to 39 characters", () => {
    const logins = ["a", "9", "a-", "a--b", "Jane_Doe", "a".repeat(39), `Z${"-".repeat(38)}`];
    for (const login of logins) {
      assert.deepEqual(mapOf(`${YOUTRACK_LOGIN}=${login}`), new Map([[YOUTRACK_LOGIN, login]]), login);
    }
  });

  it("accepts keys with any non-space characters, such as an email-shaped or dotted login", () => {
    const keys = ["123456@buas.nl", "j.doe", "jdoe_123456", "x", `j${char(0x00e9)}`];
    for (const key of keys) {
      assert.deepEqual(mapOf(`${key}=-`), new Map([[key, null]]), visible(key));
    }
  });

  it("changes no other field, and is parsed when the switch is off too", () => {
    const on = parseConfig(envWith({ ASSIGNEE_MAP: `${YOUTRACK_LOGIN}=${GITHUB_LOGIN}` }));
    const off = parseConfig(envWith({ ASSIGNEE_MAP: `${YOUTRACK_LOGIN}=${GITHUB_LOGIN}`, SYNC_ASSIGNEES: "false" }));
    const assigneeMap = new Map([[YOUTRACK_LOGIN, GITHUB_LOGIN]]);

    assert.deepEqual(on, { ...EXPECTED_CONFIG, assigneeMap });
    assert.deepEqual(off, { ...EXPECTED_CONFIG, assigneeMap, syncAssignees: false });
  });

  it("parses many entries quickly", { timeout: 5_000 }, () => {
    const count = 50_000;
    const value = Array.from({ length: count }, (_, index) => `jdoe${String(index)}=-`).join(",");

    assert.equal(mapOf(value).size, count);
  });
});

describe("parseConfig: ASSIGNEE_MAP, rejected", () => {
  const single: readonly (readonly [string, string, string])[] = [
    ["no =", YOUTRACK_LOGIN, mapFormProblem(1)],
    ["two =", `${YOUTRACK_LOGIN}=${GITHUB_LOGIN}=x`, mapFormProblem(1)],
    ["an empty key", `=${GITHUB_LOGIN}`, mapKeyProblem(1)],
    ["a blank key", ` \t=${GITHUB_LOGIN}`, mapKeyProblem(1)],
    ["a key with a space", `j doe=${GITHUB_LOGIN}`, mapKeyProblem(1)],
    ["a key with a tab", `j\tdoe=${GITHUB_LOGIN}`, mapKeyProblem(1)],
    ["a key with a no-break space", `j${NBSP}doe=${GITHUB_LOGIN}`, mapKeyProblem(1)],
    ["a key with a line separator", `j${LINE_SEPARATOR}doe=${GITHUB_LOGIN}`, mapKeyProblem(1)],
    ["an empty value", `${YOUTRACK_LOGIN}=`, mapValueProblem(1)],
    ["a value with a leading -", `${YOUTRACK_LOGIN}=-${GITHUB_LOGIN}`, mapValueProblem(1)],
    ["a value of two -", `${YOUTRACK_LOGIN}=--`, mapValueProblem(1)],
    ["a value with a leading _", `${YOUTRACK_LOGIN}=_${GITHUB_LOGIN}`, mapValueProblem(1)],
    ["a 40-character value", `${YOUTRACK_LOGIN}=${"a".repeat(40)}`, mapValueProblem(1)],
    ["a [bot] value", `${YOUTRACK_LOGIN}=${GITHUB_LOGIN}[bot]`, mapValueProblem(1)],
    ["the Actions bot", `${YOUTRACK_LOGIN}=github-actions[bot]`, mapValueProblem(1)],
    ["a value with a space", `${YOUTRACK_LOGIN}=Jane Doe`, mapValueProblem(1)],
    ["an email value", `${YOUTRACK_LOGIN}=123456@buas.nl`, mapValueProblem(1)],
    ["a quoted value", `${YOUTRACK_LOGIN}="${GITHUB_LOGIN}"`, mapValueProblem(1)],
    ["an @login value", `${YOUTRACK_LOGIN}=@${GITHUB_LOGIN}`, mapValueProblem(1)],
    ["a fullwidth value", `${YOUTRACK_LOGIN}=${fullwidth("Jane")}`, mapValueProblem(1)],
    ["a Cyrillic look-alike value", `${YOUTRACK_LOGIN}=J${CYRILLIC_SMALL_A}ne`, mapValueProblem(1)],
    ["a zero-width space in the value", `${YOUTRACK_LOGIN}=Jane${ZERO_WIDTH_SPACE}Doe`, mapValueProblem(1)],
    ["a line separator between entries", `a=b${LINE_SEPARATOR}c=d`, mapFormProblem(1)],
  ];
  for (const [name, value, problem] of single) {
    it(`rejects ${name}`, () => {
      assert.deepEqual(problemsFor(envWith({ ASSIGNEE_MAP: value })), [problem], visible(value));
    });
  }

  it("reports both problems of an entry whose key and value are both bad", () => {
    for (const value of ["j doe=-x", "=", " = "]) {
      assert.deepEqual(problemsFor(envWith({ ASSIGNEE_MAP: value })), [mapKeyProblem(1), mapValueProblem(1)], value);
    }
  });

  it("rejects a repeated key in another case, naming both positions", () => {
    const value = `${YOUTRACK_LOGIN}=${GITHUB_LOGIN},${STAFF_LOGIN}=-,JDOE123456=-`;

    assert.deepEqual(problemsFor(envWith({ ASSIGNEE_MAP: value })), [mapRepeatProblem(1, 3)]);
  });

  it("names the first position for every later repeat, even when the values agree", () => {
    const value = `${YOUTRACK_LOGIN}=-,${YOUTRACK_LOGIN}=-,Jdoe123456=${GITHUB_LOGIN}`;

    assert.deepEqual(problemsFor(envWith({ ASSIGNEE_MAP: value })), [mapRepeatProblem(1, 2), mapRepeatProblem(1, 3)]);
  });

  it("counts positions among the non-blank entries only", () => {
    const value = `,\n${YOUTRACK_LOGIN}=${GITHUB_LOGIN},, ,\r\nbroken,\n${YOUTRACK_LOGIN}=-`;

    assert.deepEqual(problemsFor(envWith({ ASSIGNEE_MAP: value })), [mapFormProblem(2), mapRepeatProblem(1, 3)]);
  });

  it("reports every problem of every entry at once, in entry order", () => {
    const value = [
      YOUTRACK_LOGIN,
      `=${GITHUB_LOGIN}`,
      "j doe=-x",
      `${YOUTRACK_LOGIN}=${GITHUB_LOGIN}`,
      `${STAFF_LOGIN}=${"b".repeat(40)}`,
      "JDOE123456=-",
      "a=b=c",
    ].join(",");

    assert.deepEqual(problemsFor(envWith({ ASSIGNEE_MAP: value })), [
      mapFormProblem(1),
      mapKeyProblem(2),
      mapKeyProblem(3),
      mapValueProblem(3),
      mapValueProblem(5),
      mapRepeatProblem(4, 6),
      mapFormProblem(7),
    ]);
  });

  it("is rejected when the switch is off too", () => {
    const env = envWith({ SYNC_ASSIGNEES: "false", ASSIGNEE_MAP: `${YOUTRACK_LOGIN}=-${GITHUB_LOGIN}` });

    assert.deepEqual(problemsFor(env), [mapValueProblem(1)]);
  });

  it("never echoes a key or a value of the map, in any case, in problems, the message or the stack", () => {
    const markers = [YOUTRACK_LOGIN, GITHUB_LOGIN, STAFF_LOGIN, "123456", "buas.nl", "Zq9EchoMarker"];
    const values = [
      YOUTRACK_LOGIN,
      `${YOUTRACK_LOGIN}=${GITHUB_LOGIN}=${STAFF_LOGIN}`,
      `${YOUTRACK_LOGIN} x=${GITHUB_LOGIN}`,
      `${YOUTRACK_LOGIN}=-${GITHUB_LOGIN}`,
      `${YOUTRACK_LOGIN}=${GITHUB_LOGIN}[bot]`,
      `${YOUTRACK_LOGIN}=123456@buas.nl`,
      `${STAFF_LOGIN}=Zq9EchoMarker Zq9EchoMarker`,
      `${YOUTRACK_LOGIN}=${GITHUB_LOGIN},${YOUTRACK_LOGIN.toUpperCase()}=-`,
      `Zq9EchoMarker Zq9EchoMarker=${"Zq9EchoMarker".repeat(4)}`,
    ];
    for (const value of [...values, values.join("\n")]) {
      const error = captureConfigError(envWith({ ASSIGNEE_MAP: value, SYNC_ASSIGNEES: STAFF_LOGIN }));

      assert.ok(error.problems.length > 0);
      for (const text of [error.message, error.stack ?? "", ...error.problems]) {
        for (const marker of markers) {
          assert.equal(text.toLowerCase().includes(marker.toLowerCase()), false, `${marker} in ${text}`);
        }
      }
    }
  });

  it("checks many repeated keys quickly", { timeout: 5_000 }, () => {
    const count = 20_000;
    const value = Array.from({ length: count }, () => `${YOUTRACK_LOGIN}=-`).join("\n");

    const problems = problemsFor(envWith({ ASSIGNEE_MAP: value }));

    assert.equal(problems.length, count - 1);
    assert.equal(problems.at(-1), mapRepeatProblem(1, count));
  });
});
