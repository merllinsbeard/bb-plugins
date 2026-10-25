import type { SyncUsage } from "@danielbachhuber/bb-plugin-component-library/sync-status";
import { useState, type ReactNode } from "react";
import { Markdown, UrlLink } from "@get-bb/plugin-sdk/app";
import { ThreadLine, OpenThreadAction, StartingThreadLine, type ThreadStatus } from "@danielbachhuber/bb-plugin-component-library/thread-status";
import { CopyLinkAction, LINE_ACTION } from "sweep-ui/actions";
import { SweepRow } from "sweep-ui/row";
import { SkippedReposFooter } from "sweep-ui/skipped-repos";
import { SummarySquares } from "sweep-ui/summary";
import type { Flag, Run, RunTone, Stage, SweepItem } from "sweep-ui/types";
import { writeLinkToClipboard } from "@/components/ui/copy-link";
import {
  LoadingGraphic,
  usePrefersReducedMotion,
} from "@/components/ui/loading-graphic";
import { EmptyGraphic } from "@/components/ui/empty-graphic";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { HarvestRowClock } from "bb-plugin-harvest/clock";
import type { HarvestTimerClient } from "bb-plugin-harvest/picker";
import { timerDefaultsForItem } from "bb-plugin-harvest/github";
import { FeedbackDrawer, type FeedbackResult } from "sweep-ui/feedback";
import { stagesOnBoard } from "./board.js";
import { relativeTime } from "./format.js";
import {
  ISSUE_RUNS,
  isStale,
  lastActivity,
  NEEDS_YOU_RUNS,
  needsYou,
  runOf,
  sortIssues,
  stageOf,
  statusGroups,
  type ListedIssue,
  type StatusGroup,
  type TierInputs,
} from "./tiers.js";

/**
 * What the Issues panel draws, given a listing. No RPC or realtime here, so
 * the stories can render every state from fixtures; app.tsx loads the listing
 * and owns the actions.
 */
export type Row = ListedIssue;

export type Listing = {
  rows: Row[];
  boardStages: string[];
  staleAfterDays: number;
  reviewStatus: string;
  countedStatuses: string[];
  sweptAt: number | null;
  skippedRepos: string[];
  truncated: boolean;
  lastError: string | null;
  /** The past hour of sweeps and what each cost on GitHub. */
  usage?: SyncUsage;
};

const DAY = 24 * 60 * 60_000;

/** What the picker offers when an issue has no status to show. */
const ADD_TO_BOARD = "Add to board";
const NO_STATUS = "No status";

/**
 * A status's colour, by what the status means rather than by its exact name,
 * so a board that calls its first column "Ready" and one that calls it "Ready
 * for Dev" read the same. Anything unrecognised stays muted: a wrong colour is
 * worse than no colour. Used for the picker's dot and the track's stages.
 */
function statusDot(status: string | null): string {
  const name = (status ?? "").toLowerCase();
  if (name.includes("progress")) return "bg-sky-500";
  if (name.includes("review")) return "bg-amber-500";
  if (name.includes("ready")) return "bg-emerald-500";
  return "bg-muted-foreground/40";
}

/** A stage's colour on the track: the status colour, with a visible grey for the rest. */
function stageColor(status: string): string {
  const color = statusDot(status);
  return color === "bg-muted-foreground/40" ? "bg-slate-400" : color;
}

/**
 * A picker in place of the track, for an issue the track cannot place: off
 * the board, with no status, or in a status the stages do not name. The last
 * shows its status as the picker's value, so it can be moved back onto the
 * track.
 *
 * An issue that is not on the board gets "Add to board" as its placeholder,
 * because adding and setting a status are one gesture — adding alone would
 * drop the issue into the board's "No Status" column, which is the state this
 * panel exists to get issues out of. One already in that column gets the same
 * picker reading "No status", since offering to add it would do nothing.
 */
