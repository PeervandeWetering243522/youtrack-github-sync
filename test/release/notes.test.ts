/**
 * Release notes (V5, V6): the conventional-changelog notes, with each breaking PR's
 * "## Upgrading" section as its note and any other PR's section under "Before updating". Runs
 * the real notes generator; only the PR lookup is faked.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { generateNotes } from "../../scripts/release/notes.ts";
import { gitHubTarget, mergedPullRequest } from "../../scripts/release/pull-request.ts";
import type { NotesContext, ReleaseCommit } from "../../scripts/release/release-notes.ts";
import { releaseNotes } from "../../scripts/release/release-notes.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const REPO = "https://github.com/owner/repo";
const CONFIG = { preset: "conventionalcommits" };

type Recorded = { readonly context: NotesContext; readonly warnings: readonly string[] };

function contextWith(commits: readonly ReleaseCommit[], env: Readonly<Record<string, string>> = {}): Recorded {
  const warnings: string[] = [];
  const context: NotesContext = {
    commits,
    lastRelease: { gitTag: "v1.0.0", gitHead: "1".repeat(40) },
    nextRelease: { version: "2.0.0", gitTag: "v2.0.0", gitHead: SHA_A },
    options: { repositoryUrl: `${REPO}.git` },
    cwd: process.cwd(),
    env,
    logger: {
      warn: (message: string) => {
        warnings.push(message);
      },
    },
  };
  return { context, warnings };
}

/** The notes without their first line, the version header, which carries today's date. */
function body(notes: string): string {
  return notes.slice(notes.indexOf("\n") + 1);
}

const link = (sha: string): string => `([${sha.slice(0, 7)}](${REPO}/commit/${sha}))`;
const pr = (n: number): string => `([#${String(n)}](${REPO}/issues/${String(n)}))`;

