# Hierarchy mirroring: epics, stories, bugs, tasks (design)

> Drafted 2026-09-28. Decisions H1-H8 in [08-decisions.md](08-decisions.md). Not implemented yet.
> GitHub facts from a docs-only research pass (docs.github.com, API version 2026-03-10); YouTrack
> facts from live GET probes of project CUI.

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

- **Milestone of an issue (H4):** the nearest Epic among its YouTrack ancestors that has a
  milestone. Tasks inherit it too, so a milestone's progress bar counts every level.
- **GitHub parent of a Task (H3):** the mirror of its nearest non-epic YouTrack ancestor. If there is
  none (parent is an epic, no parent, parent filtered by the prefix or never mirrored because it was
  resolved first, R9), the task is a top-level issue. When a mirrored parent appears later, the task
  is moved under it.
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

| Difference                          | Write                                                               |
| ----------------------------------- | ------------------------------------------------------------------- |
| Milestone or type differs           | `PATCH /issues/{n}` with `milestone` and/or `type` (one write)      |
| Task should be under another parent | `POST /issues/{parent}/sub_issues` `{sub_issue_id, replace_parent}` |
| Task should no longer have a parent | `DELETE /issues/{old parent}/sub_issue` `{sub_issue_id}`            |
| Epic resolved, milestone open       | `PATCH /milestones/{n}` `{state: "closed"}`                         |

A create sets milestone, type and parent in the same request (`milestone`, `type`,
`parent_issue_id`), so a new issue costs one write. GitHub silently drops milestone and type without
push access; the next run's sync repairs any drop, and the owner has Admin anyway.

## Run order and budget

1. Reads: GitHub issues (existing), GitHub milestones `state=all` (**+1 fetch**), YouTrack scan
   with two more fields: `parent(issues(idReadable,numberInProject))` and the `Type` custom field.
2. Milestones: create missing ones, close resolved ones.
3. Issues: create stories and bugs before tasks, so a task's parent `id` is known (from the list or
   the 201 response of the same run).
4. Sync writes, then issue closes.

All writes stay serial with the 1 s pause and count against `MAX_WRITES_PER_RUN` (30) and the
45-fetch guard. Order within each step is ascending `numberInProject` (A2). A capped run finishes
on the next one; every step is idempotent.

## Code impact

- `youtrack.ts`: request and validate `parent` and `Type` (types derived from the generated spec:
  `IssueLink`, `IssueCustomField`).
- New pure module `src/hierarchy.ts`: YouTrack tree -> desired GitHub state per issue and epic
  (milestone, type, parent), with a cycle guard.
- `plan.ts`: new action kinds `createMilestone`, `closeMilestone`, `updateIssue`, `setParent`,
  `removeParent`; create carries milestone/type/parent.
- `github.ts`: milestones list/create/close, PATCH issue, sub-issue add/remove, and parsing of
  `milestone`, `type` and `parent_issue_url`.
- `sync/execute.ts`: execute the new actions. Summary line gains `milestonesCreated`,
  `milestonesClosed` and `updated`.
- Docs: README, CLAUDE.md, docs/09 "As built".
