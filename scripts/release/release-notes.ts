/**
 * The release notes (decision V5): conventional-changelog's notes for the released commits, with
 * each breaking commit's note replaced by its PR's "## Upgrading" section. The section is looked
 * up by the caller (notes.ts reads the merged PR, pr-check.ts has the PR at hand).
 */

import type { Context, PluginConfig } from "@semantic-release/release-notes-generator";
import { generateNotes as generate } from "@semantic-release/release-notes-generator";

import { fillUpgrading, isBreakingTitle, withUpgradingToken } from "./upgrading.ts";

export type { PluginConfig };
export type ReleaseCommit = Context["commits"][number];
export type NotesContext = Context & {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly logger: { readonly warn: (message: string) => void };
};
/** The Upgrading section for a breaking commit, or null when its PR has none. */
export type LookUpSection = (commit: ReleaseCommit) => Promise<string | null>;

export async function releaseNotes(
  pluginConfig: PluginConfig,
  context: NotesContext,
  lookUp: LookUpSection,
): Promise<string> {
  const looked = await Promise.all(
    context.commits.map(async (commit) => {
      const isBreaking = isBreakingTitle(commit.message);
      return { commit, isBreaking, section: isBreaking ? await lookUp(commit) : null };
    }),
  );
  for (const { commit, isBreaking, section } of looked) {
    if (isBreaking && section === null) {
      context.logger.warn(
        `Commit ${commit.hash.slice(0, 7)} is breaking, but its PR has no "## Upgrading" section; its note is its title.`,
      );
    }
  }
  const commits = looked.map(({ commit, section }, i) =>
    section === null ? commit : { ...commit, message: withUpgradingToken(commit.message, i) },
  );
  const sections = new Map(looked.flatMap(({ section }, i) => (section === null ? [] : [[i, section] as const])));
  const notes = await generate(pluginConfig, { ...context, commits });
  return fillUpgrading(notes, sections);
}
