/**
 * The run-local resolution map (docs/11 §2.3): planned actions name their dependencies by
 * YouTrack number (a milestone's epic, a parent issue), and execution turns those into
 * GitHub numbers and ids. It is seeded from the reads and extended after each successful
 * create and createMilestone, so a child created later in the same run finds its parent. A
 * dependency still missing at its turn was not created in this run (its create failed or
 * waited itself), and the action waiting for it is capped (D4). Pure, immutable.
 */

import type { MilestoneIndex } from "../plan/milestones.ts";
import type { MirrorIndex, MirrorRef } from "../plan/mirrors.ts";

/** A GitHub issue as dependencies need it: its number (URLs) and REST id (parent_issue_id, sub_issue_id). */
export type IssueRef = Pick<MirrorRef, "id" | "issueNumber">;

/** YouTrack number -> GitHub issue of every known mirror, and epic number -> milestone number. */
export type Resolved = {
  readonly issues: ReadonlyMap<number, IssueRef>;
  readonly milestones: ReadonlyMap<number, number>;
};

/** A dependency looked up: found with its GitHub value, or missing, with a log name for it. */
export type Dependency<T> =
  { readonly found: true; readonly value: T } | { readonly found: false; readonly missing: string };

/** Every mirror (open or closed) and every milestone the reads found: the indexes the planner used. */
export function seedResolved(mirrors: MirrorIndex, milestones: MilestoneIndex): Resolved {
  return {
    issues: new Map([...mirrors].map(([numberInProject, ref]) => [numberInProject, issueRef(ref)])),
    milestones: new Map([...milestones].map(([epic, ref]) => [epic, ref.milestoneNumber])),
  };
}

/** A copy of `resolved` that also knows `ref`, the mirror of YouTrack issue `numberInProject`. */
export function withIssue(resolved: Resolved, numberInProject: number, ref: IssueRef): Resolved {
  return { ...resolved, issues: new Map([...resolved.issues, [numberInProject, issueRef(ref)]]) };
}

/** A copy of `resolved` that also knows milestone `milestoneNumber` of epic `epic`. */
export function withMilestone(resolved: Resolved, epic: number, milestoneNumber: number): Resolved {
  return { ...resolved, milestones: new Map([...resolved.milestones, [epic, milestoneNumber]]) };
}

/** The milestone number of epic `epic`, or missing ("the milestone of YT-<epic>"). */
export function milestoneFor(resolved: Resolved, epic: number): Dependency<number> {
  const milestoneNumber = resolved.milestones.get(epic);
  if (milestoneNumber === undefined) return { found: false, missing: `the milestone of YT-${String(epic)}` };
  return { found: true, value: milestoneNumber };
}

/** The mirror of YouTrack issue `numberInProject`, or missing ("the mirror of YT-<n>"). */
export function mirrorFor(resolved: Resolved, numberInProject: number): Dependency<IssueRef> {
  const ref = resolved.issues.get(numberInProject);
  if (ref === undefined) return { found: false, missing: `the mirror of YT-${String(numberInProject)}` };
  return { found: true, value: ref };
}

/** `lookup(key)`, or found null when there is no dependency (`key` null). */
export function optional<T>(key: number | null, lookup: (key: number) => Dependency<T>): Dependency<T | null> {
  return key === null ? { found: true, value: null } : lookup(key);
}

function issueRef(ref: IssueRef): IssueRef {
  return { issueNumber: ref.issueNumber, id: ref.id };
}
