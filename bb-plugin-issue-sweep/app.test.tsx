// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app.js"));

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

const OPTIONS = ["Backlog", "Ready", "In Progress", "In Review"];

/** A row in Next by default: on the board, Ready, touched three hours ago. */
function rowFixture(overrides: Record<string, unknown> = {}) {
  return {
    repo: "acme/widgets",
    number: 42,
    title: "Widget rotation drifts after a resize",
    url: "https://github.com/acme/widgets/issues/42",
    labels: ["bug"],
    createdAt: Date.now() - 48 * HOUR,
    updatedAt: Date.now() - 3 * HOUR,
    commentsCount: 2,
    boardStatus: "Ready",
    onBoard: true,
    board: "Acme Board",
    statusOptions: OPTIONS,
    blockedBy: 0,
    closingPr: null,
    subtasks: null,
    parent: null,
    note: null,
    newComments: 0,
    movedAt: null,
    threadId: null,
    canSpawn: true,
    ...overrides,
  };
}

/** The same row in Now, open with its action line, because it has a thread. */
const nowRow = (overrides: Record<string, unknown> = {}) => rowFixture({ threadId: "thr_1", ...overrides });

function listing(overrides: Record<string, unknown> = {}) {
  return {
    rows: [rowFixture()],
    boardStages: OPTIONS,
    staleAfterDays: 7,
    reviewStatus: "In Review",
    countedStatuses: ["Ready", "In Progress"],
    sweptAt: 1_700_000_000_000,
    skippedRepos: [],
    truncated: false,
    lastError: null,
    // No Harvest plugin by default, which is the state the panel has to stay
    // fully usable in.
    harvest: { available: false, running: null },
    ...overrides,
  };
}

const HARVEST_RPC = {
  harvestAssignments: () => ({
    projects: [
      {
        id: 11,
        name: "Internal",
        code: "INT",
        clientName: "Acme",
        tasks: [{ id: 22, name: "Development" }],
      },
    ],
  }),
  harvestTrackedHours: () => ({ hours: 0 }),
  harvestLastSelection: () => null,
  harvestStartTimer: () => ({ entry: null }),
};

let mounted: { lifecycle: { unmount: () => void } } | null = null;

afterEach(() => {
  mounted?.lifecycle.unmount();
  mounted = null;
});

/**
 * Mounts the panel. A fixture's `harvest` is what `harvestState` answers, and
 * the rest is the listing.
 */
function render(result: Record<string, unknown>, extraRpc: Record<string, unknown> = {}) {
  const { harvest, ...rows } = result;
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        listRows: () => rows,
        harvestState: () => harvest ?? { available: false, running: null },
        refresh: () => ({ ok: true, error: null }),
        markSeen: () => ({ ok: true }),
        ...extraRpc,
      },
    },
  );
  mounted = slot;
  return slot;
}

type Slot = ReturnType<typeof render>;

/** Opens every closed row from its chevron, once the list has drawn. */
async function expandAll(slot: Slot) {
  await slot.findAllByRole("link");
  for (const button of slot.queryAllByRole("button", { name: "Expand" })) fireEvent.click(button);
}

/** The list item holding a title, so a query can stay inside one row. */
async function rowFor(slot: Slot, title: RegExp | string) {
  const link = await slot.findByRole("link", { name: title });
  return link.closest("li")! as HTMLElement;
}

/** The titles in the order the list draws them. */
function titles(slot: Slot): string[] {
  return Array.from(slot.container.querySelectorAll("li a"), (link) => link.textContent ?? "").filter(
    (text) => text !== "",
  );
}