function StatusCell({
  row,
  options,
  busy,
  onPick,
}: {
  row: Row;
  options: string[];
  busy: boolean;
  onPick: (status: string) => void;
}) {
  const placeholder = row.onBoard ? NO_STATUS : ADD_TO_BOARD;

  // No options means the board could not be read. The status is still worth
  // showing; only the ability to change it is lost.
  if (options.length === 0) {
    return (
      <span className="inline-flex max-w-full items-center gap-1.5 text-xs text-muted-foreground">
        <span
          aria-hidden
          className={`h-2 w-2 shrink-0 rounded-full ${statusDot(row.boardStatus)}`}
        />
        <span className="truncate">{row.boardStatus ?? placeholder}</span>
      </span>
    );
  }

  // A status the board no longer offers would otherwise select nothing and
  // render the row as blank, which reads as "not on the board".
  const offered =
    row.boardStatus && !options.includes(row.boardStatus)
      ? [row.boardStatus, ...options]
      : options;

  // Shrink-wrapped, not stretched to the track's width: a full-width select
  // pins the caret a long way from the text it belongs to.
  //
  // The border and hover fill are the shared Button's `outline` variant,
  // copied rather than composed because the control is a native <select> — it
  // cannot be a Button and still open the platform's own menu. The border is
  // what tells it apart from a status name, which is text you cannot change.
  return (
    <span
      className={`relative inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-input bg-transparent pl-2 pr-2 transition-colors ${
        busy ? "opacity-50" : "hover:bg-state-hover"
      }`}
    >
      <span
        aria-hidden
        className={`h-2 w-2 shrink-0 rounded-full ${statusDot(row.boardStatus)}`}
      />
      <select
        aria-label={`Board status for #${row.number}`}
        title={row.boardStatus ?? placeholder}
        value={row.boardStatus ?? ""}
        disabled={busy}
        onChange={(event) => onPick(event.target.value)}
        className="max-w-full cursor-pointer appearance-none truncate bg-transparent pr-3.5 text-xs text-muted-foreground outline-none hover:text-foreground disabled:cursor-default"
      >
        <option value="" disabled>
          {busy ? "Saving…" : placeholder}
        </option>
        {offered.map((status) => (
          <option key={status} value={status}>
            {status}
          </option>
        ))}
      </select>
      <span
        aria-hidden
        className="pointer-events-none absolute right-2 text-[0.6rem] text-muted-foreground"
      >
        ▾
      </span>
    </span>
  );
}


/**
 * Every board stage as a button, the current one filled with its dot, so
 * moving an issue is one click on the stage it goes to. A status the stages do
 * not name, "No status", or "Not on board" shows in the last segment, whose
 * native menu offers every status the board has. `stretch` spreads the
 * buttons across their line, for the narrow column where they sit under the
 * title rather than beside it.
 */
