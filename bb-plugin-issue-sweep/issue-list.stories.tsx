import type { ReactNode } from "react";
import { StoryCard, StoryRow } from "@bb-ladle/story-card";
import type { HarvestTimerClient } from "bb-plugin-harvest/picker";
import { Icon } from "./components/ui/icon";
import { SyncStatus } from "@danielbachhuber/bb-plugin-component-library/sync-status";
import type { ThreadStatus } from "@danielbachhuber/bb-plugin-component-library/thread-status";
import { TooltipProvider } from "./components/ui/tooltip";
import {
  IssueListView,
  type HarvestPanelState,
  type HarvestState,
  type Listing,
  type Row,
} from "./issues/list-view";
import { FeedbackDrawer, FeedbackList } from "sweep-ui/feedback";
import { Markdown } from "@get-bb/plugin-sdk/app";
import type { IssueComment } from "./issues/comments";
import { relativeTime } from "./issues/format";
import { PlainLink } from "sweep-ui/row";

export default {
  title: "issue-sweep/Issue list",
};

/** The real clock, so the synced-ago label in the title bar agrees with the ages. */
const now = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const noop = () => {};

const STATUS_OPTIONS = ["Backlog", "Ready", "In Progress", "In Review", "Done"];
/** A second board's columns, for the stories with more than one board. */
const OCTOCAT_OPTIONS = ["Todo", "In Progress", "Done"];

function row(overrides: Partial<Row> & Pick<Row, "number" | "title">): Row {
  const repo = overrides.repo ?? "acme/widgets";
  return {
    repo,
    url: `https://github.com/${repo}/issues/${overrides.number}`,
    labels: [],
    boardStatus: "Ready",
    onBoard: true,
    board: "Acme Board",
    statusOptions: STATUS_OPTIONS,
    blockedBy: 0,
    closingPr: null,
    subtasks: null,
    parent: null,
    note: null,
    newComments: 0,
    movedAt: null,
    threadId: null,
    canSpawn: true,
    createdAt: now - 12 * DAY,
    updatedAt: now - 6 * HOUR,
    commentsCount: 0,
    ...overrides,
  };
}

const baselineRows: Row[] = [
  row({
    number: 214,
    title: "Let a widget remember its last export format",
    updatedAt: now - 3 * HOUR,
    commentsCount: 2,
    newComments: 2,
  }),
  row({
    number: 187,
    title: "Widget picker loses focus after closing the preview",
    updatedAt: now - 2 * DAY,
  }),
  row({
    number: 231,
    title: "Show gadget quotas on the widget settings page",
    boardStatus: "In Progress",
    updatedAt: now - 40 * 60_000,
    commentsCount: 5,
    subtasks: { completed: 2, total: 5, source: "sub-issues" },
    threadId: "thr_fixture1",
    note: "Finish the quota bar, then ask octocat to review",
  }),
  row({
    number: 156,
    title: "Document the widget import limits",
    boardStatus: "Backlog",
    updatedAt: now - 3 * 7 * DAY,
  }),
];

/** The panel with invented names. */
const baseline: Listing = {
  rows: baselineRows,
  boardStages: ["Backlog", "Ready", "In Progress", "In Review"],
  staleAfterDays: 7,
  reviewStatus: "In Review",
  countedStatuses: ["Ready", "In Progress"],
  sweptAt: now - 3 * 60_000,
  skippedRepos: [],
  truncated: false,
  lastError: null,
};

const HARVEST_IDLE: HarvestState = { available: true, running: null };

const EXPORT_EPIC = {
  number: 140,
  title: "Widget export, second pass",
  url: "https://github.com/acme/widgets/issues/140",
};

