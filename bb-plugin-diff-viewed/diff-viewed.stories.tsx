// bb's own changes panel, its toolbar and diff cards with bb's Viewed
// checkboxes, with the plugin's engine decorating it exactly as the content
// script does in bb. Only the RPC is a stand-in, answering from each story's
// marks and pull request.
//
// The README's screenshots are captures of these stories.
import { useEffect, useMemo, useRef, useState } from "react";
import type { DiffFileEntry } from "@bb/server-contract";
import { GitDiffToolbar } from "@bb-app/components/secondary-panel/GitDiffToolbar";
import { DiffFileCard } from "@bb-app/components/secondary-panel/git-diff/DiffFileCard";
import { DEFAULT_DIFF_FILE_FILTERS } from "@bb-app/components/secondary-panel/git-diff/diff-file-filters";
import { DEFAULT_CODE_OVERFLOW_MODE } from "@bb-app/lib/code-overflow-mode";
import { STYLE_TEXT } from "./viewed/dom";
import { startEngine, type SyncResult } from "./viewed/engine";
import type { GithubState } from "./viewed/github";

export default {
  title: "diff-viewed/Changes Panel",
};

const PRICING_PATCH = [
  "diff --git a/src/pricing.ts b/src/pricing.ts",
  "index 1111111..2222222 100644",
  "--- a/src/pricing.ts",
  "+++ b/src/pricing.ts",
  "@@ -1,3 +1,14 @@",
  " export function applyDiscount(amount: number, percent: number): number {",
  "-  return amount - amount * (percent / 100)",
  "+  if (percent < 0 || percent > 100) {",
  "+    throw new RangeError(`Discount percent out of range: ${percent}`)",
  "+  }",
  "+  return round(amount - amount * (percent / 100))",
  "+}",
  "+",
  "+export function applyTax(amount: number, rate: number): number {",
  "+  return round(amount * (1 + rate))",
  "+}",
  "+",
  "+function round(amount: number): number {",
  "+  return Math.round(amount * 100) / 100",
  " }",
  "",
].join("\n");

const README_PATCH = [
  "diff --git a/README.md b/README.md",
  "index 7777777..8888888 100644",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -8,3 +8,10 @@",
  " ## Pricing",
  " ",
  " Discounts are applied before checkout.",
  "+",
  "+### Tax",
  "+",
  "+Sales tax is added after discounts, at the rate in",
  "+`src/checkout.ts`. Prices shown in the cart do not",
  "+include it.",
  "+",
  "",
].join("\n");

const CART_PATCH = [
  "diff --git a/src/cart.ts b/src/cart.ts",
  "index 9999999..aaaaaaa 100644",
  "--- a/src/cart.ts",
  "+++ b/src/cart.ts",
  "@@ -1,6 +1,11 @@",
  " import { applyDiscount } from './pricing'",
  " ",
  " export function cartSubtotal(items: Item[]): number {",
  "-  const lines = items.map((item) => item.price * item.quantity)",
  "-  return lines.reduce((sum, line) => sum + line, 0)",
  "+  return items.reduce((sum, item) => sum + lineTotal(item), 0)",
  "+}",
  "+",
  "+/** One line of the cart, before discounts and tax. */",
  "+function lineTotal(item: Item): number {",
  "+  const { price, quantity } = item",
  "+  return price * quantity",
  " }",
  "",
].join("\n");

const INVENTORY_PATCH = [
  "diff --git a/src/inventory.ts b/src/inventory.ts",
  "index bbbbbbb..ccccccc 100644",
  "--- a/src/inventory.ts",
  "+++ b/src/inventory.ts",
  "@@ -4,5 +4,11 @@ export interface Stock {",
  " ",
  " export function reserve(stock: Stock, quantity: number): Stock {",
  "-  if (quantity > stock.available) return stock",
  "-  return { ...stock, available: stock.available - quantity }",
  "-}",
  "+  if (quantity <= 0) {",
  "+    throw new RangeError(`Quantity must be positive: ${quantity}`)",
  "+  }",
  "+  if (quantity > stock.available) {",
  "+    throw new Error(`Only ${stock.available} left in stock`)",
  "+  }",
  "+  return { ...stock, available: stock.available - quantity }",
  "+}",
  "+",
  "",
].join("\n");

const CHECKOUT_PATCH = [
  "diff --git a/src/checkout.ts b/src/checkout.ts",
  "index 3333333..4444444 100644",
  "--- a/src/checkout.ts",
  "+++ b/src/checkout.ts",
  "@@ -1,5 +1,12 @@",
  "-import { applyDiscount } from './pricing'",
  "+import { applyDiscount, applyTax } from './pricing'",
  "+",
  "+const TAX_RATE = 0.08",
  " ",
  " export function total(subtotal: number, discount: number): number {",
  "   return applyDiscount(subtotal, discount)",
  " }",
  "+",
  "+/** The order total after discount, with sales tax added. */",
  "+export function totalWithTax(subtotal: number, discount: number): number {",
  "+  return applyTax(total(subtotal, discount), TAX_RATE)",
  "+}",
  "",
].join("\n");

