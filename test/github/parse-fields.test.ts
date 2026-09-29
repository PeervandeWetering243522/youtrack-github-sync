import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { GitHubTarget } from "../../src/github/client.ts";
import { createIssue, listAllIssues, parseGitHubIssue, updateIssue } from "../../src/github/issues.ts";
import type { GitHubIssue } from "../../src/github/issues.ts";
import type { JsonValue } from "../../src/json.ts";
import {
  createFakeHttp,
  DEFAULT_ISSUE_ID,
  ISSUES_URL,
  issueJson,
  milestoneJson,
  NO_HIERARCHY,
  parentUrl,
  REPO_URL,
  schemaError,
  TARGET,
  TOKEN,
  withoutKey,
} from "./fixtures.ts";

function parse(value: JsonValue, target: GitHubTarget = TARGET): GitHubIssue {
  return parseGitHubIssue(value, target);
}

function parentOf(
  url: JsonValue,
  target: GitHubTarget = TARGET,
): Pick<GitHubIssue, "parentNumber" | "parentIsForeign"> {
  const { parentNumber, parentIsForeign } = parse(issueJson({ parent_issue_url: url }), target);
  return { parentNumber, parentIsForeign };
}

const FOREIGN = { parentNumber: null, parentIsForeign: true } as const;

// ---------------------------------------------------------------------------
// id
// ---------------------------------------------------------------------------

