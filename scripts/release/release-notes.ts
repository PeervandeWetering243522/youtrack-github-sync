/**
 * The release notes (decisions V5, V6): conventional-changelog's notes for the released commits,
 * with each breaking commit's note replaced by its PR's "## Upgrading" section, and the section
 * of every other commit's PR listed under "Before updating". The section is looked up by the
 * caller (notes.ts reads the merged PR, pr-check.ts has the PR at hand).
 */

import type { Context, PluginConfig } from "@semantic-release/release-notes-generator";
import { generateNotes as generate } from "@semantic-release/release-notes-generator";

import { fillUpgrading, insertBeforeUpdating, isBreakingTitle, withUpgradingToken } from "./upgrading.ts";
import type { NoticeEntry } from "./upgrading.ts";

export type { PluginConfig };
export type ReleaseCommit = Context["commits"][number];
export type NotesContext = Context & {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly logger: { readonly warn: (message: string) => void };
};
/** The Upgrading section of a commit's PR, or null when it has none. Asked for every commit. */
export type LookUpSection = (commit: ReleaseCommit) => Promise<string | null>;

export async function releaseNotes(
  pluginConfig: PluginConfig,
  context: NotesContext,
  lookUp: LookUpSection,
): Promise<string> {
  const looked = await Promise.all(
    context.commits.map(async (commit) => ({
      commit,
      isBreaking: isBreakingTitle(commit.message),
      section: await lookUp(commit),
    })),
  );
  for (const { commit, isBreaking, section } of looked) {
    if (isBreaking && section === null) {
      context.logger.warn(
        `Commit ${commit.hash.slice(0, 7)} is breaking, but its PR has no "## Upgrading" section; its note is its title.`,
      );
    }
  }
  // A breaking commit's section replaces its note (a token in its message); any other's is a notice.
  const commits = looked.map(({ commit, isBreaking, section }, i) =>
    isBreaking && section !== null ? { ...commit, message: withUpgradingToken(commit.message, i) } : commit,
  );
  const sections = new Map(
    looked.flatMap(({ isBreaking, section }, i) => (isBreaking && section !== null ? [[i, section] as const] : [])),
  );
  const notices: readonly NoticeEntry[] = looked.flatMap(({ commit, isBreaking, section }) =>
    !isBreaking && section !== null ? [{ header: commit.message, section }] : [],
  );
  const notes = await generate(pluginConfig, { ...context, commits });
  return insertBeforeUpdating(fillUpgrading(notes, sections), notices);
}
