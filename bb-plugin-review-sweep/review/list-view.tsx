import type { SyncUsage } from "@danielbachhuber/bb-plugin-component-library/sync-status";
import { useState, type ReactNode } from "react";
import {
  DayMenu,
  addDaysTo,
  describeDay,
  localDay,
  nextMonday,
  type DayChoice,
} from "@danielbachhuber/bb-plugin-component-library/day-menu";
import { Markdown, UrlLink } from "@get-bb/plugin-sdk/app";
import { ThreadLine, OpenThreadAction, StartingThreadLine, type ThreadStatus } from "@danielbachhuber/bb-plugin-component-library/thread-status";
import { CopyLinkAction, LINE_ACTION } from "sweep-ui/actions";
import { StatusBanner } from "sweep-ui/banner";
import { FeedbackDrawer, type FeedbackResult } from "sweep-ui/feedback";
import { SweepList } from "sweep-ui/list";
import { SkippedReposFooter } from "sweep-ui/skipped-repos";
import {
  Avatar,
  ChecksBadge,
  DiffCount,
  PullRequestIcon,
  ReviewerStack,
  githubAvatar,
  type ReviewerTooltipProps,
} from "sweep-ui/pull-request";
import type { Stage, SweepItem } from "sweep-ui/types";
import { writeLinkToClipboard } from "@/components/ui/copy-link";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { HarvestRowClock } from "bb-plugin-harvest/clock";
import type { HarvestTimerClient } from "bb-plugin-harvest/picker";
import { timerDefaultsForItem } from "bb-plugin-harvest/github";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  LoadingGraphic,
  usePrefersReducedMotion,
} from "@/components/ui/loading-graphic";
import { EmptyGraphic } from "@/components/ui/empty-graphic";
import { START_REVIEW_LABEL } from "./actions.js";
import { relativeTime } from "./format.js";
import { bannerFor, reviewersFor } from "./row-status.js";
import {
  REVIEW_RUNS,
  REVIEW_STAGES,
  flagsFor,
  runOf,
  sortReviews,
  stageOf,
  type ListedReview,
  type TierInputs,
} from "./tiers.js";

/**
 * What the Reviews panel draws, given a listing. No RPC or realtime here, so
 * the stories can render every state from fixtures; app.tsx loads the listing
 * and owns the actions.
 */
export type Row = ListedReview;

export type Listing = {
  rows: Row[];
  sweptAt: number | null;
  skippedRepos: string[];
  truncated: boolean;
  lastError: string | null;
  staleAfterDays: number;
  /** The past hour of sweeps and what each cost on GitHub. */
  usage?: SyncUsage;
};

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

/** Each stage's colour on the track: grey while requested, amber while a thread runs, sky for a re-review. */
const STAGES: Stage[] = REVIEW_STAGES.map((name, index) => ({
  name,
  color: ["bg-slate-400", "bg-amber-500", "bg-sky-500"][index]!,
}));

function keyOf(row: Row): string {
  return `${row.repo}#${row.number}`;
}

/**
 * Start or open the review thread.
 *
 * Three states, because a click that looks like nothing happened is what
 * makes someone click again: the action, "Starting…" while the draft is
 * fetched, then "Open thread" once one exists.
 */
function ThreadAction({
  row,
  isStarting,
  isThreadStarting,
  isOpen,
  onReview,
  onOpen,
}: {
  row: Row;
  isStarting: boolean;
  /** Its thread is being started: Open thread, greyed until it exists. */
  isThreadStarting: boolean;
  /** The Start thread box is open under this row; the button stays pressed and closes it. */
  isOpen: boolean;
  onReview: (row: Row) => void;
  onOpen: (row: Row, threadId: string) => void;
}) {
  if (row.threadId) {
    const threadId = row.threadId;
    return <OpenThreadAction onOpen={() => onOpen(row, threadId)} />;
  }
  if (isThreadStarting) return <OpenThreadAction disabled />;

  // Disabled with its reason as the label, rather than hidden: a row that
  // silently lacks the action reads as a bug.
  const label = !row.canSpawn ? "No project here" : isStarting ? "Starting…" : START_REVIEW_LABEL;
  return (
    <button
      type="button"
      className={cn(LINE_ACTION, isOpen && "bg-accent text-foreground")}
      aria-expanded={isOpen}
      disabled={!row.canSpawn || isStarting}
      title={row.canSpawn ? undefined : `No bb project is checked out for ${row.repo}`}
      onClick={() => onReview(row)}
    >
      <Icon
        name={isStarting ? "Spinner" : "MessageSquarePlus"}
        className={`size-3${isStarting ? " animate-spin" : ""}`}
      />
      {label}
    </button>
  );
}

