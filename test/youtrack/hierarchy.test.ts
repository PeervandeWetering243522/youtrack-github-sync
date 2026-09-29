/**
 * The hierarchy fields of a YouTrack row (docs/11 step 2): `type` from the "Type" custom
 * field and `parentId` from the Subtask parent link, their request spec, and the loud
 * failures on every shape the reader does not understand.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { JsonObject, JsonValue } from "../../src/json.ts";
import {
  YOUTRACK_TYPE_FIELD,
  YouTrackSchemaError,
  fetchProjectIssues,
  parseProjectIssue,
  parseYouTrackIssue,
} from "../../src/youtrack.ts";
import {
  SOURCE,
  deepFreeze,
  issueRow,
  issueRows,
  parentLink,
  schemaError,
  serveBodies,
  typeField,
  withoutFields,
} from "./fixtures.ts";

/** A valid row whose customFields are exactly `entries`. */
function withCustomFields(entries: readonly JsonValue[]): JsonObject {
  return issueRow(7, { customFields: entries });
}

/** A valid row whose parent key is exactly `parent`. */
function withParent(parent: JsonValue): JsonObject {
  return issueRow(7, { parent });
}

/** Asserts that parsing `row` throws the exact YouTrackSchemaError for field `path` of CUI-7. */
function assertFieldError(row: JsonObject, path: string, requirement: string, got: string): void {
  assert.throws(() => parseYouTrackIssue(row), {
    name: "YouTrackSchemaError",
    message: `YouTrack issue "CUI-7": field "${path}" must ${requirement}, got ${got}`,
  });
}

// ---------------------------------------------------------------------------
// type: the "Type" custom field
// ---------------------------------------------------------------------------

describe("parseYouTrackIssue: type", () => {
  it('names the custom field "Type"', () => {
    assert.equal(YOUTRACK_TYPE_FIELD, "Type");
  });

  for (const value of ["Epic", "User Story", "Bug", "Task", "Some other type"]) {
    it(`returns the Type value name ${JSON.stringify(value)} unchanged`, () => {
      assert.equal(parseYouTrackIssue(withCustomFields([typeField(value)])).type, value);
    });
  }

  it("returns null when customFields has no entries", () => {
    assert.equal(parseYouTrackIssue(withCustomFields([])).type, null);
  });

  it("returns null when customFields has only other fields", () => {
    // Arrange
    const row = withCustomFields([
      { name: "State", value: { name: "Open" } },
      { name: "Estimation", value: 42 },
    ]);

    // Act + Assert
    assert.equal(parseYouTrackIssue(row).type, null);
  });

  it("returns null when the Type field has a null value", () => {
    assert.equal(parseYouTrackIssue(withCustomFields([typeField(null)])).type, null);
  });

  it("finds the Type entry among other fields and ignores their values", () => {
    // Arrange
    const row = withCustomFields([{ name: "Estimation", value: 42 }, typeField("Bug"), { name: "Due", value: null }]);

    // Act + Assert
    assert.equal(parseYouTrackIssue(row).type, "Bug");
  });

  it("matches the field name exactly (case-sensitive, no trimming)", () => {
    // Arrange
    const row = withCustomFields([
      { name: "type", value: { name: "Task" } },
      { name: "TYPE", value: { name: "Task" } },
      { name: " Type", value: { name: "Task" } },
    ]);

    // Act + Assert
    assert.equal(parseYouTrackIssue(row).type, null);
  });

  it("accepts a Type entry without $type keys", () => {
    assert.equal(parseYouTrackIssue(withCustomFields([{ name: "Type", value: { name: "Task" } }])).type, "Task");
  });
});

