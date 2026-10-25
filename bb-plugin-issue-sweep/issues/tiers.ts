import type { Run } from "sweep-ui/types";

/**
 * Which run, and so which tier, each issue belongs in, and the order the list
 * draws them in. Pure: every input is something the sweep already fetched or
 * the plugin already stores, so the same listing always draws the same list.
 */

/** One row of the listing, as the panel receives it. */
export interface ListedIssue {
  repo: string;
  number: number;
  title: string;
  url: string;
  labels: string[];
  boardStatus: string | null;
  onBoard: boolean;
  /** The first configured board the issue is on, or null. */
  board?: string | null;
  /**
   * The Status options of the board this row's moves go to: the board it is
   * on, or the one it would be added to. Empty when that board could not be
   * read, which draws the status as text with nothing to move.
   */
  statusOptions?: string[];
  blockedBy: number;
  closingPr: number | null;
  subtasks?: { completed: number; total: number; source: "sub-issues" | "tasks" } | null;
  threadId: string | null;
  canSpawn: boolean;
  createdAt: number;
  updatedAt: number;
  commentsCount: number;
  /** The local next-step note, never sent to GitHub. */
  note: string | null;
  /** Put on hold from the note editor, which sinks it to the bottom of Needs you. Local only. */
  onHold?: boolean;
  /** Comments since the issue was last opened from here. */
  newComments: number;
  parent: { number: number; title: string; url: string } | null;
  /**
   * When this plugin last moved the issue's board status, or null. A board
   * move does not change GitHub's updatedAt, so without it an issue promoted
   * from the panel would read as stale right away.
   */
  movedAt: number | null;
}

export interface TierInputs {
  /** "Statuses that are on you": what Next is made of. */
  countedStatuses: string[];
  /** "Board status when a closing pull request opens": waiting on a reviewer. */
  reviewStatus: string;
  /** The track's stages, in order. */
  boardStages: string[];
  staleAfterDays: number;
  now: number;
}

/**
 * Every run in list order. A row that fits more than one takes the first, so
 * an issue with a thread and new comments is in "new comments".
 */
export const ISSUE_RUNS: Run[] = [
  { id: "new-comments", label: "new comments", labelOne: "new comment", tone: "new", tier: "now" },
  { id: "stale", label: "stale", labelOne: "stale", tone: "late", tier: "now" },
  { id: "working", label: "working", labelOne: "working", tone: "underway", tier: "now" },
  { id: "in-progress", label: "in progress", labelOne: "in progress", tone: "next", tier: "now", color: "bg-sky-500" },
  { id: "to-start", label: "to start", labelOne: "to start", tone: "next", tier: "next" },
  { id: "on-hold", label: "on hold", labelOne: "on hold", tone: "later", tier: "next" },
  { id: "waiting", label: "waiting on review", labelOne: "waiting on review", tone: "later", tier: "later" },
  { id: "later", label: "later", labelOne: "later", tone: "later", tier: "later" },
  { id: "blocked", label: "blocked", labelOne: "blocked", tone: "later", tier: "later" },
];

const DAY = 24 * 60 * 60_000;
const DEFAULT_STALE_AFTER_DAYS = 7;

