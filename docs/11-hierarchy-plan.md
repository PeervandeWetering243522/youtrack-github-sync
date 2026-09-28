# Hierarchy mirroring: implementation plan

> Drafted 2026-09-28 from [10-hierarchy-design.md](10-hierarchy-design.md) and decisions H1-H10 in
> [08-decisions.md](08-decisions.md). Detail rules D1-D8 were accepted on 2026-09-28.
> Nothing here changes the live Worker until it is deployed.

## 1. Behaviour, precisely

### 1.1 Classification (pure, per scanned YouTrack issue)

| `Type` value          | Kind      | GitHub                       | Issue type |
| --------------------- | --------- | ---------------------------- | ---------- |
| `Epic`                | milestone | milestone `[YT-n] <summary>` | -          |
| `User Story`          | issue     | top-level issue              | `Feature`  |
| `Bug`                 | issue     | top-level issue              | `Bug`      |
| `Task`                | task      | sub-issue, or top-level (H3) | `Task`     |
| missing / other value | issue     | top-level issue              | none (D3)  |

Eligibility is unchanged for every kind: summary starts with `[team]` (A8), and nothing is created
for an issue or epic that is already resolved (R9).

### 1.2 Desired GitHub state (pure)

Walk each issue's YouTrack parent chain (the `Subtask` link, `Issue.parent`), using every scanned
issue including filtered and resolved ones:

- **Milestone (H4, D1):** the nearest Epic ancestor. If that epic has a mirrored milestone, use it;
  otherwise none. Higher epics are not searched.
- **GitHub parent (H3, H9), tasks only:** the nearest non-Epic ancestor that has a mirror (existing,
  or created earlier in the same run). The walk stops at the first Epic. None found: top-level.
- **Type (H6):** from the table above.
- A parent in another YouTrack project (not in the scan) ends the walk (D5). A cycle ends the walk
  and logs a warning.

### 1.3 Actions

| Situation                                                | Action            | Writes                                         |
| -------------------------------------------------------- | ----------------- | ---------------------------------------------- |
| Eligible unresolved epic, no milestone                   | `createMilestone` | `POST /milestones` (title, description)        |
| Epic resolved, milestone open                            | `closeMilestone`  | `PATCH /milestones/{n}` `state: closed`        |
| Eligible unresolved issue/task, no mirror                | `create`          | `POST /issues` + milestone, type, parent       |
| Resolved, mirror open                                    | `close`           | `PATCH /issues/{n}` (unchanged, A7)            |
| Mirror's milestone or type differs from desired (D2, D3) | `update`          | one `PATCH /issues/{n}` with both fields       |
| Task mirror should sit under another mirror              | `setParent`       | `POST /issues/{p}/sub_issues` `replace_parent` |
| Mirror sits under a mirror but should be top-level       | `removeParent`    | `DELETE /issues/{old}/sub_issue`               |

- Sync (`update`, `setParent`, `removeParent`) runs on every mirror, open or closed (D8).
- Never: reopen issues or milestones, rename or re-describe them after creation (D7), reorder
  sub-issues (D6).
- **Only fields the mirror owns are touched (D2):** a milestone or parent that is not a YouTrack
  mirror (set by hand on GitHub) is left alone unless YouTrack wants a mirrored one there. A desired
  type of "none" leaves the GitHub type alone (D3).
- **A child waits for its parent (D4):** a task whose parent mirror is being created in this run is
  created after it, with that `parent_issue_id`. If the parent's create is capped or fails, the
  child's create is capped too (created next run), rather than being created top-level and moved.
  Same for an issue whose milestone is being created in this run.

### 1.4 Order and cap

Execution order (still "nothing later jumps ahead" within one ordered list, A2):

1. `createMilestone`, `closeMilestone`, ascending epic `numberInProject`;
2. `create` for non-task issues, then `create` for tasks by YouTrack depth (parent before child),
   each group ascending `numberInProject`;
3. `update`, `setParent`, `removeParent`, ascending `numberInProject`;
4. `close`, ascending `numberInProject`.

Every action costs 1 write against `MAX_WRITES_PER_RUN` and 1+ fetches against the 45-fetch
guard; the deadline (R8), rate-limit stop (R7) and failure handling (A10) apply unchanged.

### 1.5 Reads per run