describe("parseYouTrackIssue: invalid customFields", () => {
  it("throws when the customFields key is missing", () => {
    assert.throws(
      () => parseYouTrackIssue(withoutFields(issueRow(7), ["customFields"])),
      schemaError(/^YouTrack issue "CUI-7" is missing field\(s\) "customFields"$/),
    );
  });

  const nonArrays: readonly { readonly value: JsonValue; readonly got: string }[] = [
    { value: null, got: "null" },
    { value: { name: "Type" }, got: "object" },
    { value: "Type", got: "string" },
  ];
  for (const { value, got } of nonArrays) {
    it(`throws when customFields is a JSON ${got}`, () => {
      assertFieldError(issueRow(7, { customFields: value }), "customFields", "be an array", got);
    });
  }

  it("throws when an entry is not an object", () => {
    assertFieldError(withCustomFields([typeField("Task"), "Type"]), "customFields[1]", "be an object", "string");
  });

  it("throws when an entry has no string name", () => {
    assertFieldError(
      withCustomFields([{ value: { name: "Task" } }]),
      "customFields[0].name",
      "be a string",
      "undefined",
    );
    assertFieldError(withCustomFields([{ name: null, value: null }]), "customFields[0].name", "be a string", "null");
  });

  it("throws on two Type entries", () => {
    // Arrange
    const row = withCustomFields([typeField("Task"), typeField("Task")]);

    // Act + Assert
    assertFieldError(row, "customFields", 'hold at most one "Type" entry', "2");
  });

  const badValues: readonly { readonly value: JsonValue; readonly got: string }[] = [
    { value: "Task", got: "string" },
    { value: [{ name: "Task" }], got: "array" },
    { value: 3, got: "number" },
    { value: false, got: "boolean" },
  ];
  for (const { value, got } of badValues) {
    it(`throws when the Type value is a JSON ${got}`, () => {
      // Arrange
      const row = withCustomFields([{ name: "Other" }, { name: "Type", value }]);

      // Act + Assert
      assertFieldError(row, "customFields[1].value", "be null or an object", got);
    });
  }

  it("throws when the Type entry has no value key", () => {
    assertFieldError(
      withCustomFields([{ name: "Type" }]),
      "customFields[0].value",
      "be null or an object",
      "undefined",
    );
  });

  const badNames: readonly { readonly value: JsonObject; readonly got: string }[] = [
    { value: {}, got: "undefined" },
    { value: { name: null }, got: "null" },
    { value: { name: 1 }, got: "number" },
    { value: { name: { text: "Task" } }, got: "object" },
  ];
  for (const { value, got } of badNames) {
    it(`throws when the Type value name is ${got}`, () => {
      assertFieldError(withCustomFields([{ name: "Type", value }]), "customFields[0].value.name", "be a string", got);
    });
  }
});

// ---------------------------------------------------------------------------
// parentId: Issue.parent (the Subtask link)
// ---------------------------------------------------------------------------

describe("parseYouTrackIssue: parentId", () => {
  it("returns null when the parent link has no issues", () => {
    assert.equal(parseYouTrackIssue(withParent(parentLink())).parentId, null);
  });

  it("returns the idReadable of the one parent issue", () => {
    assert.equal(parseYouTrackIssue(withParent(parentLink("CUI-9"))).parentId, "CUI-9");
  });

  it("keeps a parent from another project as is (the hierarchy decides, D5)", () => {
    assert.equal(parseProjectIssue(withParent(parentLink("OTHER-3")), "CUI").parentId, "OTHER-3");
  });

  it("accepts a parent link and issue without $type keys", () => {
    assert.equal(parseYouTrackIssue(withParent({ issues: [{ idReadable: "CUI-2" }] })).parentId, "CUI-2");
  });

  it("parses type and parent together", () => {
    // Arrange
    const row = issueRow(40, { parent: parentLink("CUI-35"), customFields: [typeField("Task")] });

    // Act
    const issue = parseYouTrackIssue(row);

    // Assert
    assert.equal(issue.type, "Task");
    assert.equal(issue.parentId, "CUI-35");
  });
});

