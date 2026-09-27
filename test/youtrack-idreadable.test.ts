/**
 * Decision R4: every YouTrack row must have idReadable = <project>-<numberInProject>
 * (project prefix case-insensitive, ASCII only); otherwise the run fails.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { JsonObject } from "../src/json.ts";
import {
  ISSUE_FIELDS,
  YouTrackSchemaError,
  fetchProjectIssues,
  parseProjectIssue,
  parseYouTrackIssue,
} from "../src/youtrack.ts";
import {
  NULL_DESCRIPTION_ROW,
  RESOLVED_ROW,
  SOURCE,
  UNRESOLVED_ROW,
  deepFreeze,
  issueRow,
  issueRows,
  numbersOf,
  range,
  schemaError,
  serveBodies,
  skipsOf,
} from "./youtrack-fixtures.ts";

/** The exact R4 error for a row labelled `idReadable` when `expected` was required. */
function mismatchError(idReadable: string, expected: string): { readonly name: string; readonly message: string } {
  return {
    name: "YouTrackSchemaError",
    message:
      `YouTrack issue ${JSON.stringify(idReadable)}: idReadable must be ` +
      `${JSON.stringify(expected)} (<project>-<numberInProject>)`,
  };
}

/** One character from its code point, so every odd character below is named, not invisible. */
function char(codePoint: number): string {
  return String.fromCodePoint(codePoint);
}

describe("parseProjectIssue: matching rows", () => {
  it("returns exactly what parseYouTrackIssue returns for the live CUI rows", () => {
    for (const row of [UNRESOLVED_ROW, RESOLVED_ROW, NULL_DESCRIPTION_ROW]) {
      assert.deepEqual(parseProjectIssue(row, "CUI"), parseYouTrackIssue(row));
    }
  });

  it("returns a new object with exactly the ISSUE_FIELDS keys, without writing to a frozen row", () => {
    // Arrange
    const row = deepFreeze(issueRow(8, { customFields: [{ name: "State" }] }));

    // Act
    const issue = parseProjectIssue(row, "CUI");

    // Assert
    assert.notEqual(issue, row);
    assert.deepEqual(Object.keys(issue), [...ISSUE_FIELDS]);
  });

  const caseVariants: readonly (readonly [string, string])[] = [
    ["cui", "CUI-7"],
    ["CUI", "cui-7"],
    ["Cui", "cUI-7"],
    ["cUi", "CuI-7"],
  ];
  for (const [project, idReadable] of caseVariants) {
    it(`accepts idReadable "${idReadable}" for project "${project}" and keeps the server's spelling`, () => {
      const issue = parseProjectIssue(issueRow(7, { idReadable }), project);

      assert.equal(issue.idReadable, idReadable);
    });
  }

  it("accepts shortNames with digits, underscores and hyphens", () => {
    const cases: readonly (readonly [string, string, number])[] = [
      ["ABC_2-x", "ABC_2-X-5", 5],
      ["MY-PROJ", "my-proj-3", 3],
      ["9LIVES", "9lives-12", 12],
      ["A", "a-1", 1],
    ];
    for (const [project, idReadable, numberInProject] of cases) {
      const issue = parseProjectIssue(issueRow(numberInProject, { idReadable }), project);

      assert.equal(issue.idReadable, idReadable, `${project} / ${idReadable}`);
    }
  });

  it("builds the expected id from the row's numberInProject, up to 2^53 - 1", () => {
    // Arrange
    const numberInProject = Number.MAX_SAFE_INTEGER;
    const row = issueRow(1, { numberInProject, idReadable: `CUI-${String(numberInProject)}` });

    // Act
    const issue = parseProjectIssue(row, "CUI");

    // Assert
    assert.equal(issue.numberInProject, numberInProject);
  });
});

