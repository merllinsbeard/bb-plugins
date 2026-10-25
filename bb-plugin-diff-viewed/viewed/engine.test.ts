// @vitest-environment jsdom
//
// The sync loop driven against a DOM shaped like bb's changes panel, with a
// fake bb standing in for React: clicking a Viewed checkbox flips its
// `data-state` the way bb's Radix checkbox does. That is enough to catch the
// failures that only show up once the pieces are wired together.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startEngine, type Engine, type SyncInput, type SyncResult } from "./engine";
import { OWNED_ATTR } from "./dom";
import type { GithubState } from "./github";
import type { DiffFileEntry, DiffTarget, ViewedMap } from "./marks";

const THREAD = "/projects/proj_x/threads/thr_a";

/**
 * bb's changes panel holds every file in a `files` prop, and each rendered row
 * reaches it through React's fiber. These stand in for both: `panel.files`
 * is the whole diff, whether or not a card for a file is rendered.
 */
const panel: { files: DiffFileEntry[]; target: DiffTarget } = {
  files: [],
  target: { type: "all", mergeBaseBranch: "main" },
};

function fileEntry(path: string, additions = 2, deletions = 2): DiffFileEntry {
  return {
    path,
    previousPath: null,
    changeKind: "modified",
    additions,
    deletions,
    binary: false,
    revision: `rev-${path}-1`,
  };
}

function attachFiber(row: HTMLElement): void {
  Object.assign(row, {
    __reactFiber$test: {
      memoizedProps: { className: "absolute left-0 w-full" },
      return: {
        memoizedProps: {
          environmentId: "env_a",
          get target() {
            return panel.target;
          },
          get files() {
            return panel.files;
          },
        },
        return: null,
      },
    },
  });
}

/** Add a file to the diff without rendering its card, as when it is scrolled away. */
function addFile(path: string, additions = 2, deletions = 2): DiffFileEntry {
  const entry = fileEntry(path, additions, deletions);
  panel.files.push(entry);
  return entry;
}

/** A card with bb's Viewed checkbox, and bb's response to a click on it. */
function renderCard(path: string, checked = false): HTMLElement {
  if (!panel.files.some((file) => file.path === path)) addFile(path);
  const host = document.createElement("div");
  host.setAttribute("data-index", String(panel.files.length - 1));
  attachFiber(host);
  host.innerHTML = `
    <div class="flex w-full items-center justify-between gap-2">
      <span class="flex min-w-0 items-center"><span>${path}</span></span>
      <span class="ml-auto flex shrink-0 items-center gap-2">
        <span>+2 -2</span>
        <label><button type="button" role="checkbox"
          data-state="${checked ? "checked" : "unchecked"}"
          aria-label="Viewed ${path}"></button><span>Viewed</span></label>
      </span>
    </div>`;
  document.body.append(host);
  const box = host.querySelector('[role="checkbox"]') as HTMLElement;
  box.addEventListener("click", () => {
    const next = box.getAttribute("data-state") === "checked" ? "unchecked" : "checked";
    box.setAttribute("data-state", next);
  });
  return box;
}

function setChecked(box: HTMLElement, checked: boolean): void {
  box.setAttribute("data-state", checked ? "checked" : "unchecked");
}

function renderToolbar(): void {
  const details = document.createElement("div");
  details.setAttribute("data-testid", "git-diff-toolbar-details");
  details.innerHTML = `
    <span data-testid="git-diff-toolbar-summary">2 files, <span>+4 -4</span></span>
    <div data-testid="git-diff-toolbar-actions"></div>`;
  document.body.prepend(details);
}

function progress(): string | null {
  return document.querySelector("[data-diff-viewed-progress]")?.textContent ?? null;
}

function iconFor(box: HTMLElement): string | null {
  const icon = box.closest("label")?.nextElementSibling;
  return icon?.hasAttribute(OWNED_ATTR) ? icon.getAttribute("data-diff-viewed-sync") : null;
}

interface Harness {
  engine: Engine;
  syncs: SyncInput[];
  /** bb's marks, as the server reads them. */
  viewed: ViewedMap;
  /** Run the debounce timer a checkbox change starts, if one is waiting. */
  fireDelay: () => void;
  /** Let queued promise callbacks run, then re-sync. */
  settle: () => Promise<void>;
}

let controller: AbortController;
let started: Engine[] = [];

