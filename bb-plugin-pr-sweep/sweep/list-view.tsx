import type { SyncUsage } from "@danielbachhuber/bb-plugin-component-library/sync-status";
import type { ReactNode } from "react";
import { Markdown, UrlLink } from "@get-bb/plugin-sdk/app";
import { ThreadLine, OpenThreadAction, StartingThreadLine, type ThreadStatus } from "@danielbachhuber/bb-plugin-component-library/thread-status";
import { CopyLinkAction, LINE_ACTION } from "sweep-ui/actions";
import { StatusBanner } from "sweep-ui/banner";
import { FeedbackDrawer, type FeedbackResult } from "sweep-ui/feedback";
import { SweepList } from "sweep-ui/list";
import { SkippedReposFooter } from "sweep-ui/skipped-repos";
import {
  ChecksBadge,
  DiffCount,
  PullRequestIcon,
  ReviewerStack,
  type ReviewerTooltipProps,
} from "sweep-ui/pull-request";
import type { Stage, SweepItem } from "sweep-ui/types";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { writeLinkToClipboard } from "@/components/ui/copy-link";
import { HarvestRowClock } from "bb-plugin-harvest/clock";
import type { HarvestTimerClient } from "bb-plugin-harvest/picker";
import { timerDefaultsForItem } from "bb-plugin-harvest/github";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  LoadingGraphic,
  usePrefersReducedMotion,
} from "@/components/ui/loading-graphic";
import { EmptyGraphic } from "@/components/ui/empty-graphic";
import { actionSummary, commentsToRead, hasNothingToDo } from "./actions.js";
import { relativeTime } from "./format.js";
import { bannerFor, blockedStageOf, diffOf, reviewersFor } from "./row-status.js";
import {
  PR_RUNS,
  PR_STAGES,
  flagsFor,
  runOf,
  sortPrs,
  stageOf,
  type ListedPr,
  type TierInputs,
} from "./tiers.js";

/**
 * What the Pull requests panel draws, given a listing. No RPC or realtime
 * here, so the stories can render every state from fixtures; app.tsx loads the
 * listing and owns the actions.
 */
export type Row = ListedPr;

