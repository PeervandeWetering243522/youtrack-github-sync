/**
 * The PR check (decisions V2 and V5). The squash commit on main is the PR title only, so the
 * title must be a conventional commit, and a PR has a "## Upgrading" section exactly when its
 * title has a `!`. It also previews the release the commit will make, with the real
 * .releaserc.json, analyzer and notes generator: the bump and the PR's notes entry.
 */

import { analyzeCommits } from "@semantic-release/commit-analyzer";

import type { JsonObject } from "../../src/json.ts";
import { isJsonArray, isJsonObject, parseJson } from "../../src/json.ts";
import type { PluginConfig } from "./release-notes.ts";
import { releaseNotes } from "./release-notes.ts";
import { isBreakingTitle, upgradingSection } from "./upgrading.ts";

export type PullRequest = { readonly number: number; readonly title: string; readonly body: string | null };
export type ReleaseConfig = { readonly analyzer: PluginConfig; readonly notes: PluginConfig };
export type Bump = "major" | "minor" | "patch" | null;
export type Problem = { readonly title: string; readonly message: string };
export type PrCheck = { readonly problems: readonly Problem[]; readonly bump: Bump; readonly notes: string };
export type CheckOptions = { readonly config: ReleaseConfig; readonly repositoryUrl: string; readonly cwd: string };

const ANALYZER = "@semantic-release/commit-analyzer";
const NOTES = "./scripts/release/notes.ts";
const TITLE = /^(feat|fix|perf|refactor|docs|test|build|ci|chore|style|revert)(\([a-z0-9-]+\))?!?: [^ ].*$/;

const silent = { log: (): void => undefined, warn: (): void => undefined };

/** The options of the analyzer and of the notes plugin in .releaserc.json. Throws when one is missing. */
export function readReleaseConfig(text: string): ReleaseConfig {
  const config = parseJson(text);
  const plugins = isJsonObject(config) ? config["plugins"] : undefined;
  if (!isJsonArray(plugins)) throw new Error(".releaserc.json has no plugins list.");
  const options = (name: string): JsonObject => {
    for (const plugin of plugins) {
      if (plugin === name) return {};
      if (isJsonArray(plugin) && plugin[0] === name) {
        const pluginOptions = plugin[1];
        return isJsonObject(pluginOptions) ? pluginOptions : {};
      }
    }
    throw new Error(`.releaserc.json does not list ${name}.`);
  };
  return { analyzer: options(ANALYZER), notes: options(NOTES) };
}

function problemsOf(pr: PullRequest, section: string | null): readonly Problem[] {
  if (!TITLE.test(pr.title)) {
    return [
      {
        title: "PR title",
        message: "Use '<type>(<scope>)?: <summary>', e.g. 'feat: reopen own closes'; see CONTRIBUTING.md.",
      },
    ];
  }
  if (isBreakingTitle(pr.title) && section === null) {
    return [
      {
        title: "Upgrading section",
        message:
          "A breaking PR (a `!` in the title) needs a '## Upgrading' section in its description: what a group must do before updating. It becomes the release's breaking-change note.",
      },
    ];
  }
  if (!isBreakingTitle(pr.title) && section !== null) {
    return [
      {
        title: "Upgrading section",
        message:
          "The '## Upgrading' section is only for breaking changes. Add a `!` to the title if groups must act before updating (a major release), or empty the section.",
      },
    ];
  }
  return [];
}

export async function checkPullRequest(pr: PullRequest, options: CheckOptions): Promise<PrCheck> {
  const section = upgradingSection(pr.body);
  // GitHub's squash commit: the title with the PR number, and no body (V5).
  const commit = { hash: "", message: `${pr.title} (#${String(pr.number)})` };
  const bump = await analyzeCommits(options.config.analyzer, { commits: [commit], logger: silent, cwd: options.cwd });
  const generated = await releaseNotes(
    options.config.notes,
    {
      commits: [commit],
      lastRelease: {},
      nextRelease: { version: "preview" },
      options: { repositoryUrl: options.repositoryUrl },
      cwd: options.cwd,
      env: {},
      logger: silent,
    },
    () => Promise.resolve(section),
  );
  // Drop the version header; the rest is this PR's entry.
  const notes = generated.replace(/^## .*\n/, "").trim();
  return { problems: problemsOf(pr, section), bump, notes };
}

/** Markdown for the check's job summary. */
export function summary(check: PrCheck): string {
  const release = check.bump === null ? "no release" : `a **${check.bump}** release`;
  const parts = [`### Release preview\n\nMerging this PR makes ${release}.`];
  if (check.notes !== "") parts.push(`Its entry in the release notes:\n\n${check.notes}`);
  if (check.problems.length > 0) {
    const list = check.problems.map((problem) => `- **${problem.title}:** ${problem.message}`).join("\n");
    parts.push(`### Problems\n\n${list}`);
  }
  return `${parts.join("\n\n")}\n`;
}