function StageButtons({
  row,
  stages,
  options,
  busy,
  stretch,
  onPick,
}: {
  row: Row;
  stages: string[];
  options: string[];
  busy: boolean;
  stretch: boolean;
  onPick: (status: string) => void;
}) {
  // No options means the board could not be read, so nothing can be moved.
  if (options.length === 0) {
    return <StatusCell row={row} options={options} busy={busy} onPick={onPick} />;
  }
  // Only the stages this row's board has: with several boards, one board's
  // columns are not another's, and a stage the board lacks would refuse the move.
  stages = stagesOnBoard(stages, options);
  const stage = stageOf(row, stages);
  const offStage = stage !== null ? null : row.onBoard ? (row.boardStatus ?? NO_STATUS) : "Not on board";
  const placeholder = row.onBoard ? NO_STATUS : ADD_TO_BOARD;
  const offered =
    row.boardStatus && !options.includes(row.boardStatus) ? [row.boardStatus, ...options] : options;
  const segment = "flex items-center justify-center gap-1 whitespace-nowrap border-r border-input px-2 py-1";

  return (
    <div
      role="group"
      aria-label={`Stages for #${row.number}`}
      className={`overflow-hidden rounded-md border border-input text-[11px] ${stretch ? "grid w-full max-w-md" : "inline-flex"} ${busy ? "opacity-50" : ""}`}
      style={stretch ? { gridTemplateColumns: `repeat(${stages.length}, 1fr) auto` } : undefined}
    >
      {stages.map((name, index) => {
        const on = index === stage;
        return (
          <button
            key={name}
            type="button"
            aria-pressed={on}
            disabled={busy}
            onClick={() => {
              if (!on) onPick(name);
            }}
            className={`${segment} ${on ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-state-hover hover:text-foreground"}`}
          >
            {on ? <span aria-hidden className={`size-1.5 rounded-full ${statusDot(name)}`} /> : null}
            {name}
          </button>
        );
      })}
      <span
        className={`relative flex items-center justify-center gap-1 px-2 py-1 ${offStage ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-state-hover hover:text-foreground"}`}
      >
        <span aria-hidden className="whitespace-nowrap">
          {offStage ? `${busy ? "Saving…" : offStage} ▾` : "…"}
        </span>
        {/* A native select over the segment, so the platform's own menu opens. */}
        <select
          aria-label={`Board status for #${row.number}`}
          title={row.boardStatus ?? placeholder}
          value={offStage && row.boardStatus ? row.boardStatus : ""}
          disabled={busy}
          onChange={(event) => onPick(event.target.value)}
          className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-default"
        >
          <option value="" disabled>
            {placeholder}
          </option>
          {offered.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </span>
    </div>
  );
}


export type RunningReference =
  | {
      externalId: string;
      groupId: string | null;
      entryId: number;
      startedAt: string | null;
      projectName: string;
      taskName: string;
    }
  | null;

/** Whether the clock shows, and which row's timer is running, read apart from the listing. */
export interface HarvestState {
  available: boolean;
  running: RunningReference;
}

export interface HarvestPanelState {
  available: boolean;
  running: RunningReference;
  client: HarvestTimerClient;
  onStarted: () => void;
}

/**
 * Whether the running timer belongs to this row.
 *
 * The group is part of the comparison because Harvest can only filter
 * references by id: without it, every repository's #42 would light up
 * together.
 */
function isRunningFor(running: RunningReference, row: Row): boolean {
  if (running === null) return false;
  if (running.externalId !== String(row.number)) return false;

  const { groupId } = timerDefaultsForItem(row).externalReference;
  return running.groupId === null || running.groupId === groupId;
}

/**
 * Start or open the thread for one issue, as a labelled action in the row's
 * action line.
 */
function ThreadAction({
  row,
  isStarting,
  isThreadStarting,
  isOpen,
  onStart,
  onOpen,
}: {
  row: Row;
  isStarting: boolean;
  /** Its thread is being started: Open thread, greyed until it exists. */
  isThreadStarting: boolean;
  /** The Start thread box is open under this row; the button stays pressed and closes it. */
  isOpen: boolean;
  onStart: (row: Row) => void;
  onOpen: (row: Row) => void;
}) {
  if (row.threadId) return <OpenThreadAction onOpen={() => onOpen(row)} />;
  if (isThreadStarting) return <OpenThreadAction disabled />;
  // Disabled with its reason as the label, rather than hidden: a row that
  // silently lacks the action reads as a bug.
  const label = !row.canSpawn ? "No project here" : isStarting ? "Starting…" : "Start thread";
  return (
    <button
      type="button"
      className={cn(LINE_ACTION, isOpen && "bg-accent text-foreground")}
      aria-expanded={isOpen}
      disabled={!row.canSpawn || isStarting}
      title={row.canSpawn ? undefined : `No bb project is checked out for ${row.repo}`}
      onClick={() => onStart(row)}
    >
      <Icon
        name={isStarting ? "Spinner" : "MessageSquarePlus"}
        className={`size-3${isStarting ? " animate-spin" : ""}`}
      />
      {label}
    </button>
  );
}

function keyOf(row: Row): string {
  return `${row.repo}#${row.number}`;
}

/** The flags on a row's number line: stale in red, blocked in slate. */
function flagsFor(row: Row, inputs: TierInputs): Flag[] {
  const flags: Flag[] = [];
  if (isStale(row, inputs)) {
    const days = Math.floor((inputs.now - lastActivity(row)) / DAY);
    flags.push({ kind: "stale", text: `No activity for ${days} ${days === 1 ? "day" : "days"}` });
  }
  if (row.blockedBy > 0) {
    flags.push({
      kind: "blocked",
      text: `Blocked by ${row.blockedBy} ${row.blockedBy === 1 ? "issue" : "issues"}`,
    });
  }
  return flags;
}

/**
 * Nothing assigned, drawn as a list worked through rather than a board with
 * empty columns.
 *
 * Empty columns were the obvious picture and the wrong one: outlined rounded
 * rectangles with nothing in them are the loading-skeleton idiom, so the panel
 * would look like it was still fetching. A struck-through line with a tick
 * beside it cannot be mistaken for a placeholder — it can only mean done.
 *
 * The tick takes the same emerald the board glyph gives a card in its first
 * stage, so the two graphics stay in one family.
 */
function NoIssuesGraphic() {
  // Ragged lengths, longest first: a real list, not three copies of a bar.
  const LINES = [
    { y: 12, width: 92 },
    { y: 30, width: 74 },
    { y: 48, width: 84 },
  ];

  return (
    <svg
      role="img"
      aria-label="A checklist with every line ticked off and struck through"
      viewBox="0 0 132 60"
      className="h-[3.75rem] w-[8.25rem] text-muted-foreground"
      fill="none"
    >
      {LINES.map(({ y, width }) => (
        <g key={y}>
          {/* The tick, drawn as two strokes rather than a filled glyph so it
              keeps its weight at this size. */}
          <path
            d={`M4 ${y} L9 ${y + 5} L18 ${y - 5}`}
            className="stroke-emerald-500"
            strokeOpacity={0.75}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d={`M28 ${y} H${28 + width}`}
            stroke="currentColor"
            strokeOpacity={0.28}
            strokeWidth={2.5}
            strokeLinecap="round"
          />
          {/* The strike, at the same weight and a lower opacity: the line is
              still legible under it, the way a crossed-off item is. */}
          <path
            d={`M24 ${y} H${32 + width}`}
            stroke="currentColor"
            strokeOpacity={0.4}
            strokeWidth={1.5}
            strokeLinecap="round"
          />
        </g>
      ))}
    </svg>
  );
}

/**
 * What this panel is waiting for, drawn as the board it is about to read.
 *
 * Three columns filling one at a time, which is what a sweep of the board
 * actually is: the plugin reads it stage by stage, it does not shuffle cards
 * around. The colours are not decoration — each card is the colour
 * `statusDot` gives that stage, ready then in progress then in review, so the
 * glyph is already teaching the legend the table below uses.
 *
 * Only the stage being read stays lit; the ones behind it dim rather than
 * disappear. Three chips at full strength at once would be a rainbow, and
 * would lose the sense of the sweep moving.
 *
 * One 2.4s cycle shared by every card, expressed as fractions of it, so the
 * loop restarts as a whole and nothing snaps back on its own.
 */
function SweepingBoard() {
  const still = usePrefersReducedMotion();

  // Where each card lands, and when it is the one being read. Held at 0.45
  // afterwards: read, not forgotten.
  const STAGES = [
    { fill: "fill-emerald-500", at: "0;0.1;0.15;0.3;0.35;0.86;0.96;1" },
    { fill: "fill-sky-500", at: "0;0.3;0.35;0.5;0.55;0.86;0.96;1" },
    { fill: "fill-amber-500", at: "0;0.5;0.55;0.7;0.8;0.86;0.96;1" },
  ];

  return (
    <LoadingGraphic caption="Sweeping your board">
      <svg
        role="img"
        aria-label="A board filling one column at a time"
        viewBox="0 0 168 60"
        className="h-[3.75rem] w-[10.5rem] text-muted-foreground"
        fill="none"
      >
        {STAGES.map((stage, index) => {
          const x = 4 + index * 56;
          const last = index === STAGES.length - 1;
          return (
            <g key={stage.fill}>
              <rect
                x={x}
                y={4}
                width={48}
                height={52}
                rx={7}
                stroke="currentColor"
                strokeOpacity={0.22}
              />
              <rect
                x={x + 8}
                y={16}
                width={32}
                height={14}
                rx={3}
                className={stage.fill}
                opacity={still ? (last ? 1 : 0.45) : 0}
              >
                {still ? null : (
                  <animate
                    attributeName="opacity"
                    dur="2.4s"
                    repeatCount="indefinite"
                    // The last card has no successor to dim for, so it holds
                    // full strength until the whole glyph fades.
                    values={
                      last
                        ? "0;0;1;1;1;1;0;0"
                        : "0;0;1;1;0.45;0.45;0;0"
                    }
                    keyTimes={stage.at}
                  />
                )}
              </rect>
            </g>
          );
        })}
      </svg>
    </LoadingGraphic>
  );
}

export interface IssueListViewProps {
  /** Null until the first listing arrives. */
  listing: Listing | null;
  /**
   * One clock for the whole render, so two rows updated a second apart never
   * disagree about what "now" is.
   */
  now: number;
  /** Rows whose status change is in flight, keyed `repo#number`. */
  busyKeys: ReadonlySet<string>;
  /** Rows whose thread is being started, keyed `repo#number`. */
  starting: ReadonlySet<string>;
  /**
   * The Start thread box for a row, drawn under its action line while its
   * button has it open. Null for every other row.
   */
  renderStartThread?: (row: Row) => ReactNode;
  /** The row's thread is being started from its box, keyed `repo#number`. */
  isThreadStarting?: (key: string) => boolean;
  harvest: HarvestPanelState;
  onPick: (row: Row, status: string) => void;
  onStart: (row: Row) => void;
  onOpen: (row: Row) => void;
  /** Saves the row's note and its On hold box; "" with the box clear deletes it. Resolves true once saved. */
  onNoteSave: (row: Row, body: string, onHold: boolean) => Promise<boolean>;
  /** The title was clicked, and the issue is about to open. */
  onOpenLink: (row: Row) => void;
  /**
   * Reads the issue's latest comments, when its comment count is clicked.
   * Once it has read them, the row's "N new" is marked seen.
   */
  loadComments: (row: Row) => Promise<FeedbackResult>;
  /**
   * What a row's thread is doing, from bb's sidebar. Left out, a row with a
   * thread still draws its thread line, without the status.
   */
  threadStatus?: (threadId: string | null) => ThreadStatus | null;
}

export function IssueListView({
  listing,
  now,
  busyKeys,
  starting,
  renderStartThread,
  isThreadStarting = () => false,
  harvest,
  onPick,
  onStart,
  onOpen,
  onNoteSave,
  onOpenLink,
  loadComments,
  threadStatus,
}: IssueListViewProps): ReactNode {
  if (!listing) return <SweepingBoard />;

  const inputs: TierInputs = {
    countedStatuses: listing.countedStatuses,
    reviewStatus: listing.reviewStatus,
    boardStages: listing.boardStages,
    staleAfterDays: listing.staleAfterDays,
    now,
  };
  const stages: Stage[] = listing.boardStages.map((name) => ({ name, color: stageColor(name) }));

  // The repository only earns a place on the number line when it varies.
  const showRepo = new Set(listing.rows.map((row) => row.repo)).size > 1;

  const sorted = sortIssues(listing.rows, inputs);
  const rowsByKey = new Map(sorted.map((row) => [keyOf(row), row]));
  const items: SweepItem[] = sorted.map((row) => {
    const stage = stageOf(row, listing.boardStages);
    return {
      key: keyOf(row),
      runId: runOf(row, inputs),
      title: row.title,
      url: row.url,
      number: row.number,
      newComments: row.newComments,
      flags: flagsFor(row, inputs),
      // The age first: a Later row's single line shows only the first fact.
      // The comment count and the sub-issue progress are drawn in the action
      // line instead, the count beside the progress bar.
      facts: [relativeTime(row.updatedAt, now), showRepo ? row.repo : null].filter(
        (fact): fact is string => fact !== null,
      ),
      comments: row.commentsCount,
      parent: row.parent,
      note: row.note,
      onHold: row.onHold === true,
      stage,
      progress:
        row.subtasks && row.subtasks.total > 0
          ? { done: row.subtasks.completed, total: row.subtasks.total }
          : null,
      // A running timer must stay in view, and it lives in the action line.
      forceOpen: harvest.available && isRunningFor(harvest.running, row),
    };
  });

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto p-4 md:p-5">
        <div className="mx-auto w-full max-w-7xl space-y-5">
          {listing.lastError ? (
            <p className="rounded-lg border border-border p-3 text-sm text-destructive">
              {listing.lastError}
            </p>
          ) : null}

          {listing.truncated ? (
            <p className="text-xs text-muted-foreground">
              The sweep hit the 100 issue ceiling, so this list may be
              incomplete.
            </p>
          ) : null}

          {listing.rows.length === 0 ? (
            <EmptyGraphic
              graphic={<NoIssuesGraphic />}
              // The headline moves with the reason. "No issues assigned to
              // you" is untrue on a machine that simply cannot see them.
              headline={
                listing.skippedRepos.length
                  ? "Nothing from the repositories checked out here."
                  : "No issues assigned to you."
              }
            >
              {listing.skippedRepos.length ? (
                <>
                  Not swept: {listing.skippedRepos.join(", ")} — no project checked out here. Add
                  the project, or list the repository in this plugin's "Also sweep these
                  repositories" setting.
                </>
              ) : (
                "Anything assigned to you shows up here."
              )}
            </EmptyGraphic>
          ) : (
            <SplitList
              items={items}
              rowsByKey={rowsByKey}
              groups={statusGroups(
                listing.rows.filter((row) => !needsYou(row, inputs)),
                inputs,
              )}
              stages={stages}
              busyKeys={busyKeys}
              renderStatus={(row, stretch) => (
                <StageButtons
                  row={row}
                  stages={listing.boardStages}
                  options={row.statusOptions ?? []}
                  busy={busyKeys.has(keyOf(row))}
                  stretch={stretch}
                  onPick={(status) => onPick(row, status)}
                />
              )}
              onNoteSave={(item, body, onHold) => {
                const row = rowsByKey.get(item.key);
                return row ? onNoteSave(row, body, onHold) : Promise.resolve(false);
              }}
              onOpenLink={(item) => {
                const row = rowsByKey.get(item.key);
                if (row) onOpenLink(row);
              }}
              renderComments={(item) => {
                const row = rowsByKey.get(item.key);
                if (!row) return null;
                return (
                  <FeedbackDrawer
                    url={row.url}
                    age={(at) => relativeTime(at, now)}
                    newCount={row.newComments}
                    Link={UrlLink}
                    Markdown={Markdown}
                    load={async () => {
                      const result = await loadComments(row);
                      if (!result.error && row.newComments > 0) onOpenLink(row);
                      return result;
                    }}
                  />
                );
              }}
              renderStartThread={(item) => {
                const row = rowsByKey.get(item.key);
                return row ? renderStartThread?.(row) : null;
              }}
              renderThreadLine={(item) => {
                const row = rowsByKey.get(item.key);
                if (row && !row.threadId && isThreadStarting(item.key)) {
                  return <StartingThreadLine title={`${row.title} (#${row.number})`} />;
                }
                if (!row?.threadId) return null;
                return <ThreadLine status={threadStatus?.(row.threadId) ?? null} onOpen={() => onOpen(row)} />;
              }}
              // The timer sits at the bottom right of the row, apart from the actions.
              renderTrailing={(item) => {
                const row = rowsByKey.get(item.key);
                if (!row || !harvest.available) return null;
                return (
                  <HarvestRowClock
                    surface="issues"
                    row={row}
                    running={isRunningFor(harvest.running, row) ? harvest.running : null}
                    client={harvest.client}
                    onChanged={harvest.onStarted}
                  />
                );
              }}
              renderActions={(item) => {
                const row = rowsByKey.get(item.key);
                if (!row) return null;
                return (
                  <>
                    <ThreadAction
                      row={row}
                      isStarting={starting.has(item.key)}
                      isThreadStarting={isThreadStarting(item.key)}
                      isOpen={Boolean(renderStartThread?.(row))}
                      onStart={onStart}
                      onOpen={onOpen}
                    />
                    <CopyLinkAction
                      text={`${row.title} (#${row.number})`}
                      url={row.url}
                      write={writeLinkToClipboard}
                    />
                  </>
                );
              }}
            />
          )}
        </div>
      </div>
      {listing.rows.length > 0 ? (
        <SkippedReposFooter
          repos={listing.skippedRepos}
          hint={'Add the project, or list the repository in the "Also sweep these repositories" setting.'}
        />
      ) : null}
    </div>
  );
}

