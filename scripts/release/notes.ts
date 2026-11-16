/**
 * semantic-release plugin for the generateNotes step (.releaserc.json, decisions V5, V6): the
 * conventional-changelog notes, with the "## Upgrading" section of the PR each commit was
 * squash-merged from: a breaking commit's as its note, any other's under "Before updating".
 * Every released commit's PR is read, so the release job's token is always needed.
 */

import { gitHubTarget, mergedPullRequest } from "./pull-request.ts";
import type { NotesContext, PluginConfig } from "./release-notes.ts";
import { releaseNotes } from "./release-notes.ts";
import { upgradingSection } from "./upgrading.ts";

export function generateNotes(pluginConfig: PluginConfig, context: NotesContext): Promise<string> {
  return releaseNotes(pluginConfig, context, async (commit) => {
    const pr = await mergedPullRequest(gitHubTarget(context.env), commit.hash);
    return pr === null ? null : upgradingSection(pr.body);
  });
}
