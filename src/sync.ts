/**
 * One sync run. Runtime-agnostic: depends only on `fetch` (passed in) and the
 * pure modules. Used by src/worker.ts and src/node.ts.
 * The write phase lives in src/sync/execute.ts, log redaction in src/sync/log.ts.
 */

import type { Config } from "./config.ts";
import { listAllIssues, MIRROR_LABEL } from "./github.ts";
import type { GitHubTarget } from "./github.ts";
import {
  createHttpClient,
  DEFAULT_MAX_FETCHES,
  DEFAULT_MAX_RETRY_AFTER_MS,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_TIMEOUT_MS,
  USER_AGENT,
} from "./http.ts";
import type { HttpClient } from "./http.ts";
import { formatMirror } from "./mirror.ts";
import { buildMirrorIndex, planActions } from "./plan.ts";
import type { Action, MirrorIndex, Plan } from "./plan.ts";
import { executeActions, githubWriter } from "./sync/execute.ts";
import { redactingLogger, secretRedactor } from "./sync/log.ts";
import type { Logger, Redact } from "./sync/log.ts";
import { combine, mirrorName, NOTHING } from "./sync/tally.ts";
import type { Tally } from "./sync/tally.ts";
import { fetchProjectIssues } from "./youtrack.ts";
import type { YouTrackIssue, YouTrackSource } from "./youtrack.ts";

export type { Logger } from "./sync/log.ts";
export { WRITE_PAUSE_MS } from "./sync/execute.ts";

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
  const fields = SUMMARY_FIELDS.map((field) => `${field}=${String(summary[field])}`);
  return [SUMMARY_TAG, outcome, ...fields].join(" ");
}

/**
 * 1. GitHub list (fatal on error) -> buildMirrorIndex, log its warnings.
 * 2. YouTrack full scan (fatal on error).
 * 3. planActions.
 * 4. Execute serially, WRITE_PAUSE_MS between real writes. In dry run, log each
 *    intended write ("[dry-run] would create ...", "[dry-run] would close ...") and send nothing.
 *    - create: POST; if the response lacks MIRROR_LABEL and writes remain, addLabel
 *      (counts as a write); if closeAfter, close. A failed create skips its close.
 *    - a failed write (HttpError / NetworkError) is recorded and execution continues. That
 *      includes a write that was sent and failed but whose retry the fetch budget could not
 *      pay for: it really failed (decision A10);
 *    - FetchBudgetExceededError (the budget refused a write before sending anything) stops
 *      execution; that action and the remaining ones count as capped.
 * 5. Log formatSummary; throw SyncFailedError if any write failed.
 * Read failures: log a "failed" summary line, then rethrow the original error.
 * Tokens must never appear in logs.
 */
export async function runSync(config: Config, deps: SyncDeps): Promise<RunSummary> {
  const redact = secretRedactor([config.githubToken, config.youtrackToken]);
  const log = redactingLogger(deps.log, redact);
  const http = createHttpClient({
    fetch: deps.fetch,
    sleep: deps.sleep,
    userAgent: USER_AGENT,
    maxFetches: DEFAULT_MAX_FETCHES,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    retryDelayMs: DEFAULT_RETRY_DELAY_MS,
    maxRetryAfterMs: DEFAULT_MAX_RETRY_AFTER_MS,
  });
  const run: RunContext = { config, http, log, redact, sleep: deps.sleep };
  const inputs = await readInputs(run);
  const plan = planActions({
    youtrackIssues: inputs.youtrackIssues,
    mirrors: inputs.mirrors,
    titlePrefix: config.titlePrefix,
    maxWrites: config.maxWritesPerRun,
  });
  const tally = await performActions(plan.actions, run);
  const summary = toSummary(config.dryRun, plan, tally, http.fetchCount());
  if (tally.failures.length > 0) {
    log.error(formatSummary(summary, "failed"));
    throw new SyncFailedError(summary, tally.failures);
  }
  log.info(formatSummary(summary, "ok"));
  return summary;
}