/**
 * Whether Batch can start a review for the row: it has no thread yet, and a
 * project here is checked out for its repository.
 */
export function canBatch(row: Row): boolean {
  return row.threadId === null && row.canSpawn && !row.snoozedUntil;
}

/**
 * Opens the dialog that starts several reviews at once. Disabled, with its
 * reason as the tooltip, when no row could be started.
 */
function BatchButton({ count, onBatch }: { count: number; onBatch: () => void }) {
  // The reason sits on a wrapper, since a disabled button shows no tooltip of its own.
  return (
    <span title={count === 0 ? "Every request already has a thread, or no project here" : undefined}>
      <Button size="sm" variant="outline" disabled={count === 0} onClick={onBatch}>
        <Icon name="Layers" className="size-3.5" />
        Batch
      </Button>
    </span>
  );
}

/** The quick days Snooze offers: tomorrow, next Monday, and two weeks out. */
export function snoozeChoices(now: Date): DayChoice[] {
  const today = localDay(now);
  return [
    { label: "Tomorrow", day: addDaysTo(today, 1) },
    { label: "Next week", day: nextMonday(now) },
    { label: "In two weeks", day: addDaysTo(today, 14) },
  ];
}

/**
 * Snooze, which opens the day menu Now's Postpone uses and sinks the request
 * to one line at the bottom until that day, or Unsnooze on a row already
 * snoozed.
 */
