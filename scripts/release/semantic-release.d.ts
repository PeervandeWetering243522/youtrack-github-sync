/**
 * Types for the two semantic-release plugins the release scripts call directly; they ship none.
 * Only the parts used here: a commit needs its hash and message, and the logger its `log`.
 */

declare module "@semantic-release/release-notes-generator" {
  type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

  export type PluginConfig = Readonly<Record<string, Json>>;
  export type Commit = { readonly hash: string; readonly message: string };
  export type Release = { readonly version?: string; readonly gitTag?: string; readonly gitHead?: string };
  export type Context = {
    readonly commits: readonly Commit[];
    readonly lastRelease: Release;
    readonly nextRelease: Release & { readonly version: string };
    readonly options: { readonly repositoryUrl: string };
    readonly cwd: string;
  };

  export function generateNotes(pluginConfig: PluginConfig, context: Context): Promise<string>;
}

declare module "@semantic-release/commit-analyzer" {
  import type { Commit, PluginConfig } from "@semantic-release/release-notes-generator";

  export type Context = {
    readonly commits: readonly Commit[];
    readonly logger: { readonly log: (message: string, ...args: readonly string[]) => void };
    readonly cwd: string;
  };

  export function analyzeCommits(
    pluginConfig: PluginConfig,
    context: Context,
  ): Promise<"major" | "minor" | "patch" | null>;
}
