/**
 * Edge cases for the hierarchy fields of a YouTrack row (docs/11 step 2): counts above the
 * limits, the order of hierarchy errors, keys smuggled under an own `__proto__` key of a
 * JSON body, and values the reader passes through for the hierarchy step to judge.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseJson } from "../src/json.ts";
import type { JsonValue } from "../src/json.ts";
import { YouTrackSchemaError, parseProjectIssue, parseYouTrackIssue } from "../src/youtrack.ts";
import { issueRow, parentLink, typeField } from "./youtrack-fixtures.ts";

/** Asserts that parsing `row` throws the exact YouTrackSchemaError for field `path` of CUI-7. */
function assertFieldError(row: JsonValue, path: string, requirement: string, got: string): void {
  assert.throws(() => parseYouTrackIssue(row), {
    name: "YouTrackSchemaError",
    message: `YouTrack issue "CUI-7": field "${path}" must ${requirement}, got ${got}`,
  });
}

/** CUI-7 as JSON text with the given `parent` and `customFields` JSON, parsed like a live body. */
function rowFromJson(parent: string, customFields: string): JsonValue {
  return parseJson(
    '{"idReadable":"CUI-7","numberInProject":7,"summary":"s","description":null,"resolved":null,"updated":1,' +
      `"parent":${parent},"customFields":${customFields}}`,
  );
}

const NO_PARENT = '{"issues":[],"$type":"IssueLink"}';

describe("parseYouTrackIssue: hierarchy counts", () => {
  it("rejects three parent issues, naming the count", () => {
    // Arrange
    const row = issueRow(7, { parent: parentLink("CUI-1", "CUI-2", "CUI-3") });

    // Act + Assert
    assertFieldError(row, "parent.issues", "hold at most one issue", "3");
  });

  it("rejects three Type entries, naming the count", () => {
    // Arrange
    const row = issueRow(7, { customFields: [typeField("Task"), typeField("Bug"), typeField(null)] });

    // Act + Assert
    assertFieldError(row, "customFields", 'hold at most one "Type" entry', "3");
  });

  it("rejects two Type entries even when the first is empty", () => {
    // Arrange
    const row = issueRow(7, { customFields: [typeField(null), typeField("Task")] });

    // Act + Assert
    assertFieldError(row, "customFields", 'hold at most one "Type" entry', "2");
  });
});

describe("parseYouTrackIssue: hierarchy error order", () => {
  it("reports a wrong customFields before a wrong parent", () => {
    assertFieldError(issueRow(7, { parent: null, customFields: null }), "customFields", "be an array", "null");
  });

  it("reports a wrong Type value before two parents", () => {
    // Arrange
    const row = issueRow(7, {
      parent: parentLink("CUI-1", "CUI-2"),
      customFields: [{ name: "Type", value: "Task" }],
    });

    // Act + Assert
    assertFieldError(row, "customFields[0].value", "be null or an object", "string");
  });

  const otherKinds: readonly { readonly value: JsonValue; readonly got: string }[] = [
    { value: 7, got: "number" },
    { value: true, got: "boolean" },
  ];
  for (const { value, got } of otherKinds) {
    it(`rejects parent and customFields that are a JSON ${got}`, () => {
      assertFieldError(issueRow(7, { parent: value }), "parent", "be an object", got);
      assertFieldError(issueRow(7, { customFields: value }), "customFields", "be an array", got);
    });
  }
});

describe("parseYouTrackIssue: nested keys under an own __proto__ key", () => {
  it("parses a live-shaped JSON body with a parent and a Type", () => {
    // Arrange
    const row = rowFromJson(
      '{"issues":[{"idReadable":"CUI-9","$type":"Issue"}],"$type":"IssueLink"}',
      '[{"name":"Type","value":{"name":"Task","$type":"EnumBundleElement"},"$type":"SingleEnumIssueCustomField"}]',
    );

    // Act
    const issue = parseYouTrackIssue(row);

    // Assert
    assert.equal(issue.type, "Task");
    assert.equal(issue.parentId, "CUI-9");
  });

  it("does not read the parent issues from __proto__", () => {
    const row = rowFromJson('{"__proto__":{"issues":[{"idReadable":"CUI-1"}]}}', "[]");
    assertFieldError(row, "parent.issues", "be an array", "undefined");
  });

  it("does not read a parent idReadable from __proto__", () => {
    const row = rowFromJson('{"issues":[{"__proto__":{"idReadable":"CUI-1"}}]}', "[]");
    assertFieldError(row, "parent.issues[0].idReadable", "be a string", "undefined");
  });

  it("does not read a custom field name from __proto__", () => {
    const row = rowFromJson(NO_PARENT, '[{"__proto__":{"name":"Type"},"value":{"name":"Task"}}]');
    assertFieldError(row, "customFields[0].name", "be a string", "undefined");
  });

  it("does not read the Type value or its name from __proto__", () => {
    assertFieldError(
      rowFromJson(NO_PARENT, '[{"name":"Type","__proto__":{"value":{"name":"Task"}}}]'),
      "customFields[0].value",
      "be null or an object",
      "undefined",
    );
    assertFieldError(
      rowFromJson(NO_PARENT, '[{"name":"Type","value":{"__proto__":{"name":"Task"}}}]'),
      "customFields[0].value.name",
      "be a string",
      "undefined",
    );
  });
});

describe("parseYouTrackIssue: values left to the hierarchy step", () => {
  it("returns a parent that names the issue itself (the hierarchy step breaks cycles)", () => {
    assert.equal(parseProjectIssue(issueRow(7, { parent: parentLink("CUI-7") }), "CUI").parentId, "CUI-7");
  });

  it("returns the value name, not its localizedName", () => {
    // Arrange
    const row = issueRow(7, {
      customFields: [{ name: "Type", value: { name: "User Story", localizedName: "Story" } }],
    });

    // Act + Assert
    assert.equal(parseYouTrackIssue(row).type, "User Story");
  });

  it("keeps custom field names and parent ids out of the messages", () => {
    // Arrange
    const secret = "SECRET-TEXT-do-not-log";
    const rows = [
      issueRow(7, { customFields: [{ name: secret, value: secret }, { name: 5 }] }),
      issueRow(7, { customFields: [{ name: "Type", value: { name: secret } }, typeField(secret)] }),
      issueRow(7, { parent: { issues: [{ idReadable: secret }, { idReadable: secret }] } }),
    ];

    // Act + Assert
    for (const row of rows) {
      assert.throws(
        () => parseYouTrackIssue(row),
        (error) => {
          assert.ok(error instanceof YouTrackSchemaError);
          assert.doesNotMatch(error.message, new RegExp(secret));
          return true;
        },
      );
    }
  });
});