function SnoozeAction({
  row,
  now,
  onSnooze,
}: {
  row: Row;
  now: number;
  onSnooze: (row: Row, until: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  if (row.snoozedUntil) {
    return (
      <button type="button" className={LINE_ACTION} onClick={() => onSnooze(row, null)}>
        <Icon name="Clock" className="size-3" />
        Unsnooze
      </button>
    );
  }
  const today = new Date(now);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={cn(LINE_ACTION, open && "bg-accent text-foreground")}>
          <Icon name="Clock" className="size-3" />
          Snooze
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1" mobileTitle="Snooze">
        <DayMenu
          heading="Snooze until"
          choices={snoozeChoices(today)}
          describe={(day) => describeDay(day, today)}
          check={(day) => (day > localDay(today) ? null : "Too early")}
          onPick={(day) => {
            setOpen(false);
            onSnooze(row, day);
          }}
          now={today}
          menuLabel="Snooze until"
          inputLabel="Snooze until a day"
          footer="Comes back sooner if your review is requested again."
        />
      </PopoverContent>
    </Popover>
  );
}

/** Archive thread, on a row with a thread. Other rows have no second action. */
function ArchiveAction({ row, onArchive }: { row: Row; onArchive: (row: Row) => void }) {
  if (!row.threadId) return null;
  return (
    <button type="button" className={LINE_ACTION} onClick={() => onArchive(row)}>
      <Icon name="Archive" className="size-3" />
      Archive thread
    </button>
  );
}

/** One reviewer's name and review, in this plugin's tooltip. */
function ReviewerTooltip({ label, children }: ReviewerTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

interface BodyProps {
  row: Row;
  now: number;
  showRepo: boolean;
  avatarFor: (owner: string) => string;
}

/**
 * The row's facts as icons with numbers, as PR Sweep draws them: the author,
 * whose pull request it is, then the reviewers with you first, the checks,
 * and the size. Then the repository when the list spans several. The
 * reviewers are left out when there are none, and the checks when the pull
 * request has none.
 */
function FactIcons({ row, now, showRepo, avatarFor }: BodyProps) {
  const reviewers = reviewersFor(row, avatarFor);
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span data-part="author" className="inline-flex items-center gap-1.5">
        <Avatar login={row.author} avatarUrl={avatarFor(row.author)} />
        {row.author}
      </span>
      {reviewers.length > 0 ? (
        <span data-part="reviewers" className="inline-flex items-center">
          <TooltipProvider delayDuration={150}>
            <ReviewerStack reviewers={reviewers} Tooltip={ReviewerTooltip} />
          </TooltipProvider>
        </span>
      ) : null}
      <ChecksBadge checks={row.checks} />
      <DiffCount additions={row.size.additions} deletions={row.size.deletions} />
      {showRepo ? <span data-part="repo">{row.repo}</span> : null}
    </span>
  );
}

/**
 * Under the title: a red banner for a request waited on too long, or a blue
 * one for a re-review, then the fact icons. On a one-line Later row, only the
 * icons, inline.
 */
function RowBody({ line, inputs, ...props }: BodyProps & { line: boolean; inputs: TierInputs }) {
  const icons = <FactIcons {...props} />;
  if (line) {
    const until = props.row.snoozedUntil;
    return until ? (
      <span className="inline-flex items-center gap-3">
        {icons}
        <span data-part="snoozed" className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Icon name="Clock" className="size-3" />
          Until {describeDay(until, new Date(props.now))}
        </span>
      </span>
    ) : (
      icons
    );
  }
  const banner = bannerFor(props.row, inputs);
  return (
    <>
      {banner ? <StatusBanner tone={banner.tone}>{banner.text}</StatusBanner> : null}
      <div className="mt-1.5">{icons}</div>
    </>
  );
}

/**
 * The odometer the rolling digits spin on.
 *
 * Ten digits stacked in a one-character window, stepped past it once per
 * cycle. `steps(10)` rather than a smooth translate, so each digit sits
 * still for its moment instead of smearing — a counter, not a blur.
 *
 * Class names are prefixed because a plain `<style>` is not scoped the way
 * the plugin's compiled stylesheet is.
 */
const ODOMETER_CSS = `
.review-sweep-roll {
  display: inline-block;
  width: 1ch;
  height: 1em;
  overflow: hidden;
  vertical-align: -0.12em;
}
.review-sweep-roll-strip {
  display: block;
  animation-name: review-sweep-roll;
  animation-timing-function: steps(10);
  animation-iteration-count: infinite;
}
.review-sweep-roll-digit {
  display: block;
  height: 1em;
  line-height: 1em;
}
@keyframes review-sweep-roll {
  from { transform: translateY(0); }
  to { transform: translateY(-10em); }
}
`;

/** One rolling digit. Each gets its own period, so the six never lock in step. */
function RollingDigit({ period }: { period: number }) {
  return (
    <span className="review-sweep-roll">
      <span
        className="review-sweep-roll-strip"
        style={{ animationDuration: `${period}ms` }}
      >
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((digit) => (
          <span key={digit} className="review-sweep-roll-digit">
            {digit}
          </span>
        ))}
      </span>
    </span>
  );
}

/**
 * What this panel is waiting for, in the same notation as what it says when
 * there is nothing to wait for.
 *
 * `NothingToReview` below settles this exact glyph at `-0,0 +0,0`. Here the
 * counts are still turning, so the two states are one picture in two moments:
 * a diff being measured, and a diff that measured to nothing. Same face, same
 * size, same colours — git's own red and green — so arriving at the empty
 * state reads as the counter stopping rather than as a different screen.
 *
 * Reduced motion settles it on real-looking counts rather than on zero, which
 * would be indistinguishable from having nothing to review.
 */
function SweepingReviews() {
  const still = usePrefersReducedMotion();

  const removed = still ? "18,4" : null;
  const added = still ? "26,9" : null;

  return (
    <LoadingGraphic caption="Sweeping the reviews waiting on you">
      {still ? null : <style>{ODOMETER_CSS}</style>}
      <p
        aria-hidden="true"
        className="font-mono text-2xl tracking-tight text-muted-foreground/60 sm:text-3xl"
      >
        <span>@@ </span>
        <span className="text-rose-500">
          -
          {removed ?? (
            <>
              <RollingDigit period={620} />
              <RollingDigit period={760} />,
              <RollingDigit period={540} />
            </>
          )}
        </span>{" "}
        <span className="text-emerald-500">
          +
          {added ?? (
            <>
              <RollingDigit period={700} />
              <RollingDigit period={580} />,
              <RollingDigit period={820} />
            </>
          )}
        </span>
        <span> @@</span>
      </p>
    </LoadingGraphic>
  );
}

