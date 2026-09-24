/**
 * One sync run. Runtime-agnostic: depends only on `fetch` (passed in) and the
 * pure modules. Used by src/worker.ts and src/node.ts.
 */

import type { Config } from "./config.ts";

export type Logger = {
  readonly info: (message: string) => void;
  readonly warn: (message: string) => void;
  readonly error: (message: string) => void;
};

export type SyncDeps = {
  readonly fetch: typeof fetch;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: Logger;
};

export type RunSummary = {
  readonly dryRun: boolean;
  readonly scanned: number;
  readonly filtered: number;
  readonly unchanged: number;
  /** Mirrors created (or that would be, in dry run). */
  readonly created: number;
  /** Mirrors closed, including the close right after creating a resolved issue. */
  readonly closed: number;
  readonly labelsReAdded: number;
  /** Planned actions not executed because of the write cap or the fetch guard. */
  readonly capped: number;
  readonly failed: number;
  readonly fetches: number;
};

/** Pause between GitHub writes (GitHub best practice: serial, >= 1 s apart). */
export const WRITE_PAUSE_MS = 1_000;

/** Thrown after the summary is logged when any write failed (decision A10). */
export class SyncFailedError extends Error {
  readonly summary: RunSummary;
  readonly failures: readonly string[];

  constructor(summary: RunSummary, failures: readonly string[]) {
    super(`Sync finished with ${String(failures.length)} failure(s): ${failures.join(" | ")}`);
    this.name = "SyncFailedError";
    this.summary = summary;
    this.failures = failures;
  }
}

/**
 * One line for `wrangler tail` / journalctl, e.g.
 * `yt-gh-sync ok dryRun=true scanned=29 filtered=19 unchanged=4 created=5 closed=3 labelsReAdded=0 capped=0 failed=0 fetches=2`
 * `outcome` is "ok" or "failed".
 */
export function formatSummary(summary: RunSummary, outcome: "ok" | "failed"): string {
  void summary;
  void outcome;
  throw new Error("not implemented");
}

/**
 * 1. GitHub list (fatal on error) -> buildMirrorIndex, log its warnings.
 * 2. YouTrack full scan (fatal on error).
 * 3. planActions.
 * 4. Execute serially, WRITE_PAUSE_MS between real writes. In dry run, log each
 *    intended write ("[dry-run] create ...", "[dry-run] close ...") and send nothing.
 *    - create: POST; if the response lacks MIRROR_LABEL and writes remain, addLabel
 *      (counts as a write); if closeAfter, close. A failed create skips its close.
 *    - a failed write is recorded and execution continues;
 *    - FetchBudgetExceededError stops execution; remaining actions count as capped.
 * 5. Log formatSummary; throw SyncFailedError if any write failed.
 * Read failures: log a "failed" summary line, then rethrow the original error.
 * Tokens must never appear in logs.
 */
export async function runSync(config: Config, deps: SyncDeps): Promise<RunSummary> {
  void config;
  void deps;
  throw new Error("not implemented");
}
