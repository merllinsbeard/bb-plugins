// Reading the changes panel's full file list.
//
// bb virtualizes the panel, so only the cards near the scroll position are in
// the DOM, and the file list itself is never rendered as a whole. The list
// does exist as a prop: bb's `DiffFilesPanel` receives `files` (and `target`,
// the selected range), and React keeps each component's props on the fiber it
// attaches to the rendered elements. This walks up from a rendered row to that
// component and reads them.
//
// React's fiber fields are internal, so this is the one place the plugin
// depends on something bb does not emit on purpose. It never guesses: when the
// walk does not find a list shaped exactly like bb's, it says why, and the
// engine shows that in the toolbar and logs it rather than quietly dropping
// the progress. See `DiffFilesPanel` in bb's
// apps/app/src/components/secondary-panel/git-diff to update it.
import type { DiffFileEntry, DiffTarget } from "./marks";

/** The virtualizer row around each card. `data-index` is bb's own. */
const ROW_SELECTOR = "[data-index]";
/** How far up from a row to look for `DiffFilesPanel`. It is one level up in
 * bb today (row div -> list div -> panel); the margin absorbs a wrapper. */
const MAX_DEPTH = 12;

export type DiffFilesRead =
  | { status: "ok"; files: DiffFileEntry[]; target: DiffTarget }
  | { status: "unreadable"; reason: string };

interface Fiber {
  memoizedProps?: unknown;
  return?: Fiber | null;
}

function fiberOf(element: Element): Fiber | null {
  const key = Object.keys(element).find((name) =>
    name.startsWith("__reactFiber$"),
  );
  if (key === undefined) return null;
  const fiber = (element as unknown as Record<string, unknown>)[key];
  return typeof fiber === "object" && fiber !== null ? (fiber as Fiber) : null;
}

function isEntry(value: unknown): value is DiffFileEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.path === "string" &&
    (entry.previousPath === null || typeof entry.previousPath === "string") &&
    typeof entry.changeKind === "string" &&
    typeof entry.additions === "number" &&
    typeof entry.deletions === "number" &&
    typeof entry.binary === "boolean" &&
    typeof entry.revision === "string" &&
    entry.revision !== ""
  );
}

function isTarget(value: unknown): value is DiffTarget {
  if (typeof value !== "object" || value === null) return false;
  const target = value as Record<string, unknown>;
  switch (target.type) {
    case "uncommitted":
      return true;
    case "branch_committed":
    case "all":
      return typeof target.mergeBaseBranch === "string" && target.mergeBaseBranch !== "";
    case "commit":
      return typeof target.sha === "string" && /^[0-9a-f]{4,40}$/i.test(target.sha);
    default:
      return false;
  }
}

/**
 * The panel's file list, read from the fiber above `row`, a rendered
 * `[data-index]` row that contains a diff card.
 */
export function readDiffFiles(row: Element): DiffFilesRead {
  if (!row.matches(ROW_SELECTOR)) {
    return { status: "unreadable", reason: "the card is not inside a [data-index] row" };
  }
  let fiber = fiberOf(row);
  if (fiber === null) {
    return { status: "unreadable", reason: "the row carries no React fiber" };
  }
  for (let depth = 0; fiber !== null && fiber !== undefined && depth < MAX_DEPTH; depth++) {
    const props = fiber.memoizedProps;
    if (typeof props === "object" && props !== null && "files" in props) {
      const { files, target } = props as { files: unknown; target?: unknown };
      if (!Array.isArray(files)) {
        return { status: "unreadable", reason: "`files` is not an array" };
      }
      const bad = files.findIndex((entry) => !isEntry(entry));
      if (bad !== -1) {
        return {
          status: "unreadable",
          reason: `file ${bad} does not have the fields this plugin reads`,
        };
      }
      if (!isTarget(target)) {
        return { status: "unreadable", reason: "`target` is not a range this plugin knows" };
      }
      return { status: "ok", files: files as DiffFileEntry[], target };
    }
    fiber = fiber.return ?? null;
  }
  return {
    status: "unreadable",
    reason: `no component with a \`files\` prop within ${MAX_DEPTH} levels of the row`,
  };
}

/** The virtualizer row an element of a card sits in, if any. */
export function rowOf(element: Element): Element | null {
  return element.closest(ROW_SELECTOR);
}