const TEST_PATCH = [
  "diff --git a/test/pricing.test.ts b/test/pricing.test.ts",
  "index 5555555..6666666 100644",
  "--- a/test/pricing.test.ts",
  "+++ b/test/pricing.test.ts",
  "@@ -6,2 +6,8 @@ describe('applyDiscount', () => {",
  "   })",
  " })",
  "+",
  "+describe('applyTax', () => {",
  "+  it('adds the rate to the amount', () => {",
  "+    expect(applyTax(10, 0.08)).toBe(10.8)",
  "+  })",
  "+})",
  "",
].join("\n");

const PATCHES: Record<string, string> = {
  "README.md": README_PATCH,
  "src/cart.ts": CART_PATCH,
  "src/inventory.ts": INVENTORY_PATCH,
  "src/pricing.ts": PRICING_PATCH,
  "src/checkout.ts": CHECKOUT_PATCH,
  "test/pricing.test.ts": TEST_PATCH,
};

function entry(path: string, additions: number, deletions: number): DiffFileEntry {
  return {
    path,
    previousPath: null,
    changeKind: "modified",
    additions,
    deletions,
    binary: false,
    origin: "tracked",
    loadMode: "auto",
    revision: `100644:${path.length}a:100644:${additions}${deletions}b`,
  };
}

/** Six files, +49 -7: an invented branch adding tax to a shop's pricing. */
const FILES: DiffFileEntry[] = [
  entry("README.md", 7, 0),
  entry("src/cart.ts", 7, 2),
  entry("src/inventory.ts", 9, 3),
  entry("src/pricing.ts", 12, 1),
  entry("src/checkout.ts", 8, 1),
  entry("test/pricing.test.ts", 6, 0),
];

const PULL_URL = "https://github.com/acme/widgets/pull/42";

/** The pull request as GitHub has it, with `viewed` paths ticked. */
function pull(viewed: readonly string[], overrides: Record<string, [number, number]> = {}): GithubState {
  return {
    number: 42,
    url: PULL_URL,
    files: FILES.map((file) => {
      const [additions, deletions] = overrides[file.path] ?? [file.additions, file.deletions];
      return { path: file.path, additions, deletions, viewed: viewed.includes(file.path) };
    }),
  };
}

interface Fixture {
  /** The files bb has marked viewed. */
  viewed: readonly string[];
  github: GithubState | null;
  /** Never answer viewed_sync, to hold the panel in its loading state. */
  holdSync?: boolean;
}

/** The plugin's RPC, answered from the marks bb shows. */
function fakeRpc(fixture: Fixture, marks: () => ReadonlySet<string>) {
  return async <Result,>(method: string): Promise<Result> => {
    if (method !== "viewed_sync") return { ok: true } as Result;
    if (fixture.holdSync) return new Promise<Result>(() => {});
    const viewed = Object.fromEntries(
      FILES.filter((file) => marks().has(file.path)).map((file) => [file.path, file.revision]),
    );
    const result: SyncResult = { viewed, github: fixture.github };
    return result as Result;
  };
}

/** Starts the engine on this page, as the content script does in bb. */
function useEngine(fixture: Fixture, threadId: string, marks: () => ReadonlySet<string>): void {
  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = STYLE_TEXT;
    document.head.append(style);
    const controller = new AbortController();
    const engine = startEngine({
      rpc: fakeRpc(fixture, marks),
      signal: controller.signal,
      doc: document,
      pathname: () => `/threads/${threadId}`,
      defer: (run) => {
        const frame = window.requestAnimationFrame(run);
        return () => window.cancelAnimationFrame(frame);
      },
      delay: (run) => {
        const timer = window.setTimeout(run, 400);
        return () => window.clearTimeout(timer);
      },
      warn: (cause) => console.warn("[diff-viewed story]", cause),
    });
    return () => {
      controller.abort();
      engine.dispose();
      style.remove();
    };
  }, [fixture, threadId, marks]);
}

const PRESENTATION = {
  view: "split",
  overflow: DEFAULT_CODE_OVERFLOW_MODE,
  showLineNumbers: true,
} as const;

const TARGET = { type: "all", mergeBaseBranch: "main" } as const;

/**
 * Stands in for bb's DiffFilesPanel. The engine reads the whole file list
 * from the props of the component above the `[data-index]` rows, so this one
 * takes `environmentId`, `target`, and `files` the way bb's does. As in bb, a
 * file folds away when it is marked viewed.
 */
