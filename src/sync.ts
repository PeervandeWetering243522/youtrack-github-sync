/**
 * One sync run. Runtime-agnostic: depends only on `fetch` (passed in) and the
 * pure modules. Used by src/worker.ts and src/node.ts.
 * The write phase lives in src/sync/execute.ts, the dry-run preview in src/sync/preview.ts,
 * the redacting logger in src/sync/log.ts.
 */

import type { Config } from "./config.ts";
import { MIRROR_LABEL } from "./github/client.ts";
import type { GitHubTarget } from "./github/client.ts";
import { listAllIssues } from "./github/issues.ts";
import { listAllMilestones } from "./github/milestones.ts";
import {
  createHttpClient,
  DEFAULT_MAX_FETCHES,
  DEFAULT_MAX_RETRY_AFTER_MS,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_TIMEOUT_MS,
  USER_AGENT,
} from "./http.ts";
import type { HttpClient } from "./http.ts";
import { planActions } from "./plan.ts";
import type { Action, Plan } from "./plan.ts";
import { buildMilestoneIndex } from "./plan/milestones.ts";
import type { MilestoneIndexResult } from "./plan/milestones.ts";
import { buildMirrorIndex } from "./plan/mirrors.ts";
import type { MirrorIndex } from "./plan/mirrors.ts";
import { executeActions } from "./sync/execute.ts";
import { githubWriter } from "./sync/execute-write.ts";
import type { WriteContext } from "./sync/execute-write.ts";
import { redactingLogger } from "./sync/log.ts";
import type { Logger } from "./sync/log.ts";
import { previewActions } from "./sync/preview.ts";
import { seedResolved } from "./sync/resolved.ts";
import type { Resolved } from "./sync/resolved.ts";
import { NOTHING } from "./sync/tally.ts";
import type { Tally } from "./sync/tally.ts";
import { secretRedactor } from "./utils/redact.ts";
import type { Redact } from "./utils/redact.ts";
import { fetchProjectIssues } from "./youtrack.ts";
import type { YouTrackIssue, YouTrackSource } from "./youtrack.ts";

export type { Logger } from "./sync/log.ts";
export { WRITE_PAUSE_MS } from "./sync/execute-write.ts";

/**
 * How long after its start a run may still begin a write action (decision R8). The longest
 * single action (a create, then a label re-add with a retry) takes about a minute, so a run
 * that starts its last action just before this ends inside the 10-minute cron slot.
 */
export const RUN_DEADLINE_MS = 8 * 60_000;

export type SyncDeps = {
  readonly fetch: typeof fetch;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: Logger;
  /** Current time in epoch ms (`Date.now` in production); only compared with `deadline`. */
  readonly now: () => number;
  /**
   * Epoch ms at or after which no new write action starts; the rest count as capped
   * (decision R8). The Worker passes `controller.scheduledTime + RUN_DEADLINE_MS`, Node its
   * start time + RUN_DEADLINE_MS. Reads and the dry-run preview are not affected.
   */
  readonly deadline: number;
};

/**
 * The counts of one run (docs/11 §1.7). Every write count includes what the dry run
 * would do. Issue counts (scanned, skipped, filtered, unchanged) count scanned YouTrack
 * issues; the others count actions, and one issue can need several.
 */
