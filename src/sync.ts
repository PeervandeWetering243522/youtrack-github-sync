/**
 * One sync run. Runtime-agnostic: depends only on `fetch` (passed in) and the
 * pure modules. Used by src/worker.ts and src/node.ts.
 */

import type { Config } from "./config.ts";
import { addLabel, closeIssue, createIssue, listAllIssues, MIRROR_LABEL } from "./github.ts";
import type { CreateIssueBody, GitHubIssue, GitHubTarget } from "./github.ts";
import {
  createHttpClient,
  DEFAULT_MAX_FETCHES,
  DEFAULT_MAX_RETRY_AFTER_MS,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_TIMEOUT_MS,
  FetchBudgetExceededError,
  USER_AGENT,
} from "./http.ts";
import type { HttpClient } from "./http.ts";
import { formatMirror } from "./mirror.ts";
import { buildMirrorIndex, planActions, writeCost } from "./plan.ts";
import type { Action, MirrorIndex, Plan } from "./plan.ts";
import { fetchProjectIssues } from "./youtrack.ts";
import type { YouTrackIssue, YouTrackSource } from "./youtrack.ts";

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
 *    - a failed write is recorded and execution continues;
 *    - FetchBudgetExceededError stops execution; remaining actions count as capped.
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
/** Shorter "secrets" are not redacted, so a junk value cannot garble every log line; real tokens are far longer. */
const MIN_SECRET_CHARS = 8;
const REDACTED = "[redacted]";

type Redact = (text: string) => string;

/** Everything one run shares. */
type RunContext = {
  readonly config: Config;
  readonly http: HttpClient;
  readonly log: Logger;
  readonly redact: Redact;
  readonly sleep: (ms: number) => Promise<void>;
};

type Inputs = { readonly mirrors: MirrorIndex; readonly youtrackIssues: readonly YouTrackIssue[] };

/** What some actions did; merged into the run totals with `combine`. */
type Tally = {
  readonly created: number;
  readonly closed: number;
  readonly labelsReAdded: number;
  /** Actions (or the close of a create+close pair) left undone by the write cap or the fetch guard. */
  readonly capped: number;
  readonly failures: readonly string[];
  /** The fetch guard ran out: nothing after this may run. */
  readonly stopped: boolean;
};

const NOTHING: Tally = { created: 0, closed: 0, labelsReAdded: 0, capped: 0, failures: [], stopped: false };
/** A planned write the fetch guard refused: the action is capped and execution stops. */
const OUT_OF_FETCHES: Tally = { ...NOTHING, capped: 1, stopped: true };
const NO_PLAN: Pick<Plan, "scanned" | "filtered" | "unchanged" | "capped"> = {
  scanned: 0,
  filtered: 0,
  unchanged: 0,
  capped: 0,
};

function combine(a: Tally, b: Tally): Tally {
  return {
    created: a.created + b.created,
    closed: a.closed + b.closed,
    labelsReAdded: a.labelsReAdded + b.labelsReAdded,
    capped: a.capped + b.capped,
    failures: [...a.failures, ...b.failures],
    stopped: a.stopped || b.stopped,
  };
}