function start(
  options: {
    viewed?: ViewedMap;
    github?: GithubState | null;
    pathname?: string;
    /** Hold viewed_sync until this settles, as a slow GitHub query does. */
    gate?: Promise<void>;
    /** Answer from `viewed` alone, as when bb has yet to repaint a box. */
    ignoreBoxes?: boolean;
    /** Fail every sync, as when the server is down. */
    fail?: boolean;
    /** Collect warnings instead of failing the test on the first one. */
    warnings?: unknown[];
  } = {},
): Harness {
  const syncs: SyncInput[] = [];
  const viewed: ViewedMap = { ...(options.viewed ?? {}) };
  let delayed: (() => void) | null = null;

  const rpc = async <Result,>(method: string, input: unknown): Promise<Result> => {
    if (method === "problem_report") return { ok: true } as Result;
    syncs.push(input as SyncInput);
    if (options.gate !== undefined) await options.gate;
    if (options.fail === true) throw new Error("down");
    // Stand in for the server: it reads bb's marks, which bb has already
    // updated from the click that the box shows.
    for (const box of options.ignoreBoxes === true ? [] : document.querySelectorAll('[role="checkbox"]')) {
      const path = box.getAttribute("aria-label")!.slice("Viewed ".length);
      const entry = panel.files.find((file) => file.path === path);
      if (entry === undefined) continue;
      if (box.getAttribute("data-state") === "checked") viewed[path] = entry.revision;
      else delete viewed[path];
    }
    const result: SyncResult = { viewed: { ...viewed }, github: options.github ?? null };
    return result as Result;
  };

  const engine = startEngine({
    rpc,
    signal: controller.signal,
    doc: document,
    pathname: () => options.pathname ?? THREAD,
    // Passes run only when a test asks: the tests drive time explicitly.
    defer: () => () => {},
    delay: (run) => {
      delayed = run;
      return () => {
        if (delayed === run) delayed = null;
      };
    },
    warn: (cause) => {
      if (options.warnings === undefined) throw cause;
      options.warnings.push(cause);
    },
  });
  started.push(engine);

  return {
    engine,
    syncs,
    viewed,
    fireDelay() {
      const run = delayed;
      delayed = null;
      run?.();
    },
    async settle() {
      for (let i = 0; i < 5; i++) await Promise.resolve();
      engine.syncNow();
    },
  };
}

beforeEach(() => {
  panel.files = [];
  panel.target = { type: "all", mergeBaseBranch: "main" };
  controller = new AbortController();
  started = [];
});

afterEach(() => {
  for (const engine of started) engine.dispose();
  controller.abort();
  document.body.innerHTML = "";
});

describe("opening the changes panel", () => {
  it("syncs the thread's range and files once", async () => {
    renderToolbar();
    renderCard("a.ts");
    const h = start();
    h.engine.syncNow();
    h.engine.syncNow();
    await h.settle();
    expect(h.syncs).toEqual([
      { threadId: "thr_a", target: panel.target, files: panel.files },
    ]);
  });

  it("counts bb's marks across the whole diff, not only rendered cards", async () => {
    renderToolbar();
    renderCard("a.ts");
    const hidden = addFile("b.ts");
    addFile("c.ts");
    const h = start({ viewed: { "b.ts": hidden.revision } });
    h.engine.syncNow();
    await h.settle();
    expect(progress()).toBe("1/3 viewed");
  });

  it("does not count a mark on an older revision of the file", async () => {
    renderToolbar();
    renderCard("a.ts");
    const h = start({ viewed: { "a.ts": "rev-a.ts-0" } });
    h.engine.syncNow();
    await h.settle();
    expect(progress()).toBe("0/1 viewed");
  });

  it("syncs again when a file's revision changes", async () => {
    renderToolbar();
    renderCard("a.ts");
    const h = start();
    h.engine.syncNow();
    await h.settle();
    panel.files[0] = { ...panel.files[0]!, revision: "rev-a.ts-2" };
    h.engine.syncNow();
    await h.settle();
    expect(h.syncs).toHaveLength(2);
  });

  it("syncs again when the range changes", async () => {
    renderToolbar();
    renderCard("a.ts");
    const h = start();
    h.engine.syncNow();
    await h.settle();
    panel.target = { type: "uncommitted" };
    h.engine.syncNow();
    await h.settle();
    expect(h.syncs.map((sync) => sync.target)).toEqual([
      { type: "all", mergeBaseBranch: "main" },
      { type: "uncommitted" },
    ]);
  });
});

