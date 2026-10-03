import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { GitHubTarget } from "../../src/github/client.ts";
import { findCommitAuthor, searchUsersByEmail } from "../../src/github/users.ts";
import { HttpError } from "../../src/http.ts";
import type { HttpClient } from "../../src/http.ts";
import type { JsonObject, JsonValue } from "../../src/json.ts";
import {
  COMMITS_LOOKUP_URL,
  createFakeHttp,
  EXPECTED_HEADERS,
  hasNoIdentity,
  OTHER_STUDENT_LOGIN,
  requestAt,
  schemaError,
  SEARCH_LOOKUP_URL,
  STAFF_LOGIN,
  STUDENT_EMAIL,
  STUDENT_LOGIN,
  TARGET,
  TOKEN,
  userJson,
} from "./fixtures.ts";

/** Emails without exactly one "@"; the lookups refuse them before any request. */
const BAD_EMAILS = ["", "123456", "123456@buas.nl@x", "@@", "jdoe123456 at buas.nl"] as const;

/** An error whose message names none of the placeholder people. */
function identityFree(error: Error): boolean {
  return hasNoIdentity(error.message);
}

/** A commit as GET /repos/{o}/{r}/commits lists it: the git author, and the linked account or null. */
function commitJson(author: JsonValue): JsonObject {
  return {
    sha: "0123456789abcdef0123456789abcdef01234567",
    commit: { author: { name: "J. Doe", email: STUDENT_EMAIL, date: "2026-09-30T12:00:00Z" }, message: "Fix" },
    author,
    committer: null,
  };
}

/** A user search answer with these items. */
function searchJson(items: JsonValue): JsonObject {
  const count = Array.isArray(items) ? items.length : 0;
  return { total_count: count, incomplete_results: false, items };
}

type Lookup<Result> = (http: HttpClient, target: GitHubTarget, email: string) => Promise<Result>;

/** The cases both lookups share: email checks, error messages and HttpError propagation. */
function sharedLookupCases<Result>(lookup: Lookup<Result>, name: string, url: string, answer: JsonValue): void {
  for (const email of BAD_EMAILS) {
    it(`refuses the email ${JSON.stringify(email)} before sending anything, without echoing it`, async () => {
      const fake = createFakeHttp([]);
      await assert.rejects(lookup(fake.http, TARGET, email), {
        name: "RangeError",
        message: new RegExp(`^GitHub ${name} needs an email with exactly one "@"$`),
      });
      await assert.rejects(lookup(fake.http, TARGET, email), identityFree);
      assert.equal(fake.requests.length, 0);
    });
  }

  it("GETs with GitHub headers, retry-once and no body", async () => {
    // Arrange
    const fake = createFakeHttp([{ body: answer }]);

    // Act
    await lookup(fake.http, TARGET, STUDENT_EMAIL);

    // Assert
    assert.equal(fake.requests.length, 1);
    const request = requestAt(fake.requests, 0);
    assert.equal(request.method, "GET");
    assert.equal(request.url, url);
    assert.deepEqual(request.headers, EXPECTED_HEADERS);
    assert.equal(request.retry, "retry-once");
    assert.equal("body" in request, false);
  });

  for (const status of [403, 404, 409, 422, 502]) {
    it(`propagates an HttpError ${String(status)} unchanged (stage 2 classifies it)`, async () => {
      const failure = new HttpError("GET", url, status, '{"message":"no"}');
      const fake = createFakeHttp([], failure);
      await assert.rejects(lookup(fake.http, TARGET, STUDENT_EMAIL), (error: Error) => error === failure);
    });
  }
}

// ---------------------------------------------------------------------------
// findCommitAuthor (step c)
// ---------------------------------------------------------------------------