function toSummary(
  dryRun: boolean,
  counts: Pick<Plan, "scanned" | "filtered" | "unchanged" | "capped">,
  tally: Tally,
  fetches: number,
): RunSummary {
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
// Secrets

/** Replaces every occurrence of each secret, longest first (one may contain another). */
function secretRedactor(secrets: readonly string[]): Redact {
  const redactable = secrets
    .filter((secret) => secret.length >= MIN_SECRET_CHARS)
    .toSorted((a, b) => b.length - a.length);
  return (text) => redactable.reduce((result, secret) => result.replaceAll(secret, REDACTED), text);
}

/** Every line passes through `redact`, whatever produced it (error bodies, issue titles). */
function redactingLogger(log: Logger, redact: Redact): Logger {
  return {
    info: (message) => {
      log.info(redact(message));
    },
    warn: (message) => {
      log.warn(redact(message));
    },
    error: (message) => {
      log.error(redact(message));
    },
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

/** How issues are named in log lines; numbers only, like the mirror title prefix. */
function mirrorName(issue: YouTrackIssue): string {
  return `YT-${String(issue.numberInProject)}`;
}

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
  let tally = NOTHING;
  for (const action of actions) tally = combine(tally, previewAction(action, youtrackBaseUrl, log));
  return tally;
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

// ---------------------------------------------------------------------------
// Real writes

/** GitHub writes, sent one at a time and WRITE_PAUSE_MS apart. */
type GitHubWriter = {
  readonly create: (body: CreateIssueBody) => Promise<GitHubIssue>;
  readonly close: (issueNumber: number) => Promise<void>;
  readonly addLabel: (issueNumber: number) => Promise<void>;
  /** Writes attempted so far; each one counts against MAX_WRITES_PER_RUN. */
  readonly count: () => number;
};

type WriteContext = {
  readonly writer: GitHubWriter;
  readonly log: Logger;
  readonly redact: Redact;
  readonly youtrackBaseUrl: string;
  readonly maxWrites: number;
};

type WriteOutcome<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "out-of-fetches" };

function githubWriter(http: HttpClient, target: GitHubTarget, sleep: (ms: number) => Promise<void>): GitHubWriter {
  let writes = 0;
  const send = async <T>(write: () => Promise<T>): Promise<T> => {
    // No pause before the first write, nor before one the fetch guard is going to refuse.
    if (writes > 0 && http.remainingFetches() > 0) await sleep(WRITE_PAUSE_MS);
    writes += 1;
    return write();
  };
  return {
    create: (body) => send(() => createIssue(http, target, body)),
    close: (issueNumber) => send(() => closeIssue(http, target, issueNumber)),
    addLabel: (issueNumber) => send(() => addLabel(http, target, issueNumber, MIRROR_LABEL)),
    count: () => writes,
  };
}

/** Runs the actions in order until the write cap or the fetch guard stops it. */
async function executeActions(actions: readonly Action[], context: WriteContext): Promise<Tally> {
  let tally = NOTHING;
  for (const [position, action] of actions.entries()) {
    const notYetRun = actions.length - position;
    // planActions capped by writeCost; label re-adds are extra writes it could not foresee.
    if (context.writer.count() + writeCost(action) > context.maxWrites) {
      return combine(tally, { ...NOTHING, capped: notYetRun });
    }
    tally = combine(tally, await executeAction(action, context));
    if (tally.stopped) {
      const rest = notYetRun - 1;
      context.log.warn(`fetch guard of ${String(DEFAULT_MAX_FETCHES)} reached; ${String(rest)} more action(s) capped`);
      return combine(tally, { ...NOTHING, capped: rest });
    }
  }
  return tally;
}

function executeAction(action: Action, context: WriteContext): Promise<Tally> {
  switch (action.kind) {
    case "create":
      return executeCreate(action.issue, action.closeAfter, context);
    case "close":
      return executeClose(action.issue, action.mirror.issueNumber, context);
  }
}

/** A failed write becomes a value; the fetch guard's refusal is told apart from other errors. */
async function attemptWrite<T>(write: () => Promise<T>): Promise<WriteOutcome<T>> {
  try {
    return { kind: "ok", value: await write() };
  } catch (error) {
    if (error instanceof FetchBudgetExceededError) return { kind: "out-of-fetches" };
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Logs and records one failed write; the run goes on and throws at the end (decision A10). */
function failure(context: WriteContext, message: string): Tally {
  const redacted = context.redact(message);
  context.log.error(redacted);
  return { ...NOTHING, failures: [redacted] };
}

async function executeCreate(issue: YouTrackIssue, closeAfter: boolean, context: WriteContext): Promise<Tally> {
  const name = mirrorName(issue);
  const mirror = formatMirror(issue, context.youtrackBaseUrl);
  const body = { title: mirror.title, body: mirror.body, labels: [MIRROR_LABEL] } satisfies CreateIssueBody;
  const outcome = await attemptWrite(() => context.writer.create(body));
  if (outcome.kind === "out-of-fetches") return OUT_OF_FETCHES;
  // A failed create skips its close: there is no issue to close.
  if (outcome.kind === "failed") return failure(context, `create ${name} failed: ${outcome.reason}`);
  const created = outcome.value;
  context.log.info(`create ${name} -> #${String(created.number)}`);
  const labelled = combine({ ...NOTHING, created: 1 }, await ensureLabel(created, name, closeAfter, context));
  if (!closeAfter) return labelled;
  // The fetch guard refused the label re-add, so it would refuse the close too.
  if (labelled.stopped) return combine(labelled, { ...NOTHING, capped: 1 });
  return combine(labelled, await executeClose(issue, created.number, context));
}

/**
 * Re-adds MIRROR_LABEL when the 201 response lacks it (decision A5), if a write is
 * left after the pending close. Without it the next run still matches the mirror by title.
 */
async function ensureLabel(created: GitHubIssue, name: string, closeAfter: boolean, context: WriteContext): Promise<Tally> {
  const wanted = MIRROR_LABEL.toLowerCase();
  if (created.labelNames.some((label) => label.toLowerCase() === wanted)) return NOTHING;
  const what = `${name} #${String(created.number)}`;
  const notReAdded = `${what} was created without the "${MIRROR_LABEL}" label and it was not re-added`;
  if (context.writer.count() + (closeAfter ? 1 : 0) >= context.maxWrites) {
    context.log.warn(`${notReAdded} (write cap reached)`);
    return NOTHING;
  }
  const outcome = await attemptWrite(() => context.writer.addLabel(created.number));
  switch (outcome.kind) {
    case "ok":
      context.log.info(`label ${what}`);
      return { ...NOTHING, labelsReAdded: 1 };
    case "failed":
      return failure(context, `label ${what} failed: ${outcome.reason}`);
    case "out-of-fetches":
      context.log.warn(`${notReAdded} (fetch guard reached)`);
      return { ...NOTHING, stopped: true };
  }
}

async function executeClose(issue: YouTrackIssue, issueNumber: number, context: WriteContext): Promise<Tally> {
  const what = `${mirrorName(issue)} #${String(issueNumber)}`;
  const outcome = await attemptWrite(() => context.writer.close(issueNumber));
  switch (outcome.kind) {
    case "ok":
      context.log.info(`close ${what}`);
      return { ...NOTHING, closed: 1 };
    case "failed":
      return failure(context, `close ${what} failed: ${outcome.reason}`);
    case "out-of-fetches":
      return OUT_OF_FETCHES;
  }
}