describe("checking a file in bb", () => {
  it("moves the count at once, before the server answers", async () => {
    renderToolbar();
    const box = renderCard("a.ts");
    renderCard("b.ts");
    const h = start();
    h.engine.syncNow();
    await h.settle();
    box.click();
    h.engine.syncNow();
    expect(progress()).toBe("1/2 viewed");
  });

  it("syncs once the clicks stop, so GitHub hears about it", async () => {
    renderToolbar();
    const box = renderCard("a.ts");
    const h = start();
    h.engine.syncNow();
    await h.settle();
    box.click();
    h.engine.syncNow();
    h.engine.syncNow();
    expect(h.syncs).toHaveLength(1);
    h.fireDelay();
    await h.settle();
    expect(h.syncs).toHaveLength(2);
    expect(h.viewed["a.ts"]).toBe("rev-a.ts-1");
  });

  it("does not keep asking while bb has yet to repaint a box", async () => {
    renderToolbar();
    // The server says a.ts is viewed, as after a mark on GitHub was brought
    // into bb, and bb has not repainted the box yet.
    renderCard("a.ts", false);
    const h = start({ viewed: { "a.ts": "rev-a.ts-1" }, ignoreBoxes: true });
    h.engine.syncNow();
    await h.settle();
    h.fireDelay();
    await h.settle();
    h.fireDelay();
    await h.settle();
    expect(h.syncs).toHaveLength(2);
  });

  it("ignores a box bb has not enabled yet", async () => {
    renderToolbar();
    const box = renderCard("a.ts");
    box.setAttribute("disabled", "");
    const h = start({ viewed: { "a.ts": "rev-a.ts-1" }, ignoreBoxes: true });
    h.engine.syncNow();
    await h.settle();
    expect(progress()).toBe("1/1 viewed");
    h.fireDelay();
    expect(h.syncs).toHaveLength(1);
  });
});

describe("the sync icon", () => {
  const github = (viewed: boolean, additions = 2): GithubState => ({
    number: 42,
    url: "https://github.com/acme/widgets/pull/42",
    files: [{ path: "a.ts", additions, deletions: 2, viewed }],
  });

  it("spins until the server answers", async () => {
    renderToolbar();
    const box = renderCard("a.ts");
    let open = () => {};
    const gate = new Promise<void>((resolve) => (open = resolve));
    const h = start({ gate, github: github(false) });
    h.engine.syncNow();
    expect(iconFor(box)).toBe("pending");
    expect(document.querySelector("[data-diff-viewed-progress] .animate-pulse")).not.toBeNull();
    open();
    await h.settle();
    expect(iconFor(box)).toBe("synced:42");
  });

  it("shows Local for a file whose diff differs from the pull request's", async () => {
    renderToolbar();
    const box = renderCard("a.ts");
    const h = start({ github: github(false, 5) });
    h.engine.syncNow();
    await h.settle();
    expect(iconFor(box)).toBe("local:42");
  });

  it("shows Local without a pull request", async () => {
    renderToolbar();
    const box = renderCard("a.ts");
    const h = start();
    h.engine.syncNow();
    await h.settle();
    expect(iconFor(box)).toBe("none");
  });

  it("stops spinning when the server fails", async () => {
    renderToolbar();
    const box = renderCard("a.ts");
    const warnings: unknown[] = [];
    const h = start({ fail: true, warnings });
    h.engine.syncNow();
    await h.settle();
    expect(iconFor(box)).toBe("none");
    expect(progress()).toBe("0/1 viewed");
    expect(warnings).toHaveLength(1);
  });
});

describe("scope", () => {
  it("decorates nothing when the changes panel is not open", async () => {
    const box = renderCard("a.ts");
    const h = start();
    h.engine.syncNow();
    await h.settle();
    expect(iconFor(box)).toBeNull();
    expect(h.syncs).toEqual([]);
  });

  it("decorates nothing off a thread route", async () => {
    renderToolbar();
    const box = renderCard("a.ts");
    const h = start({ pathname: "/projects/proj_x" });
    h.engine.syncNow();
    await h.settle();
    expect(iconFor(box)).toBeNull();
    expect(progress()).toBeNull();
  });

  it("removes its own decoration on dispose", async () => {
    renderToolbar();
    renderCard("a.ts");
    const h = start();
    h.engine.syncNow();
    await h.settle();
    expect(document.querySelectorAll(`[${OWNED_ATTR}]`).length).toBeGreaterThan(0);
    h.engine.dispose();
    expect(document.querySelectorAll(`[${OWNED_ATTR}]`)).toHaveLength(0);
  });
});

describe("when bb's file list cannot be read", () => {
  it("says so in the toolbar and logs the problem once", async () => {
    renderToolbar();
    const box = renderCard("a.ts");
    const row = box.closest("[data-index]")!;
    Object.assign(row, { __reactFiber$test: { memoizedProps: {}, return: null } });
    const warnings: unknown[] = [];
    const h = start({ warnings });
    h.engine.syncNow();
    h.engine.syncNow();
    await h.settle();
    expect(progress()).toBe("Viewed progress unavailable");
    expect(warnings).toHaveLength(1);
    expect(h.syncs).toEqual([]);
  });
});
