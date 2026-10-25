// Reading bb's Viewed checkboxes and decorating the changes panel around them.
//
// bb owns this DOM. Everything here anchors on the most stable things bb
// actually emits, the toolbar's `data-testid`s and the Viewed checkbox's role
// and accessible name, and never on a minified class name. Each diff card's
// header ends with bb's own control:
//
//   <span class="ml-auto flex shrink-0 items-center gap-2">  <- the card's actions
//     <span>+12 -3</span>
//     <label class="… border-l …">
//       <button role="checkbox" aria-label="Viewed src/a.ts" data-state="checked">
//       <span>Viewed</span>
//     </label>
//     <span data-diff-viewed-owned>…</span>                   <- this plugin's icon
//   </span>
import type { SyncMode } from "./github";

/** Marks a node this plugin created, so cleanup can find every one of them. */
export const OWNED_ATTR = "data-diff-viewed-owned";
/** Set on the toolbar's details group while it holds the progress line. */
const PROGRESS_HOST_ATTR = "data-diff-viewed-progress-host";
/** Marks the progress line this plugin adds above bb's line counts. */
const PROGRESS_ATTR = "data-diff-viewed-progress";
/** Marks the icon this plugin puts after bb's Viewed checkbox. */
const SYNC_ATTR = "data-diff-viewed-sync";
/** Timeline diffs have no Viewed checkbox; this keeps a lookalike out anyway. */
const TIMELINE_SELECTOR = "[data-timeline-file-diff]";

const VIEWED_BOX_SELECTOR = 'button[role="checkbox"][aria-label^="Viewed "]';

/** bb's Viewed checkbox on one diff card, as this plugin reads it. */
export interface ViewedBox {
  /** bb's card label: the path, or `previous -> current` for a rename. */
  label: string;
  checked: boolean;
  /** bb disables the box until it has loaded the range's marks. */
  disabled: boolean;
  box: HTMLElement;
  /** The `<label>` around the box, which the sync icon goes after. */
  control: HTMLElement;
}

export function readViewedBox(box: Element): ViewedBox | null {
  if (!(box instanceof HTMLElement)) return null;
  if (box.closest(TIMELINE_SELECTOR) !== null) return null;
  const control = box.closest("label");
  if (control === null) return null;
  const label = (box.getAttribute("aria-label") ?? "").slice("Viewed ".length).trim();
  if (label === "") return null;
  const state = box.getAttribute("data-state");
  if (state !== "checked" && state !== "unchecked") return null;
  return {
    label,
    checked: state === "checked",
    disabled: box.hasAttribute("disabled") || box.hasAttribute("data-disabled"),
    box,
    control,
  };
}

/** Every Viewed checkbox currently rendered, in document order. */
export function findViewedBoxes(root: ParentNode): ViewedBox[] {
  const boxes: ViewedBox[] = [];
  for (const element of root.querySelectorAll(VIEWED_BOX_SELECTOR)) {
    const box = readViewedBox(element);
    if (box !== null) boxes.push(box);
  }
  return boxes;
}

/**
 * Where a file's mark lives, or `pending` while the thread's pull request and
 * GitHub's Viewed state are still being fetched.
 */
export type ControlMode = SyncMode | { kind: "pending" };

/** The icon's tooltip: where the mark on this file is kept. */
export function syncTitle(mode: ControlMode): string {
  switch (mode.kind) {
    case "pending":
      return "Checking GitHub";
    case "none":
      return (
        "Local: the mark is kept in bb. Once the thread has an open pull request " +
        "with this same diff, it is marked viewed on GitHub too"
      );
    case "synced":
      return `Synced with the Viewed box on pull request #${mode.number}`;
    case "local":
      return (
        `Local: this file's diff here differs from pull request #${mode.number} ` +
        "on GitHub, so the mark is kept in bb. Once you push and the diffs match, " +
        "it is marked viewed on GitHub too"
      );
  }
}

/** Lucide's `cloud-off`, the Local icon: this mark is not on GitHub. */
const LOCAL_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" class="block h-3.5 w-3.5" aria-hidden="true">' +
  '<path d="M10.94 5.274A7 7 0 0 1 15.71 10h1.79a4.5 4.5 0 0 1 4.222 6.057"/>' +
  '<path d="M18.796 18.81A4.5 4.5 0 0 1 17.5 19H9A7 7 0 0 1 5.79 5.78"/>' +
  '<path d="m2 2 20 20"/></svg>';