describe("parseGitHubIssue: id", () => {
  it("reads the numeric id, which differs from the issue number", () => {
    const issue = parse(issueJson({ number: 21, id: 3_456_789_012 }));
    assert.equal(issue.id, 3_456_789_012);
    assert.equal(issue.number, 21);
  });

  it("accepts the largest safe integer as id", () => {
    assert.equal(parse(issueJson({ id: Number.MAX_SAFE_INTEGER })).id, Number.MAX_SAFE_INTEGER);
  });

  it("rejects a missing id and names the issue", () => {
    assert.throws(
      () => parse(withoutKey(issueJson({ number: 4 }), "id")),
      schemaError(/^GitHub issue #4: "id" must be a positive integer, got nothing$/),
    );
  });

  for (const value of [0, -1, 1.5, 2 ** 53, "3400000001", null, true, [1], { id: 1 }]) {
    it(`rejects id = ${JSON.stringify(value)}`, () => {
      assert.throws(
        () => parse(issueJson({ number: 4, id: value })),
        schemaError(/#4: "id" must be a positive integer/),
      );
    });
  }

  it("checks number and title before id", () => {
    const noId = withoutKey(issueJson(), "id");
    assert.throws(() => parse({ ...noId, number: 0 }), schemaError(/"number"/));
    assert.throws(() => parse({ ...noId, title: null }), schemaError(/"title"/));
  });
});

// ---------------------------------------------------------------------------
// milestone
// ---------------------------------------------------------------------------

describe("parseGitHubIssue: milestone", () => {
  it("reads milestone.number from a full milestone object", () => {
    assert.equal(parse(issueJson({ milestone: milestoneJson({ number: 3 }) })).milestoneNumber, 3);
  });

  it("needs only the number key of the milestone object", () => {
    assert.equal(parse(issueJson({ milestone: { number: 12 } })).milestoneNumber, 12);
  });

  it("reads a missing milestone key and a null milestone as no milestone", () => {
    assert.equal(parse(issueJson()).milestoneNumber, null);
    assert.equal(parse(issueJson({ milestone: null })).milestoneNumber, null);
  });

  for (const value of ["v1", 3, true, [{ number: 3 }]]) {
    it(`rejects milestone = ${JSON.stringify(value)}`, () => {
      assert.throws(
        () => parse(issueJson({ number: 6, milestone: value })),
        schemaError(/#6: "milestone" must be an object or null/),
      );
    });
  }

  for (const value of [{}, { number: 0 }, { number: -2 }, { number: 1.5 }, { number: "3" }, { number: null }]) {
    it(`rejects milestone ${JSON.stringify(value)} without a positive integer number`, () => {
      assert.throws(
        () => parse(issueJson({ number: 6, milestone: value })),
        schemaError(/#6: "milestone\.number" must be a positive integer/),
      );
    });
  }
});

// ---------------------------------------------------------------------------
// type
// ---------------------------------------------------------------------------

describe("parseGitHubIssue: type", () => {
  it("reads type.name from a full issue type object", () => {
    const type = { id: 7, node_id: "IT_1", name: "Task", description: null, color: "yellow", is_enabled: true };
    assert.equal(parse(issueJson({ type })).typeName, "Task");
  });

  for (const name of ["Feature", "Bug", "task", "Epic", "", "ü 😀"]) {
    it(`keeps the type name ${JSON.stringify(name)} verbatim`, () => {
      assert.equal(parse(issueJson({ type: { name } })).typeName, name);
    });
  }

  it("reads a missing type key and a null type as no type", () => {
    assert.equal(parse(issueJson()).typeName, null);
    assert.equal(parse(issueJson({ type: null })).typeName, null);
  });

  for (const value of ["Task", 1, false, [{ name: "Task" }]]) {
    it(`rejects type = ${JSON.stringify(value)}`, () => {
      assert.throws(
        () => parse(issueJson({ number: 8, type: value })),
        schemaError(/#8: "type" must be an object or null/),
      );
    });
  }

  for (const value of [{}, { name: null }, { name: 3 }, { name: ["Task"] }]) {
    it(`rejects type ${JSON.stringify(value)} without a string name`, () => {
      assert.throws(
        () => parse(issueJson({ number: 8, type: value })),
        schemaError(/#8: "type\.name" must be a string/),
      );
    });
  }
});

// ---------------------------------------------------------------------------
// parent_issue_url
// ---------------------------------------------------------------------------

describe("parseGitHubIssue: parent_issue_url", () => {
  it("reads a missing key and a null value as no parent", () => {
    const expected = { parentNumber: null, parentIsForeign: false };
    assert.deepEqual(parentOf(null), expected);
    const { parentNumber, parentIsForeign } = parse(issueJson());
    assert.deepEqual({ parentNumber, parentIsForeign }, expected);
  });

  it("reads the parent number from this repository's issue URL", () => {
    assert.deepEqual(parentOf(parentUrl(24)), { parentNumber: 24, parentIsForeign: false });
  });

  it("compares owner and repo case-insensitively", () => {
    const url = "https://api.github.com/repos/bredauniversityadsai/MIRROR-REPO/issues/24";
    assert.deepEqual(parentOf(url), { parentNumber: 24, parentIsForeign: false });
  });

  it("matches a target whose owner or repo needs percent-encoding", () => {
    const target: GitHubTarget = { owner: "A b", repo: "r", token: TOKEN };
    assert.deepEqual(parentOf("https://api.github.com/repos/a%20B/R/issues/3", target), {
      parentNumber: 3,
      parentIsForeign: false,
    });
  });

  it("accepts the largest safe parent number", () => {
    assert.equal(parentOf(parentUrl(Number.MAX_SAFE_INTEGER)).parentNumber, Number.MAX_SAFE_INTEGER);
  });

  for (const url of [
    "https://api.github.com/repos/BredaUniversityADSAI/other-repo/issues/5",
    "https://api.github.com/repos/someone-else/mirror-repo/issues/5",
    "https://api.github.com/repos/BredaUniversityADSAI/mirror-repo-2/issues/5",
    "https://api.github.com/repos/BredaUniversityADSAI/mirror/issues/5",
    "https://api.github.com/repos/BredaUniversityADSAIx/mirror-repo/issues/5",
    "https://api.github.com/repositories/123456/issues/5",
    "https://github.com/BredaUniversityADSAI/mirror-repo/issues/5",
    "http://api.github.com/repos/BredaUniversityADSAI/mirror-repo/issues/5",
    "HTTPS://API.GITHUB.COM/repos/BredaUniversityADSAI/mirror-repo/issues/5",
    "https://api.github.com/REPOS/BredaUniversityADSAI/mirror-repo/issues/5",
    "https://api.github.com.evil.example/repos/BredaUniversityADSAI/mirror-repo/issues/5",
    "https://api.github.com/repos/BredaUniversityADSAI/mirror-repo?x/issues/5",
    "https://api.github.com/repos/BredaUniversityADSAI%2Fmirror-repo/issues/5",
    "",
    "not a url",
  ]) {
    it(`flags ${JSON.stringify(url)} as a foreign parent`, () => {
      assert.deepEqual(parentOf(url), FOREIGN);
    });
  }

  it("folds the case of the configured target too, not only of the URL", () => {
    const target: GitHubTarget = { owner: "bredauniversityadsai", repo: "Mirror-REPO", token: TOKEN };
    assert.deepEqual(parentOf(parentUrl(24), target), { parentNumber: 24, parentIsForeign: false });
  });

  for (const url of [`${REPO_URL}//issues/5`, `${ISSUES_URL}/5 `, `${ISSUES_URL}/5\n`, `${REPO_URL}/ISSUES/5`]) {
    it(`rejects the near-miss issue URL ${JSON.stringify(url.slice(REPO_URL.length))} instead of guessing`, () => {
      assert.throws(
        () => parse(issueJson({ number: 2, parent_issue_url: url })),
        schemaError(/#2: "parent_issue_url" is in this repository but is not an issue URL/),
      );
    });
  }

  it("folds only ASCII letters: a Kelvin sign that lowercases to k is another owner", () => {
    const target: GitHubTarget = { owner: "kit", repo: "r", token: TOKEN };
    assert.deepEqual(parentOf("https://api.github.com/repos/Kit/r/issues/5", target), FOREIGN);
    assert.equal(parentOf("https://api.github.com/repos/KIT/r/issues/5", target).parentNumber, 5);
  });

  for (const url of [
    `${REPO_URL}/pulls/5`,
    `${ISSUES_URL}/0`,
    `${ISSUES_URL}/007`,
    `${ISSUES_URL}/-5`,
    `${ISSUES_URL}/1e3`,
    `${ISSUES_URL}/abc`,
    `${ISSUES_URL}/5/`,
    `${ISSUES_URL}/5/comments`,
    `${ISSUES_URL}/5?page=2`,
    `${ISSUES_URL}/5#x`,
    `${ISSUES_URL}/9007199254740992`,
    `${ISSUES_URL}/`,
    ISSUES_URL,
    REPO_URL,
  ]) {
    it(`rejects ${JSON.stringify(url.slice(REPO_URL.length))} after this repository's URL`, () => {
      assert.throws(
        () => parse(issueJson({ number: 2, parent_issue_url: url })),
        schemaError(/#2: "parent_issue_url" is in this repository but is not an issue URL/),
      );
    });
  }

  it("quotes the part after the repository URL of a rejected parent", () => {
    assert.throws(
      () => parse(issueJson({ parent_issue_url: `${REPO_URL}/pulls/5` })),
      (error: Error) => error.message.endsWith(': "pulls/5"'),
    );
  });

  for (const value of [5, true, {}, [parentUrl(5)]]) {
    it(`rejects parent_issue_url = ${JSON.stringify(value)}`, () => {
      assert.throws(
        () => parse(issueJson({ number: 2, parent_issue_url: value })),
        schemaError(/#2: "parent_issue_url" must be a string or null/),
      );
    });
  }

  it("refuses a dot-segment target instead of matching against it", () => {
    const target: GitHubTarget = { owner: "..", repo: "r", token: TOKEN };
    assert.throws(() => parentOf("https://api.github.com/repos/../r/issues/5", target), RangeError);
  });
});

// ---------------------------------------------------------------------------
// All hierarchy fields together
// ---------------------------------------------------------------------------

describe("parseGitHubIssue: hierarchy fields together", () => {
  it("parses a sub-issue with milestone and type", () => {
    // Arrange
    const raw = issueJson({
      number: 25,
      title: "[YT-40] Task",
      milestone: milestoneJson({ number: 2, title: "[YT-33] Epic", state: "closed" }),
      type: { id: 3, name: "Task" },
      parent_issue_url: parentUrl(24),
      sub_issues_summary: { total: 0, completed: 0, percent_completed: 0 },
    });

    // Act
    const issue = parse(raw);

    // Assert
    const expected: GitHubIssue = {
      number: 25,
      id: DEFAULT_ISSUE_ID,
      title: "[YT-40] Task",
      state: "open",
      labelNames: [],
      isPullRequest: false,
      milestoneNumber: 2,
      typeName: "Task",
      parentNumber: 24,
      parentIsForeign: false,
    };
    assert.deepEqual(issue, expected);
  });

  it("gives an issue without hierarchy keys the empty hierarchy", () => {
    const { milestoneNumber, typeName, parentNumber, parentIsForeign } = parse(issueJson());
    assert.deepEqual({ milestoneNumber, typeName, parentNumber, parentIsForeign }, NO_HIERARCHY);
  });
});

// ---------------------------------------------------------------------------
// The calls that parse issues pass their own target to the parser
// ---------------------------------------------------------------------------

/** Another repository of another owner; the fixture repository's parent URLs are foreign to it. */
const OTHER: GitHubTarget = { owner: "someone", repo: "else", token: TOKEN };
const OTHER_PARENT = "https://api.github.com/repos/someone/else/issues/3";

/** [parentNumber, parentIsForeign] of each issue. */
function parents(issues: readonly GitHubIssue[]): readonly (readonly [number | null, boolean])[] {
  return issues.map((issue) => [issue.parentNumber, issue.parentIsForeign] as const);
}

describe("parseGitHubIssue: the target comes from the calling function", () => {
  it("listAllIssues parses id, milestone, type and parent of every listed issue", async () => {
    // Arrange
    const sub = issueJson({ number: 25, id: 77, milestone: { number: 2 }, type: { name: "Task" } });
    const foreign = issueJson({ number: 26, parent_issue_url: `${REPO_URL}-other/issues/1` });
    const fake = createFakeHttp([{ body: [{ ...sub, parent_issue_url: parentUrl(24) }, foreign] }]);

    // Act
    const [first, second] = await listAllIssues(fake.http, TARGET);

    // Assert
    assert.deepEqual(
      [first?.id, first?.milestoneNumber, first?.typeName, first?.parentNumber, first?.parentIsForeign],
      [77, 2, "Task", 24, false],
    );
    assert.deepEqual([second?.parentNumber, second?.parentIsForeign], [null, true]);
  });

  it("listAllIssues rejects a listed issue without an id", async () => {
    const fake = createFakeHttp([{ body: [withoutKey(issueJson({ number: 3 }), "id")] }]);
    await assert.rejects(listAllIssues(fake.http, TARGET), schemaError(/#3: "id" must be a positive integer/));
  });

  it("listAllIssues resolves parents against the listed repository, not a fixed one", async () => {
    // Arrange
    const body = [issueJson({ parent_issue_url: parentUrl(24) }), issueJson({ parent_issue_url: OTHER_PARENT })];
    const fake = createFakeHttp([{ body }]);

    // Act
    const issues = await listAllIssues(fake.http, OTHER);

    // Assert
    assert.deepEqual(parents(issues), [
      [null, true],
      [3, false],
    ]);
  });

  it("createIssue resolves the new issue's parent against its own target", async () => {
    // Arrange
    const fake = createFakeHttp([
      { status: 201, body: issueJson({ parent_issue_url: OTHER_PARENT }) },
      { status: 201, body: issueJson({ parent_issue_url: OTHER_PARENT }) },
    ]);

    // Act
    const onOther = await createIssue(fake.http, OTHER, { title: "[YT-1] t" });
    const onFixture = await createIssue(fake.http, TARGET, { title: "[YT-1] t" });

    // Assert
    assert.deepEqual(parents([onOther, onFixture]), [
      [3, false],
      [null, true],
    ]);
  });

  it("updateIssue resolves the updated issue's parent against its own target", async () => {
    // Arrange
    const fake = createFakeHttp([
      { body: issueJson({ parent_issue_url: OTHER_PARENT }) },
      { body: issueJson({ parent_issue_url: OTHER_PARENT }) },
    ]);

    // Act
    const onOther = await updateIssue(fake.http, OTHER, 1, { type: "Task" });
    const onFixture = await updateIssue(fake.http, TARGET, 1, { type: "Task" });

    // Assert
    assert.deepEqual(parents([onOther, onFixture]), [
      [3, false],
      [null, true],
    ]);
  });
});