const TONES = new Map<string, RunTone>(ISSUE_RUNS.map((run) => [run.id, run.tone]));

interface SplitListProps {
  /** Every row, already sorted. */
  items: SweepItem[];
  rowsByKey: Map<string, Row>;
  /** The rows that do not need you, grouped by status. */
  groups: ReturnType<typeof statusGroups>;
  stages: Stage[];
  busyKeys: ReadonlySet<string>;
  /** `stretch` is true in the narrow column, where the control has a line of its own. */
  renderStatus: (row: Row, stretch: boolean) => ReactNode;
  renderActions: (item: SweepItem) => ReactNode;
  renderTrailing: (item: SweepItem) => ReactNode;
  /** Drawn directly under a row's action line, for a row with a thread. */
  renderThreadLine: (item: SweepItem) => ReactNode;
  renderStartThread: (item: SweepItem) => ReactNode;
  /** The drawer the comment count opens, drawn only while it is open. */
  renderComments: (item: SweepItem) => ReactNode;
  onNoteSave: (item: SweepItem, body: string, onHold: boolean) => Promise<boolean>;
  onOpenLink: (item: SweepItem) => void;
}

/**
 * A status group's squares: the colour its status dot has, slate for blocked,
 * and the quiet Later grey for the rest.
 */
function groupSquares(group: StatusGroup): string | undefined {
  if (group.blocked) return "bg-slate-400";
  const dot = statusDot(group.status);
  return dot === "bg-muted-foreground/40" ? undefined : dot;
}

