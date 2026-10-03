/**
 * Runs the PR check (pr-check.ts) in the PR workflow: reads the PR from PR_TITLE, PR_BODY and
 * PR_NUMBER, prints each problem as an error annotation and the release preview, writes the
 * preview to the job summary, and fails on a problem. Locally:
 * `PR_TITLE='feat!: x' PR_BODY="$(cat body.md)" PR_NUMBER=1 node scripts/release/check-pr.ts`.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";

import { checkPullRequest, readReleaseConfig, summary } from "./pr-check.ts";

const env = process.env;
const config = readReleaseConfig(readFileSync(new URL("../../.releaserc.json", import.meta.url), "utf8"));
const repositoryUrl = `${env["GITHUB_SERVER_URL"] ?? "https://github.com"}/${env["GITHUB_REPOSITORY"] ?? "owner/repo"}`;
const pr = {
  number: Number(env["PR_NUMBER"] ?? "0"),
  title: env["PR_TITLE"] ?? "",
  body: env["PR_BODY"] === undefined || env["PR_BODY"] === "" ? null : env["PR_BODY"],
};

const check = await checkPullRequest(pr, { config, repositoryUrl, cwd: process.cwd() });
for (const problem of check.problems) console.log(`::error title=${problem.title}::${problem.message}`);
const text = summary(check);
// The preview holds PR text: stop the runner from reading a `::` line in it as a workflow command.
const resume = randomUUID();
console.log(`::stop-commands::${resume}\n${text}\n::${resume}::`);
const summaryFile = env["GITHUB_STEP_SUMMARY"];
if (summaryFile !== undefined && summaryFile !== "") appendFileSync(summaryFile, text);
process.exitCode = check.problems.length > 0 ? 1 : 0;
