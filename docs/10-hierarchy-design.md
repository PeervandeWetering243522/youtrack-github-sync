# Hierarchy mirroring: epics, stories, bugs, tasks (design)

> Drafted 2026-09-28. Decisions H1-H10 and D1-D8 in [08-decisions.md](08-decisions.md).
> **Status: implemented, not yet deployed.** The code follows
> [11-hierarchy-plan.md](11-hierarchy-plan.md), whose "As built" section lists what the
> implementation refined; this page is updated to match. GitHub facts from a docs-only research
> pass (docs.github.com, API version 2026-03-10); YouTrack facts from live GET probes of project
> CUI. "What exists today" is the 2026-09-28 snapshot.

## What exists today

| YouTrack (CUI)                                          | GitHub (repo / org)                                           |
| ------------------------------------------------------- | ------------------------------------------------------------- |
| `Type` field values: Epic, User Story, Task, Bug        | Org issue types: Task, Bug, Feature (no "User Story" or Epic) |
| Parent links (`Subtask` link type, `Issue.parent`)      | Sub-issues (100 per parent, 8 levels, same owner)             |
| Epic CUI-9 "Business Understanding" has 9 task subtasks | Milestones: none yet                                          |
| Epic CUI-33 "[invididual] Data Structures & Algorithms" | `youtrack` label, one mirror so far (#21, [YT-15], closed)    |
| `Relates` link CUI-11 <-> CUI-30                        | No "related" relation in REST or GraphQL (only "blocked by")  |

Neither epic has the `[team]` prefix, so under H2 neither becomes a milestone until renamed.

## Mapping (H1)

| YouTrack   | GitHub                                                                  | Issue type (H6) |
| ---------- | ----------------------------------------------------------------------- | --------------- |
| Epic       | Milestone `[YT-<n>] <summary>`, no due date                             | -               |
| User Story | Issue                                                                   | Feature         |
| Bug        | Issue                                                                   | Bug             |
| Task       | Sub-issue of its parent's mirror; top-level issue if there is none (H3) | Task            |

- **Milestone of an issue (H4, D1):** the milestone of its nearest Epic ancestor, if that epic has
  one (higher epics are not searched). An existing milestone counts whatever the epic's prefix or
  state. Tasks inherit it too, so a milestone's progress bar counts every level. The milestone's
  description is the epic's description plus the link, formatted like an issue body (H10).
- **GitHub parent of a Task (H3):** the mirror of its nearest non-epic YouTrack ancestor that has
  one (or gets one earlier in the same run), whatever that ancestor's prefix or state. Ancestors
  without a mirror (filtered by the prefix, or never mirrored because they were resolved first,
  R9) are skipped. The walk stops at the first epic. If no ancestor qualifies, the task is a
  top-level issue. When a mirrored parent appears later, the task is moved under it.
- **Stories, bugs and other issues (H9):** always top-level. A mirror that sits under another
  mirror is detached.
- **Relates links:** not mirrored (no GitHub equivalent).

## Eligibility (unchanged rules, now for every type)

- Prefix filter (A8/R2): only summaries starting with `[team]`, for epics too (H2).
- Never create for something already resolved (R9): no issue for a resolved story/bug/task, no
  milestone for a resolved epic.
- Close on resolution: open issue mirror -> close (A7, `completed`); open milestone -> close.
- Never reopen, never update titles or bodies (unchanged).

## Keep in sync (H5)

Every run compares the desired state from YouTrack with what the GitHub issue list reports
(`milestone`, `type`, `parent_issue_url`) and fixes differences on **all** mirrors, open or closed:

| Difference                                | Write                                                               |
| ----------------------------------------- | ------------------------------------------------------------------- |
| Milestone or type differs                 | `PATCH /issues/{n}` with `milestone` and/or `type` (one write)      |
| Task should be under another parent       | `POST /issues/{parent}/sub_issues` `{sub_issue_id, replace_parent}` |
| Mirror under a mirror should be top-level | `DELETE /issues/{old parent}/sub_issue` `{sub_issue_id}`            |
| Epic resolved, milestone open             | `PATCH /milestones/{n}` `{state: "closed"}`                         |

Only mirror-owned links are changed (D2): a hand-made milestone or a parent that is not a mirror
(including one in another repo) stays unless YouTrack wants a mirrored one there. A type is never
cleared (D3). `sub_issue_id` and `parent_issue_id` are the child's or parent's REST `id`, never
the issue number.

A create sets milestone, type and parent in the same request (`milestone`, `type`,
`parent_issue_id`), so a new issue costs one write. GitHub silently drops milestone and type without
push access. The create and update answers are checked, a drop is logged as a warning, and the
next run's sync repairs it; the owner has Admin anyway.

## Run order and budget

1. Reads: GitHub issues (existing), GitHub milestones `state=all` (**+1 fetch**), YouTrack scan
   with two more fields: `parent(issues(idReadable))` and `customFields(name,value(name))`,
   limited to the `Type` field by the `customFields=Type` parameter.
2. Milestones: create missing ones, close resolved ones.
3. Issues: create stories and bugs before tasks, and tasks by YouTrack depth, so a task's parent
   `id` is known (from the list or the 201 response of the same run).
4. Sync writes, then issue closes.

All writes stay serial with the 1 s pause and count against `MAX_WRITES_PER_RUN` (30) and the
45-fetch guard. Order within each step is ascending `numberInProject` (A2). A capped run finishes
on the next one; every step is idempotent.

## Code impact (as built)

- `youtrack.ts`: requests and validates `parent` and `Type` (types derived from the generated
  spec: `IssueLink`, `IssueCustomField`, `EnumBundleElement`).
- New pure module `src/hierarchy.ts`: classifies `Type` values and walks the parent links
  (nearest epic, non-epic ancestors, depth), with a cycle guard. The desired state per mirror
  is in `src/plan/desired.ts`.
- `plan.ts` (+ `plan/mirrors.ts`, `plan/milestones.ts`, `plan/desired.ts`): new action kinds
  `createMilestone`, `closeMilestone`, `update`, `setParent`, `removeParent`; create carries
  type, milestone and parent.
- `github.ts` split into `src/github/` (no barrel): milestones list/create/close, PATCH issue,
  sub-issue add/remove, and parsing of `id`, `milestone`, `type` and `parent_issue_url`.
- `sync/execute.ts` split into `execute`, `execute-write`, `execute-issues`,
  `execute-hierarchy`, plus `resolved`, `preview` and `describe`. Summary line gains `updated`,
  `milestonesCreated` and `milestonesClosed`.
- Docs: README, CLAUDE.md, docs/09 "As built".
