// The sync loop: what actually decorates bb's DOM and keeps it agreeing with
// bb's marks and GitHub's.
//
// This lives outside app.tsx so it can be driven under jsdom. Every bug this
// plugin has shipped was in here, and each one survived a green test run
// because the only tests were of pure functions and fixtures — the loop that
// wires them together was never exercised. `startEngine` takes its RPC,
// scheduler, and location as parameters for exactly that reason.
//
// bb draws the Viewed checkboxes and keeps the marks. This loop adds what bb
// does not: the count of viewed files in the toolbar, an icon on each file
// saying whether its mark reaches GitHub, and the sync itself, which runs on
// the server whenever the panel opens, the window regains focus, or a
// checkbox changes.
import {
  findToolbar,
  findViewedBoxes,
  paintSyncIcon,
  renderProgress,
  undecorate,
  type ControlMode,
  type ViewedBox,
} from "./dom";
import { readDiffFiles, rowOf, type DiffFilesRead } from "./files";
import { syncMode, type GithubState } from "./github";
import {
  countViewed,
  labelForEntry,
  threadIdFromPath,
  type DiffFileEntry,
  type DiffTarget,
  type ViewedMap,
} from "./marks";

export interface SyncInput {
  threadId: string;
  target: DiffTarget;
  files: DiffFileEntry[];
}

export interface SyncResult {
  /** bb's marks for the range once the sync has run. */
  viewed: ViewedMap;
  /** The thread's pull request, or null when nothing syncs. */
  github: GithubState | null;
}

export interface EngineDeps {
  /** Calls one of the plugin's RPC methods. */
  rpc: <Result>(method: string, input: unknown) => Promise<Result>;
  /** Aborted when the content script generation is torn down. */
  signal: AbortSignal;
  /** The document to decorate. */
  doc: Document;
  /** The current route, read fresh on every pass. */
  pathname: () => string;
  /** Defer a pass. Returns a cancel function. `requestAnimationFrame` in bb. */
  defer: (run: () => void) => () => void;
  /** Wait before syncing after a checkbox changes. Returns a cancel function. */
  delay: (run: () => void) => () => void;
  /** Where failures go. */
  warn: (cause: unknown) => void;
}

export interface Engine {
  /** Run a pass now, skipping the scheduler. Tests use this. */
  syncNow: () => void;
  /** Ask for a pass on the next frame. */
  schedule: () => void;
  /** Sync again, as when the window regains focus. */
  refresh: () => void;
  dispose: () => void;
}

interface Panel {
  threadId: string;
  target: DiffTarget;
  files: DiffFileEntry[];
  /** Thread, range, and every file's revision: what a sync answer is about. */
  key: string;
}

function panelKey(threadId: string, target: DiffTarget, files: readonly DiffFileEntry[]): string {
  return JSON.stringify([threadId, target, files.map((file) => [file.path, file.revision])]);
}

