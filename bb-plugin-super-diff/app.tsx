// Replaces the Diff tab's virtualized file list with Super Diff's own
// grouped list, built from bb's diff API, while keeping the card DOM shape Diff
// Viewed and Diff Comment look for. The grouping, explanations, and notes are
// written by the thread's agent (Generate asks it) and stored by the server.
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { definePluginApp, experimental_Diff as Diff } from "@get-bb/plugin-sdk/app";
import { ExplainTrigger, NoteRows, NotesBox, placeNotes, scrollToNote, type PlacedNote } from "./annotations";
import { SuperDiffRow, type ConcernLink, type Explaining, type Loaded, type ThreadState } from "./row";
import { ConcernHeader } from "./concern";
import {
  GENERATED_TITLE,
  UNGROUPED_TITLE,
  changedPaths,
  isPlacedByRule,
  targetKey,
  type DiffFile as FileEntry,
  type DiffTarget as Target,
  type StoredSuperDiff,
} from "./grouping";

const REPLACED_ATTR = "data-super-diff-replaced";
const HOST_ATTR = "data-super-diff-host";
const ROW_ATTR = "data-super-diff-row";
const TOOLBAR = '[data-testid="git-diff-toolbar-actions"]';
const SELECTOR_SLOT = '[data-testid="git-diff-toolbar-selector-slot"]';
const SUMMARY = '[data-testid="git-diff-toolbar-summary"]';
const LAYOUT = '[data-testid="git-diff-toolbar-layout"]';
const TIMELINE = "[data-timeline-file-diff]";
const PATCH_BATCH = 50;
const POLL_MS = 2000;

const STYLE = `[${REPLACED_ATTR}] { display: none !important; }`;

type Group = {
  kind: "concern" | "generated" | "ungrouped";
  title: string;
  explanation: string;
  files: FileEntry[];
  summaries?: Record<string, string>;
  others?: string;
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    credentials: "same-origin",
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`${path} failed (${response.status})`);
  return (await response.json()) as T;
}