/** Every run and row variation at once. */
const everything: Listing = {
  ...baseline,
  rows: [
    ...baselineRows,
    row({
      number: 242,
      title: "Retry widget uploads that time out",
      updatedAt: now - 5 * HOUR,
      commentsCount: 1,
      subtasks: { completed: 1, total: 4, source: "tasks" },
      parent: EXPORT_EPIC,
    }),
    row({
      number: 237,
      title: "Widget previews render blank on first open",
      boardStatus: "In Progress",
      updatedAt: now - 11 * DAY,
      commentsCount: 4,
    }),
    row({
      number: 219,
      title: "Rename widget slots to match the design doc",
      boardStatus: "In Review",
      updatedAt: now - 20 * HOUR,
      commentsCount: 8,
      closingPr: 251,
    }),
    row({
      number: 248,
      title: "Gadget search returns archived widgets",
      boardStatus: "Ready",
      updatedAt: now - 15 * 60_000,
      commentsCount: 1,
      newComments: 1,
      canSpawn: false,
    }),
    row({
      number: 203,
      title: "Widgets lose their colour after a sync",
      boardStatus: null,
      onBoard: false,
      updatedAt: now - 4 * DAY,
      commentsCount: 3,
    }),
    row({
      number: 199,
      title: "Pick a default theme for new widgets",
      boardStatus: null,
      onBoard: true,
      updatedAt: now - 9 * DAY,
    }),
    row({
      number: 225,
      title: "Move the widget cache to a worker",
      boardStatus: "Ready",
      blockedBy: 1,
      updatedAt: now - 6 * DAY,
      subtasks: { completed: 0, total: 3, source: "sub-issues" },
    }),
    row({
      number: 176,
      title: "Retire the old widget exporter",
      boardStatus: "Stalled",
      updatedAt: now - 2 * 30 * DAY,
    }),
    row({
      number: 271,
      title: "Simplify widget permissions",
      boardStatus: "In Progress",
      updatedAt: now - 3 * DAY,
      commentsCount: 7,
      subtasks: { completed: 3, total: 7, source: "tasks" },
      note: "Waiting on review of #312",
      onHold: true,
    }),
    row({
      number: 233,
      title: "Rename gadget slots",
      boardStatus: "In Progress",
      updatedAt: now - 9 * DAY,
      onHold: true,
    }),
  ],
};

const multiRepo: Listing = {
  ...everything,
  rows: everything.rows.map((r, index) =>
    index % 2
      ? { ...r, repo: "acme/gadgets", url: r.url.replace("widgets", "gadgets") }
      : r,
  ),
};

const harvestClient: HarvestTimerClient = {
  assignments: async () => ({ projects: [] }),
  trackedHours: async () => ({ hours: 0 }),
  startTimer: async () => ({ entry: null }),
  lastSelection: async () => null,
  stopTimer: async () => {},
};

function harvestFor(state: HarvestState): HarvestPanelState {
  return {
    available: state.available,
    running: state.running,
    client: harvestClient,
    onStarted: noop,
  };
}

/** What bb's sidebar would say about the fixture threads. */
const THREADS: Record<string, ThreadStatus> = {
  thr_fixture1: { id: "thr_fixture1", title: "Show gadget quotas on the widget settings page (#231)", live: "working" },
};
const threadStatus = (id: string | null) => (id === null ? null : (THREADS[id] ?? null));

/** The panel's title bar, so a frame reads like the real panel. */
function Frame({
  listing,
  harvest = HARVEST_IDLE,
  starting = new Set(),
  busyKeys = new Set(),
  height = "h-[30rem]",
}: {
  listing: Listing | null;
  harvest?: HarvestState;
  starting?: Set<string>;
  busyKeys?: Set<string>;
  /** A Tailwind height class, or "fit" to grow with the list. */
  height?: string;
}): ReactNode {
  return (
    <TooltipProvider delayDuration={300}>
      <div
        className={`flex w-full flex-col rounded-lg border border-border bg-background ${height === "fit" ? "" : height}`}
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
          <span className="flex items-center gap-2 text-sm font-medium">
            <Icon name="ListTodo" className="size-4 text-muted-foreground" />
            Issues
          </span>
          <SyncStatus syncedAt={listing?.sweptAt ?? null} busy={false} onRefresh={noop} />
        </div>
        <div className="min-h-0 flex-1">
          <IssueListView
            listing={listing}
            now={now}
            busyKeys={busyKeys}
            starting={starting}
            harvest={harvestFor(harvest)}
            onPick={noop}
            onStart={noop}
            onOpen={noop}
            onNoteSave={async () => true}
            onOpenLink={noop}
            loadComments={async () => ({ entries: COMMENTS, total: COMMENTS.length, error: null })}
            threadStatus={threadStatus}
          />
        </div>
      </div>
    </TooltipProvider>
  );
}

/** The conversation on #42, as the comments drawer reads it. */
const COMMENTS: IssueComment[] = [
  {
    kind: "comment",
    author: "octocat",
    avatarUrl: "",
    body: "Reproduced on a 1280px window: the widget turns a few degrees further each time the window is resized.",
    url: "https://github.com/acme/widgets/issues/42",
    at: now - 3 * DAY,
  },
  {
    kind: "comment",
    author: "hubber",
    avatarUrl: "",
    body: "Could this be the rounding in the layout pass? It only shows up at **fractional zoom levels** for me.\n\nSteps that reproduce it here:\n1. Set the browser zoom to 110%.\n2. Open a board with at least one widget.\n3. Resize the window narrower, then wider again.\n\nThe widget ends up a degree or two off each time, and it never snaps back.",
    url: "https://github.com/acme/widgets/issues/42",
    at: now - 2 * DAY,
  },
  {
    kind: "comment",
    author: "hubber",
    avatarUrl: "",
    body: "Confirmed: at 100% zoom it holds steady. At 110% it drifts on every second resize.",
    url: "https://github.com/acme/widgets/issues/42",
    at: now - 5 * HOUR,
  },
];