const SUMMARY_TAG = "yt-gh-sync";
/** formatSummary's field order. */
const SUMMARY_FIELDS = [
  "dryRun",
  "scanned",
  "filtered",
  "unchanged",
  "created",
  "closed",
  "labelsReAdded",
  "capped",
  "failed",
  "fetches",
] as const satisfies readonly (keyof RunSummary)[];
const DRY_RUN_TAG = "[dry-run]";

/** Everything one run shares. */
type RunContext = {
  readonly config: Config;
  readonly http: HttpClient;
  readonly log: Logger;
  readonly redact: Redact;
  readonly sleep: (ms: number) => Promise<void>;
};

type Inputs = { readonly mirrors: MirrorIndex; readonly youtrackIssues: readonly YouTrackIssue[] };

type PlanCounts = Pick<Plan, "scanned" | "filtered" | "unchanged" | "capped">;

const NO_PLAN: PlanCounts = { scanned: 0, filtered: 0, unchanged: 0, capped: 0 };

function toSummary(dryRun: boolean, counts: PlanCounts, tally: Tally, fetches: number): RunSummary {
  return {
    dryRun,
    scanned: counts.scanned,
    filtered: counts.filtered,
    unchanged: counts.unchanged,
    created: tally.created,
    closed: tally.closed,
    labelsReAdded: tally.labelsReAdded,
    capped: counts.capped + tally.capped,
    failed: tally.failures.length,
    fetches,
  };
}

// ---------------------------------------------------------------------------
// Read phase

function githubTarget(config: Config): GitHubTarget {
  return { owner: config.githubOwner, repo: config.githubRepo, token: config.githubToken };
}

function youtrackSource(config: Config): YouTrackSource {
  return { baseUrl: config.youtrackBaseUrl, token: config.youtrackToken, project: config.youtrackProject };
}

/** Steps 1-2. A read error is fatal: log a "failed" summary line, then rethrow the error unchanged. */
async function readInputs(run: RunContext): Promise<Inputs> {
  try {
    const githubIssues = await listAllIssues(run.http, githubTarget(run.config));
    const { index, warnings } = buildMirrorIndex(githubIssues, MIRROR_LABEL);
    for (const warning of warnings) run.log.warn(warning);
    const youtrackIssues = await fetchProjectIssues(run.http, youtrackSource(run.config));
    return { mirrors: index, youtrackIssues };
  } catch (error) {
    const summary = toSummary(run.config.dryRun, NO_PLAN, NOTHING, run.http.fetchCount());
    run.log.error(formatSummary(summary, "failed"));
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Actions

/**
 * The only way to a GitHub write: the writer is built here, and only when dry run is
 * off. The dry-run path gets neither the writer nor the HTTP client.
 */
async function performActions(actions: readonly Action[], run: RunContext): Promise<Tally> {
  if (run.config.dryRun) {
    return previewActions(actions, run.config.youtrackBaseUrl, run.log);
  }
  return executeActions(actions, {
    writer: githubWriter(run.http, githubTarget(run.config), run.sleep),
    log: run.log,
    redact: run.redact,
    youtrackBaseUrl: run.config.youtrackBaseUrl,
    maxWrites: run.config.maxWritesPerRun,
  });
}

/** Dry run: logs each write that would be sent and counts it. */
function previewActions(actions: readonly Action[], youtrackBaseUrl: string, log: Logger): Tally {
  return actions.reduce((tally, action) => combine(tally, previewAction(action, youtrackBaseUrl, log)), NOTHING);
}

function previewAction(action: Action, youtrackBaseUrl: string, log: Logger): Tally {
  const name = mirrorName(action.issue);
  switch (action.kind) {
    case "create": {
      log.info(`${DRY_RUN_TAG} would create ${name}: ${formatMirror(action.issue, youtrackBaseUrl).title}`);
      if (!action.closeAfter) return { ...NOTHING, created: 1 };
      log.info(`${DRY_RUN_TAG} would close ${name} right after creating it`);
      return { ...NOTHING, created: 1, closed: 1 };
    }
    case "close":
      log.info(`${DRY_RUN_TAG} would close ${name} #${String(action.mirror.issueNumber)}`);
      return { ...NOTHING, closed: 1 };
  }
}
