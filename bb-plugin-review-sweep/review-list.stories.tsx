import type { ReactNode } from "react";
import { StoryCard, StoryRow } from "@bb-ladle/story-card";
import type { HarvestTimerClient } from "bb-plugin-harvest/picker";
import { Icon } from "./components/ui/icon";
import { SyncStatus } from "@danielbachhuber/bb-plugin-component-library/sync-status";
import type { ThreadStatus } from "@danielbachhuber/bb-plugin-component-library/thread-status";
import { TooltipProvider } from "./components/ui/tooltip";
import { BatchPicker } from "./review/batch-dialog";
import {
  ReviewListView,
  canBatch,
  type HarvestPanelState,
  type HarvestState,
  type Listing,
  type Row,
} from "./review/list-view";
import { relativeTime } from "./review/format";
import { addDaysTo, localDay } from "@danielbachhuber/bb-plugin-component-library/parse-day";
import { FeedbackDrawer, FeedbackList, type FeedbackEntry } from "sweep-ui/feedback";
import { PlainLink } from "sweep-ui/row";
import { Markdown } from "@get-bb/plugin-sdk/app";

export default {
  title: "review-sweep/Review list",
};

/** The real clock, so the synced-ago label in the title bar agrees with the ages. */
const now = Date.now();
const HOUR = 3_600_000;
const noop = () => {};

