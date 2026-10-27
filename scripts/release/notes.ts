/**
 * semantic-release plugin for the generateNotes step (.releaserc.json, decision V5): the
 * conventional-changelog notes, with each breaking commit's note taken from the "## Upgrading"
 * section of the PR it was squash-merged from.
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