describe("releaseNotes", () => {
  it("puts a breaking PR's Upgrading section under BREAKING CHANGES, verbatim and indented", async () => {
    const { context, warnings } = contextWith([
      { hash: SHA_A, message: "feat!: assign mirrors (#8)" },
      { hash: SHA_B, message: "fix(deps): bump setup-node (#9)" },
    ]);
    const section = "Add `contents: read`.\n\nbreaking change in prose.\nCloses #12\n\n```yaml\n# comment\n```";
    const looked: string[] = [];
    const notes = await releaseNotes(CONFIG, context, (commit) => {
      looked.push(commit.hash);
      return Promise.resolve(commit.hash === SHA_A ? section : null);
    });
    assert.equal(
      body(notes),
      [
        "",
        "### ⚠ BREAKING CHANGES",
        "",
        "* Add `contents: read`.",
        "",
        "  breaking change in prose.",
        "  Closes #12",
        "",
        "  ```yaml",
        "  # comment",
        "  ```",
        "",
        "### Features",
        "",
        `* assign mirrors ${pr(8)} ${link(SHA_A)}`,
        "",
        "### Bug Fixes",
        "",
        `* **deps:** bump setup-node ${pr(9)} ${link(SHA_B)}`,
        "",
      ].join("\n"),
    );
    assert.deepEqual(looked, [SHA_A, SHA_B], "every commit is looked up");
    assert.deepEqual(warnings, []);
  });

  it("lists a non-breaking PR's Upgrading section under Before updating, after the breaking changes", async () => {
    const { context, warnings } = contextWith([
      { hash: SHA_A, message: "feat!: assign mirrors (#8)" },
      { hash: SHA_B, message: "feat(sync): sync bodies (#16)" },
      { hash: SHA_C, message: "fix: a fix (#17)" },
    ]);
    const sections = new Map([
      [SHA_A, "Add `contents: read`."],
      [SHA_B, "Bodies now follow YouTrack.\n\n- Edits on GitHub are reverted."],
    ]);
    const notes = await releaseNotes(CONFIG, context, (commit) => Promise.resolve(sections.get(commit.hash) ?? null));
    assert.equal(
      body(notes),
      [
        "",
        "### ⚠ BREAKING CHANGES",
        "",
        "* Add `contents: read`.",
        "",
        "### Before updating",
        "",
        "* **sync:** sync bodies (#16)",
        "",
        "  Bodies now follow YouTrack.",
        "",
        "  - Edits on GitHub are reverted.",
        "",
        "### Features",
        "",
        `* assign mirrors ${pr(8)} ${link(SHA_A)}`,
        `* **sync:** sync bodies ${pr(16)} ${link(SHA_B)}`,
        "",
        "### Bug Fixes",
        "",
        `* a fix ${pr(17)} ${link(SHA_C)}`,
        "",
      ].join("\n"),
    );
    assert.deepEqual(warnings, []);
  });

  it("puts Before updating first when nothing is breaking", async () => {
    const { context } = contextWith([{ hash: SHA_B, message: "fix: a fix (#9)" }]);
    const notes = await releaseNotes(CONFIG, context, () => Promise.resolve("Read this."));
    assert.equal(
      body(notes),
      `\n### Before updating\n\n* a fix (#9)\n\n  Read this.\n\n### Bug Fixes\n\n* a fix ${pr(9)} ${link(SHA_B)}\n`,
    );
  });

  it("keeps the title as the note and warns when a breaking PR has no section", async () => {
    const { context, warnings } = contextWith([{ hash: SHA_C, message: "feat!: no section (#10)" }]);
    const notes = await releaseNotes(CONFIG, context, () => Promise.resolve(null));
    assert.match(notes, /### ⚠ BREAKING CHANGES\n\n\* no section \(#10\)\n/);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /ccccccc .*no "## Upgrading" section/);
  });

  it("gives each of several breaking PRs its own section", async () => {
    const { context } = contextWith([
      { hash: SHA_A, message: "feat!: one (#1)" },
      { hash: SHA_B, message: "fix(action)!: two (#2)" },
    ]);
    const sections = new Map([
      [SHA_A, "Do one."],
      [SHA_B, "Do two."],
    ]);
    const notes = await releaseNotes(CONFIG, context, (commit) => Promise.resolve(sections.get(commit.hash) ?? null));
    assert.match(notes, /\* Do one\.\n/);
    assert.match(notes, /\* \*\*action:\*\* Do two\.\n/);
    assert.doesNotMatch(notes, /UPGRADING-NOTE/);
  });

  it("leaves a non-breaking commit without a section, and its body, to the generator", async () => {
    const { context, warnings } = contextWith([
      { hash: SHA_B, message: "feat: typed body (#3)\n\nBREAKING CHANGE: from the dialog" },
    ]);
    const notes = await releaseNotes(CONFIG, context, () => Promise.resolve(null));
    assert.match(notes, /\* from the dialog\n/);
    assert.doesNotMatch(notes, /Before updating/);
    assert.deepEqual(warnings, []);
  });

  it("fails when a lookup fails, so the release can be rerun", async () => {
    const { context } = contextWith([{ hash: SHA_A, message: "feat!: x (#1)" }]);
    await assert.rejects(
      releaseNotes(CONFIG, context, () => Promise.reject(new Error("GitHub answered 502"))),
      /GitHub answered 502/,
    );
  });
});

describe("mergedPullRequest", () => {
  const target = { apiUrl: "https://api.github.com", repository: "owner/repo", token: "secret-token" };

  function answer(status: number, json: string): typeof fetch {
    return () => Promise.resolve(new Response(json, { status, headers: { "content-type": "application/json" } }));
  }

  it("asks GitHub for the PRs of the commit, with the token", async () => {
    const requests: Request[] = [];
    const fetchFn: typeof fetch = (input, init) => {
      requests.push(new Request(input, init));
      return Promise.resolve(new Response("[]", { status: 200 }));
    };
    assert.equal(await mergedPullRequest(target, SHA_A, fetchFn), null);
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.ok(request !== undefined);
    assert.equal(request.method, "GET");
    assert.equal(request.url, `https://api.github.com/repos/owner/repo/commits/${SHA_A}/pulls?per_page=100`);
    assert.equal(request.headers.get("authorization"), "Bearer secret-token");
    assert.equal(request.headers.get("accept"), "application/vnd.github+json");
    assert.notEqual(request.headers.get("user-agent"), null);
  });

  it("returns the PR whose squash commit it is", async () => {
    const json = JSON.stringify([
      { number: 7, merge_commit_sha: SHA_B, body: "other" },
      { number: 8, merge_commit_sha: SHA_A, body: "## Upgrading\nDo it." },
    ]);
    assert.deepEqual(await mergedPullRequest(target, SHA_A, answer(200, json)), {
      number: 8,
      body: "## Upgrading\nDo it.",
    });
  });

  it("returns null for a commit no PR was merged as, and keeps a null body", async () => {
    const other = JSON.stringify([{ number: 7, merge_commit_sha: SHA_B, body: "x" }]);
    assert.equal(await mergedPullRequest(target, SHA_A, answer(200, other)), null);
    const empty = JSON.stringify([{ number: 8, merge_commit_sha: SHA_A, body: null }]);
    assert.deepEqual(await mergedPullRequest(target, SHA_A, answer(200, empty)), { number: 8, body: null });
  });

  it("throws on an error status without echoing the token", async () => {
    await assert.rejects(mergedPullRequest(target, SHA_A, answer(403, '{"message":"no"}')), (error: Error) => {
      assert.match(error.message, /403/);
      assert.match(error.message, /aaaaaaa/);
      assert.doesNotMatch(error.message, /secret-token/);
      return true;
    });
  });

  it("throws on an answer that is not a list of PRs", async () => {
    await assert.rejects(mergedPullRequest(target, SHA_A, answer(200, '{"message":"x"}')), /not a list/);
    const bad = JSON.stringify([{ number: "8", merge_commit_sha: SHA_A, body: "x" }]);
    await assert.rejects(mergedPullRequest(target, SHA_A, answer(200, bad)), /unexpected pull request/);
  });

  it("refuses a malformed commit SHA before sending anything", async () => {
    let sent = false;
    const fetchFn: typeof fetch = () => {
      sent = true;
      return Promise.resolve(new Response("[]"));
    };
    await assert.rejects(mergedPullRequest(target, "../../x", fetchFn), /commit SHA/);
    assert.equal(sent, false);
  });
});

describe("gitHubTarget", () => {
  it("reads the repository, the token and the API URL from the Actions env", () => {
    assert.deepEqual(
      gitHubTarget({
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_TOKEN: "t",
        GITHUB_API_URL: "https://ghe.example/api/v3",
      }),
      { apiUrl: "https://ghe.example/api/v3", repository: "owner/repo", token: "t" },
    );
    assert.deepEqual(gitHubTarget({ GITHUB_REPOSITORY: "owner/repo", GH_TOKEN: "t" }), {
      apiUrl: "https://api.github.com",
      repository: "owner/repo",
      token: "t",
    });
  });

  it("throws when the repository or the token is missing or malformed", () => {
    assert.throws(() => gitHubTarget({ GITHUB_TOKEN: "t" }), /GITHUB_REPOSITORY/);
    assert.throws(() => gitHubTarget({ GITHUB_REPOSITORY: "owner/repo/x", GITHUB_TOKEN: "t" }), /GITHUB_REPOSITORY/);
    assert.throws(() => gitHubTarget({ GITHUB_REPOSITORY: "owner/repo", GITHUB_TOKEN: "" }), /GITHUB_TOKEN/);
  });
});

describe("generateNotes (the semantic-release plugin)", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("reads every commit's PR from GitHub and uses its Upgrading section", async () => {
    const urls: string[] = [];
    const bodies = new Map([
      [SHA_A, { number: 8, body: "Intro.\r\n\r\n## Upgrading\r\n\r\nSet `x`.\r\n" }],
      [SHA_B, { number: 9, body: "## Upgrading\n\nRead this." }],
      [SHA_C, { number: 10, body: null }],
    ]);
    mock.method(globalThis, "fetch", (input: string) => {
      urls.push(input);
      const sha = [...bodies.keys()].find((hash) => input.includes(hash));
      const found = sha === undefined ? undefined : bodies.get(sha);
      const prs = found === undefined ? [] : [{ ...found, merge_commit_sha: sha }];
      return Promise.resolve(new Response(JSON.stringify(prs), { status: 200 }));
    });
    const { context, warnings } = contextWith(
      [
        { hash: SHA_A, message: "feat!: assign mirrors (#8)" },
        { hash: SHA_B, message: "fix: a fix (#9)" },
        { hash: SHA_C, message: "docs: a doc (#10)" },
      ],
      { GITHUB_REPOSITORY: "owner/repo", GITHUB_TOKEN: "t" },
    );
    const notes = await generateNotes(CONFIG, context);
    assert.match(notes, /### ⚠ BREAKING CHANGES\n\n\* Set `x`\.\n/);
    assert.match(notes, /### Before updating\n\n\* a fix \(#9\)\n\n {2}Read this\.\n/);
    const url = (sha: string): string => `https://api.github.com/repos/owner/repo/commits/${sha}/pulls?per_page=100`;
    assert.deepEqual(urls, [url(SHA_A), url(SHA_B), url(SHA_C)]);
    assert.deepEqual(warnings, []);
  });

  it("fails without a token, which the release job always has", async () => {
    const { context } = contextWith([{ hash: SHA_B, message: "fix: a fix (#9)" }]);
    await assert.rejects(generateNotes(CONFIG, context), /GITHUB_REPOSITORY/);
  });
});
