/**
 * The Assignee field of a YouTrack row (docs/13 unit B, U15): the request with and without
 * `assignees`, and the parse of single- and multi-user entries. Every person is a placeholder.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { JsonObject, JsonValue } from "../../src/json.ts";
import {
  YOUTRACK_ASSIGNEE_FIELD,
  fetchProjectIssues,
  issueFieldsParam,
  parseProjectIssue,
  parseYouTrackIssue,
} from "../../src/youtrack.ts";
import type { ScanOptions } from "../../src/youtrack.ts";
import {
  BASE_URL,
  FIRST_PAGE_URL,
  SOURCE,
  TOKEN,
  assertOnlyIssueGets,
  assigneeField,
  deepFreeze,
  expectedPageRequest,
  issueRow,
  issueRows,
  serveBodies,
  typeField,
  youtrackUser,
} from "./fixtures.ts";

const LOGIN = "jdoe123456";
const OTHER_LOGIN = "JaneDoe123456";
const EMAIL = "123456@buas.nl";
const ON: ScanOptions = Object.freeze({ assignees: true });
const MULTI = "MultiUserIssueCustomField";

/** The page URL with assignees on, up to its `$skip` value, spelled out independently of the implementation. */
const ASSIGNEE_PAGE_URL_PREFIX =
  `${BASE_URL}/api/issues` +
  "?query=project%3A+CUI+sort+by%3A+%7Bissue+id%7D+asc" +
  "&fields=idReadable%2CnumberInProject%2Csummary%2Cdescription%2Cresolved%2Cupdated" +
  "%2Cparent%28issues%28idReadable%29%29%2CcustomFields%28name%2Cvalue%28name%2Clogin%2Cemail%29%29" +
  "&customFields=Type&customFields=Assignee" +
  "&%24top=100&%24skip=";

/** CUI-7 with exactly these customFields entries. */
function rowWith(...entries: readonly JsonValue[]): JsonObject {
  return issueRow(7, { customFields: [...entries] });
}

/** Asserts that parsing `row` throws the exact YouTrackSchemaError for field `path` of CUI-7. */
function assertFieldError(row: JsonValue, path: string, requirement: string, got: string): void {
  assert.throws(() => parseYouTrackIssue(row), {
    name: "YouTrackSchemaError",
    message: `YouTrack issue "CUI-7": field "${path}" must ${requirement}, got ${got}`,
  });
}

