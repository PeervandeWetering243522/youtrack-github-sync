/**
 * Grouping shared by the mirror and milestone indexes: GitHub objects whose `[YT-n]` title
 * names a YouTrack issue, ranked by the caller, become one group per YouTrack number with a
 * single winner. Pure, no I/O.
 */

/** A GitHub object (as `ref`) whose title names YouTrack issue `numberInProject`. */
export type Candidate<T> = { readonly numberInProject: number; readonly ref: T };

/** All candidates for one YouTrack number: the best ranked one and the rest, in rank order. */
export type CandidateGroup<T> = {
  readonly numberInProject: number;
  readonly winner: T;
  readonly ignored: readonly T[];
};

/**
 * Splits `ranked` into one group per numberInProject. The caller sorts by numberInProject
 * first, so each group's candidates arrive adjacent; the first of each group wins.
 */
export function groupCandidates<T>(ranked: readonly Candidate<T>[]): readonly CandidateGroup<T>[] {
  const groups: { numberInProject: number; winner: T; ignored: T[] }[] = [];
  for (const { numberInProject, ref } of ranked) {
    const current = groups.at(-1);
    if (current?.numberInProject === numberInProject) current.ignored.push(ref);
    else groups.push({ numberInProject, winner: ref, ignored: [] });
  }
  return groups;
}
