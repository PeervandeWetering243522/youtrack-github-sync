# Hierarchy mirroring: implementation plan

> Drafted 2026-09-28 from [10-hierarchy-design.md](10-hierarchy-design.md) and decisions H1-H10 in
> [08-decisions.md](08-decisions.md). Detail rules D1-D8 were accepted on 2026-09-28.
> **Status: steps 1-8 implemented, not yet deployed** (step 9 below is still open). The
> "As built" section lists where the code refines this plan and supersedes the sections it
> names. Where this plan and the code still differ, `README.md` and `src/` are authoritative.

## As built

- **Exclude filter (F1-F3).** `isExcluded` in `src/plan/exclude.ts`: the issue's summary or
  the summary of any ancestor (`linkedAncestors` in `hierarchy.ts`: every Type, epics included,
  any state, ending at a parent outside the scan) starts with `YOUTRACK_EXCLUDE_PREFIX`. Unlike
  the milestone, parent and order walks, it follows the links on a parent cycle, once around:
  every member of a cycle is an ancestor of the others, so one member with the prefix excludes
  the whole cycle and everything below it. Excluded issues and epics count as `filtered` and
  get no action at all, not even a sync or a close of an existing mirror or milestone (F2).
- **Desired milestone (§1.2).** An epic's milestone counts when it exists in the milestone index
  (whatever the epic's state) or is created in this run, and never when the epic is excluded.
  So a mirror under a resolved epic gets that epic's closed milestone, on create and on update
  (V4).
- **Desired parent (§1.2).** The nearest non-epic ancestor that is not excluded and has a mirror
  (whatever its state) or gets one in this run. Unmirrored ancestors are skipped; the walk ends
  at the first epic, at a parent outside the scan (D5) or on a cycle. Under F3 an excluded
  ancestor excludes the issue itself, so the "not excluded" checks only guard inconsistent input.
- **Leaving an excluded parent.** A mirror that is not excluded but still sits under the mirror of
  an excluded issue, or in the milestone of an excluded epic, is synced like any other: it is
  moved or detached, and its milestone replaced or cleared, when YouTrack has it elsewhere (D2
  treats both as mirror-owned).
- **Parent lookup and cycles.** Parents are looked up among all scanned issues by `idReadable`,
  compared ASCII-case-insensitively. For milestones, parents and order every parent link on a
  cycle is ignored, so each issue on it acts as a root (the exclude filter still follows those
  links, see above), and one warning per cycle is logged:
  `YT-<n>: parent chain loops back to YT-<m>` (`m` is the cycle's lowest number).
- **Ownership (§1.3, D2).** An `update` clears the milestone only when the current one is a
  mirror milestone, and a `removeParent` only detaches from a parent that is a mirror in this
  repo. A hand-made milestone, a hand-made parent or a parent in another repo is replaced only
  when YouTrack wants a mirrored one. Every non-task mirror (story, bug, unknown type) that sits
  under a mirror is detached (H9). GitHub type names are compared exactly (V2).
- **Order (§1.4).** Task creates are sorted by YouTrack depth, which counts epic ancestors too.
  The sort is stable, so an issue's `update` runs before its `setParent`/`removeParent`.
- **Cap during execution.** Before each action, if the writes sent so far plus its cost would
  exceed `MAX_WRITES_PER_RUN`, it and the rest are capped (no warning). This catches the label
  re-adds the planner cannot foresee.
- **Waits (D4).** An action whose milestone or parent mirror is missing from the run-local map
  is capped with `<action> capped: the mirror of YT-<n> was not created in this run` (or
  `the milestone of YT-<n>`). It sends nothing, takes no pause, and the run goes on. A waiting
  `update` is capped whole, type change included, so a milestone create that keeps failing
  blocks every create and update under that epic on every run.
- **Dropped fields (§1.6).** The create answer is checked for milestone, type and parent
  (`parent_issue_url`, V3), the update answer for milestone and type. Each drop is one warning,
  e.g. `YT-40 #101: GitHub dropped type Task on create; the next run's sync repairs this`. No
  extra write is sent.
- **Reads (§2.1).** `YouTrackIssue.type` is the `Type` value name (null: no Type field or an
  empty value); `parentId` is the parent's `idReadable`. Two parents or two `Type` entries fail
  the row. A `parent_issue_url` in this repo that is not `.../issues/{n}` fails the GitHub read.
- **Modules (§2).** `src/github.ts` is gone. Imports use the modules in `src/github/`:
  `client.ts`, `link.ts`, `pages.ts`, `issues.ts`, `milestones.ts` and `sub-issues.ts`.
  `hierarchy.ts` exports `classify`, `buildHierarchy`, `ancestors`, `linkedAncestors`,
  `nearestEpic`, `parentChain`, `depth` and `hierarchyWarnings`; there is no `DesiredState`
  type. The exclude
  filter is `src/plan/exclude.ts`, the desired state is computed in `src/plan/desired.ts` and
  the indexes are built in `src/plan/mirrors.ts` and `src/plan/milestones.ts`, while
  `src/plan.ts` keeps the actions, order and cap. Execution is
  split over `src/sync/`: `execute.ts`, `execute-write.ts`, `execute-issues.ts`,
  `execute-hierarchy.ts`, `resolved.ts`, `preview.ts` and `describe.ts`. `HttpMethod` gains
  `DELETE`.
- **Retries.** Issue and milestone creates are never retried; every other write is retried once.
- **Known limitation: swapping two task mirrors.** Task A sits under task B on GitHub and
  YouTrack now has B under A. When B has the lower number, B's `setParent` runs before A's
  `removeParent` (or `setParent`, when A has a new mirrored parent), and GitHub is expected to
  refuse the cycle (unverified), so that write fails the run. A still leaves B in the same run
  and the next run moves B. Ordering the parent changes so that A leaves B first would avoid
  this (running every `removeParent` first covers only the detach case); that change needs a
  decision.

## 1. Behaviour, precisely

### 1.1 Classification (pure, per scanned YouTrack issue)

| `Type` value          | Kind      | GitHub                       | Issue type |
| --------------------- | --------- | ---------------------------- | ---------- |
| `Epic`                | milestone | milestone `[YT-n] <summary>` | -          |
| `User Story`          | issue     | top-level issue              | `Feature`  |
| `Bug`                 | issue     | top-level issue              | `Bug`      |
| `Task`                | task      | sub-issue, or top-level (H3) | `Task`     |
| missing / other value | issue     | top-level issue              | none (D3)  |

Eligibility is the same for every kind: neither the summary nor the summary of any YouTrack
ancestor (epics included) starts with the exclude prefix, default `[individual]` (F1, F3), and
nothing is created for an issue or epic that is already resolved (R9). An excluded issue is
ignored entirely, existing mirror or milestone included (F2).

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
| Mirror's milestone or type differs from desired (D2, D3) | `update`          | one `PATCH /issues/{n}`, milestone and/or type |
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
  - `github/pages.ts` (added): the paged list read shared by issues and milestones.
  - `src/github.ts` is removed and every import updated in the same change (no barrel).
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
  previews the new actions in dry run and extends the summary. Preview lines as built (numbers
  only; the two create lines end with the title; a same-run dependency shows as `(new)`):
  - `[dry-run] would create milestone YT-34: [YT-34] <summary>`
  - `[dry-run] would close milestone YT-33 #7`
  - `[dry-run] would create YT-40 with type Task, milestone YT-34 (new), parent YT-35 (new): [YT-40] <summary>`
  - `[dry-run] would update YT-15 #21: set milestone YT-33 #7, set type Task` (or `clear milestone`)
  - `[dry-run] would move YT-41 #25 under YT-36 #22`
  - `[dry-run] would detach YT-42 #26 from parent YT-36 #22`
  - `[dry-run] would close YT-44 #28`

  A real run logs the same text without `[dry-run] would`. Creates end with ` -> #<number>`
  instead of the title, and their dependencies show resolved numbers.

### 2.4 Docs

README (behaviour, summary line, budget), CLAUDE.md (layout, hierarchy rule), docs/09 "As built",
docs/10 (final rules), `.env.example` comments only (no new config).

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
2. Live dry run on CUI (GET only). Expected under F1 and F3 (not re-checked against live data
   here): an update of YT-15 #21 (`set type Task`), a `create milestone` for every unresolved
   epic that is not excluded, and a `create` for every unresolved story, bug, task or untyped
   issue that is not excluded, with its type, milestone and parent. Nothing for an excluded
   epic or anything below it, such as CUI-32 "[Individual] Data Structures and Algorithms" and
   its tasks CUI-46 and CUI-47: they count as `filtered`.
3. **V1-V4, needs your OK (real writes):** run once with `DRY_RUN=false` against a **private**
   scratch repo in the BredaUniversityADSAI org (issue types are defined per organization, so a
   personal repo cannot check V2), for example
   `GITHUB_REPO=BredaUniversityADSAI/yt-gh-scratch`, with the same YouTrack project. It needs the
   `youtrack` label (G1). Under F1 the scratch run mirrors every unresolved CUI issue that is
   not excluded, at most 30 writes per run (later runs finish the rest). V1-V4 need an
   unresolved epic with a story under it and a task under the story; if CUI has none, make a
   few test issues in YouTrack by hand (this tool never writes YouTrack). **Mind the live
   Worker:** the deployed version (`DRY_RUN=false`, `[team]` inclusion filter, no hierarchy)
   scans the same project and mirrors every `[team]` issue into the real repo within 10
   minutes, so do not give test issues the `[team]` prefix. Once this version is deployed with
   writes on, it mirrors every test issue without the exclude prefix, so resolve them before
   that (R9), or deploy with `DRY_RUN=true` first. Test issues in CUI are visible to everyone
   in the project. Things to confirm on the real API:
   - V1: a milestone with a long description;
   - V2: issue types `Feature`, `Bug` and `Task` accepted by name, and `type.name` returned with
     the same case (otherwise every run sends an update and warns);
   - V3: `parent_issue_id` on create (with `parent_issue_url` in the 201 answer, otherwise every
     task created with a parent logs a false "dropped parent" warning), `replace_parent` moves,
     and adding a closed issue as a sub-issue;
   - V4: an issue created or updated with a closed milestone (a mirror under a resolved epic).
     If GitHub refuses it, that create or update fails on every run.
4. Deploy with `DRY_RUN=true`, check one `wrangler tail` run, then `DRY_RUN=false`.

## 5. Work breakdown

| Step | Work                                                                    | Depends on | Status |
| ---- | ----------------------------------------------------------------------- | ---------- | ------ |
| 1    | Record H6/H9/H10 and D1-D8; update docs/10                              | -          | done   |
| 2    | `youtrack.ts`: Type + parent (+ tests)                                  | 1          | done   |
| 3    | Split `github.ts` into `src/github/` with no behaviour change           | 1          | done   |
| 4    | `github/milestones.ts`, `github/sub-issues.ts`, issue fields (+ tests)  | 3          | done   |
| 5    | `hierarchy.ts` (+ tests)                                                | 2          | done   |
| 6    | `plan.ts` actions, ordering, deferral (+ tests)                         | 4, 5       | done   |
| 7    | `sync/execute.ts`, `tally.ts`, `sync.ts`, dry-run preview (+ e2e tests) | 6          | done   |
| 8    | Docs, README, CLAUDE.md                                                 | 7          | done   |
| 9    | Review (code + security), live dry run, V1-V4 with your OK              | 8          | open   |

Steps 2, 3 and 5 can run in parallel; 4 after 3; the rest in order.

## 6. Risks

- **Undocumented behaviour** (V1-V4): milestone description limit, invalid type names, adding a
  closed issue as a sub-issue, a closed milestone on an issue. Mitigation: scratch-repo run
  before going live; failures are recorded per write and block only the actions that wait for
  them (D4).
- **Blocked epics:** a milestone create that always fails (for example on the unknown
  description limit, V1) caps every create and update under that epic on every run, and the
  failure is logged on every run.
- **Swapping two task mirrors** fails one run (see "As built").
- **Churn from hand edits on GitHub:** a teammate moving a mirrored task under another issue is
  moved back every run (only when the new parent is also a mirror, D2).
- **Budget:** a large reorganisation in YouTrack (many tasks moved) is spread over several runs by
  the 30-write cap; each run is idempotent.
- **GitHub sub-issue limits:** 100 per parent, 8 levels; a 101st child fails that write and is
  retried every run (logged).