export function startEngine(deps: EngineDeps): Engine {
  const { rpc, signal, doc, pathname, defer, delay, warn } = deps;

  /** The panel as the last pass read it. */
  let panel: Panel | null = null;
  /** The last sync answer, and which panel it is about. */
  let answer: (SyncResult & { key: string }) | null = null;
  /**
   * The checkboxes that disagreed with `answer` when a sync was last asked
   * for. A box bb has not repainted yet keeps disagreeing, and this is what
   * stops that from asking again on every pass.
   */
  let askedFor = "";
  let running = false;
  let again = false;
  let cancelPass: (() => void) | null = null;
  let cancelDelay: (() => void) | null = null;
  // True while this engine is writing to the DOM, so the observer does not
  // treat its own edits as a reason to run again.
  let writing = false;
  // Problems already sent to the server log, so a broken read is logged once
  // per window rather than on every pass.
  const reported = new Set<string>();

  function schedule(): void {
    if (signal.aborted || cancelPass !== null) return;
    cancelPass = defer(() => {
      cancelPass = null;
      syncNow();
    });
  }

  function report(message: string): void {
    if (reported.has(message)) return;
    reported.add(message);
    warn(new Error(message));
    rpc("problem_report", { message }).catch(() => {});
  }

  /** Sync the panel as it is now. Overlapping requests run one after another. */
  function requestSync(): void {
    if (cancelDelay !== null) {
      cancelDelay();
      cancelDelay = null;
    }
    if (running) {
      again = true;
      return;
    }
    const current = panel;
    if (current === null || signal.aborted) return;
    running = true;
    const input: SyncInput = {
      threadId: current.threadId,
      target: current.target,
      files: current.files,
    };
    rpc<SyncResult>("viewed_sync", input)
      .then(
        (result) => {
          if (!signal.aborted) answer = { ...result, key: current.key };
        },
        (cause: unknown) => {
          warn(cause);
          // Without an answer, show bb's marks as bb's own rather than
          // waiting on GitHub forever.
          if (!signal.aborted && answer?.key !== current.key) {
            answer = { viewed: {}, github: null, key: current.key };
          }
        },
      )
      .finally(() => {
        running = false;
        if (signal.aborted) return;
        if (again) {
          again = false;
          requestSync();
        }
        schedule();
      });
  }

  /** Sync shortly, so a run of clicks goes to the server once. */
  function requestSyncSoon(): void {
    if (cancelDelay !== null) cancelDelay();
    cancelDelay = delay(() => {
      cancelDelay = null;
      requestSync();
    });
  }

  function readPanel(boxes: readonly ViewedBox[]): DiffFilesRead | null {
    const first = boxes[0];
    if (first === undefined) return null;
    const row = rowOf(first.box);
    return row === null
      ? { status: "unreadable", reason: "the card is not inside a [data-index] row" }
      : readDiffFiles(row);
  }

  function clear(): void {
    writing = true;
    try {
      undecorate(doc.body);
      renderProgress(doc, null);
    } finally {
      writing = false;
    }
  }

  function syncNow(): void {
    if (signal.aborted) return;
    const threadId = threadIdFromPath(pathname());
    // The toolbar's presence is the signal that the changes panel is open. The
    // card list below it has no container attribute, so there is nothing else
    // to test, and scanning the whole document on every pass would be wasteful
    // on the many screens that have no diff at all.
    if (threadId === null || findToolbar(doc) === null) {
      panel = null;
      clear();
      return;
    }

    const boxes = findViewedBoxes(doc);
    const read = readPanel(boxes);
    if (read === null) {
      // No card is rendered, so there is nothing to count from.
      writing = true;
      renderProgress(doc, null);
      writing = false;
      return;
    }
    if (read.status === "unreadable") {
      writing = true;
      renderProgress(doc, { kind: "unavailable", reason: read.reason });
      writing = false;
      report(`Could not read the changes panel's file list: ${read.reason}`);
      return;
    }

    const key = panelKey(threadId, read.target, read.files);
    const changed = panel?.key !== key;
    panel = { threadId, target: read.target, files: read.files, key };
    if (changed) {
      askedFor = "";
      requestSync();
    }

    const current = answer?.key === key ? answer : null;
    const byLabel = new Map(read.files.map((file) => [labelForEntry(file), file]));

    // What the boxes on screen say is newer than the last answer: a click
    // shows there before the server has heard about it. So they count over
    // the answer, and when they disagree with it, the server is told.
    const viewed: ViewedMap = { ...(current?.viewed ?? {}) };
    const disagreeing: string[] = [];
    for (const box of boxes) {
      const entry = byLabel.get(box.label);
      if (entry === undefined || box.disabled) continue;
      const known = current !== null && current.viewed[entry.path] === entry.revision;
      if (box.checked) viewed[entry.path] = entry.revision;
      else delete viewed[entry.path];
      if (current !== null && box.checked !== known) {
        disagreeing.push(`${entry.path}:${box.checked}`);
      }
    }
    const signature = disagreeing.join("\n");
    if (signature !== askedFor) {
      askedFor = signature;
      if (signature !== "") requestSyncSoon();
    }

    writing = true;
    try {
      for (const box of boxes) {
        const entry = byLabel.get(box.label);
        if (entry === undefined) continue;
        const mode: ControlMode =
          current === null ? { kind: "pending" } : syncMode(current.github, entry);
        paintSyncIcon(box, mode);
      }
      renderProgress(doc, {
        kind: "progress",
        ...countViewed(viewed, read.files),
        ...(current === null ? { pending: true } : {}),
      });
    } finally {
      writing = false;
    }
  }

  // bb re-renders constantly, so the decoration is re-applied from whatever the
  // DOM currently says rather than assumed to survive. Passes are deferred and
  // coalesced, and edits this engine makes itself are skipped. `data-state` is
  // how a Viewed checkbox changes, from a click here or a mark made elsewhere.
  const observer = new doc.defaultView!.MutationObserver(() => {
    if (writing) return;
    schedule();
  });
  observer.observe(doc.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-state", "aria-label", "disabled"],
  });

  schedule();

  return {
    syncNow,
    schedule,
    refresh() {
      askedFor = "";
      requestSync();
    },
    dispose() {
      observer.disconnect();
      if (cancelPass !== null) cancelPass();
      if (cancelDelay !== null) cancelDelay();
      cancelPass = null;
      cancelDelay = null;
      clear();
    },
  };
}
