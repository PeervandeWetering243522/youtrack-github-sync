import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseJson } from "../src/json.ts";
import type { JsonObject, JsonValue } from "../src/json.ts";
import { ISSUE_FIELDS, YouTrackSchemaError, issueFieldsParam, parseYouTrackIssue, projectQuery } from "../src/youtrack.ts";
import {
  NULL_DESCRIPTION_ROW,
  RESOLVED_ROW,
  UNRESOLVED_ROW,
  deepFreeze,
  issueRow,
  schemaError,
  withoutFields,
} from "./youtrack-fixtures.ts";

// ---------------------------------------------------------------------------
// issueFieldsParam / projectQuery
// ---------------------------------------------------------------------------

describe("issueFieldsParam", () => {
  it("joins ISSUE_FIELDS with commas in declaration order", () => {
    // Act
    const fields = issueFieldsParam();

    // Assert
    assert.equal(fields, "idReadable,numberInProject,summary,description,resolved,updated");
    assert.equal(fields, ISSUE_FIELDS.join(","));
  });
});

describe("projectQuery", () => {
  it("builds the exact project query sorted by issue id ascending", () => {
    assert.equal(projectQuery("CUI"), "project: CUI sort by: {issue id} asc");
  });

  it("interpolates the given project shortName unchanged", () => {
    assert.equal(projectQuery("ABC_2-x"), "project: ABC_2-x sort by: {issue id} asc");
  });
});

// ---------------------------------------------------------------------------
// parseYouTrackIssue
// ---------------------------------------------------------------------------

