/**
 * The PR check (V5): a conventional title, a "## Upgrading" section exactly when the title has
 * a `!`, and a preview of the release the squash commit will make, from the real
 * .releaserc.json and the real analyzer and notes generator.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { PrCheck, PullRequest, ReleaseConfig } from "../../scripts/release/pr-check.ts";
import { checkPullRequest, readReleaseConfig, summary } from "../../scripts/release/pr-check.ts";

const RELEASERC = readFileSync(new URL("../../.releaserc.json", import.meta.url), "utf8");
const CONFIG: ReleaseConfig = readReleaseConfig(RELEASERC);
const REPO = "https://github.com/owner/repo";

function check(title: string, body: string | null = null): Promise<PrCheck> {
  const pr: PullRequest = { number: 5, title, body };
  return checkPullRequest(pr, { config: CONFIG, repositoryUrl: REPO, cwd: process.cwd() });
}

const problemTitles = (result: PrCheck): readonly string[] => result.problems.map((problem) => problem.title);

describe("readReleaseConfig", () => {
  it("finds the analyzer's and the notes plugin's options in .releaserc.json", () => {
    assert.equal(CONFIG.analyzer["preset"], "conventionalcommits");
    assert.ok(Array.isArray(CONFIG.analyzer["releaseRules"]));
    assert.equal(CONFIG.notes["preset"], "conventionalcommits");
  });

  it("throws when either plugin is missing", () => {
    const noNotes = JSON.stringify({ plugins: [["@semantic-release/commit-analyzer", {}]] });
    assert.throws(() => readReleaseConfig(noNotes), /\.\/scripts\/release\/notes\.ts/);
    const noAnalyzer = JSON.stringify({ plugins: [["./scripts/release/notes.ts", {}]] });
    assert.throws(() => readReleaseConfig(noAnalyzer), /commit-analyzer/);
    assert.throws(() => readReleaseConfig("[]"), /plugins/);
  });

  it("accepts a plugin listed without options", () => {
    const bare = JSON.stringify({ plugins: ["@semantic-release/commit-analyzer", "./scripts/release/notes.ts"] });
    assert.deepEqual(readReleaseConfig(bare), { analyzer: {}, notes: {} });
  });
});

describe("checkPullRequest", () => {
  it("rejects a title that is not a conventional commit", async () => {
    for (const title of ["Add a thing", "feat:add", "feature: add", "feat(Scope): add", "feat:  add"]) {
      assert.deepEqual(problemTitles(await check(title)), ["PR title"], title);
    }
  });

  it("previews a feat as a minor release with its notes entry", async () => {
    const result = await check("feat: add a thing");
    assert.deepEqual(result.problems, []);
    assert.equal(result.bump, "minor");
    assert.equal(result.notes, `### Features\n\n* add a thing ([#5](${REPO}/issues/5))`);
  });

  it("previews fix, perf and revert as patch releases and docs as none", async () => {
    assert.equal((await check("fix(action): pass an input")).bump, "patch");
    assert.equal((await check("perf: fewer fetches")).bump, "patch");
    assert.equal((await check("revert: undo a thing")).bump, "patch");
    const docs = await check("docs: explain a thing");
    assert.equal(docs.bump, null);
    assert.equal(docs.notes, "");
  });

  it("previews a breaking PR as a major release with its Upgrading section as the note", async () => {
    const result = await check("feat!: rename an input", "Why.\n\n## Upgrading\n\nRename `a` to `b`.\n\n## Tests\n");
    assert.deepEqual(result.problems, []);
    assert.equal(result.bump, "major");
    assert.match(result.notes, /^### ⚠ BREAKING CHANGES\n\n\* Rename `a` to `b`\.\n\n### Features\n/);
  });

  it("requires an Upgrading section when the title has a `!`", async () => {
    for (const body of [null, "No section.", "## Upgrading\n\n<!-- Only for a breaking change. -->\n"]) {
      const result = await check("feat!: rename an input", body);
      assert.deepEqual(problemTitles(result), ["Upgrading section"], String(body));
      assert.equal(result.bump, "major");
      assert.match(result.notes, /\* rename an input \(#5\)\n/);
    }
  });

  it("rejects an Upgrading section without a `!`, but not the template's empty one", async () => {
    assert.deepEqual(problemTitles(await check("feat: add", "## Upgrading\n\nDo this.")), ["Upgrading section"]);
    assert.deepEqual(problemTitles(await check("feat: add", "## Upgrading\n\n<!-- hint -->\n")), []);
  });

  it("ignores a BREAKING CHANGE line in the description, which never reaches the commit", async () => {
    const result = await check("fix: a fix", "breaking change and more.\nBREAKING CHANGE: typed");
    assert.deepEqual(result.problems, []);
    assert.equal(result.bump, "patch");
  });
});

describe("summary", () => {
  it("states the bump and shows the notes entry", async () => {
    const text = summary(await check("feat: add a thing"));
    assert.match(text, /^### Release preview\n/);
    assert.match(text, /Merging this PR makes a \*\*minor\*\* release\./);
    assert.match(text, /\* add a thing/);
  });

  it("says when there is no release", async () => {
    assert.match(summary(await check("docs: x")), /Merging this PR makes no release\./);
  });

  it("lists the problems", async () => {
    const text = summary(await check("feat!: x"));
    assert.match(text, /\*\*major\*\*/);
    assert.match(text, /### Problems\n\n- \*\*Upgrading section:\*\* /);
  });
});
