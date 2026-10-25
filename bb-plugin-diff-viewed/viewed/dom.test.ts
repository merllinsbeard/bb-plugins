// @vitest-environment jsdom
//
// The fixture below mirrors the card header bb 0.47 renders, Viewed checkbox
// included. It is the contract this plugin depends on: if a bb upgrade changes
// the card header, these tests are where that shows up, and the fix is to
// re-read the changes panel in app/dist/assets and update both the fixture and
// viewed/dom.ts together.
import { afterEach, describe, expect, it } from "vitest";
import {
  findToolbar,
  findViewedBoxes,
  paintSyncIcon,
  renderProgress,
  undecorate,
  OWNED_ATTR,
} from "./dom";

interface CardOptions {
  label: string;
  checked?: boolean;
  disabled?: boolean;
  /** Renders the card as a timeline diff instead of a changes-panel one. */
  timeline?: boolean;
}

function renderCard(options: CardOptions): HTMLElement {
  const { label, checked = false, disabled = false, timeline = false } = options;
  const host = document.createElement("div");
  if (timeline) host.setAttribute("data-timeline-file-diff", "");
  host.innerHTML = `
    <div class="flex w-full min-w-0 items-center justify-between gap-2">
      <span class="flex min-w-0 items-center">
        <button type="button" aria-label="Collapse ${label}" aria-expanded="true"></button>
        <span class="font-mono">${label}</span>
      </span>
      <span class="ml-auto flex shrink-0 items-center gap-2">
        <span class="whitespace-nowrap text-xs">+8 -4</span>
        <label class="ml-1 flex shrink-0 cursor-pointer items-center gap-1.5 border-l border-border pl-3">
          <button type="button" role="checkbox" aria-checked="${checked}"
            data-state="${checked ? "checked" : "unchecked"}" value="on"
            ${disabled ? 'disabled="" data-disabled=""' : ""}
            aria-label="Viewed ${label}"></button>
          <span>Viewed</span>
        </label>
      </span>
    </div>`;
  document.body.append(host);
  return host;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("findViewedBoxes", () => {
  it("reads each checkbox's file and state", () => {
    renderCard({ label: "src/a.ts", checked: true });
    renderCard({ label: "src/old.ts -> src/new.ts" });
    expect(findViewedBoxes(document).map(({ label, checked }) => ({ label, checked }))).toEqual([
      { label: "src/a.ts", checked: true },
      { label: "src/old.ts -> src/new.ts", checked: false },
    ]);
  });

  it("reports a checkbox bb has not enabled yet", () => {
    renderCard({ label: "a.ts", disabled: true });
    expect(findViewedBoxes(document)[0]?.disabled).toBe(true);
  });

  it("skips timeline diffs", () => {
    renderCard({ label: "a.ts", timeline: true });
    expect(findViewedBoxes(document)).toEqual([]);
  });

  it("ignores a checkbox that is not a Viewed checkbox", () => {
    document.body.innerHTML = `<label><button role="checkbox" data-state="checked" aria-label="Wrap lines"></button></label>`;
    expect(findViewedBoxes(document)).toEqual([]);
  });
});

describe("paintSyncIcon", () => {
  it("puts one icon after bb's checkbox, however often it is painted", () => {
    renderCard({ label: "a.ts" });
    const box = findViewedBoxes(document)[0]!;
    paintSyncIcon(box, { kind: "none" });
    paintSyncIcon(box, { kind: "local", number: 42 });
    const icons = document.querySelectorAll(`[${OWNED_ATTR}]`);
    expect(icons).toHaveLength(1);
    expect(box.control.nextElementSibling).toBe(icons[0]);
  });

  it("shows Local, a spinner while waiting, and nothing for a synced file", () => {
    renderCard({ label: "a.ts" });
    const box = findViewedBoxes(document)[0]!;
    const icon = () => box.control.nextElementSibling as HTMLElement;

    paintSyncIcon(box, { kind: "pending" });
    expect(icon().getAttribute("aria-label")).toBe("Loading");

    paintSyncIcon(box, { kind: "local", number: 42 });
    expect(icon().getAttribute("aria-label")).toBe("Local");
    expect(icon().title).toContain("pull request #42");

    paintSyncIcon(box, {
      kind: "synced",
      number: 42,
      file: { path: "a.ts", additions: 8, deletions: 4, viewed: true },
    });
    expect(icon().getAttribute("aria-label")).toBeNull();
    expect(icon().innerHTML).toBe("");
    expect(icon().title).toBe("Synced with the Viewed box on pull request #42");
  });
});

/**
 * The changes-panel toolbar as bb renders it above the file cards: its
 * summary and actions, inside the details group the progress line joins.
 */
function renderToolbar(): HTMLElement {
  const details = document.createElement("div");
  details.setAttribute("data-testid", "git-diff-toolbar-details");
  details.innerHTML = `
    <span data-testid="git-diff-toolbar-summary">2 files, <span>+8 -4</span></span>
    <div data-testid="git-diff-toolbar-actions">
      <button type="button" aria-label="Collapse all files"></button>
    </div>`;
  document.body.append(details);
  return details;
}

describe("findToolbar", () => {
  it("finds the toolbar", () => {
    renderToolbar();
    expect(findToolbar(document)).not.toBeNull();
  });

  it("returns null when there is no changes toolbar on the page", () => {
    expect(findToolbar(document)).toBeNull();
  });
});

describe("renderProgress", () => {
  it("shows the count above bb's summary", () => {
    renderToolbar();
    renderProgress(document, { kind: "progress", viewed: 1, total: 2 });
    const line = document.querySelector("[data-diff-viewed-progress]") as HTMLElement;
    expect(line.textContent).toBe("1/2 viewed");
    expect(line.title).toBe("1 of 2 files viewed");
  });

  it("says when the file list could not be read", () => {
    renderToolbar();
    renderProgress(document, { kind: "unavailable", reason: "no files" });
    expect(document.querySelector("[data-diff-viewed-progress]")?.textContent).toBe(
      "Viewed progress unavailable",
    );
  });

  it("removes the line again", () => {
    renderToolbar();
    renderProgress(document, { kind: "progress", viewed: 1, total: 2 });
    renderProgress(document, null);
    expect(document.querySelector("[data-diff-viewed-progress]")).toBeNull();
  });
});

describe("undecorate", () => {
  it("leaves bb's own DOM exactly as it found it", () => {
    renderToolbar();
    renderCard({ label: "a.ts" });
    const before = document.body.innerHTML;
    paintSyncIcon(findViewedBoxes(document)[0]!, { kind: "none" });
    renderProgress(document, { kind: "progress", viewed: 0, total: 1 });
    expect(document.body.innerHTML).not.toBe(before);

    undecorate(document.body);
    expect(document.body.innerHTML).toBe(before);
  });
});