/** Lucide's `loader-circle`, spinning. */
const PENDING_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" class="block h-3.5 w-3.5 animate-spin" aria-hidden="true">' +
  '<path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';

/** This plugin's icon after a Viewed checkbox, if it is still mounted. */
export function existingSyncIcon(box: ViewedBox): HTMLElement | null {
  const next = box.control.nextElementSibling;
  return next instanceof HTMLElement && next.hasAttribute(SYNC_ATTR) ? next : null;
}

/**
 * Put the sync icon after bb's Viewed checkbox and show where the mark lives.
 * The icon's space is kept even when it is empty, for a synced file, so bb's
 * checkboxes stay lined up down the panel.
 */
export function paintSyncIcon(box: ViewedBox, mode: ControlMode): void {
  let icon = existingSyncIcon(box);
  if (icon === null) {
    icon = document.createElement("span");
    icon.setAttribute(OWNED_ATTR, "");
    icon.setAttribute(SYNC_ATTR, "");
    icon.className = "flex size-3.5 shrink-0 items-center text-muted-foreground";
    box.control.after(icon);
  }
  // Compared on a key rather than on innerHTML, which the browser
  // re-serializes and so would never equal the markup it was given.
  const key = mode.kind === "synced" ? `synced:${mode.number}` : mode.kind === "local" ? `local:${mode.number}` : mode.kind;
  if (icon.getAttribute(SYNC_ATTR) === key) return;
  icon.setAttribute(SYNC_ATTR, key);
  icon.title = syncTitle(mode);
  if (mode.kind === "synced") {
    icon.innerHTML = "";
    icon.removeAttribute("role");
    icon.removeAttribute("aria-label");
    return;
  }
  icon.setAttribute("role", "img");
  icon.setAttribute("aria-label", mode.kind === "pending" ? "Loading" : "Local");
  icon.innerHTML = mode.kind === "pending" ? PENDING_SVG : LOCAL_SVG;
}

/** The progress line's layout, injected once. */
export const STYLE_TEXT = `
[${PROGRESS_HOST_ATTR}] {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas: "progress actions" "summary actions";
  align-items: center;
  align-content: center;
  gap: 0.125rem 0.25rem;
}
[${PROGRESS_HOST_ATTR}] > [${PROGRESS_ATTR}] {
  grid-area: progress;
  justify-self: end;
  font-size: 0.6875rem;
  line-height: 0.875rem;
}
[${PROGRESS_HOST_ATTR}] > [data-testid="git-diff-toolbar-summary"] {
  grid-area: summary;
  justify-self: end;
  font-size: 0.6875rem;
  line-height: 0.875rem;
}
/* The progress line above already gives the file count, so keep only bb's
   "+a -b" tally. The "N files, " before it is bare text with no element of
   its own to hide, so the summary's text is shrunk to nothing and the tally
   span is given its size back. A summary with no tally keeps its text. */
[${PROGRESS_HOST_ATTR}] > [data-testid="git-diff-toolbar-summary"]:has(> span) {
  font-size: 0;
}
[${PROGRESS_HOST_ATTR}] > [data-testid="git-diff-toolbar-summary"] > span {
  font-size: 0.6875rem;
  line-height: 0.875rem;
}
[${PROGRESS_HOST_ATTR}] > [data-testid="git-diff-toolbar-actions"] {
  grid-area: actions;
}
`;

/**
 * The changes-panel toolbar. This plugin does not touch any of its controls;
 * it looks for the toolbar only because its presence is how the plugin knows
 * the changes panel is open at all, the file card list below it carrying no
 * attribute of its own.
 */
export const TOOLBAR_SELECTOR = '[data-testid="git-diff-toolbar-actions"]';

export function findToolbar(root: ParentNode): HTMLElement | null {
  const toolbar = root.querySelector(TOOLBAR_SELECTOR);
  return toolbar instanceof HTMLElement ? toolbar : null;
}

/**
 * The toolbar group holding bb's "N files, +a -b" summary and the action
 * buttons. The progress line is stacked above the summary inside it.
 */