/** The plugin's own RPC route; a content script has no `useRpc`. */
async function callRpc<T>(pluginId: string, method: string, input: unknown): Promise<T> {
  const response = await fetch(`/api/v1/plugins/${encodeURIComponent(pluginId)}/rpc/${encodeURIComponent(method)}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json().catch(() => null)) as { ok?: boolean; result?: T } | null;
  if (!response.ok || body?.ok !== true || body.result === undefined) throw new Error(`${method} failed (${response.status})`);
  return body.result;
}

function threadIdFromPath(pathname: string): string | null {
  const match = /\/threads\/([^/?#]+)/.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/** The toolbar's diff picker label: "All changes", "Committed changes", ... */
function readSelection(toolbarRoot: ParentNode): string {
  return toolbarRoot.querySelector(SELECTOR_SLOT)?.textContent?.trim() ?? "";
}

type DiffContext = { environmentId: string; target: Target };

/** The thread's environment and the diff target the picker shows, or why Super Diff can't use it. */
async function resolveContext(threadId: string, selection: string): Promise<DiffContext | string> {
  const thread = await api<{ environmentId: string | null }>(`/threads/${threadId}`);
  if (thread.environmentId === null) return "This thread has no environment to diff.";
  if (/uncommitted/i.test(selection)) return { environmentId: thread.environmentId, target: { type: "uncommitted" } };
  const env = await api<{ mergeBaseBranch: string | null; baseBranch: string | null; defaultBranch: string | null }>(
    `/environments/${thread.environmentId}`,
  );
  const mergeBaseBranch = env.mergeBaseBranch ?? env.baseBranch ?? env.defaultBranch;
  if (mergeBaseBranch === null) return "This environment has no base branch to compare against.";
  if (/committed/i.test(selection)) return { environmentId: thread.environmentId, target: { type: "branch_committed", mergeBaseBranch } };
  if (/all changes/i.test(selection) || selection === "") return { environmentId: thread.environmentId, target: { type: "all", mergeBaseBranch } };
  return "The prototype can't group a single commit yet. Pick All changes.";
}

async function loadDiff({ environmentId, target }: DiffContext): Promise<Loaded> {
  const query =
    target.type === "uncommitted"
      ? "target=uncommitted"
      : `target=${target.type}&mergeBaseBranch=${encodeURIComponent(target.mergeBaseBranch)}`;
  const listing = await api<{ files: FileEntry[] }>(`/environments/${environmentId}/diff/files?${query}`);
  const patches = new Map<string, string>();
  const loadable = listing.files.filter((file) => file.loadMode !== "too_large").map((file) => file.path);
  for (let start = 0; start < loadable.length; start += PATCH_BATCH) {
    const result = await api<{ patches: { path: string; patch: string }[] }>(`/environments/${environmentId}/diff/patch`, {
      method: "POST",
      body: JSON.stringify({ target, paths: loadable.slice(start, start + PATCH_BATCH) }),
    });
    for (const entry of result.patches) patches.set(entry.path, entry.patch);
  }
  return { files: listing.files, patches, target };
}

/**
 * The agent's concerns, in its order, holding the files still on the diff;
 * then Generated files; then any file no concern holds, so every file on the
 * diff is shown exactly once.
 */
function buildGroups(stored: StoredSuperDiff, files: FileEntry[]): Group[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const shown = new Set<string>();
  const groups: Group[] = [];
  for (const concern of stored.submission.concerns) {
    const present = concern.files.map((path) => byPath.get(path)).filter((file): file is FileEntry => file !== undefined && !shown.has(file.path));
    present.forEach((file) => shown.add(file.path));
    if (present.length > 0) {
      groups.push({ kind: "concern", title: concern.title, explanation: concern.explanation, files: present, summaries: concern.summaries, others: concern.others });
    }
  }
  const generated = files.filter((file) => !shown.has(file.path) && isPlacedByRule(file));
  generated.forEach((file) => shown.add(file.path));
  if (generated.length > 0) {
    groups.push({ kind: "generated", title: GENERATED_TITLE, explanation: "Lockfiles, snapshots, binary files, and files too large to show. Placed by rule.", files: generated });
  }
  const ungrouped = files.filter((file) => !shown.has(file.path));
  if (ungrouped.length > 0) {
    groups.push({ kind: "ungrouped", title: UNGROUPED_TITLE, explanation: "Changed since the Super Diff was generated.", files: ungrouped });
  }
  return groups;
}

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return <pre className="px-3 py-2 text-xs text-destructive">Super Diff: {this.state.error.message}</pre>;
    }
    return this.props.children;
  }
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5 shrink-0 transition-transform duration-150"
      style={{ transform: open ? "rotate(90deg)" : undefined }}
      aria-hidden
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

/**
 * One file, in the DOM shape of bb's DiffFileCard: Diff Viewed resolves a card
 * from a `justify-between` row of exactly two children whose first child's
 * first child is the `aria-expanded` toggle, and Diff Comment walks up from
 * `diffs-container` to the nearest such toggle for the path.
 */
function FileCard({
  file,
  index,
  patch,
  split,
  wrap,
  notes,
  highlightId,
  collapsed,
  setCollapsed,
  onExplain,
}: {
  file: FileEntry;
  index: number;
  patch: string | undefined;
  split: boolean;
  wrap: boolean;
  notes: PlacedNote[];
  highlightId: string | null;
  collapsed: boolean;
  setCollapsed: (path: string, collapsed: boolean) => void;
  onExplain: (path: string, line: number, text: string) => void;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const explain = useCallback((line: number, text: string) => onExplain(file.path, line, text), [onExplain, file.path]);
  const label = file.previousPath && file.previousPath !== file.path ? `${file.previousPath} -> ${file.path}` : file.path;
  return (
    <div data-index={index} style={{ paddingBottom: 8 }}>
      <div className="overflow-clip rounded-lg border border-border bg-background">
        <div
          className={`sticky top-0 z-30 -mt-px border-t border-border rounded-lg bg-background py-1.5 pl-2 pr-3 text-xs font-medium text-foreground ${collapsed ? "" : "rounded-b-none"}`}
        >
          <div className="flex w-full min-w-0 items-center justify-between gap-2">
            <span className="flex min-w-0 items-center">
              <button
                type="button"
                className="inline-flex w-8 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => setCollapsed(file.path, !collapsed)}
                aria-label={`${collapsed ? "Expand" : "Collapse"} ${label}`}
                aria-expanded={!collapsed}
              >
                <Chevron open={!collapsed} />
              </button>
              <span className="flex min-w-0 items-center gap-1.5 pl-[1ch]">
                <span className="truncate font-mono font-medium text-foreground">{label}</span>
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1">
              <span className="whitespace-nowrap text-xs">
                <span className="text-diff-added">+{file.additions}</span>{" "}
                <span className="text-diff-removed">-{file.deletions}</span>
              </span>
            </span>
          </div>
        </div>
        {collapsed ? null : patch !== undefined ? (
          <Boundary>
            <div ref={bodyRef}>
              <Diff patch={patch} path={file.path} view={split ? "split" : "unified"} overflow={wrap ? "wrap" : "scroll"} />
              <NoteRows containerRef={bodyRef} notes={notes} highlightId={highlightId} />
              <ExplainTrigger containerRef={bodyRef} onExplain={explain} />
            </div>
          </Boundary>
        ) : (
          <div className="px-3 py-3 text-xs text-muted-foreground">
            {file.binary ? "Binary file." : file.loadMode === "too_large" ? "Too large to show here." : "Loading…"}
          </div>
        )}
      </div>
    </div>
  );
}

/** The card shown under a line while an Explain this fork writes its note. */
function explainingNote(entry: Explaining): PlacedNote {
  return {
    id: `explaining-${entry.line}`,
    n: 0,
    path: entry.path,
    anchor: "",
    line: entry.line,
    pending: true,
    title: `Explaining line ${entry.line}…`,
    body: "A hidden side chat of this thread is reading the change. The note appears here when it is written, usually within a couple of minutes.",
  };
}

/** How the list tells the row (a separate React root) what to list, and lets it jump. */
type Nav = {
  report: (links: ConcernLink[], current: number) => void;
  jump: { current: ((index: number) => void) | null };
};

/**
 * Which cards are collapsed, kept outside the list so it survives the list
 * remounting (switching to Original and back), as bb keeps its own cards'.
 * `autoCollapsed` holds the viewed files already folded once, so a viewed
 * file you reopen stays open. Keys carry the file's line counts, so a file
 * that changes since is folded again once it is marked viewed again.
 */
type CardMemory = { collapsed: Set<string>; autoCollapsed: Set<string> };

const cardKey = (file: FileEntry) => `${file.path} +${file.additions} -${file.deletions}`;

function GroupedList({
  data,
  stored,
  split,
  wrap,
  nav,
  memory,
  explaining,
  onExplain,
}: {
  data: Loaded;
  stored: StoredSuperDiff;
  split: boolean;
  wrap: boolean;
  nav: Nav;
  memory: CardMemory;
  explaining: Explaining[];
  onExplain: (path: string, line: number, text: string) => void;
}) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const groups = useMemo(() => buildGroups(stored, data.files), [stored, data]);
  const notes = useMemo(() => {
    const order = groups.flatMap((group) => group.files.map((file) => file.path));
    const fromAgent = stored.submission.annotations.map((note, index) => ({ ...note, id: `note-${index}` }));
    return placeNotes(fromAgent, order, data.patches);
  }, [stored, data, groups]);

  // Each note is listed under the group its file is in. A note whose file
  // has left the diff goes with the concern the agent put that file in, or
  // the last group when that concern has no files left either.
  const notesByGroup = useMemo(() => {
    const lists = groups.map((): PlacedNote[] => []);
    for (const note of notes) {
      let at = groups.findIndex((group) => group.files.some((file) => file.path === note.path));
      if (at === -1) {
        const concern = stored.submission.concerns.find((c) => c.files.includes(note.path));
        at = concern === undefined ? -1 : groups.findIndex((group) => group.kind === "concern" && group.title === concern.title);
      }
      lists[at === -1 ? lists.length - 1 : at]?.push(note);
    }
    return lists;
  }, [groups, notes, stored]);

  // Diff Viewed marks a viewed card's header row with data-diff-viewed="true".
  // null while Diff Viewed is not decorating these cards, so no counts show.
  const [viewed, setViewed] = useState<ReadonlySet<string> | null>(null);
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (wrapper === null) return;
    const read = () => {
      if (wrapper.querySelector("label[data-diff-viewed-owned]") === null) {
        setViewed((previous) => (previous === null ? previous : null));
        return;
      }
      const next = new Set<string>();
      for (const row of wrapper.querySelectorAll("[data-index]")) {
        if (row.querySelector('[data-diff-viewed="true"]') === null) continue;
        const label = row.querySelector("button[aria-expanded]")?.getAttribute("aria-label") ?? "";
        next.add(label.replace(/^(Collapse|Expand) /, ""));
      }
      setViewed((previous) =>
        previous !== null && previous.size === next.size && [...next].every((path) => previous.has(path)) ? previous : next,
      );
    };
    const observer = new MutationObserver(read);
    observer.observe(wrapper, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-diff-viewed"] });
    read();
    return () => observer.disconnect();
  }, []);

  // Diff Viewed folds a viewed file once per thread by clicking its toggle,
  // and never again, which leaves cards this list creates afterwards open.
  // So the list folds a file itself the first time it shows as viewed.
  const [collapsed, setCollapsedState] = useState<ReadonlySet<string>>(() => new Set(memory.collapsed));
  const setCollapsed = (path: string, value: boolean) => {
    const file = data.files.find((entry) => entry.path === path);
    if (file === undefined) return;
    const key = cardKey(file);
    if (value) memory.collapsed.add(key);
    else memory.collapsed.delete(key);
    setCollapsedState(new Set(memory.collapsed));
  };
  useEffect(() => {
    if (viewed === null) return;
    let changed = false;
    for (const file of data.files) {
      const key = cardKey(file);
      if (!viewed.has(file.path) || memory.autoCollapsed.has(key)) continue;
      memory.autoCollapsed.add(key);
      if (!memory.collapsed.has(key)) {
        memory.collapsed.add(key);
        changed = true;
      }
    }
    if (changed) setCollapsedState(new Set(memory.collapsed));
  }, [viewed, data, memory]);

  const changed = useMemo(() => changedPaths(stored, data.patches), [stored, data]);

  const links = useMemo(() => {
    let number = 0;
    return groups.map(
      (group): ConcernLink => ({
        number: group.kind === "concern" ? ++number : null,
        title: group.title,
        viewed: viewed === null ? null : group.files.filter((file) => viewed.has(file.path)).length,
        total: group.files.length,
        changed: group.files.filter((file) => changed.has(file.path)).length,
      }),
    );
  }, [groups, viewed, changed]);

  // The section at the top of the scroller, for the row to highlight. Sections
  // are few, so reading their positions once per scrolled frame is cheap.
  const [current, setCurrent] = useState(0);
  useEffect(() => {
    const scroller = wrapperRef.current?.closest<HTMLElement>(`[${HOST_ATTR}]`);
    if (!scroller) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const top = scroller.getBoundingClientRect().top + 24;
      let at = 0;
      scroller.querySelectorAll<HTMLElement>("[data-super-diff-section]").forEach((section, index) => {
        if (section.getBoundingClientRect().top <= top) at = index;
      });
      setCurrent(at);
    };
    const onScroll = () => {
      if (frame === 0) frame = window.requestAnimationFrame(read);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    read();
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [groups]);

  useEffect(() => nav.report(links, current), [nav, links, current]);
  useEffect(() => {
    nav.jump.current = (index: number) => {
      const scroller = wrapperRef.current?.closest<HTMLElement>(`[${HOST_ATTR}]`);
      const section = scroller?.querySelectorAll<HTMLElement>("[data-super-diff-section]")[index];
      if (!scroller || !section) return;
      scroller.scrollTop += section.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    };
    return () => {
      nav.jump.current = null;
    };
  }, [nav]);

  const jumpToFile = (path: string) => {
    const scroller = wrapperRef.current?.closest<HTMLElement>(`[${HOST_ATTR}]`);
    const toggle = [...(wrapperRef.current?.querySelectorAll("[data-index] button[aria-expanded]") ?? [])].find(
      (button) => button.getAttribute("aria-label")?.replace(/^(Collapse|Expand) /, "") === path,
    );
    const row = toggle?.closest("[data-index]");
    if (!scroller || !row) return;
    scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8;
  };

  const jump = (id: string) => {
    // A note in a collapsed file opens the file first.
    const note = notes.find((entry) => entry.id === id);
    if (note !== undefined) setCollapsed(note.path, false);
    setHighlightId(id);
    const scroller = wrapperRef.current?.closest<HTMLElement>(`[${HOST_ATTR}]`);
    if (!scroller) return;
    // A collapsed file opens first, so its card may take a few frames to appear.
    let tries = 0;
    const attempt = () => {
      if (!scrollToNote(scroller, id) && tries++ < 20) window.requestAnimationFrame(attempt);
    };
    attempt();
  };
  useEffect(() => {
    if (highlightId === null) return;
    const timer = window.setTimeout(() => setHighlightId(null), 1600);
    return () => window.clearTimeout(timer);
  }, [highlightId]);

  let index = 0;
  let concernNumber = 0;
  return (
    <div ref={wrapperRef}>
      <FilesProps files={data.files} target={data.target}>
        {groups.map((group, groupIndex) => (
          <section key={`${group.kind}:${group.title}`} data-super-diff-section="">
            <ConcernHeader
              number={group.kind === "concern" ? ++concernNumber : null}
              first={groupIndex === 0}
              title={group.title}
              explanation={group.explanation}
              files={group.files.map((file) => ({ path: file.path, summary: group.summaries?.[file.path] }))}
              others={group.others}
              showList={group.kind === "concern"}
              viewed={viewed}
              onJump={jumpToFile}
              changed={changed}
            >
              <NotesBox notes={notesByGroup[groupIndex] ?? []} onJump={jump} />
            </ConcernHeader>
            {group.files.map((file) => (
              <FileCard
                key={file.path}
                file={file}
                index={index++}
                patch={data.patches.get(file.path)}
                split={split}
                wrap={wrap}
                notes={[
                  ...notes.filter((note) => note.path === file.path),
                  ...explaining.filter((entry) => entry.path === file.path).map(explainingNote),
                ]}
                highlightId={highlightId}
                collapsed={collapsed.has(cardKey(file))}
                setCollapsed={setCollapsed}
                onExplain={onExplain}
              />
            ))}
          </section>
        ))}
      </FilesProps>
    </div>
  );
}

/**
 * Diff Viewed counts progress from a `files` (and `target`) prop it finds by
 * walking React fibers up from a `[data-index]` row, which is where bb's own
 * DiffFilesPanel keeps them. Carrying the same props here keeps that working.
 */
function FilesProps({ children }: { files: FileEntry[]; target: Target; children: ReactNode }) {
  return <div>{children}</div>;
}

/**
 * bb's list scrolls inside `div.overflow-y-auto > div.relative.w-full`, with
 * no attribute of its own. Walk up from the toolbar to the first ancestor that
 * holds one, outside the timeline. `list` is null while bb shows a message in
 * its place, such as "No diff to display.", and `root` is then the nearest
 * ancestor holding the whole toolbar.
 */
function findPanel(doc: Document): { toolbar: HTMLElement; list: HTMLElement | null; root: HTMLElement } | null {
  const toolbar = doc.querySelector<HTMLElement>(TOOLBAR);
  if (toolbar === null) return null;
  let root: HTMLElement | null = null;
  let node: HTMLElement | null = toolbar.parentElement;
  while (node !== null) {
    if (root === null && node.querySelector(LAYOUT) !== null) root = node;
    for (const candidate of node.querySelectorAll<HTMLElement>("div.overflow-y-auto")) {
      if (candidate.hasAttribute(HOST_ATTR) || candidate.closest(TIMELINE) !== null) continue;
      const inner = candidate.firstElementChild;
      if (inner instanceof HTMLElement && inner.classList.contains("relative") && inner.classList.contains("w-full")) {
        return { toolbar, list: candidate, root: node };
      }
    }
    node = node.parentElement;
  }
  return root === null ? null : { toolbar, list: null, root };
}

function mount(pluginId: string, signal: AbortSignal): () => void {
  const style = document.createElement("style");
  style.setAttribute("data-super-diff-style", "");
  style.textContent = STYLE;
  document.head.append(style);

  /** Keyed by thread and picker label, so each diff target has its own Super Diff. */
  const states = new Map<string, ThreadState>();
  const contexts = new Map<string, Promise<DiffContext | string>>();
  const keyOf = (threadId: string, selection: string) => `${threadId}|${selection}`;
  const contextOf = (threadId: string, selection: string) => {
    const key = keyOf(threadId, selection);
    let context = contexts.get(key);
    if (context === undefined) {
      context = resolveContext(threadId, selection);
      contexts.set(key, context);
    }
    return context;
  };

  let listHost: HTMLDivElement | null = null;
  let listRoot: Root | null = null;
  let replaced: HTMLElement | null = null;
  let rowHost: HTMLDivElement | null = null;
  let rowRoot: Root | null = null;
  let frame = 0;
  /** The thread and target the Diff tab is showing, or null when no Diff tab is open. */
  let shownKey: string | null = null;

  // What the list last reported for the row's list of concerns.
  let links: ConcernLink[] = [];
  let current = 0;
  /** bb's toolbar summary ("25 files +316 -328") last seen for each key; a change means the diff changed. */
  const summaries = new Map<string, string>();
  // sync() runs on most page mutations, so the count is worked out once per
  // loaded diff and Super Diff rather than rehashing every patch each time.
  const changedCounts = new WeakMap<Loaded, { stored: StoredSuperDiff; count: number }>();
  const changedCountOf = (stored: StoredSuperDiff, data: Loaded) => {
    const cached = changedCounts.get(data);
    if (cached?.stored === stored) return cached.count;
    const count = changedPaths(stored, data.patches).size;
    changedCounts.set(data, { stored, count });
    return count;
  };
  const memories = new Map<string, CardMemory>();
  // One stable callback per key, so the list's hover buttons are not rewired on every render.
  const explainers = new Map<string, (path: string, line: number, text: string) => void>();
  const setExplainer = (key: string, threadId: string, selection: string) => {
    const handler = (path: string, line: number, text: string) => void explain(threadId, selection, path, line, text);
    explainers.set(key, handler);
    return handler;
  };
  const memoryOf = (key: string) => {
    let memory = memories.get(key);
    if (memory === undefined) {
      memory = { collapsed: new Set(), autoCollapsed: new Set() };
      memories.set(key, memory);
    }
    return memory;
  };
  const nav: Nav = {
    report: (nextLinks, nextCurrent) => {
      if (nextCurrent === current && JSON.stringify(nextLinks) === JSON.stringify(links)) return;
      links = nextLinks;
      current = nextCurrent;
      schedule();
    },
    jump: { current: null },
  };

  const unmountLater = (root: Root | null) => {
    if (root !== null) setTimeout(() => root.unmount(), 0);
  };

  /** Puts bb's own list back. */
  const showOriginal = () => {
    replaced?.removeAttribute(REPLACED_ATTR);
    replaced = null;
    unmountLater(listRoot);
    listRoot = null;
    listHost?.remove();
    listHost = null;
  };

  const removeRow = () => {
    unmountLater(rowRoot);
    rowRoot = null;
    rowHost?.remove();
    rowHost = null;
  };

  const fail = (key: string, cause: unknown) => {
    states.set(key, { phase: "error", message: cause instanceof Error ? cause.message : String(cause) });
    schedule();
  };

  type GetResult = { stored: string | null; requestedAt: string | null; explaining: Explaining[] };

  /** Moves to whatever superdiff_get found: waiting on the agent, a stored Super Diff, or nothing yet. */
  const apply = (threadId: string, selection: string, result: GetResult) => {
    const key = keyOf(threadId, selection);
    const stored = result.stored === null ? null : (JSON.parse(result.stored) as StoredSuperDiff);
    // A request newer than what is stored means the agent is still working on it.
    if (result.requestedAt !== null && (stored === null || stored.acceptedAt < result.requestedAt)) {
      states.set(key, { phase: "generating", requestedAt: result.requestedAt });
      void poll(threadId, selection, result.requestedAt);
    } else {
      // A stored Super Diff opens by default; Original is one click away.
      states.set(
        key,
        stored === null ? { phase: "idle" } : { phase: "ready", showing: "original", stored, data: null, explaining: result.explaining },
      );
      if (result.explaining.length > 0) void watchExplains(threadId, selection);
      if (stored !== null) void show(threadId, selection, "super");
    }
    schedule();
  };

  /** Asks the server for a stored Super Diff, once per thread and target. */
  const check = async (threadId: string, selection: string) => {
    const key = keyOf(threadId, selection);
    states.set(key, { phase: "checking" });
    try {
      const context = await contextOf(threadId, selection);
      if (typeof context === "string") return fail(key, context);
      apply(threadId, selection, await callRpc<GetResult>(pluginId, "superdiff_get", { threadId, target: context.target }));
    } catch (cause) {
      fail(key, cause);
    }
  };

  /**
   * While the tab shows the Generate button or a Super Diff, checks for a
   * newer one stored another way, such as an agent running `bb super-diff
   * submit` on its own, and shows it. Each check asks only for timestamps;
   * the Super Diff itself is fetched when one is newer. Stops when the tab
   * moves to another thread or target, starts generating, or closes; sync
   * starts it again when the tab comes back. Skips the request while the
   * window is hidden.
   */
  const storedWatching = new Set<string>();
  const acceptedAtOf = (state: ThreadState | undefined) =>
    state?.phase === "ready" ? state.stored.acceptedAt : state?.phase === "idle" ? null : undefined;
  const watchStored = async (threadId: string, selection: string) => {
    const key = keyOf(threadId, selection);
    if (storedWatching.has(key)) return;
    storedWatching.add(key);
    try {
      while (!signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        if (shownKey !== key || acceptedAtOf(states.get(key)) === undefined) return;
        if (document.visibilityState === "hidden") continue;
        const context = await contextOf(threadId, selection);
        if (typeof context === "string") return;
        // A failed request is tried again next time; the tab stays as it is.
        const version = await callRpc<{ acceptedAt: string | null; requestedAt: string | null }>(pluginId, "superdiff_version", {
          threadId,
          target: context.target,
        }).catch(() => null);
        const known = acceptedAtOf(states.get(key));
        if (version === null || known === undefined) continue;
        const newer = version.acceptedAt !== null && version.acceptedAt !== known;
        const asked = version.requestedAt !== null && (known === null || known < version.requestedAt);
        if (!newer && !asked) continue;
        const result = await callRpc<GetResult>(pluginId, "superdiff_get", { threadId, target: context.target }).catch(() => null);
        const latest = states.get(key);
        if (result === null || acceptedAtOf(latest) !== known) continue;
        const stored = result.stored === null ? null : (JSON.parse(result.stored) as StoredSuperDiff);
        if (latest?.phase === "ready" && stored !== null && !asked) {
          // Keeps the loaded diff and whichever view is on show.
          states.set(key, { ...latest, stored, explaining: result.explaining });
          schedule();
          continue;
        }
        return apply(threadId, selection, result);
      }
    } finally {
      storedWatching.delete(key);
    }
  };

  /**
   * The diff changed under us: bb's file and line counts moved. The thread's
   * base branch may have changed, which makes it a different diff with its
   * own Super Diff (or none), so the base is looked up again. On the same
   * base, a Super Diff on show reloads the diff, so new files show under Not
   * yet grouped and the row says it is out of date.
   */
  const refresh = async (threadId: string, selection: string) => {
    const key = keyOf(threadId, selection);
    const before = await contextOf(threadId, selection);
    contexts.delete(key);
    const after = await contextOf(threadId, selection);
    const current = states.get(key);
    if (typeof before === "string" || typeof after === "string" || targetKey(before.target) !== targetKey(after.target)) {
      return check(threadId, selection);
    }
    if (current?.phase !== "ready" || current.data === null) return;
    try {
      const data = await loadDiff(after);
      const latest = states.get(key);
      if (latest?.phase === "ready" && latest.stored === current.stored) {
        states.set(key, { ...latest, data });
        schedule();
      }
    } catch (cause) {
      fail(key, cause);
    }
  };

  /** Asks a fork of the thread to explain one line, and shows its card at once. */
  const explain = async (threadId: string, selection: string, path: string, line: number, text: string) => {
    const key = keyOf(threadId, selection);
    const current = states.get(key);
    if (current?.phase !== "ready") return;
    if (current.explaining?.some((entry) => entry.path === path && entry.line === line)) return;
    try {
      const context = await contextOf(threadId, selection);
      if (typeof context === "string") return fail(key, context);
      const { requestedAt } = await callRpc<{ requestedAt: string }>(pluginId, "superdiff_explain", {
        threadId,
        target: context.target,
        path,
        line,
        text: text.trimEnd(),
      });
      const latest = states.get(key);
      if (latest?.phase !== "ready") return;
      states.set(key, { ...latest, explaining: [...(latest.explaining ?? []), { path, line, requestedAt }] });
      schedule();
      void watchExplains(threadId, selection);
    } catch (cause) {
      fail(key, cause);
    }
  };

  /** Polls while Explain this notes are being written, and picks each one up as it is stored. */
  const watching = new Set<string>();
  const watchExplains = async (threadId: string, selection: string) => {
    const key = keyOf(threadId, selection);
    if (watching.has(key)) return;
    watching.add(key);
    try {
      while (!signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        const current = states.get(key);
        if (current?.phase !== "ready" || (current.explaining ?? []).length === 0) return;
        const context = await contextOf(threadId, selection);
        if (typeof context === "string") return;
        const result = await callRpc<{ stored: string | null; explaining: Explaining[] }>(pluginId, "superdiff_get", {
          threadId,
          target: context.target,
        });
        const latest = states.get(key);
        if (latest?.phase !== "ready" || result.stored === null) return;
        const stored = JSON.parse(result.stored) as StoredSuperDiff;
        const changed = stored.submission.annotations.length !== latest.stored.submission.annotations.length;
        states.set(key, { ...latest, stored: changed ? stored : latest.stored, explaining: result.explaining });
        schedule();
      }
    } catch {
      // A failed poll leaves the cards as they are; reopening the tab checks again.
    } finally {
      watching.delete(key);
    }
  };

  /** Waits for the agent's submission, then shows it. */
  const poll = async (threadId: string, selection: string, requestedAt: string) => {
    const key = keyOf(threadId, selection);
    while (!signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      const current = states.get(key);
      if (current?.phase !== "generating" || current.requestedAt !== requestedAt) return;
      try {
        const context = await contextOf(threadId, selection);
        if (typeof context === "string") return fail(key, context);
        const result = await callRpc<{ stored: string | null }>(pluginId, "superdiff_get", { threadId, target: context.target });
        const stored = result.stored === null ? null : (JSON.parse(result.stored) as StoredSuperDiff);
        if (stored !== null && stored.acceptedAt >= requestedAt) {
          const data = await loadDiff(context);
          states.set(key, { phase: "ready", showing: "super", stored, data });
          schedule();
          return;
        }
        schedule(); // keeps "asked N min ago" current
      } catch (cause) {
        return fail(key, cause);
      }
    }
  };

  const generate = async (threadId: string, selection: string) => {
    const key = keyOf(threadId, selection);
    try {
      const context = await contextOf(threadId, selection);
      if (typeof context === "string") return fail(key, context);
      const { requestedAt } = await callRpc<{ requestedAt: string }>(pluginId, "superdiff_generate", { threadId, target: context.target });
      states.set(key, { phase: "generating", requestedAt });
      schedule();
      void poll(threadId, selection, requestedAt);
    } catch (cause) {
      fail(key, cause);
    }
  };

  const show = async (threadId: string, selection: string, showing: "super" | "original") => {
    const key = keyOf(threadId, selection);
    const current = states.get(key);
    if (current?.phase !== "ready") return;
    states.set(key, { ...current, showing });
    schedule();
    if (showing === "super" && current.data === null) {
      try {
        const context = await contextOf(threadId, selection);
        if (typeof context === "string") return fail(key, context);
        const data = await loadDiff(context);
        const latest = states.get(key);
        if (latest?.phase === "ready") states.set(key, { ...latest, data });
        schedule();
      } catch (cause) {
        fail(key, cause);
      }
    }
  };

  const sync = () => {
    frame = 0;
    if (signal.aborted) return;
    const threadId = threadIdFromPath(window.location.pathname);
    const panel = findPanel(document);
    if (threadId === null || panel === null) {
      shownKey = null;
      if (listHost !== null && !listHost.isConnected) showOriginal();
      if (rowHost !== null && !rowHost.isConnected) removeRow();
      return;
    }
    const toolbarRoot = panel.root;
    const layout = toolbarRoot.querySelector<HTMLElement>(LAYOUT);
    if (layout === null) {
      shownKey = null;
      return;
    }
    const summaryEl = toolbarRoot.querySelector(SUMMARY);
    const summary = summaryEl?.getAttribute("title") ?? summaryEl?.textContent ?? "";
    const selection = readSelection(toolbarRoot);
    const split =
      toolbarRoot.querySelector('button[aria-label="Split diff view"]')?.getAttribute("aria-pressed") === "true";
    // bb's wrap toggle renames itself, so match either label and read aria-pressed.
    const wrap =
      toolbarRoot
        .querySelector('button[aria-label="Wrap diff lines"], button[aria-label="Disable diff line wrap"]')
        ?.getAttribute("aria-pressed") === "true";
    const mode = toolbarRoot.querySelector<HTMLElement>('[aria-label="Diff view mode"]');
    const segmentButton = mode?.querySelector("button");

    if (rowHost === null || !rowHost.isConnected || rowHost.previousElementSibling !== layout) {
      removeRow();
      rowHost = document.createElement("div");
      rowHost.setAttribute(ROW_ATTR, "");
      layout.after(rowHost);
      rowRoot = createRoot(rowHost);
    }
    const key = keyOf(threadId, selection);
    shownKey = key;
    if (!states.has(key)) void check(threadId, selection);
    const lastSummary = summaries.get(key);
    if (summary !== "" && summary !== lastSummary) {
      summaries.set(key, summary);
      if (lastSummary !== undefined) void refresh(threadId, selection);
    }
    const state = states.get(key) ?? { phase: "checking" as const };
    if (state.phase === "idle" || state.phase === "ready") void watchStored(threadId, selection);
    const fileCount = summary === "No changes" ? 0 : Number(/^(\d+) files?/.exec(summary)?.[1] ?? NaN);
    const showingSuper = state.phase === "ready" && state.showing === "super" && state.data !== null;
    rowRoot?.render(
      <SuperDiffRow
        state={state}
        fileCount={Number.isFinite(fileCount) ? fileCount : null}
        segmentClass={mode?.className ?? ""}
        segmentButtonClass={(segmentButton?.className ?? "").replace(/\bw-7\b/, "").replace(/\bp-0\b/, "px-2.5")}
        onGenerate={() => void generate(threadId, selection)}
        onShow={(showing) => void show(threadId, selection, showing)}
        concernLinks={showingSuper ? links : []}
        changedCount={state.phase === "ready" && state.data !== null ? changedCountOf(state.stored, state.data) : 0}
        current={current}
        onJump={(index) => nav.jump.current?.(index)}
      />,
    );

    if (panel.list === null || state.phase !== "ready" || state.showing !== "super" || state.data === null) {
      if (listHost !== null) showOriginal();
      return;
    }
    if (replaced !== panel.list || listHost === null || !listHost.isConnected) {
      showOriginal();
      listHost = document.createElement("div");
      listHost.setAttribute(HOST_ATTR, "");
      listHost.className = "min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 pb-3";
      panel.list.after(listHost);
      panel.list.setAttribute(REPLACED_ATTR, "");
      replaced = panel.list;
      listRoot = createRoot(listHost);
    }
    listRoot?.render(
      <GroupedList
        key={key}
        data={state.data}
        stored={state.stored}
        split={split}
        wrap={wrap}
        nav={nav}
        memory={memoryOf(key)}
        explaining={state.explaining ?? []}
        onExplain={explainers.get(key) ?? setExplainer(key, threadId, selection)}
      />,
    );
  };

  const schedule = () => {
    if (frame === 0) frame = window.requestAnimationFrame(sync);
  };
  const observer = new MutationObserver((records) => {
    // Ignore churn inside Super Diff's own nodes; bb's re-renders are what matter.
    const ours = (node: Node) =>
      (listHost !== null && listHost.contains(node)) || (rowHost !== null && rowHost.contains(node));
    if (records.every((record) => ours(record.target))) return;
    schedule();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["aria-label", "aria-pressed", "title"],
  });
  // Keeps "generated N min ago" current.
  const clock = window.setInterval(schedule, 30_000);
  schedule();

  return () => {
    observer.disconnect();
    window.clearInterval(clock);
    if (frame !== 0) window.cancelAnimationFrame(frame);
    showOriginal();
    removeRow();
    style.remove();
  };
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "super-diff-grouped-list",
    mount({ pluginId, signal }) {
      return mount(pluginId, signal);
    },
  });
});
