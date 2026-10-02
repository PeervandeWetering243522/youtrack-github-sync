import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addAssignees,
  listAssignableUsers,
  MAX_ASSIGNEES_PER_ISSUE,
  parseAssignees,
  removeAssignees,
} from "../../src/github/assignees.ts";
import type { GitHubAssignee } from "../../src/github/assignees.ts";
import type { GitHubTarget } from "../../src/github/client.ts";
import { parseGitHubIssue } from "../../src/github/issues.ts";
import { HttpError } from "../../src/http.ts";
import type { HttpClient } from "../../src/http.ts";
import { parseJson } from "../../src/json.ts";
import type { JsonValue } from "../../src/json.ts";
import {
  ASSIGNABLE_URL,
  createFakeHttp,
  EXPECTED_HEADERS,
  hasNoIdentity,
  ISSUES_URL,
  issueJson,
  OTHER_STUDENT_LOGIN,
  requestAt,
  schemaError,
  SECOND_ASSIGNABLE_PAGE_URL,
  STAFF_LOGIN,
  STUDENT_EMAIL,
  STUDENT_LOGIN,
  TARGET,
  TOKEN,
  userJson,
} from "./fixtures.ts";

const CONTEXT = "GitHub issue #5";
const BOT_LOGIN = "github-actions[bot]";

/** An error whose message names none of the placeholder people. */
function identityFree(error: Error): boolean {
  return hasNoIdentity(error.message);
}

// ---------------------------------------------------------------------------
// MAX_ASSIGNEES_PER_ISSUE
// ---------------------------------------------------------------------------

describe("MAX_ASSIGNEES_PER_ISSUE", () => {
  it("is GitHub's limit of 10 assignees per issue", () => {
    assert.equal(MAX_ASSIGNEES_PER_ISSUE, 10);
  });
});

// ---------------------------------------------------------------------------
// parseAssignees
// ---------------------------------------------------------------------------