/**
 * The empty state, drawn in the vernacular of the thing it is about.
 *
 * A tray, an inbox or a checkmark would say "nothing here" for any panel in
 * any product. A diff hunk header with zero ranges says it in the only
 * notation that means anything to someone who reviews code, and `-0,0` and
 * `+0,0` carry the colours git itself gives them.
 *
 * Type rather than an illustration on purpose: grey rounded bars are the
 * universal loading-skeleton idiom, so an SVG of an empty diff would read as
 * "still fetching" — the opposite of what this panel has to say.
 *
 * @param skippedRepos Repositories the project filter held back. They move the
 *   headline as well as the line under it: "Nothing to review" is untrue on a
 *   machine that simply cannot see the requests waiting on you.
 */
function NothingToReview({ skippedRepos }: { skippedRepos: string[] }) {
  return (
    <EmptyGraphic
      graphic={
        <p
          role="img"
          aria-label="An empty diff: zero lines removed, zero lines added"
          className="font-mono text-2xl tracking-tight text-muted-foreground/60 sm:text-3xl"
        >
          <span aria-hidden="true">@@ </span>
          <span aria-hidden="true" className="text-rose-500">
            -0,0
          </span>{" "}
          <span aria-hidden="true" className="text-emerald-500">
            +0,0
          </span>
          <span aria-hidden="true"> @@</span>
        </p>
      }
      headline={
        skippedRepos.length
          ? "Nothing from the repositories checked out here."
          : "Nothing to review."
      }
    >
      {skippedRepos.length ? (
        <>
          Requests in {skippedRepos.join(", ")} are hidden — no project checked out here. Add the
          project, or list the repository in this plugin's "Also show these repositories" setting.
        </>
      ) : (
        "New requests appear here as they arrive."
      )}
    </EmptyGraphic>
  );
}

export interface ReviewListViewProps {
  /** Null until the first listing arrives. */
  listing: Listing | null;
  /**
   * One clock for the whole render, so two rows requested a second apart never
   * disagree about what "now" is.
   */
  now: number;
  /** Rows whose thread is being created, keyed `repo#number`. */
  starting: ReadonlySet<string>;
  /**
   * The Start thread box for a row, drawn under its action line while its
   * button has it open. Null for every other row.
   */
  renderStartThread?: (row: Row) => ReactNode;
  /** The row's thread is being started from its box, keyed `repo#number`. */
  isThreadStarting?: (key: string) => boolean;
  harvest: HarvestPanelState;
  onReview: (row: Row) => void;
  onOpen: (row: Row, threadId: string) => void;
  onArchive: (row: Row) => void;
  /** Snoozes the request until a day (`YYYY-MM-DD`), or wakes it with null. */
  onSnooze: (row: Row, until: string | null) => void;
  /** Saves the row's note; "" deletes it. Resolves true once saved. */
  onNoteSave: (row: Row, body: string) => Promise<boolean>;
  /** The title was clicked, and the pull request is about to open. */
  onOpenLink: (row: Row) => void;
  /**
   * Reads what everyone left on the pull request, when its comment count is
   * clicked. Once it has read them, the row's "N new" is marked seen.
   */
  loadFeedback: (row: Row) => Promise<FeedbackResult>;
  /**
   * A user's or organization's picture. Defaults to GitHub's; the stories
   * pass drawn ones so they need no network.
   */
  avatarFor?: (owner: string) => string;
  /** Opens the dialog that starts several reviews at once. Without it there is no Batch button. */
  onBatch?: () => void;
  /**
   * What a row's thread is doing, from bb's sidebar. Left out, a row with a
   * thread still draws its thread line, without the status.
   */
  threadStatus?: (threadId: string | null) => ThreadStatus | null;
}