| Read                                                                                                                                      | Fetches                |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| GitHub issues `state=all` (existing), now also `id`, `milestone`, `type`, `parent_issue_url`                                              | `ceil(items/100)`      |
| GitHub milestones `state=all&per_page=100` (new)                                                                                          | `ceil(milestones/100)` |
| YouTrack scan, fields `+parent(issues(idReadable))`, `+customFields(name,value(name))` with `customFields=Type` (live-checked 2026-09-28) | `ceil(issues/100)`     |

For CUI today: 3 reads per run (was 2).

### 1.6 Formatting

- Milestone title and description: `formatMirror(epic)` exactly like an issue (H7, H10): title
  `[YT-n] <summary>` (256 cap), description = neutralised epic description + link, truncated
  with the notice. GitHub documents no milestone description limit (V1 below).
- Silent drops: GitHub drops `milestone`/`type` without push access. The create response is checked;
  a drop is logged as a warning and the next run's sync repairs it (no extra retry write).

### 1.7 Summary line (extends R5)

`scanned created closed updated milestonesCreated milestonesClosed skipped capped failed filtered
unchanged labelsReAdded fetches dryRun`, where `updated` counts `update` + `setParent` +
`removeParent` writes. `unchanged` counts eligible issues and epics that need no write.

## 2. Code changes

### 2.1 Types and reads

- **`src/youtrack.ts`**
  - `YouTrackIssue` gains `type: string | null` and `parentId: string | null` (the parent's
    `idReadable`), derived from generated `IssueLink` / `IssueCustomField` types.
  - Nested field spec (`parent(issues(idReadable))`, `customFields(name,value(name))`) plus the
    `customFields=Type` query parameter; validation keeps failing loudly on shape errors
    (parent with more than one issue, Type value without a string name).
  - `YOUTRACK_TYPE_FIELD = "Type"` constant.
- **`src/github.ts` split into `src/github/`** (it is already 434 lines):
  - `github/client.ts`: headers, request builder, URL helpers, `GitHubTarget`, errors.
  - `github/link.ts`: Link header parsing (`nextPageUrl`), moved unchanged.
  - `github/issues.ts`: `GitHubIssue` (+ `id`, `milestoneNumber`, `typeName`, `parentNumber`,
    `parentIsForeign`), `listAllIssues`, `createIssue` (body now `milestone`, `type`,
    `parent_issue_id`), `closeIssue`, `updateIssue` (PATCH milestone/type), `addLabel`.
  - `github/sub-issues.ts`: `addSubIssue(parentNumber, childId, replaceParent)`,
    `removeSubIssue(parentNumber, childId)`.
  - `github/milestones.ts`: `GitHubMilestone` (number, title, state), `listAllMilestones`,
    `createMilestone`, `closeMilestone`.
  - `src/github.ts` stays as a barrel re-export so existing imports keep working, or imports are
    updated in the same change (preferred; no barrel).
  - Types from `@octokit/openapi-types` (`milestone`, `issue-type`, operations for sub-issues,
    milestones, issues/update).
  - `parent_issue_url` -> `parentNumber` only when it is this repo's
    `https://api.github.com/repos/{owner}/{repo}/issues/{n}`; another repo sets `parentIsForeign`.

### 2.2 Pure logic

- **New `src/hierarchy.ts`**: `classify(issue)`, `buildTree(issues)` (idReadable -> issue),
  `nearestEpic`, `nearestMirroredParent` with cycle guard; returns a `DesiredState` per
  numberInProject: `{ kind, milestoneEpic: number | null, parentYt: number | null, type }`.
- **`src/plan.ts`** (may split: `plan/index.ts` for issues, `plan/milestones.ts`):
  - `buildMilestoneIndex(milestones)` like `buildMirrorIndex` (duplicates: lowest number wins +
    warning).
  - `Action` union gains `createMilestone`, `closeMilestone`, `update`, `setParent`,
    `removeParent`; `create` carries `milestoneEpic` and `parentYt` (YouTrack numbers, resolved to
    GitHub numbers/ids at execution).
  - Ordering (1.4), dependency deferral (D4), cap.
  - `writeCost` stays 1 for every kind.

### 2.3 Execution

- **`src/sync/execute.ts`** (may split: `sync/execute-issues.ts`, `sync/execute-milestones.ts`):
  - A run-local `Resolved` map: YouTrack number -> GitHub `{number, id}` for issues and
    YouTrack epic number -> milestone number, seeded from the reads and extended after each
    successful create. Actions whose dependency is missing from it are capped (D4).
  - New writer methods: `createMilestone`, `closeMilestone`, `update`, `addSubIssue`,
    `removeSubIssue` (all through the same serial, paused `send`).
  - Retry policy: creates stay `no-retry`; everything else `retry-once` (idempotent), which matches
    A10. `replace_parent: true` makes `setParent` idempotent.
