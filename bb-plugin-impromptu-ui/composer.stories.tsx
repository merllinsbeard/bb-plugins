// A thread's view above its composer and in its side panel. Each story is a
// whole thread: the conversation, the banner in bb's own card, bb's
// Uncommitted row, bb's real composer, and the side panel beside it. Clicking
// a row opens that item in the panel, as it does in bb. Invented data.
import { useState, type ReactNode } from "react";
import type { PermissionMode, PromptTextMention, WorkspaceStatus } from "@bb/domain";
import { Markdown } from "@get-bb/plugin-sdk/app";
import { FollowUpPromptBox } from "@bb-app/components/promptbox/FollowUpPromptBox";
import "@bb-ladle/composer-plugin";
import { makeTypeaheadConfig } from "@bb-ladle/story-fixtures";
import { PromptStackCard } from "@bb-app/components/promptbox/banner/PromptStackCard";
import { ThreadPromptContextBanner } from "@bb-app/components/promptbox/banner/ThreadPromptContextBanner";
import { selectWorkspaceChangedFilesSection } from "@bb-app/components/workspace/workspace-change-summary";
import type { PickerOption } from "@bb-app/components/pickers/OptionPicker";
import { makeExecutionControlsProps, STORY_CLAUDE_CODE_MODELS, STORY_PROVIDER_OPTIONS } from "@bb-ladle/story-fixtures";
import { startsCollapsed, ViewBanner } from "./view/banner";
import { INLINE_REPLY_LABEL } from "./view/inline";
import nowRound0 from "./view/now-round/now-summary-0.webp?url";
import nowRound1 from "./view/now-round/now-summary-1.webp?url";
import nowRound2 from "./view/now-round/now-summary-2.webp?url";
import nowRound3 from "./view/now-round/now-summary-3.webp?url";
import nowRound4 from "./view/now-round/now-summary-4.webp?url";
import { inlineTwoView, inlineView, configAuditView, milestoneTriageView, dependabotConflictView, dependabotView, grantSectionThreads, grantSectionThreadsView, grantQuestionView, grantView, nowRoundView, reviewImages, reviewView, beforeAfterView, builtBeforeAfterView, reviewWithVerdictView, selfImproveView, refineScanView, threePrsView, staplesView, triageView } from "./view/fixtures";
import type { Feedback } from "./view/review";
import type { Item, View } from "./view/schema";
import { applyStatus, viewFor, type ItemRecord, type StoredView } from "./view/store";
import { firstOpenItem, ViewPanel, type LinkedThread } from "./view/view-panel";
import { ListPanel } from "./view/list-panel";
import { Stacked } from "./stacked";

export default {
  title: "impromptu-ui/Thread",
};

const noop = () => {};

/* -------------------------------------------------------------------------- */
/* The thread around the banner                                               */
/* -------------------------------------------------------------------------- */

type Turn =
  | { kind: "user"; text: string }
  | { kind: "work"; text: string }
  | { kind: "assistant"; text: string };

function Conversation({ turns }: { turns: Turn[] }) {
  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-6 py-6">
      {turns.map((turn, i) => {
        if (turn.kind === "user") {
          return (
            <div key={i} className="ml-auto max-w-[85%] rounded-2xl bg-muted px-4 py-2.5 text-sm text-foreground">
              {turn.text}
            </div>
          );
        }
        if (turn.kind === "work") {
          return (
            <div key={i} className="text-sm text-muted-foreground">
              {turn.text}
            </div>
          );
        }
        return (
          <div key={i} className="text-sm leading-relaxed text-foreground">
            <Markdown content={turn.text} />
          </div>
        );
      })}
    </div>
  );
}

const uncommitted: WorkspaceStatus = {
  workingTree: {
    state: "dirty",
    hasUncommittedChanges: true,
    files: [
      { path: "skills/triage/SKILL.md", status: "A", insertions: 118, deletions: 0 },
      { path: "skills/triage/findings.py", status: "A", insertions: 64, deletions: 0 },
    ],
    insertions: 182,
    deletions: 0,
    lineStatsComplete: true,
  },
  branch: { currentBranch: "main", defaultBranch: "main" },
  checkout: { kind: "branch", branchName: "main", headSha: null },
  mergeBase: null,
};
const uncommittedSection = selectWorkspaceChangedFilesSection(uncommitted);

function UncommittedRow() {
  if (!uncommittedSection) return null;
  return (
    <ThreadPromptContextBanner
      archivedSection={null}
      environmentGoneSection={null}
      gitSection={{ changedFiles: uncommittedSection, mergeBase: null, onPromptBannerFileClick: noop }}
      gitSectionPending={false}
      parentThreadSection={null}
      childThreadsSection={null}
      pullRequestSection={null}
      expandedSection={null}
      onToggleSection={noop}
    />
  );
}

const permissionOptions: readonly PickerOption<PermissionMode>[] = [
  { value: "accept-edits", label: "Accept Edits" },
  { value: "auto", label: "Approve for me" },
  { value: "full", label: "Full Access", tone: "warning" },
];