describe("parseYouTrackIssue", () => {
  it("parses the live unresolved row (CUI-31) and drops $type", () => {
    // Act
    const issue = parseYouTrackIssue(UNRESOLVED_ROW);

    // Assert
    assert.deepEqual(issue, {
      idReadable: "CUI-31",
      numberInProject: 31,
      summary: "[individual] Explore GH-YouTrack integrations",
      description:
        "Probably gonna have Claude draft up a project to use API keys to have ideally bidirectional syncing",
      resolved: null,
      updated: 1790256733345,
    });
  });

  it("parses the live resolved row (CUI-11) with its resolved timestamp", () => {
    // Act
    const issue = parseYouTrackIssue(RESOLVED_ROW);

    // Assert
    assert.equal(issue.idReadable, "CUI-11");
    assert.equal(issue.resolved, 1789644365309);
    assert.equal(issue.updated, 1790254466400);
  });

  it("parses the live row with a null description (CUI-30)", () => {
    // Act
    const issue = parseYouTrackIssue(NULL_DESCRIPTION_ROW);

    // Assert
    assert.equal(issue.description, null);
    assert.equal(issue.resolved, null);
    assert.equal(issue.numberInProject, 30);
  });

  it("accepts an empty-string description", () => {
    // Act
    const issue = parseYouTrackIssue(issueRow(5, { description: "" }));

    // Assert
    assert.equal(issue.description, "");
  });

  it("returns a new object with exactly the ISSUE_FIELDS keys and leaves the input untouched", () => {
    // Arrange
    const row = issueRow(8, { customFields: [{ name: "State" }] });
    const snapshot = structuredClone(row);

    // Act
    const issue = parseYouTrackIssue(row);

    // Assert
    assert.notEqual(issue, row);
    assert.deepEqual(Object.keys(issue), [...ISSUE_FIELDS]);
    assert.deepEqual(row, snapshot);
  });

  for (const field of ISSUE_FIELDS) {
    it(`throws YouTrackSchemaError naming the missing "${field}" field`, () => {
      // Arrange
      const row = withoutFields(issueRow(12), [field]);

      // Act + Assert
      assert.throws(
        () => parseYouTrackIssue(row),
        schemaError(new RegExp(`^YouTrack issue .+ is missing field\\(s\\) "${field}"$`)),
      );
    });
  }

  it("names every missing field at once", () => {
    // Arrange
    const row = withoutFields(issueRow(12), ["summary", "updated"]);

    // Act + Assert
    assert.throws(
      () => parseYouTrackIssue(row),
      schemaError(/^YouTrack issue "CUI-12" is missing field\(s\) "summary", "updated"$/),
    );
  });

  it("throws an instance of YouTrackSchemaError (an Error subclass)", () => {
    assert.throws(() => parseYouTrackIssue(null), (error) => {
      assert.ok(error instanceof YouTrackSchemaError);
      assert.ok(error instanceof Error);
      assert.equal(error.name, "YouTrackSchemaError");
      return true;
    });
  });

  const nonObjectRows: readonly { readonly row: JsonValue; readonly kind: string }[] = [
    { row: null, kind: "null" },
    { row: [issueRow(1)], kind: "array" },
    { row: "CUI-1", kind: "string" },
    { row: 1, kind: "number" },
    { row: true, kind: "boolean" },
  ];
  for (const { row, kind } of nonObjectRows) {
    it(`rejects a row that is a JSON ${kind}`, () => {
      assert.throws(
        () => parseYouTrackIssue(row),
        schemaError(new RegExp(`^YouTrack issue row must be a JSON object, got ${kind}$`)),
      );
    });
  }

  const wrongTypes: readonly {
    readonly field: (typeof ISSUE_FIELDS)[number];
    readonly value: JsonValue;
    readonly expected: string;
    readonly got: string;
  }[] = [
    { field: "idReadable", value: 31, expected: "a string", got: "number" },
    { field: "idReadable", value: null, expected: "a string", got: "null" },
    { field: "summary", value: null, expected: "a string", got: "null" },
    { field: "summary", value: ["x"], expected: "a string", got: "array" },
    { field: "numberInProject", value: "31", expected: "a positive safe integer", got: "string" },
    { field: "numberInProject", value: 31.5, expected: "a positive safe integer", got: "non-safe-integer number" },
    { field: "numberInProject", value: null, expected: "a positive safe integer", got: "null" },
    { field: "updated", value: 2 ** 53, expected: "a safe integer", got: "non-safe-integer number" },
    { field: "updated", value: "1790256733345", expected: "a safe integer", got: "string" },
    { field: "updated", value: null, expected: "a safe integer", got: "null" },
    { field: "resolved", value: true, expected: "a safe integer or null", got: "boolean" },
    { field: "resolved", value: 1.5, expected: "a safe integer or null", got: "non-safe-integer number" },
    { field: "resolved", value: "1789644365309", expected: "a safe integer or null", got: "string" },
    { field: "description", value: 42, expected: "a string or null", got: "number" },
    { field: "description", value: { text: "x" }, expected: "a string or null", got: "object" },
    { field: "description", value: false, expected: "a string or null", got: "boolean" },
    // "non-positive integer" is only meaningful for numberInProject; elsewhere a 0 is just a number.
    { field: "idReadable", value: 0, expected: "a string", got: "number" },
    { field: "summary", value: -1, expected: "a string", got: "number" },
    { field: "description", value: 0, expected: "a string or null", got: "number" },
    { field: "numberInProject", value: 2 ** 53, expected: "a positive safe integer", got: "non-safe-integer number" },
    { field: "numberInProject", value: -1.5, expected: "a positive safe integer", got: "non-safe-integer number" },
    { field: "numberInProject", value: false, expected: "a positive safe integer", got: "boolean" },
    { field: "updated", value: { at: 1 }, expected: "a safe integer", got: "object" },
    { field: "resolved", value: [1789644365309], expected: "a safe integer or null", got: "array" },
  ];
  for (const { field, value, expected, got } of wrongTypes) {
    it(`rejects ${field} = ${JSON.stringify(value)}`, () => {
      // Arrange
      const row = issueRow(7, { [field]: value });

      // Act + Assert
      assert.throws(
        () => parseYouTrackIssue(row),
        schemaError(new RegExp(`: field "${field}" must be ${expected}, got ${got}$`)),
      );
    });
  }

  it("labels errors with the row's idReadable", () => {
    assert.throws(
      () => parseYouTrackIssue(issueRow(7, { updated: null })),
      schemaError(/^YouTrack issue "CUI-7": field "updated"/),
    );
  });

  it("falls back to numberInProject in the label when idReadable is unusable", () => {
    assert.throws(
      () => parseYouTrackIssue(issueRow(7, { idReadable: 7 })),
      schemaError(/^YouTrack issue numberInProject=7: field "idReadable" must be a string, got number$/),
    );
  });

  it("uses a generic label when neither identifier is usable", () => {
    assert.throws(
      () => parseYouTrackIssue(issueRow(7, { idReadable: null, numberInProject: null })),
      schemaError(/^YouTrack issue row: field "idReadable"/),
    );
  });

  it("never puts description or summary text into error messages", () => {
    // Arrange
    const secret = "SECRET-TEXT-do-not-log";
    const rows: readonly JsonObject[] = [
      withoutFields(issueRow(9, { description: secret, summary: secret }), ["updated"]),
      issueRow(9, { description: secret, summary: secret, resolved: "yes" }),
      issueRow(9, { description: secret, numberInProject: "9" }),
      issueRow(9, { description: { text: secret }, summary: secret }),
    ];

    // Act + Assert
    for (const row of rows) {
      assert.throws(() => parseYouTrackIssue(row), (error) => {
        assert.ok(error instanceof YouTrackSchemaError);
        assert.doesNotMatch(error.message, new RegExp(secret));
        return true;
      });
    }
  });

  // [YT-0] / [YT--3] titles are never read back by parseMirrorTitle (positive only),
  // so accepting these would create a new duplicate mirror on every run.
  const nonPositiveNumbers: readonly { readonly label: string; readonly value: number }[] = [
    { label: "0", value: 0 },
    { label: "-0", value: -0 },
    { label: "-3", value: -3 },
    { label: "-(2^53 - 1)", value: -Number.MAX_SAFE_INTEGER },
  ];
  for (const { label, value } of nonPositiveNumbers) {
    it(`rejects the non-positive numberInProject ${label}`, () => {
      assert.throws(
        () => parseYouTrackIssue(issueRow(3, { numberInProject: value })),
        schemaError(
          /^YouTrack issue "CUI-3": field "numberInProject" must be a positive safe integer, got non-positive integer$/,
        ),
      );
    });
  }

  it("rejects a non-positive numberInProject that arrives as JSON text", () => {
    // Arrange
    const row = parseJson(
      '{"idReadable":"CUI-0","numberInProject":-0,"summary":"s","description":null,"resolved":null,"updated":1}',
    );

    // Act + Assert
    assert.throws(() => parseYouTrackIssue(row), schemaError(/field "numberInProject" must be a positive/));
  });

  it("accepts the integer boundaries: numberInProject 1 and 2^53 - 1 timestamps", () => {
    // Act
    const first = parseYouTrackIssue(issueRow(1));
    const largest = parseYouTrackIssue(
      issueRow(2, {
        numberInProject: Number.MAX_SAFE_INTEGER,
        updated: Number.MAX_SAFE_INTEGER,
        resolved: Number.MAX_SAFE_INTEGER,
      }),
    );

    // Assert
    assert.equal(first.numberInProject, 1);
    assert.equal(largest.numberInProject, Number.MAX_SAFE_INTEGER);
    assert.equal(largest.updated, Number.MAX_SAFE_INTEGER);
    assert.equal(largest.resolved, Number.MAX_SAFE_INTEGER);
  });

  it("rejects a resolved timestamp just past the negative safe-integer range", () => {
    assert.throws(
      () => parseYouTrackIssue(issueRow(4, { resolved: -(2 ** 53) })),
      schemaError(/field "resolved" must be a safe integer or null, got non-safe-integer number$/),
    );
  });

  it("reports a missing field before any wrong type in the same row", () => {
    // Arrange
    const row = withoutFields(issueRow(4, { idReadable: 4, resolved: "never" }), ["updated"]);

    // Act + Assert
    assert.throws(
      () => parseYouTrackIssue(row),
      schemaError(/^YouTrack issue numberInProject=4 is missing field\(s\) "updated"$/),
    );
  });

  it("reports the first wrong field in ISSUE_FIELDS order", () => {
    assert.throws(
      () => parseYouTrackIssue(issueRow(4, { updated: "later", summary: 5 })),
      schemaError(/^YouTrack issue "CUI-4": field "summary" must be a string, got number$/),
    );
  });

  it("JSON-escapes the idReadable label so it cannot forge log lines", () => {
    // Arrange
    const row = issueRow(6, { idReadable: 'CUI-6\n[fake] "quoted"', resolved: "x" });

    // Act + Assert
    assert.throws(() => parseYouTrackIssue(row), (error) => {
      assert.ok(error instanceof YouTrackSchemaError);
      assert.doesNotMatch(error.message, /\n/);
      assert.ok(error.message.startsWith('YouTrack issue "CUI-6\\n[fake] \\"quoted\\"": field "resolved"'));
      return true;
    });
  });

  it("does not accept a field supplied only through a JSON __proto__ key", () => {
    // Arrange: JSON.parse makes "__proto__" an own key, so "summary" is really absent.
    const row = parseJson(
      '{"__proto__":{"summary":"inherited?"},"idReadable":"CUI-2","numberInProject":2,' +
        '"description":null,"resolved":null,"updated":1}',
    );

    // Act + Assert
    assert.throws(
      () => parseYouTrackIssue(row),
      schemaError(/^YouTrack issue "CUI-2" is missing field\(s\) "summary"$/),
    );
  });

  it("drops a JSON __proto__ key and returns a plain object", () => {
    // Arrange
    const row = parseJson(
      '{"__proto__":{"polluted":true},"idReadable":"CUI-2","numberInProject":2,"summary":"s",' +
        '"description":null,"resolved":null,"updated":1}',
    );

    // Act
    const issue = parseYouTrackIssue(row);

    // Assert
    assert.equal(Object.getPrototypeOf(issue), Object.prototype);
    assert.deepEqual(Object.keys(issue), [...ISSUE_FIELDS]);
    assert.equal("polluted" in issue, false);
  });

  it("parses a deep-frozen row without writing to it", () => {
    // Arrange
    const row = deepFreeze(issueRow(10, { description: "text", resolved: 1789644365309 }));

    // Act
    const issue = parseYouTrackIssue(row);

    // Assert
    assert.equal(issue.description, "text");
    assert.equal(issue.resolved, 1789644365309);
  });
});
