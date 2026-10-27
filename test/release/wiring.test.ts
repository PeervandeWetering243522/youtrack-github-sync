/**
 * The release wiring (V5): semantic-release uses the notes plugin instead of the stock generator,
 * the release job may read PRs, and the required PR check runs check-pr.ts with the PR text as
 * env, never inside the script.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("release wiring", () => {
  it("generates notes with scripts/release/notes.ts only", () => {
    const releaserc = read(".releaserc.json");
    assert.match(releaserc, /"\.\/scripts\/release\/notes\.ts"/);
    assert.doesNotMatch(releaserc, /release-notes-generator/, "two notes plugins would print the notes twice");
  });

  it("lets the release job read the merged PRs", () => {
    assert.match(read(".github/workflows/release.yml"), /^ {6}pull-requests: read\b/m);
  });

  it("runs the PR check under the job name the ruleset requires", () => {
    const workflow = read(".github/workflows/pr-title.yml");
    assert.match(workflow, /^ {4}name: Conventional PR title$/m);
    assert.match(workflow, /^ {8}run: node scripts\/release\/check-pr\.ts$/m);
    assert.match(workflow, /^ {10}PR_BODY: \$\{\{ github\.event\.pull_request\.body \}\}$/m);
    assert.match(workflow, /types: \[opened, edited, synchronize, reopened\]/, "editing the description reruns it");
    assert.doesNotMatch(workflow, /run: .*\$\{\{/, "PR text goes through env, not into a script");
  });

  it("gives new PRs an empty Upgrading section", () => {
    assert.match(read(".github/pull_request_template.md"), /^## Upgrading$/m);
  });
});