- **`src/sync/tally.ts`**: counters `updated`, `milestonesCreated`, `milestonesClosed`.
- **`src/sync.ts`**: reads milestones, builds both indexes, passes hierarchy to the planner,
  previews the new actions in dry run (`[dry-run] would create milestone YT-33: ...`,
  `would set milestone of YT-15 #21 to YT-33`, `would move YT-40 #25 under YT-35 #24`, ...),
  extends the summary.

### 2.4 Docs

README (behaviour, summary line, budget), CLAUDE.md (layout, hierarchy rule), docs/09 "As built",
docs/10 (final rules), `.env.example` unchanged (no new config).

## 3. Tests (TDD: written first, per module)

| Area               | Cases                                                                                                                                                                                                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `youtrack`         | Type and parent parsed; no Type field; Type with null value; parent `[]`; parent with 2 issues -> schema error; `customFields=Type` in the URL                                                                                                                                      |
| `github/*`         | parse `id`, milestone, type, `parent_issue_url` (same repo, foreign repo, null); milestones list paging; create/close milestone; PATCH body; sub-issue add (`sub_issue_id` as JSON integer) and remove                                                                              |
| `hierarchy`        | epic/story/bug/task/unknown; nearest epic; nearest mirrored parent across unmirrored and filtered ancestors; stop at epic; cross-project parent; cycle                                                                                                                              |
| `plan`             | every action kind; D2/D3 ownership rules; closed mirrors synced; ordering; D4 deferral; cap never lets later actions jump ahead; no reopen; no rename                                                                                                                               |
| `sync` / `execute` | end-to-end with fake fetch: epic + stories + tasks created in one run with correct `parent_issue_id`/`milestone`; parent create fails -> child capped; re-parenting; milestone closed; silent drop warned; dry run sends no writes; budget/deadline/rate-limit still stop correctly |

## 4. Verification and rollout

1. `npm run check` + coverage (>= current 99.9% lines).
2. Live dry run on CUI (GET only): expected today: `[dry-run] would update YT-15 #21` (type
   `Task`), nothing else, because neither epic has `[team]` and all `[team]` issues are resolved.
3. **V1/V2, needs your OK (real writes):** run once with `DRY_RUN=false` against a scratch
   GitHub repo you own (`GITHUB_REPO=<you>/yt-gh-scratch`, same YouTrack project) to confirm on a
   real API: milestone with a long description (V1), issue types `Feature/Bug/Task` accepted by
   name (V2), `parent_issue_id` on create and `replace_parent` moves (V3). Alternative: a few
   `[team]` test issues in YouTrack against the real repo.
4. Deploy with `DRY_RUN=true`, check one `wrangler tail` run, then `DRY_RUN=false`.

## 5. Work breakdown

| Step | Work                                                                    | Depends on |
| ---- | ----------------------------------------------------------------------- | ---------- |
| 1    | Record H6/H9/H10 and D1-D8; update docs/10                              | -          |
| 2    | `youtrack.ts`: Type + parent (+ tests)                                  | 1          |
| 3    | Split `github.ts` into `src/github/` with no behaviour change           | 1          |
| 4    | `github/milestones.ts`, `github/sub-issues.ts`, issue fields (+ tests)  | 3          |
| 5    | `hierarchy.ts` (+ tests)                                                | 2          |
| 6    | `plan.ts` actions, ordering, deferral (+ tests)                         | 4, 5       |
| 7    | `sync/execute.ts`, `tally.ts`, `sync.ts`, dry-run preview (+ e2e tests) | 6          |
| 8    | Docs, README, CLAUDE.md                                                 | 7          |
| 9    | Review (code + security), live dry run, V1-V3 with your OK              | 8          |

Steps 2, 3 and 5 can run in parallel; 4 after 3; the rest in order.

## 6. Risks

- **Undocumented behaviour** (V1-V3): milestone description limit, invalid type names, adding a
  closed issue as a sub-issue. Mitigation: scratch-repo run before going live; failures are
  recorded per write and never block other actions.
- **Churn from hand edits on GitHub:** a teammate moving a mirrored task under another issue is
  moved back every run (only when the new parent is also a mirror, D2).
- **Budget:** a large reorganisation in YouTrack (many tasks moved) is spread over several runs by
  the 30-write cap; each run is idempotent.
- **GitHub sub-issue limits:** 100 per parent, 8 levels; a 101st child fails that write and is
  retried every run (logged).