/** The "Stale after (days)" setting. Anything but a positive whole number takes the default. */
export function parseStaleAfterDays(raw: string): number {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_STALE_AFTER_DAYS;
  const days = Number(trimmed);
  return days > 0 ? days : DEFAULT_STALE_AFTER_DAYS;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Same rule as the sidebar badge: no counted statuses counts every status. */
function isCounted(row: ListedIssue, inputs: TierInputs): boolean {
  if (!row.onBoard || row.boardStatus === null) return false;
  if (inputs.countedStatuses.length === 0) return true;
  return inputs.countedStatuses.some((status) => same(status, row.boardStatus!));
}

/**
 * Has sub-issues. A task list in the body does not count: its items are steps
 * of this issue, not issues someone else can pick up.
 */
function isParent(row: ListedIssue): boolean {
  return row.subtasks?.source === "sub-issues" && row.subtasks.total > 0;
}

/**
 * In a counted status further along the stages than the first counted one:
 * with the defaults, In Progress rather than Ready. Started, so not done, and
 * that holds for a parent too, whose sub-issues are still under way.
 */
function isUnderway(row: ListedIssue, inputs: TierInputs): boolean {
  if (!isCounted(row, inputs) || row.blockedBy > 0) return false;
  const stage = stageOf(row, inputs.boardStages);
  if (stage === null) return false;
  const counted = inputs.boardStages
    .map((name, index) => ({ name, index }))
    .filter(({ name }) => inputs.countedStatuses.some((status) => same(status, name)));
  const first = counted[0]?.index;
  return first !== undefined && stage > first;
}

function isWaiting(row: ListedIssue, inputs: TierInputs): boolean {
  return inputs.reviewStatus.trim() !== "" && row.boardStatus !== null && same(row.boardStatus, inputs.reviewStatus);
}

/**
 * The latest sign of life: GitHub's updatedAt, or a board move made from
 * here if that came later. Moves made on GitHub's own board are not seen.
 */
export function lastActivity(row: ListedIssue): number {
  return Math.max(row.updatedAt, row.movedAt ?? 0);
}

/**
 * Something you meant to be doing that has not moved for the configured number
 * of days. Never a parent: its sub-issues are the work, and they carry their
 * own activity.
 */
export function isStale(row: ListedIssue, inputs: TierInputs): boolean {
  return (
    !row.onHold &&
    isCounted(row, inputs) &&
    row.blockedBy === 0 &&
    !isParent(row) &&
    inputs.now - lastActivity(row) > inputs.staleAfterDays * DAY
  );
}

/** The runs an issue on hold leaves for "on hold". */
const HELD_FROM = new Set(["stale", "working", "in-progress", "to-start"]);

export function runOf(row: ListedIssue, inputs: TierInputs): string {
  if (row.newComments > 0) return "new-comments";
  const run = unheldRunOf(row, inputs);
  // A hold only sinks an issue that would otherwise need you. One in review,
  // blocked, or later is already out of the way.
  return row.onHold && HELD_FROM.has(run) ? "on-hold" : run;
}

function unheldRunOf(row: ListedIssue, inputs: TierInputs): string {
  if (isStale(row, inputs)) return "stale";
  if (row.threadId) return "working";
  if (isUnderway(row, inputs)) return "in-progress";
  if (isCounted(row, inputs) && row.blockedBy === 0 && !isParent(row)) return "to-start";
  // Waiting before blocked: an issue in review is out of your hands already,
  // whatever else it depends on.
  if (isWaiting(row, inputs)) return "waiting";
  if (row.blockedBy > 0) return "blocked";
  return "later";
}

/** The track's column for a row, or null when its status is not one of the stages. */
export function stageOf(row: ListedIssue, boardStages: string[]): number | null {
  if (!row.onBoard || row.boardStatus === null) return null;
  const index = boardStages.findIndex((stage) => same(stage, row.boardStatus!));
  return index === -1 ? null : index;
}

/**
 * Within the "later" run: statuses in board order, then statuses the stages
 * do not name, then issues off the board, then parents. Returned as a tuple
 * compared left to right.
 */
function laterRank(row: ListedIssue, inputs: TierInputs): [number, number, string] {
  if (isParent(row)) return [3, 0, ""];
  if (!row.onBoard || row.boardStatus === null) return [2, 0, ""];
  const stage = stageOf(row, inputs.boardStages);
  if (stage !== null) return [0, stage, ""];
  return [1, 0, row.boardStatus.toLowerCase()];
}

/**
 * Run order first, which also puts Now before Next before Later, then the
 * later run's groups, then the most recently updated. The repo-then-number
 * tiebreak keeps rows that share a timestamp from reshuffling between sweeps.
 */
export function sortIssues(rows: ListedIssue[], inputs: TierInputs): ListedIssue[] {
  const order = new Map(ISSUE_RUNS.map((run, index) => [run.id, index]));
  const keyed = rows.map((row) => {
    const run = runOf(row, inputs);
    return { row, run: order.get(run) ?? ISSUE_RUNS.length, rank: run === "later" ? laterRank(row, inputs) : null };
  });
  keyed.sort((a, b) => {
    if (a.run !== b.run) return a.run - b.run;
    if (a.rank && b.rank) {
      if (a.rank[0] !== b.rank[0]) return a.rank[0] - b.rank[0];
      if (a.rank[1] !== b.rank[1]) return a.rank[1] - b.rank[1];
      const byName = a.rank[2].localeCompare(b.rank[2]);
      if (byName !== 0) return byName;
    }
    return (
      b.row.updatedAt - a.row.updatedAt ||
      a.row.repo.localeCompare(b.row.repo) ||
      a.row.number - b.row.number
    );
  });
  return keyed.map((entry) => entry.row);
}

/** The runs drawn in the "Needs you" column. Every other run goes beside it. */
export const NEEDS_YOU_RUNS = new Set(["new-comments", "stale", "working", "in-progress", "to-start", "on-hold"]);

export function needsYou(row: ListedIssue, inputs: TierInputs): boolean {
  return NEEDS_YOU_RUNS.has(runOf(row, inputs));
}

export interface StatusGroup {
  /** The heading: a status name, "Blocked", "No status", or "Not on board". */
  name: string;
  /** The status whose colour the heading's dot takes, or null for none. */
  status: string | null;
  blocked: boolean;
  rows: ListedIssue[];
}

/**
 * The rows that do not need you, grouped for the column beside "Needs you":
 * the stages furthest along first, then blocked issues, then statuses the
 * stages do not name, alphabetically, then issues with no status and issues
 * off the board. Each group keeps the order `sortIssues` gave its rows.
 */
export function statusGroups(rows: ListedIssue[], inputs: TierInputs): StatusGroup[] {
  const groups = new Map<string, StatusGroup>();
  const rank = new Map<string, [number, number, string]>();
  for (const row of sortIssues(rows, inputs)) {
    let name: string;
    let key: [number, number, string];
    let status: string | null = row.boardStatus;
    const blocked = runOf(row, inputs) === "blocked";
    const stage = stageOf(row, inputs.boardStages);
    if (blocked) {
      name = "Blocked";
      key = [1, 0, ""];
      status = null;
    } else if (!row.onBoard) {
      name = "Not on board";
      key = [4, 0, ""];
    } else if (row.boardStatus === null) {
      name = "No status";
      key = [3, 0, ""];
    } else if (stage !== null) {
      name = inputs.boardStages[stage]!;
      key = [0, inputs.boardStages.length - stage, ""];
    } else {
      name = row.boardStatus;
      key = [2, 0, row.boardStatus.toLowerCase()];
    }
    const id = name.toLowerCase();
    const group = groups.get(id) ?? { name, status, blocked, rows: [] };
    group.rows.push(row);
    groups.set(id, group);
    rank.set(id, key);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => {
      const x = rank.get(a)!;
      const y = rank.get(b)!;
      return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]);
    })
    .map(([, group]) => group);
}