describe("panel", () => {
  it("registers one nav panel", () => {
    expect(app.navPanels).toHaveLength(1);
    expect(app.navPanels[0]!.path).toBe("issues");
  });

  it("lists an assigned issue, linked out to GitHub", async () => {
    const slot = render(listing());
    const link = await slot.findByRole("link", { name: "Widget rotation drifts after a resize" });
    expect(link).toHaveAttribute("href", "https://github.com/acme/widgets/issues/42");
    expect(await slot.findByText("#42")).toBeInTheDocument();
  });

  it("shows the age on the number line, and the comment count beside the checklist's bar", async () => {
    const slot = render(
      listing({ rows: [rowFixture({ subtasks: { completed: 8, total: 14, source: "tasks" } })] }),
    );
    const row = await rowFor(slot, /Widget rotation/);
    expect(within(row).getByText("3h ago")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Show 2 comments" })).toHaveTextContent("2");
    expect(within(row).getByText("8/14")).toBeInTheDocument();
    // The bar says it, so the number line does not.
    expect(within(row).queryByText("8/14 tasks")).toBeNull();
    expect(within(row).queryByText("2 comments")).toBeNull();
  });

  it("names the repository only when more than one is in play", async () => {
    const one = render(listing());
    await one.findByText("#42");
    expect(one.queryByText("acme/widgets")).not.toBeInTheDocument();
    one.lifecycle.unmount();

    const many = render(
      listing({
        rows: [rowFixture(), rowFixture({ repo: "acme/gadgets", number: 8, title: "Other" })],
      }),
    );
    expect(await many.findByText("acme/widgets")).toBeInTheDocument();
    expect(await many.findByText("acme/gadgets")).toBeInTheDocument();
  });

  it("says so when nothing is assigned, over the panel's own graphic", async () => {
    const slot = render(listing({ rows: [] }));
    expect(await slot.findByText(/No issues assigned to you/i)).toBeInTheDocument();
    expect(await slot.findByText(/Anything assigned to you shows up here/i)).toBeInTheDocument();
    expect(await slot.findByRole("img", { name: /checklist/i })).toBeInTheDocument();
  });

  it("names the repositories the project filter held back when nothing is left", async () => {
    // Otherwise an empty panel on a machine holding none of your checkouts
    // reads as an empty assignment queue.
    const slot = render(listing({ rows: [], skippedRepos: ["acme/widgets", "acme/gadgets"] }));
    expect(await slot.findByText(/acme\/widgets, acme\/gadgets/)).toBeInTheDocument();
    expect(
      await slot.findByText(/Nothing from the repositories checked out here/i),
    ).toBeInTheDocument();
  });

  it("still names held-back repositories alongside rows that did match", async () => {
    const slot = render(listing({ skippedRepos: ["acme/gadgets"] }));
    expect(await slot.findByRole("note", { name: /Not swept: acme\/gadgets/ })).toBeInTheDocument();
  });

  it("surfaces the last sweep error above the list", async () => {
    const slot = render(listing({ lastError: "`gh` was not found on PATH." }));
    expect(await slot.findByText(/was not found on PATH/i)).toBeInTheDocument();
    // The stale rows stay visible underneath rather than being replaced.
    expect(await slot.findByText(/Widget rotation/i)).toBeInTheDocument();
  });

  it("warns when the search hit its ceiling", async () => {
    const slot = render(listing({ truncated: true }));
    expect(await slot.findByText(/may be incomplete/i)).toBeInTheDocument();
  });

  it("keeps the sync controls out of the body, where the title bar now has them", async () => {
    const slot = render(listing());
    await slot.findByText(/Widget rotation/i);
    expect(slot.queryByRole("button", { name: /Refresh/i })).toBeNull();
    expect(slot.queryByText(/synced/i)).toBeNull();
  });
});

describe("tiers", () => {
  it("opens every row that needs you, and draws the rest as one line each", async () => {
    const slot = render(
      listing({
        rows: [
          rowFixture({ number: 1, title: "Backlog item", boardStatus: "Backlog" }),
          rowFixture({ number: 2, title: "Ready item" }),
          nowRow({ number: 3, title: "Working item" }),
        ],
      }),
    );
    const working = await rowFor(slot, "Working item");
    const ready = await rowFor(slot, "Ready item");
    const later = await rowFor(slot, "Backlog item");

    expect(within(working).getByRole("button", { name: "Open thread" })).toBeInTheDocument();
    expect(within(working).getByRole("button", { name: "Add note" })).toBeInTheDocument();
    expect(within(ready).getByRole("button", { name: "Add note" })).toBeInTheDocument();
    // No reason label over the stage buttons; the squares name the runs.
    expect(within(ready).queryByText("To start")).toBeNull();
    // One line: the age, and nothing else from the number line.
    expect(within(later).getByText("3h ago")).toBeInTheDocument();
    expect(within(later).queryByText("2 comments")).toBeNull();
    expect(within(later).queryByRole("button", { name: "Add note" })).toBeNull();
  });

  it("puts what needs you in one column and the rest in the other", async () => {
    const slot = render(
      listing({
        rows: [
          rowFixture({ number: 1, title: "Backlog item", boardStatus: "Backlog" }),
          rowFixture({ number: 2, title: "Ready item" }),
        ],
      }),
    );
    const mine = await slot.findByRole("region", { name: "Needs you" });
    const rest = slot.getByRole("region", { name: "Everything else" });
    expect(within(mine).getByText("Ready item")).toBeInTheDocument();
    expect(within(rest).getByText("Backlog item")).toBeInTheDocument();
    expect(within(rest).getByRole("heading", { name: "Backlog1" })).toBeInTheDocument();
    expect(within(rest).getByRole("button", { name: "1 backlog" })).toBeInTheDocument();
  });

  it("opens a row in the rest to its note and actions", async () => {
    const slot = render(listing({ rows: [rowFixture({ boardStatus: "Backlog" })] }));
    await expandAll(slot);
    const row = await rowFor(slot, "Widget rotation drifts after a resize");
    expect(within(row).getByRole("button", { name: "Add note" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Start thread" })).toBeInTheDocument();
    // Its stage buttons sit on a line of their own in the narrow column.
    expect(within(row).getByRole("button", { name: "Backlog" })).toHaveAttribute("aria-pressed", "true");
  });

  it("narrows each column to the group pressed in its squares, and back", async () => {
    const slot = render(
      listing({
        rows: [
          rowFixture({ number: 1, title: "Backlog item", boardStatus: "Backlog" }),
          rowFixture({ number: 2, title: "Review item", boardStatus: "In Review" }),
          rowFixture({ number: 3, title: "Ready item" }),
          nowRow({ number: 4, title: "Working item" }),
        ],
      }),
    );
    const mine = await slot.findByRole("group", { name: "Needs you by run" });
    const rest = slot.getByRole("group", { name: "Everything else by status" });

    fireEvent.click(within(mine).getByRole("button", { name: "1 working" }));
    expect(slot.queryByText("Ready item")).toBeNull();
    expect(slot.getByText("Working item")).toBeInTheDocument();
    // The other column is not narrowed.
    expect(slot.getByText("Backlog item")).toBeInTheDocument();

    fireEvent.click(within(rest).getByRole("button", { name: "1 backlog" }));
    expect(slot.queryByText("Review item")).toBeNull();
    expect(slot.getByText("Backlog item")).toBeInTheDocument();

    fireEvent.click(within(rest).getByRole("button", { name: "1 backlog" }));
    expect(slot.getByText("Review item")).toBeInTheDocument();
  });

  it("says so when nothing needs you", async () => {
    const slot = render(listing({ rows: [rowFixture({ boardStatus: "Backlog" })] }));
    expect(await slot.findByText("Nothing needs you right now.")).toBeInTheDocument();
  });

  it("draws Now, then Next, then Later, whatever order the rows arrive in", async () => {
    const slot = render(
      listing({
        rows: [
          rowFixture({ number: 1, title: "Backlog item", boardStatus: "Backlog" }),
          rowFixture({ number: 2, title: "Ready item" }),
          rowFixture({ number: 3, title: "Commented item", newComments: 2, boardStatus: "Backlog" }),
        ],
      }),
    );
    await slot.findByText("Backlog item");
    expect(titles(slot)).toEqual(["Commented item", "Ready item", "Backlog item"]);
  });

  it("shows the new comment count, and the stale and blocked flags", async () => {
    const slot = render(
      listing({
        rows: [
          rowFixture({ number: 1, title: "Commented", newComments: 3 }),
          rowFixture({ number: 2, title: "Untouched", updatedAt: Date.now() - 12 * DAY - HOUR }),
          rowFixture({ number: 3, title: "Waiting on another", blockedBy: 1 }),
        ],
      }),
    );
    expect(await slot.findByText("3 new")).toBeInTheDocument();
    expect(slot.getByText("No activity for 12 days")).toBeInTheDocument();
    // The dot and the red edge say it; no label repeats it over the buttons.
    expect(slot.queryByText("New comments")).toBeNull();
    expect(slot.queryByText("Stale")).toBeNull();
    await expandAll(slot);
    expect(slot.getByText("Blocked by 1 issue")).toBeInTheDocument();
  });

  it("names a single day of inactivity in the singular", async () => {
    const slot = render(
      listing({ staleAfterDays: 1, rows: [rowFixture({ updatedAt: Date.now() - DAY - HOUR })] }),
    );
    expect(await slot.findByText("No activity for 1 day")).toBeInTheDocument();
  });

  it("does not call an issue stale right after it was moved from here", async () => {
    const slot = render(
      listing({ rows: [rowFixture({ updatedAt: Date.now() - 20 * DAY, movedAt: Date.now() - HOUR })] }),
    );
    await rowFor(slot, "Widget rotation drifts after a resize");
    expect(slot.queryByText(/No activity for/)).toBeNull();
  });

  it("shows a sub-issue's parent on its number line", async () => {
    const parent = { number: 140, title: "Widget export, second pass", url: "https://github.com/acme/widgets/issues/140" };
    const slot = render(listing({ rows: [rowFixture({ parent })] }));
    expect(await slot.findByRole("link", { name: "Widget export, second pass" })).toHaveAttribute("href", parent.url);
  });

  it("groups the rest by status, furthest along first, with blocked and off-board issues after", async () => {
    const slot = render(
      listing({
        rows: [
          rowFixture({ number: 1, title: "Off the board", onBoard: false, boardStatus: null }),
          rowFixture({ number: 2, title: "Backlog item", boardStatus: "Backlog" }),
          rowFixture({ number: 3, title: "Blocked item", blockedBy: 1 }),
          rowFixture({ number: 4, title: "Stalled item", boardStatus: "Stalled" }),
          rowFixture({ number: 5, title: "Review item", boardStatus: "In Review" }),
        ],
      }),
    );
    const rest = await slot.findByRole("region", { name: "Everything else" });
    expect(within(rest).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "In Review1",
      "Backlog1",
      "Blocked1",
      "Stalled1",
      "Not on board1",
    ]);
  });

  it("shows a status the stages do not name in its picker, and still sorts it by the rules", async () => {
    const slot = render(
      listing({
        rows: [
          rowFixture({ number: 1, title: "Ready item" }),
          nowRow({ number: 2, title: "Stalled item", boardStatus: "Stalled" }),
        ],
      }),
    );
    const stalled = await rowFor(slot, "Stalled item");
    expect(within(stalled).getByLabelText("Board status for #2")).toHaveValue("Stalled");
    // It has a thread, so it is working, above the row still to start.
    expect(titles(slot)).toEqual(["Stalled item", "Ready item"]);
  });
});

describe("status picker", () => {
  it("moves an issue to the stage whose button was pressed", async () => {
    const calls: unknown[] = [];
    const slot = render(listing(), {
      setBoardStatus: (input: unknown) => {
        calls.push(input);
        return { ok: true, added: false, error: null };
      },
    });

    const stages = await slot.findByRole("group", { name: "Stages for #42" });
    expect(within(stages).getByRole("button", { name: "Ready" })).toHaveAttribute("aria-pressed", "true");
    // Pressing the current stage moves nothing.
    fireEvent.click(within(stages).getByRole("button", { name: "Ready" }));
    fireEvent.click(within(stages).getByRole("button", { name: "In Progress" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    // By name, never by option id: the ids are the board's private node ids.
    expect(calls[0]).toEqual({ repo: "acme/widgets", number: 42, status: "In Progress" });
  });

  it("offers every status the board has behind the last segment", async () => {
    const calls: unknown[] = [];
    const slot = render(listing({ rows: [rowFixture({ statusOptions: [...OPTIONS, "Stalled"] })] }), {
      setBoardStatus: (input: unknown) => {
        calls.push(input);
        return { ok: true, added: false, error: null };
      },
    });
    fireEvent.change(await slot.findByLabelText("Board status for #42"), { target: { value: "Stalled" } });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ repo: "acme/widgets", number: 42, status: "Stalled" });
  });

  it("offers to add an issue that is on no board, and sends the picked status", async () => {
    const calls: unknown[] = [];
    const slot = render(listing({ rows: [rowFixture({ onBoard: false, boardStatus: null })] }), {
      setBoardStatus: (input: unknown) => {
        calls.push(input);
        return { ok: true, added: true, error: null };
      },
    });
    await expandAll(slot);
    expect(await slot.findByText("Add to board")).toBeInTheDocument();

    fireEvent.change(slot.getByLabelText("Board status for #42"), { target: { value: "Ready" } });

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ repo: "acme/widgets", number: 42, status: "Ready" });
  });

  it("offers the picker for a status the stages do not name, so the issue can be moved back", async () => {
    const calls: unknown[] = [];
    const slot = render(listing({ rows: [rowFixture({ boardStatus: "Stalled" })] }), {
      setBoardStatus: (input: unknown) => {
        calls.push(input);
        return { ok: true, added: false, error: null };
      },
    });
    await expandAll(slot);
    const picker = await slot.findByLabelText("Board status for #42");
    expect(picker).toHaveValue("Stalled");

    fireEvent.change(picker, { target: { value: "Ready" } });

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ repo: "acme/widgets", number: 42, status: "Ready" });
  });

  it("draws only the stages the row's own board has", async () => {
    // A second board with its own columns: In Progress is shared, the rest are not.
    const slot = render(
      listing({
        rows: [nowRow({ board: "Octocat's Board", statusOptions: ["Todo", "In Progress", "Done"], boardStatus: "Todo" })],
      }),
    );
    const stages = await slot.findByRole("group", { name: "Stages for #42" });
    expect(within(stages).getByRole("button", { name: "In Progress" })).toBeInTheDocument();
    expect(within(stages).queryByRole("button", { name: "Ready" })).toBeNull();
    expect(within(stages).queryByRole("button", { name: "In Review" })).toBeNull();
  });

  it("does not offer to add an issue already on the board with no status", async () => {
    // Adding it again would be a no-op, and the label would be a lie.
    const slot = render(listing({ rows: [rowFixture({ onBoard: true, boardStatus: null })] }));
    await expandAll(slot);
    expect(await slot.findByRole("option", { name: "No status" })).toBeInTheDocument();
    expect(slot.queryByText("Add to board")).toBeNull();
  });

  it("falls back to plain text when the board could not be read", async () => {
    const slot = render(listing({ rows: [rowFixture({ statusOptions: [], onBoard: false, boardStatus: null })] }));
    await expandAll(slot);
    expect(await slot.findByText("Add to board")).toBeInTheDocument();
    expect(slot.queryByLabelText("Board status for #42")).toBeNull();
  });
});