export type Listing = {
  rows: Row[];
  staleAfterDays: number;
  sweptAt: number | null;
  failedRepos: string[];
  skippedRepos: string[];
  truncated: boolean;
  lastError: string | null;
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

/** Each stage's colour on the track: grey for a draft, amber while checks run, then sky and emerald. */
const STAGES: Stage[] = PR_STAGES.map((name, index) => ({
  name,
  color: ["bg-slate-400", "bg-amber-500", "bg-sky-500", "bg-emerald-500"][index]!,
}));

function keyOf(row: Row): string {
  return `${row.repo}#${row.number}`;
}

/**
 * Start or open the thread for one pull request.
 *
 * Three states, because a click that looks like nothing happened is what
 * makes someone click again: the action, "Starting…" while the draft is
 * fetched, then "Open thread" once one exists. A row that asks nothing of you,
 * such as one only waiting for a run to finish, offers no start at all.
 */
function ThreadAction({
  row,
  isStarting,
  isThreadStarting,
  isOpen,
  onWork,
  onOpen,
}: {
  row: Row;
  isStarting: boolean;
  /** Its thread is being started: Open thread, greyed until it exists. */
  isThreadStarting: boolean;
  /** The Start thread box is open under this row; the button stays pressed and closes it. */
  isOpen: boolean;
  onWork: (row: Row) => void;
  onOpen: (row: Row, threadId: string) => void;
}) {
  if (row.threadId) {
    const threadId = row.threadId;
    return <OpenThreadAction onOpen={() => onOpen(row, threadId)} />;
  }
  if (isThreadStarting) return <OpenThreadAction disabled />;

  const toRead = commentsToRead(row);
  if (hasNothingToDo(row.group, row.flags, toRead)) return null;

  // Which work the click starts, such as "Resolve conflict", is the title,
  // so the sentence survives for anyone who hovers.
  const action = actionSummary(row.flags, toRead);
  // Disabled with its reason as the label, rather than hidden: a row that
  // silently lacks the action reads as a bug.
  const label = !row.canSpawn ? "No project here" : isStarting ? "Starting…" : "Start thread";
  return (
    <button
      type="button"
      className={cn(LINE_ACTION, isOpen && "bg-accent text-foreground")}
      aria-expanded={isOpen}
      disabled={!row.canSpawn || isStarting}
      title={row.canSpawn ? action : `No bb project is checked out for ${row.repo}`}
      onClick={() => onWork(row)}
    >
      <Icon
        name={isStarting ? "Spinner" : "MessageSquarePlus"}
        className={`size-3${isStarting ? " animate-spin" : ""}`}
      />
      {label}
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
  item: SweepItem;
  showRepo: boolean;
  avatarFor?: (owner: string) => string;
}

/** The banner's Dismiss or Undo, styled as a link in the banner's own color. */
function BannerAction({
  row,
  action,
  onDismissChecks,
}: {
  row: Row;
  action: "dismiss-checks" | "restore-checks";
  onDismissChecks: (row: Row, dismissed: boolean) => void;
}) {
  const dismiss = action === "dismiss-checks";
  return (
    <button
      type="button"
      className="font-medium underline-offset-2 hover:underline"
      title={
        dismiss
          ? "Stop flagging these checks until a new push or a different check fails"
          : "Flag these failing checks again"
      }
      onClick={() => onDismissChecks(row, dismiss)}
    >
      {dismiss ? "Dismiss" : "Undo"}
    </button>
  );
}

/**
 * The row's facts as icons with numbers: reviewers, then checks, then size,
 * then the repository when the list spans several and a stale flag when there
 * is one. The checks are left out when the pull request has none, and the
 * size when the row was stored before the sweep read it.
 */
function FactIcons({ row, item, showRepo, avatarFor }: BodyProps) {
  const reviewers = reviewersFor(row, avatarFor);
  const diff = diffOf(row);
  const stale = item.flags.find((flag) => flag.kind === "stale");
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span data-part="reviewers" className="inline-flex items-center">
        {reviewers.length > 0 ? (
          <TooltipProvider delayDuration={150}>
            <ReviewerStack reviewers={reviewers} Tooltip={ReviewerTooltip} />
          </TooltipProvider>
        ) : (
          "no reviewer"
        )}
      </span>
      <ChecksBadge checks={row.checks} />
      {diff ? <DiffCount {...diff} /> : null}
      {showRepo ? <span data-part="repo">{row.repo}</span> : null}
      {stale ? (
        <span data-part="stale" className="font-medium text-destructive-text">
          {stale.text}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Under the title: a red banner naming what stops the pull request, or a green
 * one when it is ready to merge, then the fact icons. On a one-line Later row,
 * only the icons, inline.
 */
function RowBody({
  line,
  onDismissChecks,
  ...props
}: BodyProps & { line: boolean; onDismissChecks: (row: Row, dismissed: boolean) => void }) {
  const icons = <FactIcons {...props} />;
  if (line) return icons;
  const banner = bannerFor(props.row);
  return (
    <>
      {banner ? (
        <StatusBanner
          tone={banner.tone}
          detail={banner.detail}
          action={
            banner.action ? (
              <BannerAction row={props.row} action={banner.action} onDismissChecks={onDismissChecks} />
            ) : undefined
          }
        >
          {banner.text}
        </StatusBanner>
      ) : null}
      <div className="mt-1.5">{icons}</div>
    </>
  );
}

/**
 * The pull request's earlier threads, when it has any.
 *
 * One pull request has several threads over its life, such as a conflict
 * thread, then a CI thread, then a merge thread, and "Open thread" opens only
 * the newest. This is how the finished ones stay reachable instead of being
 * visible only in the sidebar. Renders nothing on a single-thread row.
 */
function EarlierThreads({ row, onOpen }: { row: Row; onOpen: (row: Row, threadId: string) => void }) {
  const older = row.threadIds.slice(1);
  if (older.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={LINE_ACTION}>
          <Icon name="MoreHorizontal" className="size-3" />
          {older.length} earlier thread{older.length === 1 ? "" : "s"}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {older.map((threadId, index) => (
          <DropdownMenuItem key={threadId} onSelect={() => onOpen(row, threadId)}>
            {/* Numbered from the newest backwards, because "earlier thread 1"
                is the one before the one the button opens. The thread's own
                title is not on the row, so a position is all this can say. */}
            Earlier thread {index + 1}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Nothing open, drawn as the finished shape of the loading glyph above.
 *
 * Same trunk, same arc, same merge node — but the branch is behind you: it is
 * drawn faint and already rejoined, and the merge point is solid. The two
 * glyphs are the same picture at two moments, so the panel settling into
 * emptiness reads as the work having landed rather than as a different screen.
 */
function NoPullRequestsGraphic() {
  return (
    <svg
      role="img"
      aria-label="A branch merged back into the trunk, with nothing outstanding"
      viewBox="0 0 132 64"
      className="h-[4.5rem] w-[9.5rem] text-muted-foreground"
      fill="none"
    >
      {/* The trunk, at the weight it carries in the loading glyph. */}
      <path
        d="M8 46H124"
        stroke="currentColor"
        strokeOpacity={0.3}
        strokeWidth={2.5}
        strokeLinecap="round"
      />

      {/* The branch, faint: it happened, and it is over. */}
      <path
        d="M30 46C44 46 44 22 58 22H82C96 22 96 46 110 46"
        stroke="currentColor"
        strokeOpacity={0.22}
        strokeWidth={2.5}
        strokeLinecap="round"
      />

      <circle cx={30} cy={46} r={3.5} fill="currentColor" fillOpacity={0.3} />

      {/* The merge, solid and alone: everything is back in the trunk. */}
      <circle cx={110} cy={46} r={4.5} className="fill-emerald-500" fillOpacity={0.75} />
    </svg>
  );
}

/**
 * What this panel is waiting for, drawn as the thing it is waiting on.
 *
 * A pull request is a branch that leaves the trunk, collects commits and comes
 * back, so that is what the wait shows: the branch draws itself, three commits
 * land on it in turn, and the merge point arrives last and in colour. The one
 * accent in the whole panel-load is the merge — the moment every row in the
 * list below is working toward.
 *
 * Timings are fractions of a single 2.4s cycle rather than separate durations,
 * so every part of the glyph restarts together and the loop has no seam.
 */
function SweepingPullRequests() {
  const still = usePrefersReducedMotion();

  return (
    <LoadingGraphic caption="Sweeping your open pull requests">
      <svg
        role="img"
        aria-label="A branch leaving the trunk, gathering commits, and merging back"
        viewBox="0 0 132 64"
        className="h-[4.5rem] w-[9.5rem] text-muted-foreground"
        fill="none"
      >
        {/* The trunk, which is always there and never animates. */}
        <path
          d="M8 46H124"
          stroke="currentColor"
          strokeOpacity={0.3}
          strokeWidth={2.5}
          strokeLinecap="round"
        />

        {/* Where the branch leaves. */}
        <circle cx={30} cy={46} r={3.5} fill="currentColor" fillOpacity={0.7} opacity={still ? 1 : 0}>
          {still ? null : (
            <animate
              attributeName="opacity"
              dur="2.4s"
              repeatCount="indefinite"
              values="0;0;1;1;0;0"
              keyTimes="0;0.02;0.06;0.86;0.96;1"
            />
          )}
        </circle>

        <path
          d="M30 46C44 46 44 22 58 22H82C96 22 96 46 110 46"
          stroke="currentColor"
          strokeOpacity={0.55}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeDasharray={92}
          strokeDashoffset={still ? 0 : 92}
        >
          {still ? null : (
            <>
              <animate
                attributeName="stroke-dashoffset"
                dur="2.4s"
                repeatCount="indefinite"
                values="92;92;0;0;0"
                keyTimes="0;0.05;0.42;0.86;1"
              />
              <animate
                attributeName="opacity"
                dur="2.4s"
                repeatCount="indefinite"
                values="1;1;0;0"
                keyTimes="0;0.86;0.96;1"
              />
            </>
          )}
        </path>

        {/* The commits, landing in the order they would be pushed. */}
        {[
          { cx: 58, at: "0.3;0.34" },
          { cx: 70, at: "0.38;0.42" },
          { cx: 82, at: "0.46;0.5" },
        ].map(({ cx, at }) => (
          <circle
            key={cx}
            cx={cx}
            cy={22}
            r={3.5}
            fill="currentColor"
            fillOpacity={0.7}
            opacity={still ? 1 : 0}
          >
            {still ? null : (
              <animate
                attributeName="opacity"
                dur="2.4s"
                repeatCount="indefinite"
                values="0;0;1;1;0;0"
                keyTimes={`0;${at};0.86;0.96;1`}
              />
            )}
          </circle>
        ))}

        {/* The merge: the only colour, and the last thing to arrive. */}
        <circle cx={110} cy={46} r={4.5} className="fill-emerald-500" opacity={still ? 1 : 0}>
          {still ? null : (
            <>
              <animate
                attributeName="opacity"
                dur="2.4s"
                repeatCount="indefinite"
                values="0;0;1;1;0;0"
                keyTimes="0;0.58;0.63;0.86;0.96;1"
              />
              <animate
                attributeName="r"
                dur="2.4s"
                repeatCount="indefinite"
                values="1;1;5.5;4.5;4.5;4.5"
                keyTimes="0;0.58;0.63;0.7;0.96;1"
              />
            </>
          )}
        </circle>
      </svg>
    </LoadingGraphic>
  );
}

/**
 * Why the panel is emptier than GitHub is.
 *
 * The filter is a setting with no panel control, so this sentence is the only
 * evidence it is on. Without it an empty panel on a machine holding none of
 * your checkouts is indistinguishable from having no open pull requests.
 *
 * It stands in for the empty state's usual second line when there are no rows.
 * When there are, `SkippedReposFooter` names the repositories at the bottom of
 * the panel instead.
 */
function SkippedRepos({ repos }: { repos: string[] }) {
  return (
    <>
      Not swept: {repos.join(", ")} — no project checked out here. Add the project, or list the
      repository in this plugin's "Also sweep these repositories" setting.
    </>
  );
}


export interface PrListViewProps {
  /** Null until the first listing arrives, which draws the loading graphic. */
  listing: Listing | null;
  /**
   * One clock for the whole render, so two rows updated a second apart never
   * disagree about what "now" is.
   */
  now: number;
  /** Rows whose thread is being created, keyed `repo#number`. */
  starting: ReadonlySet<string>;
  /**
   * The Start thread box for a row, keyed `repo#number`, drawn under its
   * action line while its button has it open. Null for every other row.
   */
  renderStartThread?: (row: Row) => ReactNode;
  /** The row's thread is being started from its box, keyed `repo#number`. */
  isThreadStarting?: (key: string) => boolean;
  harvest: HarvestPanelState;
  onWork: (row: Row) => void;
  /** Opens one of the row's threads: the newest, or one from the earlier-threads menu. */
  onOpen: (row: Row, threadId: string) => void;
  onArchive: (row: Row) => void;
  /** Saves the row's note; "" deletes it. Resolves true once saved. */
  onNoteSave: (row: Row, body: string) => Promise<boolean>;
  /** Dismisses the row's failing checks, or with `false` flags them again. */
  onDismissChecks: (row: Row, dismissed: boolean) => void;
  /** The title was clicked, and the pull request is about to open. */
  onOpenLink: (row: Row) => void;
  /**
   * Reads what reviewers left on the pull request, when its comment count is
   * clicked. Once it has read them, the row's "N new" is marked seen.
   */
  loadFeedback: (row: Row) => Promise<FeedbackResult>;
  /**
   * A user's or organization's picture. Defaults to GitHub's; the stories
   * pass drawn ones so they need no network.
   */
  avatarFor?: (owner: string) => string;
  /**
   * Draws each row's right-hand column. Rows have none by default: the banner
   * and the icons say where a pull request stands.
   */
  renderTrack?: (item: SweepItem, line: boolean, row: Row) => ReactNode;
  /**
   * What a row's thread is doing, from bb's sidebar. Left out, a row with a
   * thread still draws its thread line, without the status.
   */
  threadStatus?: (threadId: string | null) => ThreadStatus | null;
}

export function PrListView({
  listing,
  now,
  starting,
  renderStartThread,
  isThreadStarting = () => false,
  harvest,
  onWork,
  onOpen,
  onArchive,
  onNoteSave,
  onDismissChecks,
  onOpenLink,
  loadFeedback,
  avatarFor,
  renderTrack,
  threadStatus,
}: PrListViewProps): ReactNode {
  if (!listing) return <SweepingPullRequests />;

  const inputs: TierInputs = { staleAfterDays: listing.staleAfterDays, now };

  // The repository only earns a place on the row when it varies.
  const showRepo = new Set(listing.rows.map((row) => row.repo)).size > 1;

  const sorted = sortPrs(listing.rows, inputs);
  const rowsByKey = new Map(sorted.map((row) => [keyOf(row), row]));
  const items: SweepItem[] = sorted.map((row) => ({
    key: keyOf(row),
    runId: runOf(row),
    title: row.title,
    url: row.url,
    number: row.number,
    newComments: row.newComments,
    flags: flagsFor(row, inputs),
    // Only the age: the body draws the rest as icons.
    facts: [relativeTime(row.updatedAt, now)],
    parent: null,
    note: row.note,
    stage: stageOf(row),
    blockedStage: blockedStageOf(row),
    icon: <PullRequestIcon draft={row.isDraft} />,
    conflicted: row.flags.includes("conflict"),
    // General and inline comments together, so a pull request whose review
    // threads were all answered still shows it has comments to read.
    comments: row.commentsCount + (row.inlineComments ?? 0),
    stack: row.stack
      ? {
          index: row.stack.index,
          size: row.stack.size,
          on: row.stack.on === null ? null : { number: row.stack.on, url: `https://github.com/${row.repo}/pull/${row.stack.on}` },
        }
      : null,
    // A running timer must stay in view, and it lives in the action line.
    forceOpen: harvest.available && isRunningFor(harvest.running, row),
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
              The sweep hit the 100 pull request ceiling, so this list may be incomplete.
            </p>
          ) : null}

          {listing.failedRepos.length ? (
            <p className="text-xs text-muted-foreground">
              Could not refresh {listing.failedRepos.join(", ")}. Showing the last known rows.
            </p>
          ) : null}

          {listing.rows.length === 0 ? (
            <EmptyGraphic
              graphic={<NoPullRequestsGraphic />}
              // The headline has to move too. "No open pull requests" is untrue
              // on a machine that simply cannot see the thirty you have open.
              headline={
                listing.skippedRepos.length
                  ? "Nothing from the repositories checked out here."
                  : "No open pull requests."
              }
            >
              {listing.skippedRepos.length ? (
                <SkippedRepos repos={listing.skippedRepos} />
              ) : (
                "Anything you open shows up here."
              )}
            </EmptyGraphic>
          ) : (
            <SweepList
              stages={STAGES}
              runs={PR_RUNS}
              items={items}
              // Rows stay open, so each pull request shows its actions, except
              // the ones waiting on someone else, which close to one line.
              collapsible="later"
              // Newest first with the minimized rows last, not grouped by tier.
              order="given"
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
              renderTrack={
                renderTrack
                  ? (item, line) => {
                      const row = rowsByKey.get(item.key);
                      return row ? renderTrack(item, line, row) : null;
                    }
                  : () => null
              }
              renderBody={(item, _open, line) => {
                const row = rowsByKey.get(item.key);
                return row ? (
                  <RowBody
                    row={row}
                    item={item}
                    line={line}
                    showRepo={showRepo}
                    avatarFor={avatarFor}
                    onDismissChecks={onDismissChecks}
                  />
                ) : null;
              }}
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
                    surface="pull-requests"
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
                      onWork={onWork}
                      onOpen={onOpen}
                    />
                    {/* The tidy-up once the work a thread was started for is
                        finished: the pull request has no flags left. */}
                    {row.threadId && row.flags.length === 0 ? (
                      <button type="button" className={LINE_ACTION} onClick={() => onArchive(row)}>
                        <Icon name="Archive" className="size-3" />
                        Archive thread
                      </button>
                    ) : null}
                    <EarlierThreads row={row} onOpen={onOpen} />
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