describe("findCommitAuthor", () => {
  sharedLookupCases(findCommitAuthor, "commit lookup", COMMITS_LOOKUP_URL, []);

  it("builds author=<email>&per_page=1 with URLSearchParams", async () => {
    // Arrange: "+" must not reach GitHub as a space, nor "&" or "#" split the query.
    const fake = createFakeHttp([{ body: [] }, { body: [] }]);

    // Act
    await findCommitAuthor(fake.http, TARGET, "jdoe+x@buas.nl");
    await findCommitAuthor(fake.http, TARGET, "a&b#c@buas.nl");

    // Assert
    assert.deepEqual(
      fake.requests.map((request) => request.url),
      [
        "https://api.github.com/repos/BredaUniversityADSAI/mirror-repo/commits?author=jdoe%2Bx%40buas.nl&per_page=1",
        "https://api.github.com/repos/BredaUniversityADSAI/mirror-repo/commits?author=a%26b%23c%40buas.nl&per_page=1",
      ],
    );
  });

  it("sends the email as given (GitHub's author filter ignores case, live)", async () => {
    const fake = createFakeHttp([{ body: [] }]);
    await findCommitAuthor(fake.http, TARGET, "123456@BUAS.NL");
    assert.match(requestAt(fake.requests, 0).url, /\?author=123456%40BUAS\.NL&per_page=1$/);
  });

  it("returns null when no commit has that author email", async () => {
    const fake = createFakeHttp([{ body: [] }]);
    assert.equal(await findCommitAuthor(fake.http, TARGET, STUDENT_EMAIL), null);
  });

  it("returns null when the commit's email is linked to no account (top-level author null)", async () => {
    for (const author of [null, undefined]) {
      const commit = author === null ? commitJson(null) : withoutAuthor(commitJson(null));
      const fake = createFakeHttp([{ body: [commit] }]);
      assert.equal(await findCommitAuthor(fake.http, TARGET, STUDENT_EMAIL), null);
    }
  });

  it("returns null when the linked account is a Bot", async () => {
    const fake = createFakeHttp([{ body: [commitJson(userJson("github-actions[bot]", "Bot"))] }]);
    assert.equal(await findCommitAuthor(fake.http, TARGET, STUDENT_EMAIL), null);
  });

  it("returns null for an account without a type (only User counts)", async () => {
    const fake = createFakeHttp([{ body: [commitJson({ login: STUDENT_LOGIN })] }]);
    assert.equal(await findCommitAuthor(fake.http, TARGET, STUDENT_EMAIL), null);
  });

  it("returns the login of the linked User verbatim", async () => {
    const fake = createFakeHttp([{ body: [commitJson(userJson(OTHER_STUDENT_LOGIN))] }]);
    assert.equal(await findCommitAuthor(fake.http, TARGET, STUDENT_EMAIL), OTHER_STUDENT_LOGIN);
  });

  it("reads only the first commit", async () => {
    const fake = createFakeHttp([{ body: [commitJson(null), commitJson(userJson(STUDENT_LOGIN))] }]);
    assert.equal(await findCommitAuthor(fake.http, TARGET, STUDENT_EMAIL), null);
  });

  for (const [description, body, message] of [
    ["an object", { message: STUDENT_EMAIL }, /commits page must be a JSON array, got an object$/],
    ["a string", STUDENT_LOGIN, /commits page must be a JSON array, got a string$/],
    ["null", null, /commits page must be a JSON array, got null$/],
    ["a page whose first commit is a string", [STUDENT_LOGIN], /commit 1 must be a JSON object, got a string$/],
    ["an author that is a string", [commitJson(STUDENT_LOGIN)], /"author" must be an object or null, got a string$/],
    [
      "a User author whose login is a number",
      [commitJson({ login: 123_456, type: "User" })],
      /"author\.login" must be a non-empty string, got a number$/,
    ],
    [
      "a User author with an empty login",
      [commitJson({ login: "", type: "User" })],
      /"author\.login" must be a non-empty string, got a string$/,
    ],
  ] as const) {
    it(`rejects ${description} without echoing a login or email`, async () => {
      await assert.rejects(
        findCommitAuthor(createFakeHttp([{ body }]).http, TARGET, STUDENT_EMAIL),
        schemaError(new RegExp(`^GitHub commit lookup: .*${message.source}`)),
      );
      await assert.rejects(findCommitAuthor(createFakeHttp([{ body }]).http, TARGET, STUDENT_EMAIL), identityFree);
    });
  }

  it("percent-encodes owner and repo and refuses a dot-segment repo before any request", async () => {
    // Arrange
    const fake = createFakeHttp([{ body: [] }]);

    // Act
    await findCommitAuthor(fake.http, { owner: "o w", repo: "r#1", token: TOKEN }, STUDENT_EMAIL);

    // Assert
    assert.equal(
      requestAt(fake.requests, 0).url,
      "https://api.github.com/repos/o%20w/r%231/commits?author=123456%40buas.nl&per_page=1",
    );
    await assert.rejects(findCommitAuthor(fake.http, { owner: "o", repo: "..", token: TOKEN }, STUDENT_EMAIL), {
      name: "RangeError",
    });
    assert.equal(fake.requests.length, 1);
  });
});

