// Pure logic about the files in a diff and bb's own Viewed marks on them. No
// DOM, no network, no clock: everything here is a function of its arguments so
// the tests can pin the contract without a browser or a server.
//
// bb keeps the marks. It stores one per environment, diff range, and path,
// together with the file's `revision` (its old and new blob hashes), and a
// file counts as viewed only while that revision is still the one in the
// diff. So a mark clears itself when the file changes.

/** One file in bb's changes panel, as the panel's own file list holds it. */
export interface DiffFileEntry {
  path: string;
  previousPath: string | null;
  changeKind: string;
  additions: number;
  deletions: number;
  binary: boolean;
  /** Changes whenever the file's content on either side of the diff does. */
  revision: string;
}

/** bb's marks for one range: path -> the revision that was marked viewed. */
export type ViewedMap = Record<string, string>;

/** The range the changes panel shows, as bb's panel holds it. */
export type DiffTarget =
  | { type: "uncommitted" }
  | { type: "branch_committed"; mergeBaseBranch: string }
  | { type: "all"; mergeBaseBranch: string }
  | { type: "commit"; sha: string };

/**
 * One key per range bb keeps marks for. Mirrors `diffViewedTargetKey` in bb's
 * server, so a key here names the same set of marks bb does.
 */
export function targetKey(target: DiffTarget): string {
  switch (target.type) {
    case "uncommitted":
      return "uncommitted";
    case "branch_committed":
    case "all":
      return `${target.type}:${target.mergeBaseBranch}`;
    case "commit":
      return `commit:${target.sha.toLowerCase()}`;
  }
}

/** The range in the shape bb's diff read APIs take as a query. */
export function targetQuery(
  target: DiffTarget,
):
  | { target: "uncommitted" }
  | { target: "branch_committed" | "all"; mergeBaseBranch: string }
  | { target: "commit"; sha: string } {
  switch (target.type) {
    case "uncommitted":
      return { target: "uncommitted" };
    case "branch_committed":
    case "all":
      return { target: target.type, mergeBaseBranch: target.mergeBaseBranch };
    case "commit":
      return { target: "commit", sha: target.sha };
  }
}

/**
 * The thread a diff belongs to, read from the app route. bb serves thread
 * pages at both `/threads/:id` and `/projects/:projectId/threads/:id`.
 */
export function threadIdFromPath(pathname: string): string | null {
  const match = /\/threads\/([^/?#]+)/.exec(pathname);
  const threadId = match?.[1];
  if (threadId === undefined || threadId === "") return null;
  return decodeURIComponent(threadId);
}

/**
 * The label bb puts on this file's card: the path, or `previous -> current`
 * for a rename or copy. bb's Viewed checkbox is named `Viewed <label>`, which
 * is how a checkbox is matched back to its file. Mirrors
 * `formatDiffEntryLabel` in bb's DiffFileCard.
 */
export function labelForEntry(entry: Pick<DiffFileEntry, "path" | "previousPath" | "changeKind">): string {
  if (
    (entry.changeKind === "renamed" || entry.changeKind === "copied") &&
    entry.previousPath !== null &&
    entry.previousPath !== "" &&
    entry.previousPath !== entry.path
  ) {
    return `${entry.previousPath} -> ${entry.path}`;
  }
  return entry.path;
}

/** Whether bb counts this file's current diff as viewed. */
export function isViewed(viewed: ViewedMap, entry: Pick<DiffFileEntry, "path" | "revision">): boolean {
  return viewed[entry.path] === entry.revision;
}

/** How far through a diff the marks go. */
export interface ReviewProgress {
  viewed: number;
  total: number;
}

export function countViewed(
  viewed: ViewedMap,
  entries: readonly DiffFileEntry[],
): ReviewProgress {
  let count = 0;
  for (const entry of entries) if (isViewed(viewed, entry)) count += 1;
  return { viewed: count, total: entries.length };
}

// Before bb had its own Viewed checkbox, this plugin kept the marks itself,
// per thread, keyed on bb's card label and the file's `+a -d` counts. These
// read those marks once so they can move into bb's.

/** Storage key for one thread's marks from before bb kept them. */
export function legacyRecordKey(threadId: string): string {
  return `viewed:${threadId}`;
}

/** Storage key for one thread's marks that were waiting to reach GitHub. */
export function legacyPendingKey(threadId: string): string {
  return `pending:${threadId}`;
}

/** label -> `+a -d` counts, or `none` for a binary file. */
export type LegacyRecord = Record<string, string>;

/**
 * The files whose old mark still describes their current diff and that bb
 * does not already count as viewed. A mark whose counts have moved on was
 * already cleared under the old rules, so it is not carried over.
 */
export function legacyMarksToMove(
  record: LegacyRecord,
  entries: readonly DiffFileEntry[],
  viewed: ViewedMap,
): DiffFileEntry[] {
  return entries.filter((entry) => {
    if (isViewed(viewed, entry)) return false;
    const mark = record[labelForEntry(entry)];
    if (mark === undefined) return false;
    return mark === `+${entry.additions} -${entry.deletions}` || (entry.binary && mark === "none");
  });
}