describe("parseYouTrackIssue: invalid parent", () => {
  it("throws when the parent key is missing", () => {
    assert.throws(
      () => parseYouTrackIssue(withoutFields(issueRow(7), ["parent"])),
      schemaError(/^YouTrack issue "CUI-7" is missing field\(s\) "parent"$/),
    );
  });

  it("names missing flat and hierarchy fields together, in request order", () => {
    assert.throws(
      () => parseYouTrackIssue(withoutFields(issueRow(7), ["customFields", "summary", "parent"])),
      schemaError(/^YouTrack issue "CUI-7" is missing field\(s\) "summary", "parent", "customFields"$/),
    );
  });

  const nonObjects: readonly { readonly value: JsonValue; readonly got: string }[] = [
    { value: null, got: "null" },
    { value: [], got: "array" },
    { value: "CUI-9", got: "string" },
  ];
  for (const { value, got } of nonObjects) {
    it(`throws when parent is a JSON ${got}`, () => {
      assertFieldError(withParent(value), "parent", "be an object", got);
    });
  }

  it("throws when the parent link has no issues array", () => {
    assertFieldError(withParent({ $type: "IssueLink" }), "parent.issues", "be an array", "undefined");
    assertFieldError(withParent({ issues: null }), "parent.issues", "be an array", "null");
    assertFieldError(withParent({ issues: { idReadable: "CUI-9" } }), "parent.issues", "be an array", "object");
  });

  it("throws on two parent issues", () => {
    assertFieldError(withParent(parentLink("CUI-9", "CUI-10")), "parent.issues", "hold at most one issue", "2");
  });

  it("throws when the parent issue is not an object", () => {
    assertFieldError(withParent({ issues: ["CUI-9"] }), "parent.issues[0]", "be an object", "string");
    assertFieldError(withParent({ issues: [null] }), "parent.issues[0]", "be an object", "null");
  });

  it("throws when the parent issue has no string idReadable", () => {
    assertFieldError(withParent({ issues: [{}] }), "parent.issues[0].idReadable", "be a string", "undefined");
    assertFieldError(
      withParent({ issues: [{ idReadable: 9 }] }),
      "parent.issues[0].idReadable",
      "be a string",
      "number",
    );
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting guarantees
// ---------------------------------------------------------------------------

describe("parseYouTrackIssue: hierarchy guarantees", () => {
  it("reports a wrong flat field before a wrong hierarchy field", () => {
    assert.throws(
      () => parseYouTrackIssue(issueRow(7, { updated: null, parent: null, customFields: null })),
      schemaError(/^YouTrack issue "CUI-7": field "updated" must be a safe integer, got null$/),
    );
  });

  it("never puts issue text or field values into the messages", () => {
    // Arrange
    const secret = "SECRET-TEXT-do-not-log";
    const text = { summary: secret, description: secret };
    const rows: readonly JsonObject[] = [
      issueRow(9, { ...text, customFields: [{ name: "Type", value: secret }] }),
      issueRow(9, { ...text, customFields: [{ name: "Type", value: { name: { text: secret } } }] }),
      issueRow(9, { ...text, customFields: [secret] }),
      issueRow(9, { ...text, parent: { issues: [secret] } }),
      issueRow(9, { ...text, parent: { issues: [{ idReadable: [secret] }] } }),
      issueRow(9, { ...text, parent: parentLink(secret, secret) }),
      issueRow(9, { ...text, parent: secret }),
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

  it("parses a deep-frozen row with a parent and a Type without writing to it", () => {
    // Arrange
    const row = deepFreeze(issueRow(12, { parent: parentLink("CUI-9"), customFields: [typeField("User Story")] }));
    const snapshot = structuredClone(row);

    // Act
    const issue = parseYouTrackIssue(row);

    // Assert
    assert.equal(issue.type, "User Story");
    assert.equal(issue.parentId, "CUI-9");
    assert.deepEqual(row, snapshot);
  });
});

// ---------------------------------------------------------------------------
// fetchProjectIssues: request and results
// ---------------------------------------------------------------------------

describe("fetchProjectIssues: hierarchy fields", () => {
  it("requests the nested parent and custom field specs and limits customFields to Type", async () => {
    // Arrange
    const fake = serveBodies([[issueRow(1)]]);

    // Act
    await fetchProjectIssues(fake.http, SOURCE);

    // Assert
    const url = new URL(fake.requests[0]?.url ?? "");
    const fields = url.searchParams.get("fields") ?? "";
    assert.ok(fields.includes(",parent(issues(idReadable)),"), fields);
    assert.ok(fields.endsWith(",customFields(name,value(name))"), fields);
    assert.deepEqual(url.searchParams.getAll("customFields"), ["Type"]);
  });

  it("returns type and parentId for every issue", async () => {
    // Arrange
    const rows = [
      issueRow(9, { customFields: [typeField("Epic")] }),
      issueRow(10, { parent: parentLink("CUI-9"), customFields: [typeField("User Story")] }),
      issueRow(11, { parent: parentLink("CUI-10"), customFields: [typeField("Task")] }),
      issueRow(12, { customFields: [typeField(null)] }),
    ];
    const fake = serveBodies([rows]);

    // Act
    const issues = await fetchProjectIssues(fake.http, SOURCE);

    // Assert
    assert.deepEqual(
      issues.map(({ numberInProject, type, parentId }) => ({ numberInProject, type, parentId })),
      [
        { numberInProject: 9, type: "Epic", parentId: null },
        { numberInProject: 10, type: "User Story", parentId: "CUI-9" },
        { numberInProject: 11, type: "Task", parentId: "CUI-10" },
        { numberInProject: 12, type: null, parentId: null },
      ],
    );
  });

  it("fails the scan on a row with two parents, without fetching the next page", async () => {
    // Arrange
    const page = [...issueRows(1, 99), issueRow(100, { parent: parentLink("CUI-1", "CUI-2") })];
    const fake = serveBodies([page, issueRows(101, 1)]);

    // Act + Assert
    await assert.rejects(
      fetchProjectIssues(fake.http, SOURCE),
      schemaError(/^YouTrack issue "CUI-100": field "parent\.issues" must hold at most one issue, got 2$/),
    );
    assert.equal(fake.requests.length, 1);
  });
});
