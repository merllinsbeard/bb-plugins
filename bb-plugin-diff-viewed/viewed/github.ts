// Pure rules for keeping bb's Viewed marks and GitHub's own per-file Viewed
// state on a pull request in step. No network: the server fetches both sides
// and hands them here, and the content script uses the same rules to decide
// which files show the Local icon.
//
// A file syncs when its `+a -d` counts in bb match GitHub's: then the diff on
// screen is the one on GitHub, and a mark on either side is copied to the
// other. When the counts differ, as with unpushed edits or the Uncommitted
// range, GitHub's state is about a different diff, so the file is Local and
// GitHub is left alone.
import { isViewed, type DiffFileEntry, type ViewedMap } from "./marks";

/** One file of the pull request, as GitHub reports it for the viewer. */
export interface GithubFile {
  path: string;
  additions: number;
  deletions: number;
  /** GitHub's VIEWED. UNVIEWED and DISMISSED (changed since viewed) are false. */
  viewed: boolean;
}

/** The thread's pull request and its files, or null when nothing syncs. */
export interface GithubState {
  number: number;
  url: string;
  files: GithubFile[];
}

/** Where a file's mark lives. */
export type SyncMode =
  /** No pull request, or sync is off: the mark is bb's alone. */
  | { kind: "none" }
  /** The diff matches GitHub's, so the mark is shared with GitHub's Viewed box. */
  | { kind: "synced"; number: number; file: GithubFile }
  /** There is a pull request, but this diff is not the one on GitHub. */
  | { kind: "local"; number: number };

type Counted = Pick<DiffFileEntry, "path" | "additions" | "deletions">;

/** Whether bb's diff of a file is the one GitHub has. */
export function sameDiff(file: GithubFile, entry: Counted): boolean {
  return file.additions === entry.additions && file.deletions === entry.deletions;
}

export function syncMode(github: GithubState | null, entry: Counted): SyncMode {
  if (github === null) return { kind: "none" };
  const file = github.files.find((candidate) => candidate.path === entry.path);
  if (file !== undefined && sameDiff(file, entry)) {
    return { kind: "synced", number: github.number, file };
  }
  return { kind: "local", number: github.number };
}

/** Replace one file's Viewed state, returning a new state. */
export function withGithubViewed<State extends GithubState>(
  github: State,
  path: string,
  viewed: boolean,
): State {
  return {
    ...github,
    files: github.files.map((file) =>
      file.path === path ? { ...file, viewed } : file,
    ),
  };
}

/**
 * What bb and GitHub last agreed on for each synced file, keyed by path. It
 * is how a difference between the two is read: the side that no longer
 * matches it is the one that changed.
 */
export type Baseline = Record<string, { revision: string; viewed: boolean }>;

export interface Reconciliation {
  /** Files to mark viewed in bb, because GitHub has them viewed. */
  markInBb: DiffFileEntry[];
  /** Files to clear in bb, because they were unmarked on GitHub. */
  clearInBb: DiffFileEntry[];
  /** GitHub paths to set, because they changed in bb. */
  pushToGithub: { path: string; viewed: boolean }[];
  /** The agreement once those are applied. */
  baseline: Baseline;
}

/**
 * Bring bb's marks and GitHub's Viewed boxes into line for every file that
 * syncs. Where they differ, the side that moved away from `baseline` wins.
 * With no agreement on record yet, as for a file marked in bb before the pull
 * request was opened, a mark on either side wins over no mark, so nothing is
 * ever unmarked on a first meeting.
 *
 * The baseline is kept per revision, so a file that changes starts over:
 * bb's old mark no longer counts, and GitHub dismisses its own.
 */
export function reconcile(
  entries: readonly DiffFileEntry[],
  viewed: ViewedMap,
  github: GithubState,
  baseline: Baseline,
): Reconciliation {
  const result: Reconciliation = {
    markInBb: [],
    clearInBb: [],
    pushToGithub: [],
    baseline: {},
  };
  for (const entry of entries) {
    const mode = syncMode(github, entry);
    if (mode.kind !== "synced") continue;
    const inBb = isViewed(viewed, entry);
    const onGithub = mode.file.viewed;
    const agreed = baseline[entry.path];
    const before = agreed?.revision === entry.revision ? agreed.viewed : undefined;

    let now: boolean;
    if (inBb === onGithub) {
      now = inBb;
    } else if (before === undefined) {
      now = true;
      if (inBb) result.pushToGithub.push({ path: entry.path, viewed: true });
      else result.markInBb.push(entry);
    } else if (inBb !== before) {
      now = inBb;
      result.pushToGithub.push({ path: entry.path, viewed: inBb });
    } else {
      now = onGithub;
      if (onGithub) result.markInBb.push(entry);
      else result.clearInBb.push(entry);
    }
    result.baseline[entry.path] = { revision: entry.revision, viewed: now };
  }
  return result;
}

/** Whether two baselines record the same agreement, to skip a redundant write. */
export function sameBaseline(a: Baseline, b: Baseline): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(
    (key) => a[key]?.revision === b[key]?.revision && a[key]?.viewed === b[key]?.viewed,
  );
}