describe("notes", () => {
  it("shows the note in an open row", async () => {
    const slot = render(listing({ rows: [nowRow({ note: "Ask hubber about the resize case" })] }));
    expect(await slot.findByText("Ask hubber about the resize case")).toBeInTheDocument();
    expect(slot.getByRole("button", { name: "Edit note" })).toBeInTheDocument();
  });

  it("saves an edited note for that row, then reloads the listing", async () => {
    const calls: unknown[] = [];
    let loads = 0;
    const slot = render(listing(), {
      listRows: () => {
        loads += 1;
        return listing({ rows: [nowRow()] });
      },
      setNote: (input: unknown) => {
        calls.push(input);
        return { ok: true };
      },
    });

    fireEvent.click(await slot.findByRole("button", { name: "Add note" }));
    const field = slot.getByRole("textbox", { name: "Note" });
    fireEvent.change(field, { target: { value: "  Reply to octocat  " } });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ repo: "acme/widgets", number: 42, body: "Reply to octocat", onHold: false });
    await waitFor(() => expect(loads).toBe(2));
    await waitFor(() => expect(slot.queryByRole("textbox", { name: "Note" })).toBeNull());
  });

  it("puts the issue on hold from the note editor's checkbox", async () => {
    const calls: unknown[] = [];
    const slot = render(listing({ rows: [nowRow()] }), {
      setNote: (input: unknown) => {
        calls.push(input);
        return { ok: true };
      },
    });

    fireEvent.click(await slot.findByRole("button", { name: "Add note" }));
    fireEvent.change(slot.getByRole("textbox", { name: "Note" }), { target: { value: "Waiting on #31" } });
    fireEvent.click(slot.getByRole("checkbox", { name: "On hold" }));
    fireEvent.click(slot.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ repo: "acme/widgets", number: 42, body: "Waiting on #31", onHold: true });
  });

  it("clears the note and the hold from the note's clear button", async () => {
    const calls: unknown[] = [];
    const slot = render(listing({ rows: [nowRow({ note: "Waiting on #31", onHold: true })] }), {
      setNote: (input: unknown) => {
        calls.push(input);
        return { ok: true };
      },
    });

    // A held issue is one closed line until it is opened.
    fireEvent.click(await slot.findByRole("button", { name: "Expand" }));
    fireEvent.click(await slot.findByRole("button", { name: "Clear note" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ repo: "acme/widgets", number: 42, body: "", onHold: false });
  });

  it("closes a held issue to one line that shows its note", async () => {
    const slot = render(listing({ rows: [nowRow({ note: "Waiting on #31", onHold: true })] }));
    expect(await slot.findByText("Waiting on #31")).toBeInTheDocument();
    expect(slot.queryByRole("button", { name: "Edit note" })).toBeNull();
  });

  it("says On hold before the note of a held issue once it is opened", async () => {
    const slot = render(listing({ rows: [nowRow({ note: "Waiting on #31", onHold: true })] }));
    fireEvent.click(await slot.findByRole("button", { name: "Expand" }));
    expect(await slot.findByText("On hold")).toBeInTheDocument();
    expect(slot.getByText("Waiting on #31")).toBeInTheDocument();
  });
});