function FileList({
  files,
  marks,
  onViewedChange,
}: {
  environmentId: string;
  target: typeof TARGET;
  files: DiffFileEntry[];
  marks: ReadonlySet<string>;
  onViewedChange: (path: string, viewed: boolean) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  return (
    <div className="relative w-full">
      {files.map((file, index) => (
        <div key={file.path} data-index={index} className="pb-2">
          <DiffFileCard
            entry={file}
            presentation={PRESENTATION}
            ignoreWhitespace={false}
            isViewed={marks.has(file.path)}
            isViewedDisabled={false}
            onViewedChange={(viewed) => {
              onViewedChange(file.path, viewed);
              setOpen((previous) => {
                const next = new Set(previous);
                next.delete(file.path);
                return next;
              });
            }}
            isCollapsed={marks.has(file.path) && !open.has(file.path)}
            onToggleCollapsed={() =>
              setOpen((previous) => {
                const next = new Set(previous);
                if (next.has(file.path)) next.delete(file.path);
                else next.add(file.path);
                return next;
              })
            }
            patchState={{ status: "loaded", patch: PATCHES[file.path] }}
            onLoadPatch={() => {}}
            onRetry={() => {}}
          />
        </div>
      ))}
    </div>
  );
}

const noop = () => {};

function Panel({ fixture, threadId }: { fixture: Fixture; threadId: string }) {
  const [marks, setMarks] = useState<ReadonlySet<string>>(() => new Set(fixture.viewed));
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const readMarks = useMemo(() => () => marksRef.current, []);
  useEngine(fixture, threadId, readMarks);
  const stats = {
    filesCount: FILES.length,
    insertions: FILES.reduce((sum, file) => sum + file.additions, 0),
    deletions: FILES.reduce((sum, file) => sum + file.deletions, 0),
  };
  return (
    <div data-screenshot-frame className="flex w-[800px] min-w-0 flex-col overflow-hidden bg-background pt-3">
      <GitDiffToolbar
        selectionValue="all"
        selectionOptions={[
          { value: "all", label: "All changes" },
          { value: "uncommitted", label: "Uncommitted changes" },
        ]}
        onSelectionChange={noop}
        isSelectorDisabled={false}
        stats={stats}
        isStatsLoading={false}
        totalFilesCount={FILES.length}
        isTruncated={false}
        fileFilter={null}
        filters={DEFAULT_DIFF_FILE_FILTERS}
        onFiltersChange={noop}
        extensionCounts={[]}
        onFileFilterChange={noop}
        areAllFilesCollapsed={false}
        isCollapseAllDisabled={false}
        collapseAllDisabledReason={null}
        onToggleAllCollapsed={noop}
        displayMode="split"
        onDisplayModeChange={noop}
        lineOverflowMode={DEFAULT_CODE_OVERFLOW_MODE}
        onLineOverflowModeChange={noop}
        ignoreWhitespace={false}
        onIgnoreWhitespaceChange={noop}
      />
      <div className="px-4 pt-2 pb-3">
        <FileList
          environmentId="env_story"
          target={TARGET}
          files={FILES}
          marks={marks}
          onViewedChange={(path, viewed) =>
            setMarks((previous) => {
              const next = new Set(previous);
              if (viewed) next.add(path);
              else next.delete(path);
              return next;
            })
          }
        />
      </div>
    </div>
  );
}

const VIEWED_FIXTURE: Fixture = {
  viewed: ["README.md", "src/cart.ts", "src/inventory.ts"],
  github: pull(["README.md", "src/cart.ts", "src/inventory.ts"]),
};

/**
 * Three files checked Viewed in bb fold away, the unread file below them
 * stays open, and the toolbar counts 3/6 viewed. Every file here syncs with
 * the pull request, so none shows the Local icon.
 */
export function Viewed() {
  return <Panel fixture={VIEWED_FIXTURE} threadId="thr_viewed" />;
}

const LOCAL_FIXTURE: Fixture = {
  viewed: ["README.md", "src/cart.ts", "src/inventory.ts", "src/pricing.ts"],
  github: pull(["README.md", "src/cart.ts", "src/inventory.ts"], {
    "src/pricing.ts": [10, 1],
  }),
};

/**
 * src/pricing.ts has edits that are not pushed, so its diff here differs from
 * the pull request's. Its mark is Local, shown by the crossed-out cloud after
 * the checkbox, and stays in bb until a push makes the diffs match.
 */
export function Local() {
  return <Panel fixture={LOCAL_FIXTURE} threadId="thr_local" />;
}

const NO_PULL_FIXTURE: Fixture = {
  viewed: ["README.md", "src/cart.ts"],
  github: null,
};

/**
 * A thread with no open pull request: every mark is Local, checked or not,
 * and goes to GitHub once a pull request with the same diff is opened.
 */
export function NoPullRequest() {
  return <Panel fixture={NO_PULL_FIXTURE} threadId="thr_no_pull" />;
}

const LOADING_FIXTURE: Fixture = {
  viewed: ["README.md", "src/cart.ts"],
  github: null,
  holdSync: true,
};

/**
 * While GitHub is still answering: bb's checkboxes show its marks at once, a
 * spinner holds the Local icon's place, and the viewed count stays muted.
 */
export function Loading() {
  return <Panel fixture={LOADING_FIXTURE} threadId="thr_loading" />;
}