/**
 * Four issues assigned to you. The one with new comments, the one with a
 * thread, and the ready one need you, open on the left; the backlog one is a
 * single line on the right.
 */
export function Baseline() {
  return (
    <StoryCard>
      <StoryRow
        label="Baseline"
        hint="One ready with two new comments, one ready, one in progress with a thread and a note, one in the backlog."
      >
        <Frame listing={baseline} height="h-[36rem]" />
      </StoryRow>
    </StoryCard>
  );
}

/**
 * Project boards set to "Acme Board, Octocat's Board", two boards with
 * different columns. Each row draws only the stages its own board has: the
 * Acme row shows Backlog, Ready, In Progress, and In Review, and the Octocat
 * rows show Todo and In Progress. The row on neither board shows the stages
 * of the board it would be added to.
 */
export function TwoBoards() {
  return (
    <StoryCard>
      <StoryRow
        label="Two boards"
        hint="Board stages list both boards' columns. #214 is on Acme Board; #8 is on Octocat's Board, which has Todo, In Progress, and Done; #9 is on neither and would be added to Octocat's Board."
      >
        <Frame
          listing={{
            ...baseline,
            boardStages: ["Backlog", "Todo", "Ready", "In Progress", "In Review"],
            rows: [
              row({
                number: 214,
                title: "Let a widget remember its last export format",
                boardStatus: "In Progress",
                threadId: "thr_story_1",
              }),
              row({
                repo: "octocat/notes",
                number: 8,
                title: "Sort the reading list by date added",
                board: "Octocat's Board",
                boardStatus: "Todo",
                statusOptions: OCTOCAT_OPTIONS,
                threadId: "thr_story_2",
              }),
              row({
                repo: "octocat/notes",
                number: 9,
                title: "Archive notes older than a year",
                board: null,
                onBoard: false,
                boardStatus: null,
                statusOptions: OCTOCAT_OPTIONS,
                threadId: "thr_story_3",
              }),
            ],
          }}
        />
      </StoryRow>
    </StoryCard>
  );
}

/**
 * Every run the list can draw: new comments, stale, working, and to start
 * under Needs you, then two issues on hold at its bottom, one with a note
 * and one without; waiting on review, later, and blocked grouped by status
 * beside them. Rows show a parent chip, sub-issue and task counts, a status
 * the stages do not name,
 * issues off the board, and "No project here" where nothing is checked out.
 * Then the same list across two repositories, a thread being started with a
 * timer running, and the panel without Harvest.
 */
export function Rows() {
  return (
    <StoryCard>
      <StoryRow
        label="Every run"
        hint="Each run, a stale row, a parent, a Stalled status, issues with no board status, and a blocked issue."
      >
        <Frame listing={everything} height="h-[60rem]" />
      </StoryRow>
      <StoryRow
        label="Two repositories"
        hint="The repository joins the number line once it varies."
      >
        <Frame listing={multiRepo} height="h-[60rem]" />
      </StoryRow>
      <StoryRow
        label="Starting, saving, and timing"
        hint="A thread being created for #214, a status change saving on #156, and a Harvest timer running on #231."
      >
        <Frame
          listing={baseline}
          harvest={{
            available: true,
            running: {
              externalId: "231",
              groupId: null,
              entryId: 1,
              startedAt: new Date(now - 25 * 60_000).toISOString(),
              projectName: "Widgets",
              taskName: "Development",
            },
          }}
          starting={new Set(["acme/widgets#214"])}
          busyKeys={new Set(["acme/widgets#156"])}
          height="h-[36rem]"
        />
      </StoryRow>
      <StoryRow label="Without Harvest" hint="No clock in the action line.">
        <Frame
          listing={baseline}
          harvest={{ available: false, running: null }}
          height="h-[36rem]"
        />
      </StoryRow>
    </StoryCard>
  );
}

/**
 * The panel before the first listing arrives, with nothing assigned, and with
 * nothing visible because the only repository with issues has no project on
 * this machine.
 */
export function States() {
  const empty: Listing = { ...baseline, rows: [] };
  return (
    <StoryCard>
      <StoryRow label="Loading" hint="The first load, before the listing arrives.">
        <Frame listing={null} />
      </StoryRow>
      <StoryRow label="Empty" hint="No issues assigned to you.">
        <Frame listing={empty} />
      </StoryRow>
      <StoryRow
        label="Empty, repositories hidden"
        hint="Issues exist in a repository with no project checked out here."
      >
        <Frame listing={{ ...empty, skippedRepos: ["acme/gadgets"] }} />
      </StoryRow>
    </StoryCard>
  );
}