const DETAILS_SELECTOR = '[data-testid="git-diff-toolbar-details"]';

/** What the progress line shows. */
export type ProgressView =
  | {
      kind: "progress";
      viewed: number;
      total: number;
      /** GitHub has not answered yet, so the count is bb's marks alone. */
      pending?: boolean;
    }
  | { kind: "unavailable"; reason: string };

const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function ringSvg(viewed: number, total: number): string {
  const fraction = total === 0 ? 0 : viewed / total;
  const complete = total > 0 && viewed === total;
  const dash = (fraction * RING_CIRCUMFERENCE).toFixed(2);
  const color = complete ? "var(--success)" : "var(--primary)";
  return (
    '<svg viewBox="0 0 16 16" class="h-3 w-3 shrink-0 -rotate-90" aria-hidden="true">' +
    `<circle cx="8" cy="8" r="${RING_RADIUS}" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="2"/>` +
    `<circle cx="8" cy="8" r="${RING_RADIUS}" fill="none" stroke="${color}" stroke-width="2" ` +
    `stroke-linecap="round" stroke-dasharray="${dash} ${RING_CIRCUMFERENCE.toFixed(2)}"` +
    (fraction === 0 ? ' stroke-opacity="0"' : "") +
    "/></svg>"
  );
}

function progressMarkup(view: ProgressView): { html: string; title: string } {
  if (view.kind === "unavailable") {
    return {
      html:
        '<span class="truncate text-muted-foreground">Viewed progress unavailable</span>',
      title:
        `Diff Viewed Enhanced could not read this panel's file list: ${view.reason}. ` +
        "A bb update probably changed the changes panel; see the plugin's README.",
    };
  }
  const { viewed, total, pending = false } = view;
  // While GitHub is still answering, the whole line stays muted, so a count
  // that may still change does not read as final.
  const number = pending ? "text-muted-foreground" : "text-foreground";
  const counted = `${viewed} of ${total} file${total === 1 ? "" : "s"} viewed`;
  return {
    html:
      ringSvg(viewed, total) +
      `<span class="truncate${pending ? " animate-pulse" : ""}">` +
      `<span class="${number}">${viewed}</span>` +
      '<span class="text-muted-foreground">/</span>' +
      `<span class="${number}">${total}</span>` +
      '<span class="text-muted-foreground"> viewed</span></span>',
    title: pending ? `${counted} in bb. Checking GitHub` : counted,
  };
}

/**
 * Show `view` above bb's line counts, or remove the line when `view` is null.
 * Rewrites the line only when what it says changes, so a pass that finds
 * nothing new does not touch the DOM.
 */
export function renderProgress(doc: Document, view: ProgressView | null): void {
  const details = doc.querySelector(DETAILS_SELECTOR);
  if (!(details instanceof HTMLElement)) return;
  let line = details.querySelector(`:scope > [${PROGRESS_ATTR}]`);
  if (view === null) {
    line?.remove();
    details.removeAttribute(PROGRESS_HOST_ATTR);
    return;
  }
  if (!(line instanceof HTMLElement)) {
    line = doc.createElement("div");
    line.setAttribute(OWNED_ATTR, "");
    line.setAttribute(PROGRESS_ATTR, "");
    line.className =
      "flex min-w-0 items-center gap-1 pl-2.5";
    details.append(line);
  }
  if (!details.hasAttribute(PROGRESS_HOST_ATTR)) {
    details.setAttribute(PROGRESS_HOST_ATTR, "");
  }
  // Compared on a key rather than on innerHTML, which the browser
  // re-serializes and so would never equal the markup it was given.
  const element = line as HTMLElement;
  const key = JSON.stringify(view);
  if (element.getAttribute(PROGRESS_ATTR) === key) return;
  const { html, title } = progressMarkup(view);
  element.innerHTML = html;
  element.title = title;
  element.setAttribute(PROGRESS_ATTR, key);
}

/** Remove every node and attribute this plugin added under `root`. */
export function undecorate(root: ParentNode): void {
  for (const owned of root.querySelectorAll(`[${OWNED_ATTR}]`)) owned.remove();
  for (const host of root.querySelectorAll(`[${PROGRESS_HOST_ATTR}]`)) {
    host.removeAttribute(PROGRESS_HOST_ATTR);
  }
}