function withoutAuthor(commit: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(commit).filter(([key]) => key !== "author"));
}

// ---------------------------------------------------------------------------
// searchUsersByEmail (step d)
// ---------------------------------------------------------------------------

describe("searchUsersByEmail", () => {
  sharedLookupCases(searchUsersByEmail, "user search", SEARCH_LOOKUP_URL, searchJson([]));

  it('builds q="<email>" in:email type:user&per_page=100 with URLSearchParams', async () => {
    // Arrange
    const fake = createFakeHttp([{ body: searchJson([]) }]);

    // Act
    await searchUsersByEmail(fake.http, TARGET, "jdoe+x@buas.nl");

    // Assert
    assert.equal(
      requestAt(fake.requests, 0).url,
      "https://api.github.com/search/users?q=%22jdoe%2Bx%40buas.nl%22+in%3Aemail+type%3Auser&per_page=100",
    );
  });

  it("does not depend on the repository: only the token is used", async () => {
    // Arrange
    const fake = createFakeHttp([{ body: searchJson([]) }]);

    // Act
    await searchUsersByEmail(fake.http, { owner: "..", repo: "..", token: TOKEN }, STUDENT_EMAIL);

    // Assert
    assert.equal(requestAt(fake.requests, 0).url, SEARCH_LOOKUP_URL);
    assert.deepEqual(requestAt(fake.requests, 0).headers, EXPECTED_HEADERS);
  });

  it("returns [] when nobody has that public email (live: 0 hits)", async () => {
    const fake = createFakeHttp([{ body: searchJson([]) }]);
    assert.deepEqual(await searchUsersByEmail(fake.http, TARGET, STUDENT_EMAIL), []);
  });

  it("returns the logins of the User items only, verbatim and in order", async () => {
    // Arrange
    const items = [
      userJson(OTHER_STUDENT_LOGIN),
      userJson("some-org", "Organization"),
      userJson("a-bot[bot]", "Bot"),
      { login: "no-type" },
      userJson(STAFF_LOGIN),
    ];
    const fake = createFakeHttp([{ body: searchJson(items) }]);

    // Act
    const logins = await searchUsersByEmail(fake.http, TARGET, STUDENT_EMAIL);

    // Assert
    assert.deepEqual(logins, [OTHER_STUDENT_LOGIN, STAFF_LOGIN]);
  });

  for (const [description, body, message] of [
    ["an array", [userJson(STUDENT_LOGIN)], /answer must be a JSON object, got an array$/],
    ["a string", STUDENT_EMAIL, /answer must be a JSON object, got a string$/],
    ["an answer without items", { total_count: 0 }, /"items" must be an array, got nothing$/],
    ["items that are an object", searchJson(userJson(STUDENT_LOGIN)), /"items" must be an array, got an object$/],
    ["an item that is a string", searchJson([STUDENT_LOGIN]), /item 1 must be a JSON object, got a string$/],
    [
      "a User item whose login is null",
      searchJson([userJson(STAFF_LOGIN), { login: null, type: "User" }]),
      /item 2 "login" must be a non-empty string, got null$/,
    ],
  ] as const) {
    it(`rejects ${description} without echoing a login or email`, async () => {
      await assert.rejects(
        searchUsersByEmail(createFakeHttp([{ body }]).http, TARGET, STUDENT_EMAIL),
        schemaError(new RegExp(`^GitHub user search: .*${message.source}`)),
      );
      await assert.rejects(searchUsersByEmail(createFakeHttp([{ body }]).http, TARGET, STUDENT_EMAIL), identityFree);
    });
  }
});