/**
 * What the panel shows when something is wrong: a failed sweep above the last
 * good rows, gh-context missing so no row can start a thread, and no board
 * configured so every row shows its status as text in place of the picker.
 */
export function Warnings() {
  return (
    <StoryCard>
      <StoryRow
        label="Sweep failed"
        hint="The error and the 100 issue ceiling above the last good rows, and a skipped repository counted at the bottom of the panel."
      >
        <Frame
          listing={{
            ...baseline,
            lastError: "gh exited 1: HTTP 502 from api.github.com",
            truncated: true,
            skippedRepos: ["acme/gadgets"],
          }}
          height="h-[42rem]"
        />
      </StoryRow>
      <StoryRow
        label="gh-context missing"
        hint="Without thread links, no row offers to start a thread."
      >
        <Frame
          listing={{
            ...baseline,
            lastError:
              "Issue Sweep needs the gh-context plugin, which records which threads belong to which issues. Install it, then reload Issue Sweep.",
            rows: baselineRows.map((r) => ({ ...r, canSpawn: false, threadId: null })),
          }}
          height="h-[40rem]"
        />
      </StoryRow>
      <StoryRow
        label="No board"
        hint="No board is configured or it could not be read, so no issue has a status and none can be added."
      >
        <Frame
          listing={{
            ...baseline,
            rows: baselineRows.map((r) => ({
              ...r,
              boardStatus: null,
              onBoard: false,
              board: null,
              statusOptions: [],
            })),
          }}
        />
      </StoryRow>
    </StoryCard>
  );
}

const LONG_TITLES = [
  "Widget grid jumps when a row is added",
  "Keyboard focus lost after closing the gadget drawer",
  "Import widgets from a spreadsheet",
  "Bulk-rename gadgets",
  "Undo for widget deletes",
  "Widget previews in search results",
  "Share a gadget by link",
  "Printable widget sheets",
  "Keyboard shortcuts for the gadget tray",
  "Widget templates",
  "Gadget usage chart per week",
  "Archive widgets older than a year",
];

/** A long backlog, most of it waiting in the right column. */
const long: Listing = {
  ...baseline,
  rows: [
    ...baselineRows,
    ...LONG_TITLES.map((title, index) =>
      row({
        number: 300 + index,
        title,
        boardStatus: index % 4 === 3 ? null : "Backlog",
        onBoard: index % 4 !== 3,
        updatedAt: now - (index + 2) * 5 * DAY,
      }),
    ),
  ],
};

/**
 * The drawer a row's comment count opens: the issue's latest comments, oldest
 * first, with the ones that arrived since it was last seen marked new. Each
 * is drawn as the Markdown it was written in, and one longer than three lines
 * is cut there, with Show more under it. Then the drawer while it reads, when GitHub fails, and when
 * the issue has more comments than the drawer reads.
 */
export function CommentsDrawerStates() {
  const box = (children: ReactNode) => (
    <div className="w-full max-w-3xl rounded-md border border-border bg-muted/40 px-3 py-2">{children}</div>
  );
  const url = "https://github.com/acme/widgets/issues/42";
  const age = (at: number) => relativeTime(at, now);
  return (
    <StoryCard>
      <StoryRow label="Open" hint="Three comments on #42, the latest one new.">
        {box(<FeedbackList entries={COMMENTS} total={COMMENTS.length} newCount={1} age={age} url={url} Link={PlainLink} Markdown={Markdown} />)}
      </StoryRow>
      <StoryRow label="Reading" hint="While the one request to GitHub runs.">
        <FeedbackDrawer load={() => new Promise(() => {})} age={age} url={url} Link={PlainLink} Markdown={Markdown} />
      </StoryRow>
      <StoryRow label="Failed" hint="GitHub could not be reached.">
        <FeedbackDrawer
          load={async () => ({ entries: [], total: 0, error: "Could not read the comments from GitHub." })}
          age={age}
          url={url}
          Link={PlainLink}
          Markdown={Markdown}
        />
      </StoryRow>
      <StoryRow label="More than it reads" hint="The latest of 80 comments, with a link to the rest.">
        {box(<FeedbackList entries={COMMENTS} total={80} age={age} url={url} Link={PlainLink} Markdown={Markdown} />)}
      </StoryRow>
    </StoryCard>
  );
}

/**
 * A long list: what needs you on the left, and a long backlog grouped on the
 * right, with the issues off the board after it.
 */
export function LongList() {
  return (
    <StoryCard>
      <StoryRow label="Long list" hint="Twelve more issues in Backlog or off the board.">
        <Frame listing={long} height="fit" />
      </StoryRow>
    </StoryCard>
  );
}