/** A drawn picture for each account, so the stories need no network. */
function avatar(letter: string, color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" fill="${color}"/><text x="10" y="14" font-family="sans-serif" font-size="11" font-weight="600" fill="white" text-anchor="middle">${letter}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
const AVATARS: Record<string, string> = {
  hubber: avatar("H", "#d0703c"),
  octocat: avatar("O", "#7c5cc4"),
  acme: avatar("A", "#4a6b8a"),
  mona: avatar("M", "#2f8f5b"),
};
const avatarFor = (owner: string) => AVATARS[owner] ?? avatar(owner[0]!.toUpperCase(), "#6e7781");

function checks(overrides: Partial<Row["checks"]>): Row["checks"] {
  const merged = { pass: 0, fail: 0, skip: 0, pending: 0, cancelled: 0, ...overrides };
  return {
    ...merged,
    total: merged.pass + merged.fail + merged.skip + merged.pending + merged.cancelled,
  };
}

const GREEN = checks({ pass: 11, skip: 2 });
const TEAM_PENDING: Row["reviewers"] = [{ login: "acme/widgets-reviewers", state: "pending", team: true }];
// You, asked by name: first in the reviewer stack.
const YOU: Row["reviewers"][number] = { login: "mona", state: "pending", team: false };

function row(overrides: Partial<Row> & Pick<Row, "number" | "title">): Row {
  return {
    repo: "acme/widgets",
    url: `https://github.com/${overrides.repo ?? "acme/widgets"}/pull/${overrides.number}`,
    author: "octocat",
    isDraft: false,
    state: "first-look",
    requestedAt: now - 5 * HOUR,
    lastReviewedAt: null,
    requestedReviewers: ["you"],
    size: { additions: 40, deletions: 6, changedFiles: 3 },
    canSpawn: true,
    threadId: null,
    comments: 0,
    inlineComments: 0,
    checks: GREEN,
    reviewers: [YOU],
    stack: null,
    note: null,
    newComments: 0,
    ...overrides,
  };
}

const needsReview: Row[] = [
  row({
    number: 412,
    title: "test(widgets): cover the widget export for every account type",
    requestedAt: now - 60 * HOUR,
    requestedReviewers: ["widgets-api-experts"],
    size: { additions: 15208, deletions: 64, changedFiles: 71 },
    checks: checks({ pass: 9, pending: 4, skip: 1 }),
    reviewers: [
      { login: "acme/widgets-api-experts", state: "pending", team: true },
      { login: "octocat", state: "commented", team: false },
    ],
    inlineComments: 2,
  }),
  row({
    number: 437,
    title: "fix(gadgets): keep the `sort` order when a gadget is renamed",
    requestedAt: now - 9 * HOUR,
    author: "hubber",
    requestedReviewers: ["widgets-committers"],
    size: { additions: 18, deletions: 4, changedFiles: 2 },
    reviewers: TEAM_PENDING,
    comments: 3,
    inlineComments: 5,
    newComments: 2,
  }),
];

const inProgress: Row[] = [
  row({
    number: 425,
    title:
      "docs: propose moving widget themes into their own package so each gadget can override them",
    requestedAt: now - 17 * HOUR,
    size: { additions: 96, deletions: 0, changedFiles: 1 },
    threadId: "thr_fixture1",
    note: "Check the theme override example against the gadget docs",
  }),
];

/** A typical day, with invented names. */
const baseline: Listing = {
  rows: [...needsReview, ...inProgress],
  sweptAt: now - 2 * 60_000,
  skippedRepos: [],
  truncated: false,
  lastError: null,
  staleAfterDays: 2,
};

const HARVEST_IDLE: HarvestState = { available: true, running: null };

/** Every run and every row state at once. */
const everything: Listing = {
  ...baseline,
  rows: [
    ...needsReview,
    row({
      number: 398,
      title: "Retry widget uploads that time out",
      author: "hubber",
      state: "re-review",
      requestedAt: now - 5 * 24 * HOUR,
      lastReviewedAt: now - 6 * 24 * HOUR,
      // Conflicts with its base, so a warning follows the title.
      conflicted: true,
      requestedReviewers: ["you", "widgets-committers"],
      size: { additions: 320, deletions: 118, changedFiles: 14 },
      checks: checks({ pass: 10, fail: 2, skip: 1 }),
      reviewers: [
        YOU,
        { login: "acme/widgets-committers", state: "pending", team: true },
        { login: "octocat", state: "changes_requested", team: false },
      ],
    }),
    row({
      number: 441,
      title: "Bump the gadget SDK",
      author: "hubber",
      requestedAt: now - 20 * 60_000,
      requestedReviewers: [],
      size: { additions: 2, deletions: 2, changedFiles: 1 },
      checks: checks({}),
      reviewers: [],
      canSpawn: false,
    }),
    ...inProgress,
    row({
      number: 405,
      title: "Rename widget slots to match the design doc",
      state: "re-review",
      requestedAt: now - 3 * 24 * HOUR,
      threadId: "thr_fixture2",
      reviewers: [YOU, { login: "hubber", state: "approved", team: false }],
      // The middle of a stack of three, on a pull request not in this list.
      stack: { index: 2, size: 3, on: 404 },
    }),
    row({
      number: 443,
      title: "WIP: widget search",
      isDraft: true,
      stack: { index: 3, size: 3, on: 405 },
      requestedAt: now - 26 * HOUR,
      size: { additions: 890, deletions: 45, changedFiles: 21 },
    }),
    row({
      number: 436,
      title: "Translate the gadget settings page into every supported language",
      author: "octocat",
      requestedAt: now - 4 * 24 * HOUR,
      requestedReviewers: ["you", "widgets-committers"],
      size: { additions: 1240, deletions: 310, changedFiles: 38 },
      reviewers: [YOU, { login: "acme/widgets-committers", state: "pending", team: true }],
      snoozedUntil: addDaysTo(localDay(new Date(now)), 4),
    }),
  ],
};

const multiRepo: Listing = {
  ...everything,
  rows: everything.rows.map((r, index) =>
    index % 2 ? { ...r, repo: "acme/gadgets", url: r.url.replace("widgets", "gadgets") } : r,
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

/** What is on #437 for you (mona) as its reviewer, oldest first, your own threads included. */
const FEEDBACK: FeedbackEntry[] = [
  {
    kind: "thread",
    author: "octocat",
    avatarUrl: avatarFor("octocat"),
    path: "gadgets/rename.ts",
    line: 3,
    status: "resolved",
    outdated: true,
    replies: 1,
    body: "Unused import.",
    url: "https://github.com/acme/widgets/pull/437",
    at: now - 32 * HOUR,
  },
  {
    kind: "review",
    author: "mona",
    avatarUrl: avatarFor("mona"),
    you: true,
    state: "commented",
    body: "Looks right overall. Two questions inline before I approve.",
    url: "https://github.com/acme/widgets/pull/437",
    at: now - 30 * HOUR,
  },
  {
    kind: "thread",
    author: "mona",
    avatarUrl: avatarFor("mona"),
    you: true,
    path: "gadgets/rename.ts",
    line: 27,
    status: "unanswered",
    outdated: false,
    replies: 1,
    body: "Does this keep the order when two gadgets share a name?",
    url: "https://github.com/acme/widgets/pull/437",
    at: now - 30 * HOUR,
  },
  {
    kind: "thread",
    author: "mona",
    avatarUrl: avatarFor("mona"),
    you: true,
    path: "gadgets/sort.ts",
    line: 9,
    status: "waiting",
    outdated: false,
    replies: 0,
    body: "Could the comparator move next to the other sort helpers?",
    url: "https://github.com/acme/widgets/pull/437",
    at: now - 30 * HOUR,
  },
  {
    kind: "comment",
    author: "hubber",
    avatarUrl: avatarFor("hubber"),
    body: "Pushed a fix for the duplicate-name case. Mind another look?",
    url: "https://github.com/acme/widgets/pull/437",
    at: now - 4 * HOUR,
  },
];

/** What bb's sidebar would say about the fixture threads. */
const THREADS: Record<string, ThreadStatus> = {
  thr_fixture1: { id: "thr_fixture1", title: "Review the widget export retry change", live: "needs-you" },
  thr_fixture2: { id: "thr_fixture2", title: "Review the gadget picker rewrite", live: "done" },
};
const threadStatus = (id: string | null) => (id === null ? null : (THREADS[id] ?? null));

/** The panel's title bar, so a frame reads like the real panel. */
function Frame({
  listing,
  harvest = HARVEST_IDLE,
  starting = new Set(),
  height,
}: {
  listing: Listing | null;
  harvest?: HarvestState;
  starting?: Set<string>;
  /** Fixed for the loading and empty states; otherwise the frame fits its rows. */
  height?: string;
}): ReactNode {
  return (
    <TooltipProvider delayDuration={300}>
      <div className={`flex w-full flex-col rounded-lg border border-border bg-background ${height ?? ""}`}>
        <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
          <span className="flex items-center gap-2 text-sm font-medium">
            <Icon name="Eye" className="size-4 text-muted-foreground" />
            Reviews
          </span>
          <SyncStatus syncedAt={listing?.sweptAt ?? null} busy={false} onRefresh={noop} />
        </div>
        <div className="min-h-0 flex-1">
          <ReviewListView
            listing={listing}
            now={now}
            starting={starting}
            harvest={harvestFor(harvest)}
            onReview={noop}
            onOpen={noop}
            onArchive={noop}
            onSnooze={noop}
            onNoteSave={async () => true}
            onOpenLink={noop}
            loadFeedback={async () => ({ entries: FEEDBACK, error: null })}
            avatarFor={avatarFor}
            onBatch={noop}
            threadStatus={threadStatus}
          />
        </div>
      </div>
    </TooltipProvider>
  );
}

/**
 * A typical day. The one waited on too long, with its red banner, and the one
 * with a thread at the top; then the fresh request, with two new comments.
 */
export function Baseline() {
  return (
    <StoryCard>
      <StoryRow
        label="Baseline"
        hint="One waiting too long, one with a thread and a note, and a fresh one with two new comments."
      >
        <Frame listing={baseline} />
      </StoryRow>
    </StoryCard>
  );
}

/**
 * Every run the list can draw: re-review, with its blue banner, waiting too
 * long, and reviewing in Now; to review in Next; drafts in Later.
 * Every row is open, with the timer at the bottom right. The thread re-review
 * and the draft are layers of one stack, each with a chip saying where it
 * sits and what it is built on. Then the list across
 * two repositories, a thread being started with a timer running, and the panel
 * without Harvest.
 */
export function Rows() {
  return (
    <StoryCard>
      <StoryRow
        label="Every run"
        hint="Two re-reviews, one with a thread and one with failing checks; one waiting too long; one reviewing with a note; two to review, one with no other reviewers, no checks, and no project checked out; a draft; and a request snoozed for four days, closed to one line at the bottom. The re-review with a thread and the draft are in one stack."
      >
        <Frame listing={everything} />
      </StoryRow>
      <StoryRow label="Two repositories" hint="The repository joins the icons once it varies.">
        <Frame listing={multiRepo} />
      </StoryRow>
      <StoryRow
        label="Starting and timing"
        hint="A thread being created on #412, and a Harvest timer running on #425."
      >
        <Frame
          listing={baseline}
          harvest={{
            available: true,
            running: {
              externalId: "425",
              groupId: null,
              entryId: 1,
              startedAt: new Date(now - 25 * 60_000).toISOString(),
              projectName: "Widgets",
              taskName: "Code Review",
            },
          }}
          starting={new Set(["acme/widgets#412"])}
        />
      </StoryRow>
      <StoryRow label="Without Harvest" hint="No clock in the action line.">
        <Frame listing={baseline} harvest={{ available: false, running: null }} />
      </StoryRow>
    </StoryCard>
  );
}

/**
 * The drawer a row's comment count opens, on a pull request you are
 * reviewing. Your own threads stay in: the author's answer to one is marked
 * unanswered, and one nobody has answered yet waits on a reply. Resolved
 * threads wait behind "1 resolved". Then the drawer while it reads, and when
 * GitHub fails.
 */
export function CommentsDrawer() {
  const url = "https://github.com/acme/widgets/pull/437";
  const age = (at: number) => relativeTime(at, now);
  return (
    <StoryCard>
      <StoryRow label="Open" hint="What is on #437, your own threads included.">
        <div className="w-full max-w-3xl rounded-md border border-border bg-muted/40 px-3 py-2">
          <FeedbackList entries={FEEDBACK} age={age} url={url} Link={PlainLink} Markdown={Markdown} />
        </div>
      </StoryRow>
      <StoryRow label="Reading" hint="While the one request to GitHub runs.">
        <FeedbackDrawer load={() => new Promise(() => {})} age={age} url={url} Link={PlainLink} Markdown={Markdown} />
      </StoryRow>
      <StoryRow label="Failed" hint="GitHub could not be reached.">
        <FeedbackDrawer
          load={async () => ({ entries: [], error: "Could not read the comments from GitHub." })}
          age={age}
          url={url}
          Link={PlainLink}
          Markdown={Markdown}
        />
      </StoryRow>
    </StoryCard>
  );
}

/** Loading, empty, and the notices the panel shows above and below its rows. */
export function States() {
  const empty: Listing = { ...baseline, rows: [] };
  return (
    <StoryCard>
      <StoryRow label="Loading" hint="The first load, before the listing arrives.">
        <Frame listing={null} height="h-[26rem]" />
      </StoryRow>
      <StoryRow label="Empty" hint="Nothing waiting on you.">
        <Frame listing={empty} height="h-[26rem]" />
      </StoryRow>
      <StoryRow label="Empty, repositories hidden" hint="Requests exist in repositories with no project here.">
        <Frame listing={{ ...empty, skippedRepos: ["acme/gadgets"] }} height="h-[26rem]" />
      </StoryRow>
      <StoryRow label="Warnings" hint="A failed sweep, the search ceiling, and a hidden repository.">
        <Frame
          listing={{
            ...baseline,
            lastError: "gh exited 1: HTTP 502 from api.github.com",
            truncated: true,
            skippedRepos: ["acme/gadgets"],
          }}
        />
      </StoryRow>
    </StoryCard>
  );
}

const LONG_TITLES = [
  "WIP: widget bulk edit",
  "Draft: gadget webhooks v2",
  "Try a card layout for widgets",
  "Spike: gadget offline mode",
  "WIP: widget import from CSV",
  "Draft: split the gadget API client",
  "Explore widget tagging",
  "WIP: gadget usage charts",
];

/** Many snoozed requests, so the fold after five Later rows shows. */
const long: Listing = {
  ...baseline,
  rows: [
    ...baseline.rows,
    ...LONG_TITLES.map((title, index) =>
      row({
        number: 450 + index,
        title,
        snoozedUntil: addDaysTo(localDay(new Date(now)), 2 + index),
        author: index % 2 ? "hubber" : "octocat",
        requestedAt: now - (index + 1) * 11 * HOUR,
      }),
    ),
  ],
};

/**
 * A long list: the Now and Next rows at the top, then the first five Later
 * rows, with the rest folded into "N more".
 */
export function LongList() {
  return (
    <StoryCard>
      <StoryRow label="Long list" hint="Eight snoozed requests, one line each, three of them folded.">
        <Frame listing={long} />
      </StoryRow>
    </StoryCard>
  );
}

/** The requests Batch can start: those with no thread, and a project here. */
const batchRows = everything.rows.filter(canBatch);

/** Batch's dialog, drawn as its body so the story needs no overlay. */
function BatchFrame({ picked }: { picked: string[] }): ReactNode {
  return (
    <div className="max-w-full rounded-xl border border-border bg-background p-5 shadow-lg" style={{ width: "56rem" }}>
      <h2 className="text-base font-semibold">Start reviews</h2>
      <p className="mt-1 mb-4 text-sm text-muted-foreground">
        Tick the requests to review. Each starts in a new worktree, with the pull request named before its prompt and
        the rule against posting to GitHub after it.
      </p>
      <BatchPicker rows={batchRows} now={now} initialPicked={picked} onStart={async () => {}} onCancel={noop} />
    </div>
  );
}

/**
 * Batch, beside the summary squares, opens this dialog. Ticking a request
 * shows the prompt its review will start with, in a column to edit before
 * starting; clicking another ticked title shows its prompt instead.
 */
export function Batch() {
  return (
    <StoryCard>
      <StoryRow label="Two ticked" hint="The re-review was ticked last, so its prompt is the one shown.">
        <BatchFrame picked={["acme/widgets#412", "acme/widgets#398"]} />
      </StoryRow>
      <StoryRow label="Nothing ticked" hint="The column says what it is for, and Start is disabled.">
        <BatchFrame picked={[]} />
      </StoryRow>
    </StoryCard>
  );
}