export function ReviewListView({
  listing,
  now,
  starting,
  renderStartThread,
  isThreadStarting = () => false,
  harvest,
  onReview,
  onOpen,
  onArchive,
  onSnooze,
  onNoteSave,
  onOpenLink,
  loadFeedback,
  avatarFor = githubAvatar,
  onBatch,
  threadStatus,
}: ReviewListViewProps): ReactNode {
  if (!listing) return <SweepingReviews />;

  const inputs: TierInputs = { staleAfterDays: listing.staleAfterDays, now };

  // The repository only earns a place on the row when it varies.
  const showRepo = new Set(listing.rows.map((row) => row.repo)).size > 1;

  const sorted = sortReviews(listing.rows, inputs);
  const rowsByKey = new Map(sorted.map((row) => [keyOf(row), row]));
  const items: SweepItem[] = sorted.map((row) => ({
    key: keyOf(row),
    runId: runOf(row, inputs),
    title: row.title,
    url: row.url,
    number: row.number,
    newComments: row.newComments,
    comments: row.comments + (row.inlineComments ?? 0),
    flags: flagsFor(row, inputs),
    // Only the age: the body draws the rest as icons.
    facts: [relativeTime(row.requestedAt, now)],
    parent: null,
    note: row.note,
    stage: stageOf(row),
    icon: <PullRequestIcon draft={row.isDraft} />,
    conflicted: row.conflicted === true,
    stack: row.stack
      ? {
          index: row.stack.index,
          size: row.stack.size,
          on: row.stack.on === null ? null : { number: row.stack.on, url: `https://github.com/${row.repo}/pull/${row.stack.on}` },
        }
      : null,
  }));

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto p-4 md:p-5">
        <div className="mx-auto w-full max-w-6xl space-y-5">
          {listing.lastError ? (
            <p className="rounded-lg border border-border p-3 text-sm text-destructive">
              {listing.lastError}
            </p>
          ) : null}

          {listing.truncated ? (
            <p className="text-xs text-muted-foreground">
              The sweep hit GitHub's search ceiling, so this list may be incomplete.
            </p>
          ) : null}

          {listing.rows.length === 0 ? (
            <NothingToReview skippedRepos={listing.skippedRepos} />
          ) : (
            <SweepList
              stages={STAGES}
              runs={REVIEW_RUNS}
              items={items}
              Link={UrlLink}
              renderStartThread={(item) => {
                const row = rowsByKey.get(item.key);
                return row ? renderStartThread?.(row) : null;
              }}
              onNoteSave={(item, body) => {
                const row = rowsByKey.get(item.key);
                return row ? onNoteSave(row, body) : Promise.resolve(false);
              }}
              onOpenLink={(item) => {
                const row = rowsByKey.get(item.key);
                if (row) onOpenLink(row);
              }}
              // No stage track: the banner and the icons say where a review stands.
              renderTrack={() => null}
              renderBody={(item, _open, line) => {
                const row = rowsByKey.get(item.key);
                return row ? (
                  <RowBody row={row} line={line} now={now} inputs={inputs} showRepo={showRepo} avatarFor={avatarFor} />
                ) : null;
              }}
              // Every row stays open, since each review is one to do, except a
              // snoozed one, which closes to one line at the bottom.
              collapsible="later"
              summaryAction={
                onBatch ? <BatchButton count={listing.rows.filter(canBatch).length} onBatch={onBatch} /> : undefined
              }
              renderComments={(item) => {
                const row = rowsByKey.get(item.key);
                if (!row) return null;
                return (
                  <FeedbackDrawer
                    url={row.url}
                    age={(at) => relativeTime(at, now)}
                    Link={UrlLink}
                    Markdown={Markdown}
                    load={async () => {
                      const result = await loadFeedback(row);
                      if (!result.error && row.newComments > 0) onOpenLink(row);
                      return result;
                    }}
                  />
                );
              }}
              renderThreadLine={(item) => {
                const row = rowsByKey.get(item.key);
                const threadId = row?.threadId;
                if (row && !threadId && isThreadStarting(item.key)) {
                  return <StartingThreadLine title={`${row.title} (#${row.number})`} />;
                }
                if (!row || !threadId) return null;
                return <ThreadLine status={threadStatus?.(threadId) ?? null} onOpen={() => onOpen(row, threadId)} />;
              }}
              // The timer sits at the bottom right of the row, apart from the actions.
              renderTrailing={(item) => {
                const row = rowsByKey.get(item.key);
                if (!row || !harvest.available) return null;
                return (
                  <HarvestRowClock
                    surface="reviews"
                    preferredTaskName="Code Review"
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
                      onReview={onReview}
                      onOpen={onOpen}
                    />
                    <ArchiveAction row={row} onArchive={onArchive} />
                    <SnoozeAction row={row} now={now} onSnooze={onSnooze} />
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
          label="Not shown"
          hint={'Add the project, or list the repository in the "Also show these repositories" setting.'}
        />
      ) : null}
    </div>
  );
}