const baseExecution = makeExecutionControlsProps();
const execution = makeExecutionControlsProps({
  provider: { ...baseExecution.provider, options: STORY_PROVIDER_OPTIONS, selectedId: "claude-code" },
  model: { ...baseExecution.model, active: { model: "claude-sonnet-5" }, selected: "claude-sonnet-5", options: STORY_CLAUDE_CODE_MODELS },
});

function stored(view: View, items: Record<string, ItemRecord> = {}, id = 1, key = "default"): StoredView {
  // As the store reads it back: an agent-set status decides the item's state.
  return { id, threadId: "thr_story01", key, view, cwd: "/tmp", publishedAt: "2026-03-12T12:00:00Z", hiddenAt: null, items: applyStatus(view, items) };
}

/** Another view the thread published under its own key, under the first in the same card. */
function OtherViewBanner({ view, onOpenItem }: { view: StoredView; onOpenItem: (item: Item) => void }) {
  const [collapsedByUser, setCollapsedByUser] = useState<boolean | null>(null);
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  const collapsed = collapsedByUser ?? startsCollapsed(view);
  return (
    <ViewBanner
      stored={view}
      collapsed={collapsed}
      onToggle={() => setCollapsedByUser(!collapsed)}
      onHide={() => setHidden(true)}
      busyItem={null}
      focusedItem={null}
      onOpenItem={onOpenItem}
      onGoToThread={noop}
      onOpenView={noop}
    />
  );
}

/**
 * A thread at a typical window width with its side panel open: the
 * conversation scrolls, the banner, the Uncommitted row, and the composer sit
 * at the bottom, and the panel shows whichever item was clicked, or the first
 * open one before any is.
 */