describe("parseAssignees", () => {
  it("reads a missing key and null as no assignees", () => {
    assert.deepEqual(parseAssignees(undefined, CONTEXT), []);
    assert.deepEqual(parseAssignees(null, CONTEXT), []);
  });

  it("reads an empty array as no assignees", () => {
    assert.deepEqual(parseAssignees([], CONTEXT), []);
  });

  it("keeps only the login and the type of a full user object", () => {
    const expected: readonly GitHubAssignee[] = [{ login: STUDENT_LOGIN, type: "User" }];
    assert.deepEqual(parseAssignees([userJson(STUDENT_LOGIN)], CONTEXT), expected);
  });

  it("keeps a Bot with its type, so the caller can leave it alone", () => {
    assert.deepEqual(parseAssignees([userJson(BOT_LOGIN, "Bot")], CONTEXT), [{ login: BOT_LOGIN, type: "Bot" }]);
  });

  it("keeps logins verbatim and in order (no case folding, no deduplication)", () => {
    // Arrange
    const value: JsonValue = [userJson(OTHER_STUDENT_LOGIN), userJson(STAFF_LOGIN), userJson(OTHER_STUDENT_LOGIN)];

    // Act
    const assignees = parseAssignees(value, CONTEXT);

    // Assert
    assert.deepEqual(
      assignees.map((assignee) => assignee.login),
      [OTHER_STUDENT_LOGIN, STAFF_LOGIN, OTHER_STUDENT_LOGIN],
    );
  });

  for (const [description, item] of [
    ["missing", { login: STUDENT_LOGIN }],
    ["null", { login: STUDENT_LOGIN, type: null }],
    ["a number", { login: STUDENT_LOGIN, type: 1 }],
    ["an object", { login: STUDENT_LOGIN, type: { name: "User" } }],
  ] as const) {
    it(`reads a type that is ${description} as "" (never owned, so never removed)`, () => {
      assert.deepEqual(parseAssignees([item], CONTEXT), [{ login: STUDENT_LOGIN, type: "" }]);
    });
  }

  it("skips items without a string login and keeps the rest", () => {
    // Arrange
    const value: JsonValue = [
      null,
      3,
      STUDENT_LOGIN,
      [STUDENT_LOGIN],
      {},
      { login: null, type: "User" },
      { login: 5, type: "User" },
      { name: STUDENT_LOGIN, type: "User" },
      userJson(STAFF_LOGIN),
    ];

    // Act
    const assignees = parseAssignees(value, CONTEXT);

    // Assert
    assert.deepEqual(assignees, [{ login: STAFF_LOGIN, type: "User" }]);
  });

  for (const value of [{ login: STUDENT_LOGIN }, STUDENT_LOGIN, 1, true] as const) {
    it(`rejects assignees = ${JSON.stringify(value)} with the context and without echoing it`, () => {
      assert.throws(
        () => parseAssignees(value, CONTEXT),
        schemaError(/^GitHub issue #5: "assignees" must be an array/),
      );
      assert.throws(() => parseAssignees(value, CONTEXT), identityFree);
    });
  }

  it("names the JSON kind of a rejected value only", () => {
    assert.throws(() => parseAssignees(STUDENT_EMAIL, CONTEXT), schemaError(/got a string$/));
    assert.throws(() => parseAssignees({ login: STUDENT_LOGIN }, CONTEXT), schemaError(/got an object$/));
  });

  it("leaves the input untouched and returns new objects", () => {
    // Arrange
    const value: JsonValue = [userJson(STUDENT_LOGIN)];
    const snapshot = structuredClone(value);

    // Act
    const [assignee] = parseAssignees(value, CONTEXT);

    // Assert
    assert.deepEqual(value, snapshot);
    assert.notEqual(assignee, value[0]);
  });
});

// ---------------------------------------------------------------------------
// parseGitHubIssue: assignees
// ---------------------------------------------------------------------------

describe("parseGitHubIssue: assignees", () => {
  function parse(value: JsonValue): readonly GitHubAssignee[] {
    return parseGitHubIssue(value, TARGET).assignees;
  }

  it("reads a missing key, null and [] as no assignees", () => {
    assert.deepEqual(parse(issueJson()), []);
    assert.deepEqual(parse(issueJson({ assignees: null })), []);
    assert.deepEqual(parse(issueJson({ assignees: [] })), []);
  });

  it("reads a User and a Bot with their logins verbatim", () => {
    // Arrange
    const raw = issueJson({
      assignee: userJson(OTHER_STUDENT_LOGIN),
      assignees: [userJson(OTHER_STUDENT_LOGIN), userJson(BOT_LOGIN, "Bot")],
    });

    // Act + Assert
    assert.deepEqual(parse(raw), [
      { login: OTHER_STUDENT_LOGIN, type: "User" },
      { login: BOT_LOGIN, type: "Bot" },
    ]);
  });

  it("skips assignee items without a string login", () => {
    assert.deepEqual(parse(issueJson({ assignees: [{ type: "User" }, userJson(STAFF_LOGIN)] })), [
      { login: STAFF_LOGIN, type: "User" },
    ]);
  });

  it("rejects a non-array assignees value, naming the issue number but no login", () => {
    // Arrange
    const raw = issueJson({ number: 5, assignees: userJson(STUDENT_LOGIN) });

    // Act + Assert
    assert.throws(() => parseGitHubIssue(raw, TARGET), schemaError(/^GitHub issue #5: "assignees" must be an array/));
    assert.throws(() => parseGitHubIssue(raw, TARGET), identityFree);
  });

  it("is not fooled by an assignees key under __proto__", () => {
    // Arrange
    const raw = parseJson(
      '{"id":1,"number":1,"title":"t","state":"open","labels":[],"__proto__":{"assignees":[{"login":"jdoe123456"}]}}',
    );

    // Act + Assert
    assert.deepEqual(parse(raw), []);
  });
});

// ---------------------------------------------------------------------------
// listAssignableUsers
// ---------------------------------------------------------------------------

describe("listAssignableUsers", () => {
  it("GETs the assignees list with per_page=100, GitHub headers and retry-once", async () => {
    // Arrange
    const fake = createFakeHttp([{ body: [userJson(STUDENT_LOGIN), userJson(STAFF_LOGIN)] }]);

    // Act
    const users = await listAssignableUsers(fake.http, TARGET);

    // Assert
    assert.equal(fake.requests.length, 1);
    const request = requestAt(fake.requests, 0);
    assert.equal(request.method, "GET");
    assert.equal(request.url, ASSIGNABLE_URL);
    assert.deepEqual(request.headers, EXPECTED_HEADERS);
    assert.equal(request.retry, "retry-once");
    assert.equal("body" in request, false);
    assert.deepEqual(users, [
      { login: STUDENT_LOGIN, type: "User" },
      { login: STAFF_LOGIN, type: "User" },
    ]);
  });

  it("returns [] for an empty list", async () => {
    const fake = createFakeHttp([{ body: [] }]);
    assert.deepEqual(await listAssignableUsers(fake.http, TARGET), []);
  });

  it('follows Link rel="next" verbatim and keeps the page order', async () => {
    // Arrange
    const fake = createFakeHttp([
      { body: [userJson(STUDENT_LOGIN)], link: `<${SECOND_ASSIGNABLE_PAGE_URL}>; rel="next"` },
      { body: [userJson(OTHER_STUDENT_LOGIN), userJson(BOT_LOGIN, "Bot")] },
    ]);

    // Act
    const users = await listAssignableUsers(fake.http, TARGET);

    // Assert
    assert.deepEqual(
      fake.requests.map((request) => [request.url, request.retry]),
      [
        [ASSIGNABLE_URL, "retry-once"],
        [SECOND_ASSIGNABLE_PAGE_URL, "retry-once"],
      ],
    );
    assert.deepEqual(users, [
      { login: STUDENT_LOGIN, type: "User" },
      { login: OTHER_STUDENT_LOGIN, type: "User" },
      { login: BOT_LOGIN, type: "Bot" },
    ]);
  });

  it("skips list items without a string login, like an issue's assignees", async () => {
    const fake = createFakeHttp([{ body: [null, { id: 3 }, userJson(STAFF_LOGIN)] }]);
    assert.deepEqual(await listAssignableUsers(fake.http, TARGET), [{ login: STAFF_LOGIN, type: "User" }]);
  });

  for (const body of [{ message: STUDENT_LOGIN }, STUDENT_EMAIL, null] as const) {
    it(`rejects a page that is ${JSON.stringify(body)} without echoing it`, async () => {
      const fake = createFakeHttp([{ body }]);
      await assert.rejects(listAssignableUsers(fake.http, TARGET), schemaError(/assignees page must be a JSON array/));
      await assert.rejects(listAssignableUsers(createFakeHttp([{ body }]).http, TARGET), identityFree);
    });
  }

  it("fails the whole list when a later page is not an array", async () => {
    // Arrange
    const fake = createFakeHttp([
      { body: [userJson(STUDENT_LOGIN)], link: `<${SECOND_ASSIGNABLE_PAGE_URL}>; rel="next"` },
      { body: {} },
    ]);

    // Act + Assert
    await assert.rejects(listAssignableUsers(fake.http, TARGET), schemaError(/assignees page/));
  });

  it("percent-encodes owner and repo and refuses a dot-segment repo before any request", async () => {
    // Arrange
    const fake = createFakeHttp([{ body: [] }]);

    // Act
    await listAssignableUsers(fake.http, { owner: "o w", repo: "r#1", token: TOKEN });

    // Assert
    assert.equal(requestAt(fake.requests, 0).url, "https://api.github.com/repos/o%20w/r%231/assignees?per_page=100");
    await assert.rejects(listAssignableUsers(fake.http, { owner: "o", repo: "..", token: TOKEN }), RangeError);
    assert.equal(fake.requests.length, 1);
  });

  it("propagates an HttpError unchanged", async () => {
    const failure = new HttpError("GET", ASSIGNABLE_URL, 502, "Bad Gateway");
    const fake = createFakeHttp([], failure);
    await assert.rejects(listAssignableUsers(fake.http, TARGET), (error: Error) => error === failure);
  });
});

// ---------------------------------------------------------------------------
// addAssignees and removeAssignees
// ---------------------------------------------------------------------------

type AssigneeWrite = (
  http: HttpClient,
  target: GitHubTarget,
  issueNumber: number,
  logins: readonly string[],
) => Promise<readonly GitHubAssignee[]>;

/** Each write with its name, method, the status GitHub answers it with (live) and its wording in errors. */
const WRITES: readonly (readonly [string, AssigneeWrite, "POST" | "DELETE", number, string])[] = [
  ["addAssignees", addAssignees, "POST", 201, "add"],
  ["removeAssignees", removeAssignees, "DELETE", 200, "remove"],
];

for (const [name, write, method, status, verb] of WRITES) {
  describe(name, () => {
    it(`${method}s a plain string array to the issue's assignees with retry-once`, async () => {
      // Arrange
      const fake = createFakeHttp([{ status, body: issueJson({ number: 21 }) }]);

      // Act
      await write(fake.http, TARGET, 21, [STUDENT_LOGIN, OTHER_STUDENT_LOGIN]);

      // Assert
      assert.equal(fake.requests.length, 1);
      const request = requestAt(fake.requests, 0);
      assert.equal(request.method, method);
      assert.equal(request.url, `${ISSUES_URL}/21/assignees`);
      assert.deepEqual(request.headers, EXPECTED_HEADERS);
      assert.equal(request.retry, "retry-once");
      assert.equal(JSON.stringify(request.body), '{"assignees":["jdoe123456","JaneDoe123456"]}');
    });

    it("sends the logins verbatim, in order, in a new array", async () => {
      // Arrange
      const logins = [OTHER_STUDENT_LOGIN, STAFF_LOGIN];
      const fake = createFakeHttp([{ status, body: issueJson({ number: 21 }) }]);

      // Act
      await write(fake.http, TARGET, 21, logins);

      // Assert
      const body = requestAt(fake.requests, 0).body;
      assert.deepEqual(body, { assignees: [OTHER_STUDENT_LOGIN, STAFF_LOGIN] });
      assert.notEqual(body.assignees, logins);
    });

    it("returns the assignees of the answered issue as GitHub spells them", async () => {
      // Arrange: write bodies ignore case; the answer spells the login as GitHub does (live).
      const answer = issueJson({ number: 21, assignees: [userJson(STUDENT_LOGIN), userJson(BOT_LOGIN, "Bot")] });
      const fake = createFakeHttp([{ status, body: answer }]);

      // Act
      const assignees = await write(fake.http, TARGET, 21, ["JDOE123456"]);

      // Assert
      assert.deepEqual(assignees, [
        { login: STUDENT_LOGIN, type: "User" },
        { login: BOT_LOGIN, type: "Bot" },
      ]);
    });

    it(`resolves with the answer when GitHub silently ignored a login (live: HTTP ${String(status)})`, async () => {
      // Arrange: a login that cannot be assigned is not an error; the answer simply lacks it.
      const answer = issueJson({ number: 21, assignees: [userJson(STUDENT_LOGIN)] });
      const fake = createFakeHttp([{ status, body: answer }]);

      // Act
      const assignees = await write(fake.http, TARGET, 21, [STUDENT_LOGIN, OTHER_STUDENT_LOGIN]);

      // Assert
      assert.deepEqual(assignees, [{ login: STUDENT_LOGIN, type: "User" }]);
    });

    it("reads an answer without assignees as none", async () => {
      const fake = createFakeHttp([{ status, body: issueJson({ number: 21 }) }]);
      assert.deepEqual(await write(fake.http, TARGET, 21, [STUDENT_LOGIN]), []);
    });

    it(`accepts exactly ${String(MAX_ASSIGNEES_PER_ISSUE)} logins`, async () => {
      // Arrange
      const logins = Array.from({ length: MAX_ASSIGNEES_PER_ISSUE }, (_, index) => `user${String(index)}`);
      const fake = createFakeHttp([{ status, body: issueJson({ number: 21 }) }]);

      // Act
      await write(fake.http, TARGET, 21, logins);

      // Assert
      assert.deepEqual(requestAt(fake.requests, 0).body, { assignees: logins });
    });

    for (const count of [0, MAX_ASSIGNEES_PER_ISSUE + 1]) {
      it(`refuses ${String(count)} logins before sending anything`, async () => {
        // Arrange
        const logins = Array.from({ length: count }, () => STUDENT_LOGIN);
        const fake = createFakeHttp([]);

        // Act + Assert
        await assert.rejects(write(fake.http, TARGET, 21, logins), {
          name: "RangeError",
          message: new RegExp(`^GitHub ${verb} assignees needs 1 to 10 logins, got ${String(count)}$`),
        });
        assert.equal(fake.requests.length, 0);
      });
    }

    it("refuses an empty login before sending anything, naming its position only", async () => {
      // Arrange
      const fake = createFakeHttp([]);

      // Act + Assert
      await assert.rejects(write(fake.http, TARGET, 21, [STUDENT_LOGIN, "", STAFF_LOGIN]), {
        name: "RangeError",
        message: new RegExp(`^GitHub ${verb} assignees: login 2 is empty$`),
      });
      await assert.rejects(write(fake.http, TARGET, 21, [STUDENT_LOGIN, ""]), identityFree);
      assert.equal(fake.requests.length, 0);
    });

    for (const issueNumber of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      it(`refuses issue number ${String(issueNumber)} before sending anything`, async () => {
        const fake = createFakeHttp([]);
        await assert.rejects(write(fake.http, TARGET, issueNumber, [STUDENT_LOGIN]), {
          name: "RangeError",
          message: /GitHub issue number must be a positive integer/,
        });
        assert.equal(fake.requests.length, 0);
      });
    }

    for (const body of [null, [userJson(STUDENT_LOGIN)], STUDENT_LOGIN, 201] as const) {
      it(`rejects a non-object answer ${JSON.stringify(body)} without echoing it`, async () => {
        const fake = createFakeHttp([{ status, body }]);
        await assert.rejects(
          write(fake.http, TARGET, 21, [STUDENT_LOGIN]),
          schemaError(new RegExp(`^GitHub ${verb} assignees answer for issue #21 must be a JSON object, got `)),
        );
        await assert.rejects(write(createFakeHttp([{ status, body }]).http, TARGET, 21, [STUDENT_LOGIN]), identityFree);
      });
    }

    it("rejects an answer whose assignees is not an array, naming the issue but no login", async () => {
      // Arrange
      const body = issueJson({ number: 21, assignees: { login: STUDENT_LOGIN } });

      // Act + Assert
      await assert.rejects(
        write(createFakeHttp([{ status, body }]).http, TARGET, 21, [STUDENT_LOGIN]),
        schemaError(/^GitHub issue #21: "assignees" must be an array/),
      );
      await assert.rejects(write(createFakeHttp([{ status, body }]).http, TARGET, 21, [STUDENT_LOGIN]), identityFree);
    });

    it("percent-encodes owner and repo and refuses a dot-segment owner before any request", async () => {
      // Arrange
      const fake = createFakeHttp([{ status, body: issueJson({ number: 3 }) }]);

      // Act
      await write(fake.http, { owner: "o w", repo: "r?x", token: TOKEN }, 3, [STUDENT_LOGIN]);

      // Assert
      assert.equal(requestAt(fake.requests, 0).url, "https://api.github.com/repos/o%20w/r%3Fx/issues/3/assignees");
      await assert.rejects(write(fake.http, { owner: ".", repo: "r", token: TOKEN }, 3, [STUDENT_LOGIN]), RangeError);
      assert.equal(fake.requests.length, 1);
    });

    it("propagates an HttpError unchanged (stage 2 classifies it)", async () => {
      // Arrange: a 422 body may name a login; this module passes it on as it is.
      const url = `${ISSUES_URL}/21/assignees`;
      const failure = new HttpError(method, url, 422, `{"message":"${STUDENT_LOGIN} cannot be assigned"}`);
      const fake = createFakeHttp([], failure);

      // Act + Assert
      await assert.rejects(write(fake.http, TARGET, 21, [STUDENT_LOGIN]), (error: Error) => error === failure);
    });
  });
}