describe("seen comments", () => {
  it("marks the issue seen when its title is clicked", async () => {
    const calls: unknown[] = [];
    const slot = render(listing({ rows: [rowFixture({ newComments: 2 })] }), {
      markSeen: (input: unknown) => {
        calls.push(input);
        return { ok: true };
      },
    });
    const link = await slot.findByRole("link", { name: /Widget rotation/ });
    // jsdom cannot follow a link, and says so loudly.
    link.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(link);
    await waitFor(() => expect(calls).toEqual([{ repo: "acme/widgets", number: 42 }]));
  });

  it("logs a failed markSeen rather than leaving the rejection unhandled", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const slot = render(listing({ rows: [rowFixture({ newComments: 2 })] }), {
        markSeen: () => {
          throw new Error("server went away");
        },
      });
      const link = await slot.findByRole("link", { name: /Widget rotation/ });
      link.addEventListener("click", (event) => event.preventDefault());
      fireEvent.click(link);
      await waitFor(() => expect(warn).toHaveBeenCalled());
    } finally {
      warn.mockRestore();
    }
  });

  it("records the count on every open, even with nothing new showing", async () => {
    const calls: unknown[] = [];
    const slot = render(listing({ rows: [nowRow({ newComments: 0 })] }), {
      markSeen: (input: unknown) => {
        calls.push(input);
        return { ok: true };
      },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Open thread" }));
    await waitFor(() => expect(calls).toEqual([{ repo: "acme/widgets", number: 42 }]));
  });

  it("reads the comments when the comment count is clicked, marks the new ones, and marks the issue seen", async () => {
    const commentCalls: unknown[] = [];
    const seenCalls: unknown[] = [];
    const slot = render(listing({ rows: [nowRow({ commentsCount: 2, newComments: 1 })] }), {
      listComments: (input: unknown) => {
        commentCalls.push(input);
        return {
          entries: [
            { kind: "comment", author: "octocat", avatarUrl: "", body: "Seen this one before.", url: "u1", at: Date.now() - 5 * HOUR },
            { kind: "comment", author: "hubber", avatarUrl: "", body: "It drifts on every second resize.", url: "u2", at: Date.now() - HOUR },
          ],
          total: 2,
          error: null,
        };
      },
      markSeen: (input: unknown) => {
        seenCalls.push(input);
        return { ok: true };
      },
    });
    const row = await rowFor(slot, /Widget rotation/);
    expect(commentCalls).toEqual([]);

    fireEvent.click(within(row).getByRole("button", { name: "Show 2 comments" }));
    const newest = await within(row).findByText("It drifts on every second resize.");
    expect(within(newest.closest("li")!).getByText("new")).toBeInTheDocument();
    const older = within(row).getByText("Seen this one before.");
    expect(within(older.closest("li")!).queryByText("new")).toBeNull();
    expect(commentCalls).toEqual([{ repo: "acme/widgets", number: 42 }]);
    await waitFor(() => expect(seenCalls).toEqual([{ repo: "acme/widgets", number: 42 }]));

    fireEvent.click(within(row).getByRole("button", { name: "Hide 2 comments" }));
    expect(within(row).queryByText("It drifts on every second resize.")).toBeNull();
  });

  it("says so in the drawer when GitHub could not be read, and leaves the issue unseen", async () => {
    const seenCalls: unknown[] = [];
    const slot = render(listing({ rows: [nowRow({ newComments: 1 })] }), {
      listComments: () => ({ entries: [], total: 0, error: "Could not read the comments from GitHub." }),
      markSeen: (input: unknown) => {
        seenCalls.push(input);
        return { ok: true };
      },
    });
    const row = await rowFor(slot, /Widget rotation/);
    fireEvent.click(within(row).getByRole("button", { name: "Show 2 comments" }));
    expect(await within(row).findByText("Could not read the comments from GitHub.")).toBeInTheDocument();
    expect(seenCalls).toEqual([]);
  });

  it("marks the issue seen when its thread is opened", async () => {
    const calls: unknown[] = [];
    const slot = render(listing({ rows: [nowRow({ newComments: 2 })] }), {
      markSeen: (input: unknown) => {
        calls.push(input);
        return { ok: true };
      },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Open thread" }));
    await waitFor(() => expect(calls).toEqual([{ repo: "acme/widgets", number: 42 }]));
  });
});

/** What `startThreadDraft` hands the composer. */
const SEED = {
  projectId: "proj_widgets",
  providerId: "claude-code",
  model: null,
  permissionMode: "full" as const,
  prompt: "Work on acme/widgets#1.",
  preview: {
    title: "Add the widget endpoint",
    number: 1,
    url: "https://github.com/acme/widgets/issues/1",
    meta: "acme/widgets · Ready",
  },
  environment: {
    type: "host" as const,
    workspace: {
      type: "managed-worktree" as const,
      baseBranch: { kind: "default" as const },
    },
  },
};

describe("thread action", () => {
  /** Opens every row, so a Next row shows its action line. */
  async function expanded(slot: Slot) {
    await expandAll(slot);
    return slot;
  }

  it("offers to start a thread when the issue has none", async () => {
    const slot = await expanded(render(listing()));
    expect(slot.getByRole("button", { name: "Start thread" })).toBeEnabled();
  });

  it("offers to open the thread once one exists", async () => {
    const slot = render(listing({ rows: [nowRow()] }));
    expect(await slot.findByRole("button", { name: "Open thread" })).toBeInTheDocument();
    expect(slot.queryByRole("button", { name: "Start thread" })).toBeNull();
  });

  it("will not offer to start one for a repository with no checkout", async () => {
    // The spawn would fail on the server; a disabled button says so up front.
    const slot = await expanded(render(listing({ rows: [rowFixture({ canSpawn: false })] })));
    expect(slot.getByRole("button", { name: "No project here" })).toBeDisabled();
  });

  it("asks for a draft for the issue that was clicked", async () => {
    const calls: unknown[] = [];
    const slot = await expanded(
      render(
        listing({
          rows: [
            rowFixture({ number: 1, title: "First", updatedAt: Date.now() - HOUR }),
            rowFixture({ number: 2, title: "Second", updatedAt: Date.now() - 2 * HOUR }),
          ],
        }),
        {
          startThreadDraft: (input: unknown) => {
            calls.push(input);
            return { existingThreadId: null, reason: null, seed: SEED };
          },
        },
      ),
    );

    fireEvent.click(within(await rowFor(slot, "Second")).getByRole("button", { name: "Start thread" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ repo: "acme/widgets", number: 2 });
  });

  it("opens the box under the row, rather than spawning, and closes it on a second click", async () => {
    const slot = await expanded(
      render(listing({ rows: [rowFixture({ number: 7, title: "Second" })] }), {
        startThreadDraft: () => ({ existingThreadId: null, reason: null, seed: SEED }),
      }),
    );

    fireEvent.click(slot.getByRole("button", { name: "Start thread" }));

    expect(await slot.findByRole("region", { name: "Start a thread" })).toBeInTheDocument();
    expect(slot.inspection.rpcCalls.some((call) => call.method === "startThreadSubmit")).toBe(false);
    // The composer has a Start thread button of its own; the row's is the one that expands.
    fireEvent.click(slot.getByRole("button", { name: "Start thread", expanded: true }));
    await waitFor(() => expect(slot.queryByRole("region", { name: "Start a thread" })).toBeNull());
  });

  it("refuses without opening the composer when the server says why", async () => {
    const slot = await expanded(
      render(listing(), {
        startThreadDraft: () => ({
          existingThreadId: null,
          reason: "No bb project is checked out for acme/widgets.",
          seed: null,
        }),
      }),
    );

    fireEvent.click(slot.getByRole("button", { name: "Start thread" }));

    await waitFor(() => expect(slot.queryByText(/^Start a thread for/)).toBeNull());
  });

  it("disables the button while the draft is in flight", async () => {
    // A second click before the first returns is how two threads got created
    // for one row in pr-sweep.
    let release: (() => void) | null = null;
    const slot = await expanded(
      render(listing(), {
        startThreadDraft: () =>
          new Promise((resolve) => {
            release = () => resolve({ existingThreadId: null, reason: null, seed: SEED });
          }),
      }),
    );

    fireEvent.click(slot.getByRole("button", { name: "Start thread" }));

    await waitFor(() => expect(slot.getByRole("button", { name: "Starting…" })).toBeDisabled());
    release?.();
  });

  it("copies the issue's link from the action line", async () => {
    const slot = render(listing({ rows: [nowRow()] }));
    expect(await slot.findByRole("button", { name: "Copy link" })).toBeInTheDocument();
  });
});

describe("sync header", () => {
  function renderHeader(result: Record<string, unknown>, extraRpc: Record<string, unknown> = {}) {
    const slot = renderSlot(
      { component: app.navPanels[0]!.headerContent! },
      { subPath: "" },
      { rpc: { listRows: () => result, refresh: () => ({ ok: true, error: null }), ...extraRpc } },
    );
    mounted = slot;
    return slot;
  }

  it("says how long ago the sweep landed, relatively", async () => {
    // Relative, because the question the header answers is "is this current",
    // not "what time is it".
    const slot = renderHeader(listing({ sweptAt: Date.now() - 4 * 60_000 }));
    expect(await slot.findByText("synced 4m ago")).toBeInTheDocument();
  });

  it("says so before the first sweep rather than showing a bogus age", async () => {
    const slot = renderHeader(listing({ sweptAt: null }));
    expect(await slot.findByText("not synced yet")).toBeInTheDocument();
  });

  it("refreshes on demand", async () => {
    let refreshes = 0;
    const slot = renderHeader(listing(), {
      refresh: () => {
        refreshes += 1;
        return { ok: true, error: null };
      },
    });

    fireEvent.click(await slot.findByRole("button", { name: /Refresh/i }));
    await waitFor(() => expect(refreshes).toBe(1));
  });
});


describe("harvest", () => {
  const available = (extra: Record<string, unknown> = {}, rows = [nowRow()]) =>
    listing({ rows, harvest: { available: true, running: null, ...extra } });

  it("offers no clock when the Harvest plugin is not installed", async () => {
    const slot = render(listing({ rows: [nowRow()] }));
    await slot.findByRole("button", { name: "Open thread" });

    // Issue Sweep has to stay fully useful with no Harvest plugin present.
    expect(slot.queryByRole("button", { name: /track time/i })).toBeNull();
  });

  it("offers a clock on an open row when Harvest is available", async () => {
    const slot = render(available(), HARVEST_RPC);
    expect(await slot.findByRole("button", { name: /track time for #42/i })).toBeTruthy();
  });

  it("marks the row whose timer is running", async () => {
    const slot = render(available({ running: { externalId: "42", groupId: "widgets" } }), HARVEST_RPC);
    expect(await slot.findByRole("button", { name: /timer running for #42/i })).toBeTruthy();
  });

  it("keeps the row whose timer is running open, even when its tier would close it", async () => {
    // A Next row, which is closed to its number line by default.
    const slot = render(available({ running: { externalId: "42", groupId: "widgets" } }, [rowFixture()]), HARVEST_RPC);
    expect(await slot.findByRole("button", { name: /timer running for #42/i })).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Collapse" })).toBeNull();
  });

  it("leaves other rows unmarked when a timer runs on one of them", async () => {
    const slot = render(
      available({ running: { externalId: "42", groupId: "widgets" } }, [
        nowRow(),
        nowRow({ number: 43, title: "Another issue", threadId: "thr_2" }),
      ]),
      HARVEST_RPC,
    );

    await slot.findByRole("button", { name: /timer running for #42/i });
    expect(slot.getByRole("button", { name: /track time for #43/i })).toBeTruthy();
  });

  it("does not mark a row when the running timer is for the same number in another repo", async () => {
    // Harvest can only filter references by id, so the group has to be part
    // of the comparison or every repo's #42 would light up together.
    const slot = render(available({ running: { externalId: "42", groupId: "other-repo" } }), HARVEST_RPC);

    await slot.findByRole("button", { name: /track time for #42/i });
    expect(slot.queryByRole("button", { name: /timer running/i })).toBeNull();
  });
});

describe("loading state", () => {
  // Never resolves, so the panel stays in the state it shows before its rows
  // arrive.
  const pending = () => new Promise<never>(() => {});

  it("draws its own subject rather than a spinner", async () => {
    const slot = render({} as Record<string, unknown>, { listRows: pending });
    const frame = await slot.findByRole("status");
    expect(frame).toHaveAttribute("aria-busy", "true");
    expect(await slot.findByRole("img", { name: "A board filling one column at a time" })).toBeInTheDocument();
  });

  it("says what it is doing once, in the panel's own words", async () => {
    const slot = render({} as Record<string, unknown>, { listRows: pending });
    // role="status" carries the caption to a screen reader, so there is no
    // second hidden copy of it to read out.
    expect(await slot.findByText("Sweeping your board")).toBeInTheDocument();
    expect(slot.queryByText("Loading…")).toBeNull();
  });
});