function ThreadStage({
  turns,
  view: published,
  initialFocus = null,
  initialCollapsed,
  confirming,
  reviewInitial,
  currentThreadId,
  threads,
  others = [],
  chatOnly = false,
  height = 860,
  images = reviewImages,
}: {
  turns: Turn[];
  /** Only the chat and composer, as the thread looked before it published the view. */
  chatOnly?: boolean;
  view: StoredView;
  /** Views published under other keys, shown under the first. */
  others?: StoredView[];
  initialFocus?: string | null;
  initialCollapsed?: boolean;
  confirming?: string;
  reviewInitial?: Feedback;
  /** The thread on screen, when the view was published by another. */
  currentThreadId?: string;
  threads?: Record<string, LinkedThread>;
  /** The stage's height in pixels, raised when the open item's buttons sit below the default. */
  height?: number;
  /** The screenshots a visual review shows, in the order of its variations. */
  images?: string[];
}) {
  const [draft, setDraft] = useState("");
  const [mentions, setMentions] = useState<PromptTextMention[]>([]);
  const [focus, setFocus] = useState<string | null>(initialFocus);
  const [collapsedByUser, setCollapsedByUser] = useState<boolean | null>(initialCollapsed ?? null);
  const [hidden, setHidden] = useState(chatOnly);
  // A list view's buttons work here without a server: they mark rows done or skipped.
  const [items, setItems] = useState(published.items);
  const view = { ...published, items };
  const collapsed = collapsedByUser ?? startsCollapsed(view);
  const setItem = (item: Item, record: ItemRecord) => setItems((current) => ({ ...current, [item.id]: record }));
  // An inline view is answered above the composer and has no side panel.
  const panel = !chatOnly && view.view.layout !== "inline";
  return (
    <div className="flex w-[1320px] overflow-hidden border border-border bg-background" style={{ height }}>
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto">
        <Conversation turns={turns} />
      </div>
      <div className="chat-prompt-box mx-auto w-full max-w-[760px] px-6 pb-4">
        <FollowUpPromptBox
          attachments={{ items: [], projectId: "proj_demo", isAttaching: false, error: null, onAttachFiles: noop, onRemove: noop }}
          stack={
            <>
              {hidden && others.length === 0 ? null : (
              <PromptStackCard ariaLabel="impromptu-ui">
                <div className="divide-y divide-border">
                {hidden ? null : (
                <ViewBanner
                  stored={view}
                  collapsed={collapsed}
                  onToggle={() => setCollapsedByUser(!collapsed)}
                  onHide={() => setHidden(true)}
                  busyItem={null}
                  focusedItem={focus ?? firstOpenItem(view, currentThreadId)?.id ?? null}
                  onOpenItem={(item) => setFocus(item.id)}
                  onGoToThread={noop}
                  onOpenView={noop}
                  currentThreadId={currentThreadId}
                  onAnswer={(item, index) =>
                    setItem(item, { state: "done", result: { label: item.actions[index]!.label, at: "2026-03-12T12:07:00Z" } })
                  }
                  onReply={(item, text) => setItem(item, { state: "done", result: { label: INLINE_REPLY_LABEL, at: "2026-03-12T12:07:00Z", draft: text } })}
                />
                )}
                {others.map((other) => (
                  <OtherViewBanner key={other.id} view={other} onOpenItem={noop} />
                ))}
                </div>
              </PromptStackCard>
              )}
              <UncommittedRow />
            </>
          }
          composer={{
            history: { currentDraft: { text: draft, mentions, attachments: [] }, entries: [], onSelectEntry: noop },
            isFollowUpSubmitting: false,
            message: draft,
            mentionRanges: mentions,
            onChangeMessage: (text: string, next: PromptTextMention[]) => {
              setDraft(text);
              setMentions(next);
            },
            onModifierSubmit: noop,
            onSubmit: () => setDraft(""),
            compactPromptPlaceholder: "Ask for a follow-up",
            promptPlaceholder: "Ask for a follow-up. @ to mention files, folders, sections, or threads",
            canModifierSubmit: false,
            steerActiveThreadOnEnter: false,
            submitMode: { kind: "ready" },
            threadRuntimeDisplayStatus: "idle",
          }}
          environmentSummary={null}
          contextWindowUsage={null}
          execution={execution}
          permission={{ value: "full", options: permissionOptions, onChange: noop, supported: true }}
          promptActions={[]}
          typeahead={makeTypeaheadConfig()}
          collapseResetKey="thr_story"
        />
      </div>
    </div>
    {!panel ? null : (
    <aside className="w-[440px] shrink-0 border-l border-border">
      {view.view.layout === "list" ? (
        <ListPanel
          stored={view}
          busyItem={null}
          onRun={(item, index) =>
            setItem(item, { state: "done", result: { label: item.actions[index]!.label, at: "2026-03-12T12:07:00Z", exitCode: 0 } })
          }
          onDismiss={(item, dismissed) => setItem(item, { state: dismissed ? "dismissed" : "open", result: items[item.id]?.result ?? null })}
        />
      ) : (
        <ViewPanel
          stored={view}
          busyItem={null}
          focusItemId={focus}
          confirming={confirming}
          onRun={noop}
          onDismiss={noop}
          onGoToThread={noop}
          onStartThread={noop}
          onRunRelated={noop}
          onOpenItem={(item) => setFocus(item.id)}
          imageUrl={(_, index) => images[index] ?? null}
          reviewInitial={reviewInitial}
          currentThreadId={currentThreadId}
          threads={threads}
        />
      )}
    </aside>
    )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Triage                                                                     */
/* -------------------------------------------------------------------------- */

const triageTurns: Turn[] = [
  { kind: "user", text: "Triage milestone 4.2 in acme/widgets" },
  { kind: "work", text: "Read 3 issues, their timelines, and 4 linked pull requests" },
  {
    kind: "assistant",
    text: "Milestone 4.2 has **3 open issues**: one done and ready to close, one still needed, one duplicate. They're above the composer; click one to see its evidence and the drafted comment.",
  },
];

/** The view above the composer, before anything is opened. */
export function Triage() {
  return <ThreadStage turns={triageTurns} view={stored(triageView)} />;
}

/** A row clicked: the side panel shows that issue with its details and every button. */
export function TriageItemOpen() {
  return <ThreadStage turns={triageTurns} view={stored(triageView)} initialFocus="issue-101" />;
}

/** "Close only" is a command, so clicking it opens the item asking first. */
export function TriageConfirmCommand() {
  return <ThreadStage turns={triageTurns} view={stored(triageView)} initialFocus="issue-101" confirming="issue-101:2" />;
}

/** One issue closed: it moves to the bottom, under the two still open. */
export function TriageOneDone() {
  return (
    <ThreadStage
      turns={triageTurns}
      view={stored(triageView, {
        "issue-101": { state: "done", result: { label: "Post and close", at: "2026-03-12T12:05:00Z" } },
      })}
    />
  );
}

/** After acting: one closed, one opened as a thread, one dismissed. */
export function TriageAfter() {
  return (
    <ThreadStage
      turns={triageTurns}
      view={stored(triageView, {
        "issue-101": { state: "done", result: { label: "Post and close", at: "2026-03-12T12:05:00Z" } },
        "issue-117": { state: "done", result: { label: "Fix in a new thread", at: "2026-03-12T12:06:00Z", threadId: "thr_fix0117" } },
        "issue-123": { state: "dismissed", result: null },
      })}
      initialFocus="issue-117"
    />
  );
}

/** A command that failed: the row says so, and the panel shows the output. */
export function TriageFailed() {
  return (
    <ThreadStage
      turns={triageTurns}
      view={stored(triageView, {
        "issue-101": {
          state: "open",
          result: { label: "Close only", at: "2026-03-12T12:05:00Z", exitCode: 1, output: "GraphQL: Could not resolve to an issue with the number of 101." },
        },
      })}
      initialFocus="issue-101"
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Grocery staples, as a list in the side panel                               */
/* -------------------------------------------------------------------------- */

const staplesTurns: Turn[] = [
  { kind: "user", text: "What staples are missing from the grocery list?" },
  { kind: "work", text: "Read the staples list and 3 open Groceries tasks" },
  {
    kind: "assistant",
    text: "**4 staples** are due and not on the list. They're in the side panel with the list as it stands: Add or Skip each one.",
  },
];

/** A list view: one row above the composer previewing what is left and what is on the list, and the whole view in the side panel, each staple's name in a field to edit before Add. */
export function Staples() {
  return <ThreadStage turns={staplesTurns} view={stored(staplesView)} />;
}

/** After deciding: Oat milk added and moved into the list, Bananas skipped with Undo, and Brown rice failed with its error, ready to retry. */
export function StaplesAfter() {
  return (
    <ThreadStage
      turns={staplesTurns}
      view={stored(staplesView, {
        "oat-milk": { state: "done", result: { label: "Add", at: "2026-03-12T12:05:00Z", exitCode: 0, output: "Added: Oat milk" } },
        bananas: { state: "dismissed", result: null },
        rice: { state: "open", result: { label: "Add", at: "2026-03-12T12:06:30Z", exitCode: 1, output: 'Error: no project named "Groceries"' } },
      })}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Refine Impromptu UI                                                        */
/* -------------------------------------------------------------------------- */

const refineScanTurns: Turn[] = [
  { kind: "user", text: "Scan the last 2 days of threads for moments Impromptu UI missed." },
  { kind: "work", text: "Read 14 threads with 2 subagents" },
  {
    kind: "assistant",
    text: "Read **14 threads**. One moment is still waiting on you, and there are **3 ways** to stop the rest happening again. They're above the composer.",
  },
];

/** The refine-impromptu-ui skill's scan: a thread still waiting on an answer, and three fixes, each saying where it lands and how many threads showed it. */
export function RefineScan() {
  return <ThreadStage turns={refineScanTurns} view={stored(refineScanView)} />;
}

/** A fix opened: what goes wrong now, a real moment, and the exact edit to the instructions, with Make this edit. */
export function RefineScanItemOpen() {
  return <ThreadStage turns={refineScanTurns} view={stored(refineScanView)} initialFocus="pick-lists" />;
}

/* -------------------------------------------------------------------------- */
/* Self-improve                                                               */
/* -------------------------------------------------------------------------- */

const selfImproveTurns: Turn[] = [
  { kind: "user", text: "Review my threads from the past week and find what we could improve." },
  { kind: "work", text: "Collected 94 threads, ran 13 reviewers, merged 41 reports" },
  {
    kind: "assistant",
    text: "I found **5 changes** that would have saved you time, most important first. They're above the composer: open a thread for any you want fixed.",
  },
];

/** Five findings above the composer. */
export function SelfImprove() {
  return <ThreadStage turns={selfImproveTurns} view={stored(selfImproveView)} />;
}

/** A finding opened: the evidence and the task in the side panel. */
export function SelfImproveItemOpen() {
  return <ThreadStage turns={selfImproveTurns} view={stored(selfImproveView)} initialFocus="finding-1" />;
}

/** Collapsed to one line once two threads are open. */
export function SelfImproveCollapsed() {
  return (
    <ThreadStage
      turns={selfImproveTurns}
      initialCollapsed
      view={stored(selfImproveView, {
        "finding-1": { state: "done", result: { label: "Open thread", at: "t", threadId: "thr_imp0001" } },
        "finding-2": { state: "done", result: { label: "Open thread", at: "t", threadId: "thr_imp0002" } },
      })}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Dependabot                                                                 */
/* -------------------------------------------------------------------------- */

const dependabotTurns: Turn[] = [
  { kind: "user", text: "acme/widgets#412 is a Dependabot pull request. Assess it and draft a comment." },
  { kind: "work", text: "Read the PR, its changelog, and 3 files that use prettier" },
  {
    kind: "assistant",
    text: "Safe to merge: a dev-only patch bump whose one fix doesn't reach this repository. The assessment is above the composer, ready to post.",
  },
];

const dependabotAssessment = `## Assessment

**Scope:** \`devDependency\` only, in \`package.json\`. Prettier is not imported anywhere in the code. It runs from \`npm run format\` and the lint job, so it has no reach into what ships.

**Version jump:** patch, 3.6.1 to 3.6.2. Per the changelog, the only change is a fix for formatting decorators in class expressions.

**What changed:** acme/widgets has no decorators in class expressions, so the fix doesn't apply here.

**Blast radius:** formatting only. No build artifact depends on prettier.

**Verification performed locally:**
- \`npm run format -- --check\` is clean on the branch, so no files would be reformatted.
- \`npm run lint\` passes.

**CI:** 12 of 12 checks passing.

**Diff cleanliness:** clean, two files (\`package.json\`, \`package-lock.json\`), no unrelated changes.

**Verdict:** safe to merge.

Do you want me to post this on #412, approve it, and merge it? Or post it only?`;

const dependabotInChatTurns: Turn[] = [
  { kind: "user", text: "acme/widgets#412 is a Dependabot pull request. Assess it and draft a comment." },
  { kind: "work", text: "Read the PR, its changelog, and 3 files that use prettier" },
  { kind: "assistant", text: dependabotAssessment },
];

/** Before: the assessment written out in chat, ending in a question to answer by typing. */
export function DependabotInChat() {
  return <ThreadStage turns={dependabotInChatTurns} view={stored(dependabotView)} chatOnly />;
}

/** One pull request above the composer, with its main button. */
export function Dependabot() {
  return <ThreadStage turns={dependabotTurns} view={stored(dependabotView)} />;
}

/** The pull request opened: the evidence, the assessment to edit, and every button. */
export function DependabotItemOpen() {
  return <ThreadStage turns={dependabotTurns} view={stored(dependabotView)} initialFocus="pr-412" height={1220} />;
}

/** A conflicted bump: the rebase is the main button, and it asks before running. */
export function DependabotConflict() {
  return (
    <ThreadStage
      turns={[
        { kind: "user", text: "acme/widgets#418 is a Dependabot pull request. Assess it and draft a comment." },
        { kind: "work", text: "Read the PR, its changelog, and 14 files that use date-fns" },
        { kind: "assistant", text: "This one needs a rebase before it can merge. The assessment is above the composer." },
      ]}
      view={stored(dependabotConflictView)}
      initialFocus="pr-418"
      confirming="pr-418:0"
    />
  );
}

/**
 * After "Post, approve, and merge": with nothing left open, the list above the
 * composer collapses to its header, and the checkmark there hides it. The panel shows
 * the draft as posted.
 */
export function DependabotAfter() {
  return (
    <ThreadStage
      turns={dependabotTurns}
      view={stored(dependabotView, {
        "pr-412": { state: "done", result: { label: "Post, approve, and merge", at: "2026-03-12T12:05:00Z" } },
      })}
      initialFocus="pr-412"
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Visual review                                                              */
/* -------------------------------------------------------------------------- */

const reviewTurns: Turn[] = [
  { kind: "user", text: "These rows look kinda messy. How might we improve this?" },
  { kind: "work", text: "Built two variations in the story and took screenshots of each" },
  {
    kind: "assistant",
    text: "Too much color and dates that change shape from row to row. I've put the current rows and **2 directions** above the composer: pick one and note anything to change.",
  },
];

/** A fresh review: the original on top, two directions under it. */
export function VisualReview() {
  return <ThreadStage turns={reviewTurns} view={stored(reviewView)} />;
}

const beforeAfterTurns: Turn[] = [
  { kind: "user", text: "These rows look kinda messy. What would you change?" },
  { kind: "work", text: "Built the change in the story and took a screenshot before and after" },
  {
    kind: "assistant",
    text: "One change would do most of it: headings for Overdue and Today in place of a red date on every row. It's above the composer as **before and after**.",
  },
];

/** One proposed change: Before and After in the same place, flipped with the tabs or the arrow keys, and Build it to go ahead. */
export function BeforeAfter() {
  return <ThreadStage turns={beforeAfterTurns} view={stored(beforeAfterView)} />;
}

const builtTurns: Turn[] = [
  { kind: "user", text: "Group the rows under Overdue and Today." },
  { kind: "work", text: "Built the headings in the story and took a screenshot before and after" },
  { kind: "assistant", text: "The rows are grouped now. The screen as it was and as it is now are above the composer." },
];

/** Work already built, against the screen it replaced: Looks good to accept it, or a note on what to change. */
export function BeforeAfterBuilt() {
  return <ThreadStage turns={builtTurns} view={stored(builtBeforeAfterView)} initialFocus="rows-built" />;
}

/** After Build it: the row says so, and the panel keeps the note that went with it. */
export function BeforeAfterSent() {
  const feedback = { pick: 1, notes: ["", ""], overall: "Keep the overdue count in the heading" };
  return (
    <ThreadStage
      turns={beforeAfterTurns}
      view={stored(beforeAfterView, {
        "rows-sections": { state: "done", result: { label: "Send feedback", at: "2026-03-12T12:05:00Z", feedback } },
      })}
      initialFocus="rows-sections"
    />
  );
}

const verdictTurns: Turn[] = [
  { kind: "user", text: "Review acme/widgets#431." },
  { kind: "work", text: "Read the diff and ran the sync tests against it" },
  {
    kind: "assistant",
    text: "I'd request changes for the paging bug. **3 findings** are above the composer, then the verdict once you've been through them.",
  },
];

/** A review with its verdict as the closing step: under the findings rather than first. Opened early, it says what is left and its buttons wait. */
export function ClosingStepWaiting() {
  return <ThreadStage turns={verdictTurns} view={stored(reviewWithVerdictView)} initialFocus="verdict" />;
}

/** Every finding handled: the closing step opens, its summary tallies what was done, and its buttons work. */
export function ClosingStepReady() {
  const at = "2026-03-12T12:05:00Z";
  return (
    <ThreadStage
      turns={verdictTurns}
      view={stored(reviewWithVerdictView, {
        "finding-paging": { state: "done", result: { label: "Attach as draft comment", at } },
        "finding-retry": { state: "done", result: { label: "Attach as draft comment", at } },
        "finding-name": { state: "dismissed", result: null },
      })}
    />
  );
}

const nowRoundImages = [nowRound0, nowRound1, nowRound2, nowRound3, nowRound4];

const nowRoundTurns: Turn[] = [
  { kind: "user", text: "The Now page has no overview. How might we show what's waiting before I scroll?" },
  { kind: "work", text: "Built four directions in the Now story and took screenshots of each" },
  {
    kind: "assistant",
    text: "You can't see how much is urgent until you scroll. I've put the page as it is and **4 directions** for a summary above the composer: pick one and note anything to change.",
  },
];

/** Picking a design: four directions for a summary above the Now list, with one square per row picked. */
export function VisualReviewNowRound() {
  return (
    <ThreadStage
      turns={nowRoundTurns}
      view={stored(nowRoundView)}
      images={nowRoundImages}
      reviewInitial={{ pick: 4, notes: ["", "", "", "", "Keep the counts under each run"], overall: "" }}
    />
  );
}

/** One picked, with notes, ready to send. */
export function VisualReviewFilledIn() {
  return (
    <ThreadStage
      turns={reviewTurns}
      view={stored(reviewView)}
      reviewInitial={{ pick: 2, notes: ["", "Headings are good but too tall", "Keep the overdue date red"], overall: "" }}
    />
  );
}

/** After sending: the pick and notes stay as what was sent, and the row says which was picked. */
export function VisualReviewSent() {
  const feedback = { pick: 2, notes: ["", "Headings are good but too tall", "Keep the overdue date red"], overall: "" };
  return (
    <ThreadStage
      turns={reviewTurns}
      view={stored(reviewView, {
        "review-rows": { state: "done", result: { label: "Send feedback", at: "2026-03-12T12:05:00Z", feedback } },
      })}
      initialFocus="review-rows"
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Work in rounds                                                             */
/* -------------------------------------------------------------------------- */

const grantTurns: Turn[] = [
  { kind: "user", text: "Help me write the Acme Foundation Open Tools Fund application for acme/widgets." },
  { kind: "work", text: "Read the fund's guidelines and the application form" },
  { kind: "user", text: "Lead the Need section with who maintains it, not downloads." },
  { kind: "work", text: "Revised Need and counted its words" },
  { kind: "assistant", text: "**Round 2 of Need** leads with the two volunteer maintainers. It's 180 of 200 words." },
];

/** A piece of work in rounds: the header counts what the agent marked complete, and each row shows the status it set. */
export function Grant() {
  return <ThreadStage turns={grantTurns} view={stored(grantView)} initialFocus="need" />;
}

/** Two views at once: the grant, and a suggested answer the thread published under a key of its own. Each has its own header, count, collapse, and archive button. */
export function GrantWithQuestion() {
  return (
    <ThreadStage
      turns={grantTurns}
      view={stored(grantView)}
      others={[stored(grantQuestionView, {}, 2, "why-acme")]}
      initialFocus="need"
    />
  );
}

const sectionTurns: Turn[] = [
  { kind: "user", text: "Help me write the Acme Foundation Open Tools Fund application for acme/widgets." },
  { kind: "work", text: "Read the fund's guidelines and started a thread for each section" },
  { kind: "assistant", text: "Each section is drafted with you in its own thread. **Open thread** on a row goes there; Accept comes back here to write it in." },
];

const needTurns: Turn[] = [
  { kind: "user", text: "Draft the Need section of the Acme Foundation application with me." },
  { kind: "work", text: "Drafted Need and counted its words" },
  { kind: "assistant", text: "**Round 2 of Need** leads with the two volunteer maintainers. It's 180 of 200 words." },
];

/** Each section worked in a thread of its own: in the thread that published the view, a row's Open thread goes to that section's thread, and the side panel keeps the page map. */
export function GrantSectionThreads() {
  return <ThreadStage turns={sectionTurns} view={stored(grantSectionThreadsView)} currentThreadId="thr_story01" threads={grantSectionThreads} />;
}

/** The Need section's own thread: the same card above its composer and in its side panel, from the view the other thread published. Revise and the note stay here; Accept goes back. */
export function GrantSectionOwnThread() {
  return (
    <ThreadStage
      turns={needTurns}
      view={viewFor(stored(grantSectionThreadsView), "thr_need01")}
      currentThreadId="thr_need01"
      threads={grantSectionThreads}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Configuration audit                                                        */
/* -------------------------------------------------------------------------- */

const auditFindings = `I checked the Widgets Configuration Audit doc against current \`main\`. It has drifted: about 90 commits have landed since it was written. I haven't edited the doc.

## Must fix

1. **Delete the "Gadget previews" row.** The feature is gone. \`client/modules/gadget-preview/\` no longer exists. Removed in Remove gadget previews (#412). The Modules count drops from 9 to 8.
2. **Add Widget Home as a feature.** It is a public landing page for a team, listing its open and closed widgets.
   - Turned on by the \`widgetHomeEnabled\` team setting, which defaults to off.
   - Code: \`client/screens/widget-home.tsx\`. Added in Add Widget Home (#388).
3. **\`REPORTS_CAPABILITY\` no longer exists.** It was split into \`REPORTS_VIEW_CAPABILITY\` and \`REPORTS_MANAGE_CAPABILITY\` in #401. Two rows need updating:
   - The Admin page now uses VIEW.
   - The Reports page uses VIEW for the screen and MANAGE for changes.
4. **Setting defaults have moved.** Every "settings-map.ts stores X, defaulting to Y" claim now points to the wrong place. That covers about 8 rows.
   - The default values themselves are unchanged.
   - Defaults now live in \`server/settings.ts\`.
   - Moved in Serve settings from the database layer (#395).
5. **Environment variables:**
   - \`LOCAL_DEV\`, \`EMULATOR_HOST\` and \`CLOUD_PROJECT\` are no longer declared. Remove those rows.
   - Add \`WIDGETS_CONFIG_FILE\`, which names a JSON settings file. Added in #379.

## Should fix (inaccurate details)

- **sorterKey:** the row says it picks "which sorter a team uses", but nothing reads it. Sorting uses a hardcoded \`ACTIVE_SORTER\`. Worth an open question: wire it up or remove it?
- **Dashboard:** the tabs are Widgets, Gadgets, Reports and Settings. The per-user page is a subscreen, not a tab.
- **Environment variable wording:**
   - \`MAIL_PROVIDER\` and \`MAIL_PORT\` each state their default twice.
   - \`BASE_URL\` is optional, even though it sits under "Required".

## Worth adding

- A link from the Environment Variables section to \`docs/configuration.md\`, which has a stale line of its own: it lists \`MAIL_SENDER_ID\`, which doesn't exist.

Do you want me to make these edits in the doc directly, or would you rather apply them yourself?`;

const auditTurns: Turn[] = [
  { kind: "user", text: "Review the Widgets Configuration Audit doc for anything that's out of date." },
  { kind: "work", text: "Ran 3 subagents, explored 41 files" },
  { kind: "assistant", text: auditFindings },
];

const auditViewTurns: Turn[] = [
  { kind: "user", text: "use impromptu ui for the suggestions" },
  { kind: "work", text: "Ran 1 tool, ran 2 commands" },
  {
    kind: "assistant",
    text: "The 9 suggestions are above the composer, in three groups: 5 must fix, 3 should fix and 1 worth adding. Most show the doc's current text next to the proposed text, which you can edit before you press **Apply to doc**.",
  },
];

/** Before: the audit's findings written out in chat, to be answered by typing. */
export function ConfigAuditInChat() {
  return <ThreadStage turns={auditTurns} view={stored(configAuditView)} chatOnly />;
}

/** After: the same findings as rows above the composer, one open in the side panel with the doc's text next to the edit. */
export function ConfigAuditItemOpen() {
  return <ThreadStage turns={auditViewTurns} view={stored(configAuditView)} initialFocus="reports-capability" />;
}

/* -------------------------------------------------------------------------- */
/* Milestone triage                                                           */
/* -------------------------------------------------------------------------- */

const milestoneDrafts = `I've triaged all 13 open issues in the Gadget Embed milestone. Here is a draft comment for each. Nothing has been posted yet.

**#313 Translate gadget titles in the embed** (close, completed)

> This is fixed. The embed no longer reads the old metadata endpoint, and the v2 gadget read (#518) returns the title's translations, which the embed picks from by the reader's locale.
> - Seeded and real gadget titles translate: done in #518
> - The old endpoint returning translations: no longer needed, since nothing calls it

**#429 Share one stylesheet between the embed and the app** (close, completed)

> This is done. #540 moved the embed and the app onto the same theme tokens, so a color change in the theme now reaches both.
> - Shared colors: done in #540
> - Shared spacing: done in #540
> - The embed's own copy of the palette: deleted in #540

**#310 Decide which embed styles we support** (close, duplicate of #320)

> Closing as a duplicate of #320, where the design discussion on which embed styles to keep is happening. The list of styles from this issue is copied there.

**#311 Decide how partner colors are managed** (close, duplicate of #619)

> Closing as a duplicate of #619, which handles partner colors as part of the theme work.

**#308 Serve the new embed at the existing /embed URL** (keep open, question)

> Status: still open, and it's the last step before partners switch. In May we said we'd choose between a redirect and serving the new embed directly at the end of the project. Which do we want?

**#320 Design the default embed** (keep open, question)

> Status: the embed ships one style today. Before we build more, we need a direction for the default.

…and 7 more. Which should I post, and which should I close?`;

const milestoneTurns: Turn[] = [
  { kind: "user", text: "Triage each of the open issues" },
  { kind: "work", text: "Ran 4 subagents, explored 1 list, ran 2 commands" },
];

/** Before: thirteen draft comments written out in chat, one after another. */
export function MilestoneTriageInChat() {
  return <ThreadStage turns={[...milestoneTurns, { kind: "assistant", text: milestoneDrafts }]} view={stored(milestoneTriageView)} chatOnly />;
}

/** After: the same thirteen issues grouped by outcome above the composer, one open with its comment and buttons. */
export function MilestoneTriageItemOpen() {
  return (
    <ThreadStage
      turns={[
        ...milestoneTurns,
        { kind: "assistant", text: "I've triaged all 13 open issues in the Gadget Embed milestone. Each one is above the composer with its draft comment, grouped by outcome. Nothing has been posted yet." },
      ]}
      view={stored(milestoneTriageView)}
      initialFocus="issue-429"
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Three PRs at once                                                          */
/* -------------------------------------------------------------------------- */

const threePrsRequest: Turn[] = [
  { kind: "user", text: "Two separate PRs to fix the issues in this comment: https://github.com/acme/widgets/issues/2318#issuecomment-1" },
  { kind: "user", text: "Actually, three:\n1. Invites\n2. Demo accounts\n3. Docs" },
  { kind: "work", text: "Ran 8 commands, explored 9 files, 6 searches" },
];

const threePrsInChat = `I've made the three fixes from the comment, each on its own branch in its own worktree. All three are uncommitted, and each has a drafted PR description.

1. **Invites** (\`invite-as-viewer\`, this worktree): members invited without a role now start as Viewer instead of Maintainer. Tests, lint and typecheck pass.
2. **Demo accounts** (\`seed-retired-roles\`, in \`../widgets-seed-retired-roles\`): I removed the three demo accounts whose only role is one we are retiring.
   - **Decision for you:** I removed them rather than moving them to current roles, because every current role already has a demo account.
   - Server tests, lint and typecheck pass.
3. **Docs** (\`docs-permissions-accuracy\`, in \`../widgets-docs-permissions-accuracy\`): I removed the "Permission groups" section, because each role in the code lists its own permissions and nothing inherits.

Check the testing steps in each draft before opening the PRs:
- pull-request-invite-as-viewer.md
- pull-request-seed-retired-roles.md
- pull-request-docs-permissions-accuracy.md

Which should I open?`;

const threePrsTurns: Turn[] = [
  ...threePrsRequest,
  { kind: "assistant", text: "I've made the three fixes, each uncommitted in its own worktree with its PR description drafted. They're above the composer; each card's button commits, pushes, and opens that PR." },
  { kind: "user", text: "Only Owners and Maintainers can open this screen.\n\nWe should probably drop Maintainers, since that role is going away soon." },
  { kind: "work", text: "Ran 2 commands" },
  {
    kind: "assistant",
    text: `I've dropped Maintainers from the three places in the guide that say who can open Team Settings:

- **Intro:** "available to Owners and Maintainers" is now "available to Owners."
- **Members section:** "**Assign roles** stays with Owners and Maintainers" is now "stays with Owners."
- **Assigning roles:** "Owners can open it. From there, an Owner can add..."

I left out "Only" in the last one. Members who still hold Maintainer can open the screen until that role is removed, so "Only Owners" wouldn't be true yet.

I've updated the draft to match, and its card above the composer shows the new diff. The change is still uncommitted.`,
  },
];

/** Before, three finished fixes written out in chat, each opened by typing which one. After, one card per pull request, each with its diff and a button that commits, pushes, and opens it: the first is already open, and the demo accounts fix is open in the side panel. */
export function ThreePrsAtOnce() {
  return (
    <Stacked
      before={<ThreadStage turns={[...threePrsRequest, { kind: "assistant", text: threePrsInChat }]} view={stored(threePrsView)} chatOnly />}
      after={
        <ThreadStage
          turns={threePrsTurns}
          view={stored(threePrsView, {
            "invite-viewer": { state: "done", result: { label: "Commit, push, and open PR", at: "2026-03-12T12:05:00Z" } },
          })}
          initialFocus="demo-accounts"
        />
      }
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Inline: one question, answered above the composer                          */
/* -------------------------------------------------------------------------- */

const inlineTurns: Turn[] = [
  { kind: "user", text: "Fix the failing check on acme/widgets#412" },
  { kind: "work", text: "Read the check run, its job log, and the snapshot diff" },
  {
    kind: "assistant",
    text: "The one failing check is **Run web tests**. The new tabs work; the snapshot just wasn't updated for them. Both failing snapshots have the same diff: 10 added lines and nothing removed.\n\nI'd update the snapshots, re-run the suite, then commit and push. How to go ahead is above the composer.",
  },
];

/** A question with its answers right above the composer. Hover an answer for what it does, or type something else. */
export function InlineQuestion() {
  return <ThreadStage turns={inlineTurns} view={stored(inlineView)} height={640} />;
}

/** Answered: the buttons give way to a green banner with the answer sent. */
export function InlineAnswered() {
  return (
    <ThreadStage
      turns={inlineTurns}
      view={stored(inlineView, { snapshot: { state: "done", result: { label: "Update, commit, and push", at: "2026-03-12T12:07:00Z" } } })}
      height={640}
    />
  );
}

/** Answered in the user's own words, from the field under the buttons. */
export function InlineAnsweredInOwnWords() {
  return (
    <ThreadStage
      turns={inlineTurns}
      view={stored(inlineView, { snapshot: { state: "done", result: { label: INLINE_REPLY_LABEL, at: "2026-03-12T12:07:00Z", draft: "Update them, but push to a new branch" } } })}
      height={640}
    />
  );
}

/** A send that failed: red over the buttons, which stay so the answer can be sent again. */
export function InlineFailed() {
  return (
    <ThreadStage
      turns={inlineTurns}
      view={stored(inlineView, {
        snapshot: { state: "open", result: { label: "Update, commit, and push", at: "2026-03-12T12:07:00Z", error: "The thread is archived. Unarchive it and try again." } },
      })}
      height={680}
    />
  );
}

const inlineTwoTurns: Turn[] = [
  { kind: "user", text: "Make the widget list open faster" },
  { kind: "work", text: "Edited 9 files, ran the tests, timed the page" },
  {
    kind: "assistant",
    text: "The widget list now opens on the rows it showed last time, in 48 ms instead of 340 ms, and the slow part loads after the rows are drawn. The tests pass.\n\nNothing is committed yet. Two questions are above the composer.",
  },
];

/** Two questions in one view, the first answered. */
export function InlineTwoQuestions() {
  return (
    <ThreadStage
      turns={inlineTwoTurns}
      view={stored(inlineTwoView, { commit: { state: "done", result: { label: "2 commits, push, and capture", at: "2026-03-12T12:07:00Z" } } })}
      height={720}
    />
  );
}