describe("parseProjectIssue: mismatching rows", () => {
  const mismatches: readonly { readonly label: string; readonly idReadable: string }[] = [
    { label: "another project", idReadable: "OTHER-7" },
    { label: "a shorter prefix", idReadable: "CU-7" },
    { label: "a longer prefix", idReadable: "CUII-7" },
    { label: "a prefix with a leading extra letter", idReadable: "XCUI-7" },
    { label: "another number", idReadable: "CUI-8" },
    { label: "a number with an extra digit", idReadable: "CUI-70" },
    { label: "a zero-padded number", idReadable: "CUI-07" },
    { label: "a signed number", idReadable: "CUI-+7" },
    { label: "a decimal number", idReadable: "CUI-7.0" },
    { label: "no separator", idReadable: "CUI7" },
    { label: "a doubled separator", idReadable: "CUI--7" },
    { label: "an underscore separator", idReadable: "CUI_7" },
    { label: "a space separator", idReadable: "CUI 7" },
    { label: "a leading space", idReadable: " CUI-7" },
    { label: "a trailing space", idReadable: "CUI-7 " },
    { label: "a trailing newline", idReadable: "CUI-7\n" },
    { label: "an empty idReadable", idReadable: "" },
    { label: "the number only", idReadable: "7" },
    { label: "the project only", idReadable: "CUI" },
    { label: "an Arabic-Indic digit", idReadable: `CUI-${char(0x0667)}` },
    { label: "a dotless i (U+0131, upper-cases to I)", idReadable: `CU${char(0x0131)}-7` },
    { label: "a dotted capital I (U+0130)", idReadable: `CU${char(0x0130)}-7` },
    { label: "FULLWIDTH letters", idReadable: `${char(0xff23)}${char(0xff35)}${char(0xff29)}-7` },
    { label: "a zero-width space", idReadable: `CUI-${char(0x200b)}7` },
  ];
  for (const { label, idReadable } of mismatches) {
    it(`rejects ${label}, naming both ids`, () => {
      assert.throws(() => parseProjectIssue(issueRow(7, { idReadable }), "CUI"), mismatchError(idReadable, "CUI-7"));
    });
  }

  it("folds ASCII letters only, so Unicode case mappings onto ASCII never match", () => {
    // U+017F (long s) upper-cases to "S"; U+212A (Kelvin sign) lower-cases to "k".
    for (const idReadable of [`A${char(0x017f)}K-1`, `AS${char(0x212a)}-1`]) {
      assert.throws(() => parseProjectIssue(issueRow(1, { idReadable }), "ASK"), mismatchError(idReadable, "ASK-1"));
    }
    assert.equal(parseProjectIssue(issueRow(1, { idReadable: "ask-1" }), "ASK").idReadable, "ask-1");
  });

  it("names the configured project spelling in the expected id", () => {
    assert.throws(() => parseProjectIssue(issueRow(4), "cui-x"), mismatchError("CUI-4", "cui-x-4"));
  });

  it("throws an instance of YouTrackSchemaError", () => {
    assert.throws(
      () => parseProjectIssue(issueRow(2), "OTHER"),
      (error) => {
        assert.ok(error instanceof YouTrackSchemaError);
        assert.equal(error.name, "YouTrackSchemaError");
        return true;
      },
    );
  });

  it("JSON-escapes idReadable so the message stays on one line", () => {
    // Arrange
    const idReadable = 'CUI-6\n[fake] "quoted"';

    // Act + Assert
    assert.throws(
      () => parseProjectIssue(issueRow(6, { idReadable }), "CUI"),
      (error) => {
        assert.ok(error instanceof YouTrackSchemaError);
        assert.doesNotMatch(error.message, /\n/);
        assert.ok(error.message.startsWith('YouTrack issue "CUI-6\\n[fake] \\"quoted\\"": idReadable must be "CUI-6"'));
        return true;
      },
    );
  });

  it("never puts summary or description text into the message", () => {
    // Arrange
    const secret = "SECRET-TEXT-do-not-log";
    const row: JsonObject = issueRow(9, { idReadable: "OTHER-9", summary: secret, description: secret });

    // Act + Assert
    assert.throws(
      () => parseProjectIssue(row, "CUI"),
      (error) => {
        assert.ok(error instanceof YouTrackSchemaError);
        assert.doesNotMatch(error.message, new RegExp(secret));
        return true;
      },
    );
  });

  it("reports a schema problem in the row before the id check", () => {
    assert.throws(
      () => parseProjectIssue(issueRow(7, { idReadable: "OTHER-7", updated: null }), "CUI"),
      schemaError(/^YouTrack issue "OTHER-7": field "updated" must be a safe integer, got null$/),
    );
  });

  it("leaves parseYouTrackIssue itself project-agnostic", () => {
    const issue = parseYouTrackIssue(issueRow(7, { idReadable: "OTHER-7" }));

    assert.equal(issue.idReadable, "OTHER-7");
  });
});

describe("fetchProjectIssues: idReadable check (R4)", () => {
  it("fails the scan at a foreign row on a full page, without fetching the next page", async () => {
    // Arrange
    const page = [...issueRows(1, 50), issueRow(51, { idReadable: "OTHER-51" }), ...issueRows(52, 49)];
    const fake = serveBodies([page, issueRows(101, 1)]);

    // Act + Assert
    await assert.rejects(fetchProjectIssues(fake.http, SOURCE), mismatchError("OTHER-51", "CUI-51"));
    assert.deepEqual(skipsOf(fake.requests), ["0"]);
  });

  it("fails the scan at a mismatching row on a later page", async () => {
    // Arrange
    const fake = serveBodies([issueRows(1, 100), [issueRow(101, { idReadable: "CUI-102" })]]);

    // Act + Assert
    await assert.rejects(fetchProjectIssues(fake.http, SOURCE), mismatchError("CUI-102", "CUI-101"));
    assert.deepEqual(skipsOf(fake.requests), ["0", "100"]);
  });

  it("checks every row, including a repeat that de-duplication would drop", async () => {
    // Arrange
    const fake = serveBodies([[issueRow(1), issueRow(1, { idReadable: "OTHER-1" })]]);

    // Act + Assert
    await assert.rejects(fetchProjectIssues(fake.http, SOURCE), mismatchError("OTHER-1", "CUI-1"));
  });

  it("accepts upper-case ids when the configured project is lower-case", async () => {
    // Arrange
    const fake = serveBodies([issueRows(1, 3)]);

    // Act
    const issues = await fetchProjectIssues(fake.http, { ...SOURCE, project: "cui" });

    // Assert
    assert.deepEqual(numbersOf(issues), range(1, 3));
    assert.equal(
      new URL(fake.requests[0]?.url ?? "").searchParams.get("query"),
      "project: cui sort by: {issue id} asc",
    );
  });

  it("uses the source's project, not a fixed one", async () => {
    // Arrange
    const fake = serveBodies([issueRows(1, 1)]);

    // Act + Assert
    await assert.rejects(
      fetchProjectIssues(fake.http, { ...SOURCE, project: "OTHER" }),
      mismatchError("CUI-1", "OTHER-1"),
    );
  });
});