export type RunSummary = {
  readonly dryRun: boolean;
  /** YouTrack issues scanned (epics included). */
  readonly scanned: number;
  /** Mirrors created. */
  readonly created: number;
  /** Open mirrors closed because their YouTrack issue is resolved. */
  readonly closed: number;
  /** Mirror sync writes: `update` (milestone and/or type), `setParent` and `removeParent`. */
  readonly updated: number;
  /** Milestones created for epics. */
  readonly milestonesCreated: number;
  /** Open milestones closed because their epic is resolved. */
  readonly milestonesClosed: number;
  /** Scanned issues that needed nothing: `filtered` + `unchanged` (decision R5). */
  readonly skipped: number;
  /**
   * Planned actions left undone by the write cap, the fetch guard, a GitHub rate limit,
   * the run deadline, or a dependency not created in this run (D4); picked up by the next run.
   */
  readonly capped: number;
  readonly failed: number;
  /** Issues and epics whose summary lacks YOUTRACK_TITLE_PREFIX. */
  readonly filtered: number;
  /**
   * Eligible issues and epics that need no write: the mirror or milestone is already as
   * desired, or the issue is resolved and has none (never mirrored, decision R9).
   */
  readonly unchanged: number;
  readonly labelsReAdded: number;
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
 * `yt-gh-sync ok scanned=29 created=5 closed=3 updated=2 milestonesCreated=1 milestonesClosed=0 skipped=23 capped=0 failed=0 filtered=19 unchanged=4 labelsReAdded=0 fetches=3 dryRun=true`
 * `outcome` is "ok" or "failed". The headline counts come first, then the breakdown
 * (decision R5, extended by docs/11 §1.7).
 */
export function formatSummary(summary: RunSummary, outcome: "ok" | "failed"): string {
  const fields = SUMMARY_FIELDS.map((field) => `${field}=${String(summary[field])}`);
  return [SUMMARY_TAG, outcome, ...fields].join(" ");
}

/**
 * 1. GitHub issues (fatal on error) -> buildMirrorIndex, log its warnings.
 * 2. GitHub milestones (fatal on error) -> buildMilestoneIndex.
 * 3. YouTrack full scan (fatal on error).
 * 4. planActions; log its warnings (milestone duplicates, parent cycles).
 * 5. Execute serially, WRITE_PAUSE_MS between real writes, resolving each action's
 *    milestone and parent through a map seeded from the reads and extended by each
 *    successful create (src/sync/resolved.ts). In dry run, log each intended write
 *    ("[dry-run] would ...", src/sync/preview.ts) and send nothing.
 *    - createMilestone / create (unresolved only, decision R9): POST, never retried; a create
 *      sends milestone, type and parent_issue_id; if its response lacks MIRROR_LABEL and
 *      writes remain, addLabel (counts as a write); other dropped fields are warned about;
 *    - closeMilestone / close / update / setParent / removeParent: retried once;
 *    - an action whose milestone or parent was not created in this run is capped with a
 *      warning and execution continues (D4);
 *    - a failed write (HttpError / NetworkError) is recorded and execution continues. That
 *      includes a write that was sent and failed but whose retry the fetch budget could not
 *      pay for: it really failed (decision A10);
 *    - a write GitHub rate-limited (HttpError.rateLimited) is recorded as failed too, and
 *      stops execution: the remaining actions count as capped (decision R7);
 *    - FetchBudgetExceededError (the budget refused a write before sending anything) stops
 *      execution; that action and the remaining ones count as capped;
 *    - no action starts once deps.now() reaches deps.deadline; the rest count as capped
 *      (decision R8).
 * 6. Log formatSummary; throw SyncFailedError if any write failed.
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
  const run: RunContext = { config, http, log, redact, sleep: deps.sleep, now: deps.now, deadline: deps.deadline };
  const inputs = await readInputs(run);
  const plan = planActions({
    youtrackIssues: inputs.youtrackIssues,
    mirrors: inputs.mirrors,
    milestones: inputs.milestones,
    titlePrefix: config.titlePrefix,
    maxWrites: config.maxWritesPerRun,
  });
  for (const warning of plan.warnings) log.warn(warning);
  const seed = seedResolved(inputs.mirrors, inputs.milestones.index);
  const tally = await performActions(plan.actions, run, seed);
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
  "scanned",
  "created",
  "closed",
  "updated",
  "milestonesCreated",
  "milestonesClosed",
  "skipped",
  "capped",
  "failed",
  "filtered",
  "unchanged",
  "labelsReAdded",
  "fetches",
  "dryRun",
] as const satisfies readonly (keyof RunSummary)[];

/** Everything one run shares. */
type RunContext = {
  readonly config: Config;
  readonly http: HttpClient;
  readonly log: Logger;
  readonly redact: Redact;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly deadline: number;
};

type Inputs = {
  readonly mirrors: MirrorIndex;
  readonly milestones: MilestoneIndexResult;
  readonly youtrackIssues: readonly YouTrackIssue[];
};

type PlanCounts = Pick<Plan, "scanned" | "filtered" | "unchanged" | "capped">;

const NO_PLAN: PlanCounts = { scanned: 0, filtered: 0, unchanged: 0, capped: 0 };

function toSummary(dryRun: boolean, counts: PlanCounts, tally: Tally, fetches: number): RunSummary {
  return {
    dryRun,
    scanned: counts.scanned,
    created: tally.created,
    closed: tally.closed,
    updated: tally.updated,
    milestonesCreated: tally.milestonesCreated,
    milestonesClosed: tally.milestonesClosed,
    skipped: counts.filtered + counts.unchanged,
    capped: counts.capped + tally.capped,
    failed: tally.failures.length,
    filtered: counts.filtered,
    unchanged: counts.unchanged,
    labelsReAdded: tally.labelsReAdded,
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

/** Steps 1-3. A read error is fatal: log a "failed" summary line, then rethrow the error unchanged. */
async function readInputs(run: RunContext): Promise<Inputs> {
  try {
    const target = githubTarget(run.config);
    const githubIssues = await listAllIssues(run.http, target);
    const { index, warnings } = buildMirrorIndex(githubIssues, MIRROR_LABEL);
    for (const warning of warnings) run.log.warn(warning);
    // The milestone index warnings reach the log through Plan.warnings.
    const milestones = buildMilestoneIndex(await listAllMilestones(run.http, target));
    const youtrackIssues = await fetchProjectIssues(run.http, youtrackSource(run.config));
    return { mirrors: index, milestones, youtrackIssues };
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
async function performActions(actions: readonly Action[], run: RunContext, seed: Resolved): Promise<Tally> {
  if (run.config.dryRun) {
    return previewActions(actions, { log: run.log, youtrackBaseUrl: run.config.youtrackBaseUrl, resolved: seed });
  }
  const context: WriteContext = {
    writer: githubWriter(run.http, githubTarget(run.config), run.sleep),
    log: run.log,
    redact: run.redact,
    youtrackBaseUrl: run.config.youtrackBaseUrl,
    maxWrites: run.config.maxWritesPerRun,
    now: run.now,
    deadline: run.deadline,
  };
  return executeActions(actions, context, seed);
}