/**
 * Two columns, each under its own summary squares. On the left, only what
 * needs you, every row open with its actions, why it is there, and a status
 * picker, with a square per issue grouped by run. On the right, everything
 * else grouped by status, one line each, opening to the same actions, with a
 * square per issue grouped by status. Pressing a group in either shows only
 * its rows in that column; pressing it again shows them all.
 */
function SplitList({
  items,
  rowsByKey,
  groups,
  stages,
  busyKeys,
  renderStatus,
  renderActions,
  renderTrailing,
  renderThreadLine,
  renderStartThread,
  renderComments,
  onNoteSave,
  onOpenLink,
}: SplitListProps) {
  // Rows opened by hand in the right column. Open state lives only as long as the panel.
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [commentsOpen, setCommentsOpen] = useState<ReadonlySet<string>>(new Set());
  const [mineFilter, setMineFilter] = useState<string | null>(null);
  const [restFilter, setRestFilter] = useState<string | null>(null);

  const itemsByKey = new Map(items.map((item) => [item.key, item]));
  const mine = items.filter((item) => NEEDS_YOU_RUNS.has(item.runId));
  const restCount = groups.reduce((total, group) => total + group.rows.length, 0);

  // A sync can empty the chosen group, and then the filter would hide every
  // row, so a filter with nothing left in it is read as no filter.
  const mineActive = mine.some((item) => item.runId === mineFilter) ? mineFilter : null;
  const mineShown = mineActive === null ? mine : mine.filter((item) => item.runId === mineActive);

  const groupRuns: Run[] = groups.map((group) => ({
    id: group.name.toLowerCase(),
    label: group.name.toLowerCase(),
    labelOne: group.name.toLowerCase(),
    tone: "later",
    tier: "later",
    color: groupSquares(group),
  }));
  const groupItems = groups.flatMap((group) =>
    group.rows.flatMap((row) => {
      const item = itemsByKey.get(keyOf(row));
      return item ? [{ ...item, runId: group.name.toLowerCase() }] : [];
    }),
  );
  const restActive = groupRuns.some((run) => run.id === restFilter) ? restFilter : null;
  const groupsShown =
    restActive === null ? groups : groups.filter((group) => group.name.toLowerCase() === restActive);

  const rowFor = (item: SweepItem, side: "mine" | "rest") => {
    const row = rowsByKey.get(item.key)!;
    // Everything else, and an issue on hold, closes to one line, the held one
    // showing its note there.
    const closable = side === "rest" || item.runId === "on-hold";
    const open = !closable || item.forceOpen === true || opened[item.key] === true;
    return (
      <SweepRow
        key={item.key}
        item={item}
        tier={closable ? "later" : "now"}
        open={open}
        chevron={closable}
        onToggle={
          closable && !item.forceOpen
            ? () => setOpened((current) => ({ ...current, [item.key]: !open }))
            : undefined
        }
        tone={TONES.get(item.runId)}
        stages={stages}
        onOpenLink={() => onOpenLink(item)}
        Link={UrlLink}
        actions={renderActions(item)}
        trailing={renderTrailing(item)}
        threadLine={renderThreadLine(item)}
        startThread={renderStartThread(item)}
        onToggleComments={() =>
          setCommentsOpen((current) => {
            const next = new Set(current);
            if (!next.delete(item.key)) next.add(item.key);
            return next;
          })
        }
        commentsOpen={commentsOpen.has(item.key)}
        commentsDrawer={commentsOpen.has(item.key) ? renderComments(item) : undefined}
        editing={editing === item.key}
        onEditNote={() => setEditing(item.key)}
        holdable
        onNoteSave={async (body, onHold) => {
          const saved = await onNoteSave(item, body, onHold);
          if (saved) setEditing((current) => (current === item.key ? null : current));
          return saved;
        }}
        onNoteCancel={() => setEditing(null)}
        busy={busyKeys.has(item.key)}
        // Beside the title in the wide column, so the action line and its
        // Harvest clock run the full width underneath; on a line of its own in
        // the narrow one.
        trackPlacement={side === "mine" ? "header" : "below"}
        renderTrack={(_, line) =>
          line ? null : side === "mine" ? (
            // No label over it: the squares above the column name each run,
            // and the row's dot, edge, or flag says the rest.
            <div className="flex shrink-0 self-start">{renderStatus(row, false)}</div>
          ) : (
            renderStatus(row, true)
          )
        }
      />
    );
  };

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      <section aria-label="Needs you" className="min-w-0 lg:basis-3/5">
        {mine.length ? (
          <div className="space-y-3">
            <SummarySquares
              label="Needs you by run"
              runs={ISSUE_RUNS}
              items={mine}
              value={mineActive}
              onChange={setMineFilter}
            />
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card px-4">
              {mineShown.map((item) => rowFor(item, "mine"))}
            </ul>
          </div>
        ) : (
          <p className="rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground">
            Nothing needs you right now.
          </p>
        )}
      </section>
      {restCount ? (
        <section aria-label="Everything else" className="min-w-0 lg:basis-2/5">
          <SummarySquares
            label="Everything else by status"
            runs={groupRuns}
            items={groupItems}
            value={restActive}
            onChange={setRestFilter}
          />
          <div className="mt-3 space-y-3">
            {groupsShown.map((group) => (
              <div key={group.name}>
                <h3 className="mb-0.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  {group.blocked ? (
                    <Icon name="CircleX" className="size-3" />
                  ) : (
                    <span aria-hidden className={`size-2 rounded-full ${statusDot(group.status)}`} />
                  )}
                  {group.name}
                  <span>{group.rows.length}</span>
                </h3>
                <ul className="divide-y divide-border rounded-lg border border-border bg-card px-4">
                  {group.rows.map((row) => {
                    const item = itemsByKey.get(keyOf(row));
                    return item ? rowFor(item, "rest") : null;
                  })}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