/** The error message of parsing `row`; fails the test when it parses. */
function errorMessageOf(row: JsonValue): string {
  try {
    parseYouTrackIssue(row);
  } catch (error) {
    assert.ok(error instanceof Error);
    return error.message;
  }
  assert.fail("expected the row to fail");
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

describe("issueFieldsParam: assignees", () => {
  it("is today's value without options and with assignees off", () => {
    // Arrange
    const today =
      "idReadable,numberInProject,summary,description,resolved,updated," +
      "parent(issues(idReadable)),customFields(name,value(name))";

    // Act + Assert
    assert.equal(issueFieldsParam(), today);
    assert.equal(issueFieldsParam({ assignees: false }), today);
  });

  it("asks for the user login and email in the shared value spec with assignees on", () => {
    // Act
    const fields = issueFieldsParam(ON);

    // Assert
    assert.equal(
      fields,
      "idReadable,numberInProject,summary,description,resolved,updated," +
        "parent(issues(idReadable)),customFields(name,value(name,login,email))",
    );
  });
});

describe("fetchProjectIssues: the Assignee request", () => {
  it("sends today's URL byte for byte with assignees off", async () => {
    // Arrange
    const fake = serveBodies([[issueRow(1)]]);

    // Act
    await fetchProjectIssues(fake.http, SOURCE, { assignees: false });

    // Assert
    assert.deepEqual(fake.requests, [expectedPageRequest(0)]);
    assert.equal(fake.requests[0]?.url, FIRST_PAGE_URL);
  });

  it("sends the exact URL with both customFields for every page with assignees on", async () => {
    // Arrange
    const fake = serveBodies([issueRows(1, 100), issueRows(101, 2)]);

    // Act
    await fetchProjectIssues(fake.http, SOURCE, ON);

    // Assert
    assert.deepEqual(
      fake.requests,
      [0, 100].map((skip) => ({
        method: "GET",
        url: `${ASSIGNEE_PAGE_URL_PREFIX}${String(skip)}`,
        headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
        retry: "retry-once",
      })),
    );
    assertOnlyIssueGets(fake.requests);
  });

  it("repeats customFields in order between fields and $top with assignees on", async () => {
    // Arrange
    const fake = serveBodies([[]]);

    // Act
    await fetchProjectIssues(fake.http, SOURCE, ON);

    // Assert
    const url = new URL(fake.requests[0]?.url ?? "");
    assert.deepEqual(
      [...url.searchParams.keys()],
      ["query", "fields", "customFields", "customFields", "$top", "$skip"],
    );
    assert.deepEqual(url.searchParams.getAll("customFields"), ["Type", YOUTRACK_ASSIGNEE_FIELD]);
    assert.equal(url.searchParams.get("fields"), issueFieldsParam(ON));
  });

  it("returns each row's Assignee field next to its Type", async () => {
    // Arrange
    const rows = [
      issueRow(1, { customFields: [typeField("Task"), assigneeField(youtrackUser(LOGIN, EMAIL))] }),
      issueRow(2, { customFields: [typeField("Bug"), assigneeField(null)] }),
      issueRow(3, { customFields: [typeField(null)] }),
    ];
    const fake = serveBodies([rows]);

    // Act
    const issues = await fetchProjectIssues(fake.http, SOURCE, ON);

    // Assert
    assert.deepEqual(
      issues.map(({ numberInProject, type, assignee }) => ({ numberInProject, type, assignee })),
      [
        { numberInProject: 1, type: "Task", assignee: { kind: "users", users: [{ login: LOGIN, email: EMAIL }] } },
        { numberInProject: 2, type: "Bug", assignee: { kind: "users", users: [] } },
        { numberInProject: 3, type: null, assignee: { kind: "absent" } },
      ],
    );
  });
});

// ---------------------------------------------------------------------------
// Parsing a recognised entry
// ---------------------------------------------------------------------------

describe("parseYouTrackIssue: Assignee users", () => {
  it("reads a single-user value as one user with login and email", () => {
    // Act
    const issue = parseYouTrackIssue(rowWith(typeField("Task"), assigneeField(youtrackUser(LOGIN, EMAIL))));

    // Assert
    assert.deepEqual(issue.assignee, { kind: "users", users: [{ login: LOGIN, email: EMAIL }] });
    assert.equal(issue.type, "Task");
  });

  it("reads a single-user null value as unassigned", () => {
    assert.deepEqual(parseYouTrackIssue(rowWith(assigneeField(null))).assignee, { kind: "users", users: [] });
  });

  it("reads a multi-user value as every user, in order", () => {
    // Arrange
    const value = [youtrackUser(OTHER_LOGIN, null), youtrackUser(LOGIN, EMAIL)];

    // Act
    const issue = parseYouTrackIssue(rowWith(assigneeField(value, MULTI)));

    // Assert
    assert.deepEqual(issue.assignee, {
      kind: "users",
      users: [
        { login: OTHER_LOGIN, email: null },
        { login: LOGIN, email: EMAIL },
      ],
    });
  });

  it("reads a multi-user [] and a multi-user null as unassigned", () => {
    for (const value of [[], null]) {
      assert.deepEqual(parseYouTrackIssue(rowWith(assigneeField(value, MULTI))).assignee, {
        kind: "users",
        users: [],
      });
    }
  });

  it("matches the entry name ignoring A-Z case", () => {
    for (const name of ["assignee", "ASSIGNEE", "aSSignee"]) {
      // Act
      const issue = parseYouTrackIssue(rowWith(assigneeField(youtrackUser(LOGIN, EMAIL), undefined, name)));

      // Assert
      assert.deepEqual(issue.assignee, { kind: "users", users: [{ login: LOGIN, email: EMAIL }] }, name);
    }
  });

  it("reads a missing email, an empty email and a null email as null", () => {
    // Arrange
    const users = [{ login: "jdoe111111" }, { login: "jdoe222222", email: "" }, { login: "jdoe333333", email: null }];

    // Act
    const issue = parseYouTrackIssue(rowWith(assigneeField(users, MULTI)));

    // Assert
    assert.deepEqual(issue.assignee, {
      kind: "users",
      users: [
        { login: "jdoe111111", email: null },
        { login: "jdoe222222", email: null },
        { login: "jdoe333333", email: null },
      ],
    });
  });

  it("keeps only login and email of a user, dropping name, fullName and every other key", () => {
    // Act
    const issue = parseYouTrackIssue(rowWith(assigneeField(youtrackUser(LOGIN, EMAIL))));

    // Assert
    assert.equal(issue.assignee.kind, "users");
    assert.deepEqual(
      issue.assignee.users.map((user) => Object.keys(user)),
      [["login", "email"]],
    );
    assert.equal(JSON.stringify(issue).includes("Jane Doe"), false);
  });

  it("keeps the login verbatim, case and all", () => {
    // Act
    const issue = parseYouTrackIssue(rowWith(assigneeField(youtrackUser(OTHER_LOGIN, "JaneDoe@Example.TEST"))));

    // Assert
    assert.deepEqual(issue.assignee, {
      kind: "users",
      users: [{ login: OTHER_LOGIN, email: "JaneDoe@Example.TEST" }],
    });
  });

  it("parses a deep-frozen row into new user objects", () => {
    // Arrange
    const user = youtrackUser(LOGIN, EMAIL);
    const row = deepFreeze(rowWith(assigneeField([user], MULTI)));

    // Act
    const issue = parseYouTrackIssue(row);

    // Assert
    assert.equal(issue.assignee.kind, "users");
    assert.notEqual(issue.assignee.users[0], user);
  });

  it("carries the Assignee field through parseProjectIssue", () => {
    // Arrange
    const row = rowWith(assigneeField(youtrackUser(LOGIN, EMAIL)));

    // Act + Assert
    assert.deepEqual(parseProjectIssue(row, "CUI"), parseYouTrackIssue(row));
    assert.equal(parseProjectIssue(row, "CUI").assignee.kind, "users");
  });
});

// ---------------------------------------------------------------------------
// Rows that read as absent
// ---------------------------------------------------------------------------

describe("parseYouTrackIssue: Assignee absent", () => {
  it("reads a row without customFields entries as absent, never as unassigned", () => {
    assert.deepEqual(parseYouTrackIssue(rowWith()).assignee, { kind: "absent" });
  });

  it("reads a row with only a Type entry as absent", () => {
    assert.deepEqual(parseYouTrackIssue(rowWith(typeField("Task"))).assignee, { kind: "absent" });
  });

  it("ignores an Assignee entry of a non-user $type", () => {
    // Arrange
    const enumAssignee = assigneeField({ name: LOGIN, $type: "EnumBundleElement" }, "SingleEnumIssueCustomField");

    // Act + Assert
    assert.deepEqual(parseYouTrackIssue(rowWith(enumAssignee)).assignee, { kind: "absent" });
  });

  it("ignores an Assignee entry without a $type or with a non-string $type", () => {
    for (const entry of [
      { name: "Assignee", value: youtrackUser(LOGIN, EMAIL) },
      { name: "Assignee", value: youtrackUser(LOGIN, EMAIL), $type: 5 },
    ]) {
      assert.deepEqual(parseYouTrackIssue(rowWith(entry)).assignee, { kind: "absent" });
    }
  });

  it("ignores a user field of another name", () => {
    // Arrange
    const reviewer = assigneeField(youtrackUser(LOGIN, EMAIL), undefined, "Reviewer");

    // Act + Assert
    assert.deepEqual(parseYouTrackIssue(rowWith(reviewer)).assignee, { kind: "absent" });
  });

  it("uses the user entry when a non-user entry has the same name", () => {
    // Arrange
    const enumAssignee = assigneeField({ name: "x" }, "SingleEnumIssueCustomField");

    // Act
    const issue = parseYouTrackIssue(rowWith(enumAssignee, assigneeField(youtrackUser(LOGIN, EMAIL))));

    // Assert
    assert.deepEqual(issue.assignee, { kind: "users", users: [{ login: LOGIN, email: EMAIL }] });
  });

  it("does not read an Assignee entry as the Type", () => {
    assert.equal(parseYouTrackIssue(rowWith(assigneeField(youtrackUser(LOGIN, EMAIL)))).type, null);
  });
});

// ---------------------------------------------------------------------------
// Shape errors
// ---------------------------------------------------------------------------

describe("parseYouTrackIssue: invalid Assignee entries", () => {
  it("rejects two recognised entries, naming the count", () => {
    // Arrange
    const row = rowWith(
      assigneeField(youtrackUser(LOGIN, EMAIL)),
      typeField("Task"),
      assigneeField([], MULTI, "assignee"),
    );

    // Act + Assert
    assertFieldError(row, "customFields", 'hold at most one "Assignee" entry', "2");
  });

  it("rejects a single-user value that is not null or an object", () => {
    assertFieldError(rowWith(assigneeField(LOGIN)), "customFields[0].value", "be null or an object", "string");
    assertFieldError(rowWith(assigneeField([])), "customFields[0].value", "be null or an object", "array");
  });

  it("rejects a single-user entry without a value", () => {
    assertFieldError(
      rowWith({ name: "Assignee", $type: "SingleUserIssueCustomField" }),
      "customFields[0].value",
      "be null or an object",
      "undefined",
    );
  });

  it("rejects a multi-user value that is not null or an array", () => {
    assertFieldError(
      rowWith(typeField(null), assigneeField(youtrackUser(LOGIN, EMAIL), MULTI)),
      "customFields[1].value",
      "be null or an array",
      "object",
    );
  });

  it("rejects a multi-user item that is not an object", () => {
    assertFieldError(
      rowWith(assigneeField([youtrackUser(LOGIN, EMAIL), EMAIL], MULTI)),
      "customFields[0].value[1]",
      "be an object",
      "string",
    );
  });

  it("rejects a user without a login, naming the path", () => {
    assertFieldError(
      rowWith(assigneeField({ email: EMAIL, name: "Jane Doe" })),
      "customFields[0].value.login",
      "be a non-empty string",
      "undefined",
    );
    assertFieldError(
      rowWith(assigneeField([youtrackUser(LOGIN, EMAIL), { email: EMAIL }], MULTI)),
      "customFields[0].value[1].login",
      "be a non-empty string",
      "undefined",
    );
  });

  it("rejects a numeric, a null and an empty login", () => {
    assertFieldError(
      rowWith(assigneeField({ login: 123456 })),
      "customFields[0].value.login",
      "be a non-empty string",
      "number",
    );
    assertFieldError(
      rowWith(assigneeField({ login: null })),
      "customFields[0].value.login",
      "be a non-empty string",
      "null",
    );
    assertFieldError(
      rowWith(assigneeField({ login: "" })),
      "customFields[0].value.login",
      "be a non-empty string",
      "empty string",
    );
  });

  it("rejects an email that is not a string or null", () => {
    assertFieldError(
      rowWith(assigneeField({ login: LOGIN, email: 123456 })),
      "customFields[0].value.email",
      "be a string or null",
      "number",
    );
  });

  it("never puts a login or an email in an error message", () => {
    // Arrange: every failing shape carries the placeholder people.
    const rows = [
      rowWith(assigneeField(youtrackUser(LOGIN, EMAIL)), assigneeField(youtrackUser(OTHER_LOGIN, EMAIL))),
      rowWith(assigneeField(LOGIN)),
      rowWith(assigneeField(EMAIL, MULTI)),
      rowWith(assigneeField([LOGIN, EMAIL], MULTI)),
      rowWith(assigneeField({ login: 123456, email: EMAIL, name: OTHER_LOGIN })),
      rowWith(assigneeField({ login: LOGIN, email: 123456 })),
      rowWith(assigneeField({ email: EMAIL, fullName: OTHER_LOGIN })),
    ];

    for (const row of rows) {
      // Act
      const message = errorMessageOf(row);

      // Assert
      for (const secret of [LOGIN, OTHER_LOGIN, EMAIL, "123456", "buas.nl", "jdoe", "JaneDoe"]) {
        assert.equal(message.toLowerCase().includes(secret.toLowerCase()), false, `${message} names ${secret}`);
      }
    }
  });
});
