// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const app = await loadPluginApp(() => import("./app.js"));

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** A row in Now by default: a merge conflict, which needs you. */
function rowFixture(overrides: Record<string, unknown> = {}) {
  return {
    repo: "acme/widgets",
    number: 42,
    title: "Add the widget endpoint",
    url: "https://github.com/acme/widgets/pull/42",
    isDraft: false,
    flags: ["conflict"],
    group: "needs-action",
    checks: { pass: 3, fail: 0, skip: 1, pending: 0, cancelled: 0, total: 4 },
    approvedBy: [],
    commentedBy: [],
    waitingOn: [],
    awaitingReReview: false,
    lastCommentBy: null,
    unresolvedThreads: 0,
    outdatedThreads: 0,
    notedBy: [],
    canSpawn: true,
    threadId: null,
    threadIds: [],
    updatedAt: Date.now() - 3 * HOUR,
    commentsCount: 2,
    note: null,
    newComments: 0,
    ...overrides,
  };
}

/** Unflagged with a reviewer outstanding: awaiting review, so in Later. */
const waitingRow = (overrides: Record<string, unknown> = {}) =>
  rowFixture({ flags: [], group: "clean", waitingOn: ["hubber"], ...overrides });

/**
 * A row with several threads, the way the server stamps one: `threadId` is the
 * newest and `threadIds` lists every one, newest first, including it.
 */
function rowWithThreads(threadIds: string[], overrides: Record<string, unknown> = {}) {
  return rowFixture({ threadId: threadIds[0] ?? null, threadIds, ...overrides });
}

function listing(overrides: Record<string, unknown> = {}) {
  return {
    rows: [rowFixture()],
    staleAfterDays: 3,
    sweptAt: 1_700_000_000_000,
    failedRepos: [],
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
    app.navPanels.find((panel) => panel.id === "prs")!,
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
  it("registers one list panel and the Open pull request page", () => {
    expect(app.navPanels.map((panel) => panel.id).sort()).toEqual(["open-pr", "prs"]);
    expect(app.navPanels.find((panel) => panel.id === "prs")!.path).toBe("prs");
  });

  it("lists a pull request, linked out to GitHub", async () => {
    const slot = render(listing());
    const link = await slot.findByRole("link", { name: "Add the widget endpoint" });
    expect(link).toHaveAttribute("href", "https://github.com/acme/widgets/pull/42");
    expect(await slot.findByText("#42")).toBeInTheDocument();
  });

  it("shows the age on the title line, then reviewers, checks, and size as icons, in that order", async () => {
    const slot = render(
      listing({
        rows: [rowFixture({ approvedBy: ["hubber"], waitingOn: ["octocat"], additions: 128, deletions: 12 })],
      }),
    );
    const row = await rowFor(slot, /Add the widget endpoint/);
    expect(within(row).getByText("3h ago")).toBeInTheDocument();
    const parts = Array.from(row.querySelectorAll("[data-part]"), (part) => part.getAttribute("data-part"));
    expect(parts).toEqual(["reviewers", "checks", "diff"]);
    expect(within(row).getByRole("img", { name: "Reviewers: octocat review pending, hubber approved" })).toBeInTheDocument();
    const checks = row.querySelector('[data-part="checks"]')!;
    expect(checks).toHaveTextContent("3/3");
    expect(checks.querySelector('[data-icon="CircleCheck"]')).toHaveClass("text-success");
    expect(row.querySelector('[data-part="diff"]')).toHaveTextContent("+128 −12");
    // The sentences the icons replace are gone.
    expect(within(row).queryByText("3 pass, 1 skip")).toBeNull();
    expect(within(row).queryByText(/approved by hubber/)).toBeNull();
  });

  it("counts failing and cancelled checks in red, running ones with a clock, says no reviewer, and leaves out what it does not have", async () => {
    const slot = render(
      listing({
        rows: [
          rowFixture({ number: 1, title: "Failing", flags: ["ci-failing"], checks: { pass: 5, fail: 2, skip: 1, pending: 0, cancelled: 0, total: 8 } }),
          rowFixture({ number: 2, title: "No checks", flags: ["ci-absent"], checks: { pass: 0, fail: 0, skip: 0, pending: 0, cancelled: 0, total: 0 } }),
          rowFixture({ number: 3, title: "Cancelled", flags: ["ci-cancelled"], checks: { pass: 6, fail: 0, skip: 0, pending: 0, cancelled: 1, total: 7 } }),
          rowFixture({ number: 4, title: "Running", flags: ["ci-pending"], checks: { pass: 2, fail: 0, skip: 0, pending: 3, cancelled: 0, total: 5 } }),
        ],
      }),
    );
    const failing = await rowFor(slot, "Failing");
    const checks = failing.querySelector('[data-part="checks"]')!;
    expect(checks).toHaveTextContent("2/7 failing");
    expect(checks.querySelector('[data-icon="CircleX"]')).toHaveClass("text-destructive-text");
    expect(failing.querySelector('[data-part="reviewers"]')).toHaveTextContent("no reviewer");
    expect(failing.querySelector('[data-part="diff"]')).toBeNull();

    const cancelled = await rowFor(slot, "Cancelled");
    expect(cancelled.querySelector('[data-part="checks"] [data-icon="CircleX"]')).toHaveClass("text-destructive-text");
    expect(cancelled.querySelector('[data-part="checks"]')).toHaveTextContent("1/7 cancelled");

    const running = await rowFor(slot, "Running");
    expect(running.querySelector('[data-part="checks"] [data-icon="Clock"]')).not.toBeNull();

    const none = await rowFor(slot, "No checks");
    expect(none.querySelector('[data-part="checks"]')).toBeNull();
  });

  it("marks an open pull request with a green icon and a draft with a muted one", async () => {
    const slot = render(
      listing({
        rows: [
          rowFixture({ number: 1, title: "Open one" }),
          rowFixture({ number: 2, title: "Draft one", isDraft: true, flags: [], group: "clean" }),
        ],
      }),
    );
    expect(within(await rowFor(slot, "Open one")).getByLabelText("Open pull request")).toHaveClass("text-success");
    expect(within(await rowFor(slot, "Draft one")).getByLabelText("Draft pull request")).toHaveClass(
      "text-muted-foreground",
    );
  });

  it("warns after the title of a pull request that conflicts with its base", async () => {
    const slot = render(
      listing({
        rows: [
          rowFixture({ number: 1, title: "Conflicted one", flags: ["conflict"] }),
          rowFixture({ number: 2, title: "Clean one", flags: [], group: "clean" }),
        ],
      }),
    );
    expect(within(await rowFor(slot, "Conflicted one")).getByLabelText("Merge conflict")).toBeInTheDocument();
    expect(within(await rowFor(slot, "Clean one")).queryByLabelText("Merge conflict")).not.toBeInTheDocument();
  });

  it("names the repository only when more than one is in play", async () => {
    const one = render(listing());
    const row = await rowFor(one, /Add the widget endpoint/);
    expect(within(row).queryByText("acme/widgets")).toBeNull();
    one.lifecycle.unmount();

    const two = render(
      listing({
        rows: [
          rowFixture({ number: 1, title: "Widgets row" }),
          rowFixture({ number: 2, title: "Gadgets row", repo: "acme/gadgets" }),
        ],
      }),
    );
    expect(within(await rowFor(two, "Gadgets row")).getByText("acme/gadgets")).toBeInTheDocument();
  });

  it("says so when nothing is open, over the panel's own graphic", async () => {
    const slot = render(listing({ rows: [] }));
    await slot.findByText(/No open pull requests/i);
    await slot.findByText(/Anything you open shows up here/i);
    await slot.findByRole("img", { name: /merged back into the trunk/i });
  });

  it("names the repositories the project filter held back", async () => {
    // Otherwise an empty panel reads as "you have no open pull requests" on
    // the machine where none of your repositories are checked out.
    const slot = render(listing({ rows: [], skippedRepos: ["acme/widgets", "acme/gadgets"] }));
    await slot.findByText(/acme\/widgets/);
    await slot.findByText(/acme\/gadgets/);
    // The headline moves with it: "No open pull requests" is untrue on a
    // machine that simply cannot see the ones you have open.
    await slot.findByText(/Nothing from the repositories checked out here/i);
    expect(slot.queryByText(/^No open pull requests\.$/)).toBeNull();
  });

  it("puts a mention of held-back repositories below the list, not above it", async () => {
    // A standing fact about this machine, not news. Above the list it would
    // push the work down the page on every load.
    const slot = render(listing({ skippedRepos: ["acme/gadgets"] }));
    const notice = await slot.findByRole("note", { name: /Not swept: acme\/gadgets/ });
    const list = (await rowFor(slot, /Add the widget endpoint/)).closest("ul")!;
    expect(list.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("surfaces a sweep error without blanking the rows", async () => {
    const slot = render(listing({ lastError: "`gh` is not authenticated. Run `gh auth login`." }));
    await slot.findByText(/gh auth login/);
    await slot.findByText(/Add the widget endpoint/);
  });

  it("warns when the sweep hit the 100-PR ceiling", async () => {
    const slot = render(listing({ truncated: true }));
    await slot.findByText(/100 pull request ceiling/i);
  });

  it("names a repository it could not refresh", async () => {
    const slot = render(listing({ failedRepos: ["acme/gadgets"] }));
    await slot.findByText(/Could not refresh acme\/gadgets/);
  });
});

describe("tiers", () => {
  it("keeps every row open but the waiting ones, which close to one line", async () => {
    const slot = render(
      listing({
        rows: [
          waitingRow({ number: 1, title: "Waiting item" }),
          rowFixture({ number: 2, title: "Draft item", flags: [], group: "clean", isDraft: true }),
          rowFixture({ number: 3, title: "Conflict item" }),
        ],
      }),
    );
    for (const title of ["Conflict item", "Draft item"]) {
      const row = await rowFor(slot, title);
      expect(within(row).getByText("3/3")).toBeInTheDocument();
      expect(within(row).getByRole("button", { name: "Add note" })).toBeInTheDocument();
      expect(within(row).queryByRole("button", { name: /^(Collapse|Expand)$/ })).toBeNull();
    }
    // The waiting row's line keeps its checks, and opens to its actions.
    const waiting = await rowFor(slot, "Waiting item");
    expect(within(waiting).getByText("3/3")).toBeInTheDocument();
    expect(within(waiting).queryByRole("button", { name: "Add note" })).toBeNull();
    fireEvent.click(within(waiting).getByRole("button", { name: "Expand" }));
    expect(await within(await rowFor(slot, "Waiting item")).findByRole("button", { name: "Add note" })).toBeInTheDocument();
  });

  it("draws the newest first, with the ones being worked on pinned on top and the minimized ones last, overdue first", async () => {
    const slot = render(
      listing({
        rows: [
          waitingRow({ number: 1, title: "Overdue", updatedAt: Date.now() - 5 * DAY }),
          rowFixture({ number: 2, title: "Draft", flags: [], group: "clean", isDraft: true, updatedAt: Date.now() - HOUR }),
          rowFixture({ number: 3, title: "Working", threadId: "thr_1", threadIds: ["thr_1"], updatedAt: Date.now() - 2 * DAY }),
          rowFixture({ number: 4, title: "Ready", flags: ["merge-ready"], group: "ready-to-merge", updatedAt: Date.now() - 2 * HOUR }),
          rowFixture({ number: 5, title: "Conflict", updatedAt: Date.now() - 3 * HOUR }),
          waitingRow({ number: 6, title: "Waiting", updatedAt: Date.now() - HOUR }),
        ],
      }),
    );
    await slot.findByText("Overdue");
    expect(titles(slot)).toEqual(["Working", "Draft", "Ready", "Conflict", "Overdue", "Waiting"]);
  });

  it("puts what stops the pull request in a red banner under the title", async () => {
    const bannerOf = async (overrides: Record<string, unknown>) => {
      const slot = render(listing({ rows: [rowFixture(overrides)] }));
      const row = await rowFor(slot, /Add the widget endpoint/);
      const banner = row.querySelector("[data-tone]");
      const found = banner ? [banner.getAttribute("data-tone"), banner.textContent] : null;
      slot.lifecycle.unmount();
      return found;
    };
    expect(await bannerOf({ flags: ["conflict", "ci-pending"], baseRefName: "main" })).toEqual([
      "blocked",
      "Merge conflict with main",
    ]);
    expect(
      await bannerOf({ flags: ["ci-failing"], checks: { pass: 7, fail: 2, skip: 0, pending: 0, cancelled: 0, total: 9 } }),
    ).toEqual(["blocked", "2 of 9 checks failing"]);
    expect(
      await bannerOf({ flags: ["conflict", "feedback"], baseRefName: "main", changesRequestedBy: ["hubber"] }),
    ).toEqual(["blocked", "Merge conflict with main · hubber requested changes"]);
    expect(await bannerOf({ flags: ["merge-ready"], group: "ready-to-merge", approvedBy: ["hubber"] })).toEqual([
      "ready",
      "Ready to merge · approved by hubber",
    ]);
    expect(await bannerOf({ flags: ["ci-pending"] })).toBeNull();
    // Nothing flagged, but comments left to answer are why it needs you.
    expect(await bannerOf({ flags: [], group: "clean", unresolvedThreads: 2, notedBy: ["hubber"] })).toEqual([
      "blocked",
      "Review notes from hubber · 2 unanswered comments",
    ]);
  });

  it("flags a pull request left awaiting review past the setting as stale", async () => {
    const slot = render(listing({ rows: [waitingRow({ updatedAt: Date.now() - 5 * DAY - HOUR })] }));
    await slot.findAllByRole("link");
    expect(slot.getByText("Waiting 5 days")).toBeInTheDocument();
  });

  it("shows the new comment count", async () => {
    const slot = render(listing({ rows: [rowFixture({ newComments: 3 })] }));
    expect(await slot.findByText("3 new")).toBeInTheDocument();
  });

  it("counts general and inline comments together in the action line", async () => {
    const slot = render(listing({ rows: [rowFixture({ commentsCount: 1, inlineComments: 4 })] }));
    const row = await rowFor(slot, /Add the widget endpoint/);
    expect(within(row).getByRole("button", { name: "Show 5 comments" })).toHaveTextContent("5");
  });

  it("reads the feedback when the comment count is clicked, and marks it seen", async () => {
    const feedbackCalls: unknown[] = [];
    const seenCalls: unknown[] = [];
    const slot = render(listing({ rows: [rowFixture({ commentsCount: 2, newComments: 1 })] }), {
      listFeedback: (input: unknown) => {
        feedbackCalls.push(input);
        return {
          entries: [
            {
              kind: "thread",
              author: "hubber",
              avatarUrl: "",
              path: "export/csv.ts",
              line: 42,
              status: "unanswered",
              outdated: false,
              replies: 0,
              body: "This skips widgets whose owner is null.",
              url: "https://github.com/acme/widgets/pull/42#discussion_r1",
              at: 0,
            },
          ],
          error: null,
        };
      },
      markSeen: (input: unknown) => {
        seenCalls.push(input);
        return { ok: true };
      },
    });
    const row = await rowFor(slot, /Add the widget endpoint/);
    expect(feedbackCalls).toEqual([]);

    fireEvent.click(within(row).getByRole("button", { name: "Show 2 comments" }));
    expect(await within(row).findByText("This skips widgets whose owner is null.")).toBeInTheDocument();
    expect(within(row).getByText("export/csv.ts:42")).toBeInTheDocument();
    expect(feedbackCalls).toEqual([{ repo: "acme/widgets", number: 42 }]);
    await waitFor(() => expect(seenCalls).toEqual([{ repo: "acme/widgets", number: 42 }]));
  });

  it("folds nothing, however many rows are waiting", async () => {
    const rows = Array.from({ length: 7 }, (_, index) =>
      waitingRow({ number: index + 1, title: `Waiting item ${index + 1}` }),
    );
    const slot = render(listing({ rows }));
    expect(await slot.findByText("Waiting item 7")).toBeInTheDocument();
    expect(slot.queryByRole("button", { name: /more$/ })).toBeNull();
  });

  it("shows a tab of only Later rows as the list, not the empty state", async () => {
    const rows = Array.from({ length: 7 }, (_, index) =>
      waitingRow({ number: index + 1, title: `Waiting item ${index + 1}` }),
    );
    const slot = render(listing({ rows }));
    expect(await slot.findByText("Waiting item 1")).toBeInTheDocument();
    expect(slot.getByRole("group", { name: "Rows by run" })).toBeInTheDocument();
    expect(slot.getByRole("button", { name: "7 waiting" })).toBeInTheDocument();
    expect(slot.queryByText(/No open pull requests/i)).toBeNull();
  });
});

describe("track", () => {
  it("draws no stage track: the banner and the icons say where a pull request stands", async () => {
    const slot = render(listing());
    await slot.findByText(/Add the widget endpoint/);
    for (const stage of ["Draft", "Checks", "Review", "Merge"]) expect(slot.queryByText(stage)).toBeNull();
    expect(slot.queryByLabelText(/^Blocked at/)).toBeNull();
  });
});

describe("notes", () => {
  it("shows the note in an open row", async () => {
    const slot = render(listing({ rows: [rowFixture({ note: "Ask hubber about the retry" })] }));
    expect(await slot.findByText("Ask hubber about the retry")).toBeInTheDocument();
    expect(slot.getByRole("button", { name: "Edit note" })).toBeInTheDocument();
  });

  it("saves an edited note for that row, then reloads the listing", async () => {
    const calls: unknown[] = [];
    let loads = 0;
    const slot = render(listing(), {
      listRows: () => {
        loads += 1;
        return listing();
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
    expect(calls[0]).toEqual({ repo: "acme/widgets", number: 42, body: "Reply to octocat" });
    await waitFor(() => expect(loads).toBe(2));
    await waitFor(() => expect(slot.queryByRole("textbox", { name: "Note" })).toBeNull());
  });
});

describe("seen comments", () => {
  function recordingMarkSeen() {
    const calls: unknown[] = [];
    return {
      calls,
      rpc: {
        markSeen: (input: unknown) => {
          calls.push(input);
          return { ok: true };
        },
      },
    };
  }

  it("marks the pull request seen when its title is clicked", async () => {
    const seen = recordingMarkSeen();
    const slot = render(listing({ rows: [rowFixture({ newComments: 2 })] }), seen.rpc);
    const link = await slot.findByRole("link", { name: /Add the widget endpoint/ });
    // jsdom cannot follow a link, and says so loudly.
    link.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(link);
    await waitFor(() => expect(seen.calls).toEqual([{ repo: "acme/widgets", number: 42 }]));
  });

  it("logs a failed markSeen rather than leaving the rejection unhandled", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const slot = render(listing({ rows: [rowFixture({ newComments: 2 })] }), {
        markSeen: () => {
          throw new Error("server went away");
        },
      });
      const link = await slot.findByRole("link", { name: /Add the widget endpoint/ });
      link.addEventListener("click", (event) => event.preventDefault());
      fireEvent.click(link);
      await waitFor(() => expect(warn).toHaveBeenCalled());
    } finally {
      warn.mockRestore();
    }
  });

  it("records the count when its thread is opened, even with nothing new showing", async () => {
    const seen = recordingMarkSeen();
    const slot = render(listing({ rows: [rowWithThreads(["thr_1"])] }), seen.rpc);
    fireEvent.click(await slot.findByRole("button", { name: "Open thread" }));
    await waitFor(() => expect(seen.calls).toEqual([{ repo: "acme/widgets", number: 42 }]));
  });
});

describe("thread action", () => {
  it("offers to start a thread, named for the work in its title", async () => {
    const slot = render(listing());
    const button = await slot.findByRole("button", { name: "Start thread" });
    expect(button).toHaveAttribute("title", "Resolve conflict");
    // A plain line action like the rest, not a bordered button.
    expect(button.className).not.toMatch(/\bborder\b/);
  });

  it("names the work after the row's worst flag", async () => {
    const titleFor = async (flags: string[], extra: Record<string, unknown> = {}) => {
      const slot = render(listing({ rows: [rowFixture({ flags, ...extra })] }));
      const title = (await slot.findByRole("button", { name: "Start thread" })).getAttribute("title");
      slot.lifecycle.unmount();
      return title;
    };
    expect(await titleFor(["ci-failing"])).toMatch(/fix failing ci/i);
    expect(await titleFor(["no-reviewer"])).toMatch(/add a reviewer/i);
    expect(await titleFor(["conflict", "feedback"])).toBe("Address issues");
  });

  it("says it will read outstanding comments before merging", async () => {
    const slot = render(
      listing({
        rows: [rowFixture({ flags: ["merge-ready"], group: "ready-to-merge", unresolvedThreads: 3 })],
      }),
    );
    expect(await slot.findByRole("button", { name: "Start thread" })).toHaveAttribute("title", "Review and merge");
  });

  it("offers no start on a row only waiting for a run to finish", async () => {
    const slot = render(listing({ rows: [rowFixture({ flags: ["ci-pending"], group: "needs-action" })] }));
    await slot.findAllByRole("link");
    expect(slot.queryByRole("button", { name: "Start thread" })).toBeNull();
  });

  it("still offers one when that row is carrying comments", async () => {
    // Approved with an unresolved thread and a nit in the review body while
    // checks ran. Neither is a flag, and both are work.
    const slot = render(
      listing({ rows: [rowFixture({ flags: ["ci-pending"], unresolvedThreads: 1, notedBy: ["hubber"] })] }),
    );
    expect(await slot.findByRole("button", { name: "Start thread" })).toHaveAttribute("title", "Review comments");
  });

  it("will not offer to start one for a repository with no checkout", async () => {
    const slot = render(listing({ rows: [rowFixture({ canSpawn: false })] }));
    expect(await slot.findByRole("button", { name: "No project here" })).toBeDisabled();
  });

  it("offers to open the thread once one exists, and navigates to it", async () => {
    const slot = render(listing({ rows: [rowWithThreads(["thr_1"])] }));
    fireEvent.click(await slot.findByRole("button", { name: "Open thread" }));
    expect(slot.queryByRole("button", { name: "Start thread" })).toBeNull();
    await waitFor(() =>
      expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_1" }),
    );
  });

  it("disables the button and says Starting while the draft is fetched, and fires once", async () => {
    let release: (() => void) | undefined;
    const slot = render(listing(), {
      workOnThisDraft: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { existingThreadId: null, reason: null, seed: SEED };
      },
    });

    const button = await slot.findByRole("button", { name: "Start thread" });
    fireEvent.click(button);
    const starting = await slot.findByRole("button", { name: "Starting…" });
    expect(starting).toBeDisabled();
    fireEvent.click(starting);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "workOnThisDraft")).toHaveLength(1);

    release?.();
  });

  it("says so when the draft cannot be fetched, rather than doing nothing", async () => {
    const slot = render(listing(), {
      workOnThisDraft: () => {
        throw new Error('plugin "pr-sweep" is not running');
      },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Start thread" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not start a thread: plugin "pr-sweep" is not running'),
    );
    expect(await slot.findByRole("button", { name: "Start thread" })).toBeEnabled();
  });

  it("opens the box under the row with the suggested skills, rather than spawning", async () => {
    const slot = render(listing(), {
      workOnThisDraft: () => ({ existingThreadId: null, reason: null, seed: SEED }),
    });
    fireEvent.click(await slot.findByRole("button", { name: "Start thread" }));
    expect(await slot.findByRole("region", { name: "Start a thread" })).toBeInTheDocument();
    expect(slot.getByRole("button", { name: "resolve-merge-conflicts" })).toHaveAttribute("aria-pressed", "true");
    expect(slot.getByRole("button", { name: "pr-sweep" })).toHaveAttribute("aria-pressed", "false");
    // The composer has a Start thread button of its own; the row's is the one that expands.
    expect(slot.getByRole("button", { name: "Start thread", expanded: true })).toBeInTheDocument();
    expect(slot.inspection.rpcCalls.some((call) => call.method === "workOnThisSubmit")).toBe(false);
  });

  it("closes the box when Start thread is clicked again", async () => {
    const slot = render(listing(), {
      workOnThisDraft: () => ({ existingThreadId: null, reason: null, seed: SEED }),
    });
    fireEvent.click(await slot.findByRole("button", { name: "Start thread" }));
    await slot.findByRole("region", { name: "Start a thread" });
    fireEvent.click(slot.getByRole("button", { name: "Start thread", expanded: true }));
    await waitFor(() => expect(slot.queryByRole("region", { name: "Start a thread" })).toBeNull());
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "workOnThisDraft")).toHaveLength(1);
  });

  it("offers Archive thread once a row with a thread has no flags left", async () => {
    const slot = render(
      listing({ rows: [rowWithThreads(["thr_1"], { flags: [], group: "clean" })] }),
      { archiveThread: () => ({ ok: true, reason: null }) },
    );
    fireEvent.click(await slot.findByRole("button", { name: "Archive thread" }));
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.some((call) => call.method === "archiveThread")).toBe(true),
    );
  });

  it("does not offer Archive thread while the row still has flags", async () => {
    const slot = render(listing({ rows: [rowWithThreads(["thr_1"])] }));
    await slot.findByRole("button", { name: "Open thread" });
    expect(slot.queryByRole("button", { name: "Archive thread" })).toBeNull();
  });
});

/** What `workOnThisDraft` hands the composer. */
const SEED = {
  projectId: "proj_a",
  providerId: "claude-code",
  model: "claude-sonnet-5",
  permissionMode: "full" as const,
  skills: [
    {
      name: "resolve-merge-conflicts",
      reason: "It conflicts with its base branch.",
      instruction: "It conflicts with its base branch. Use the `resolve-merge-conflicts` skill.",
      selected: true,
    },
    {
      name: "pr-sweep",
      reason: "Check the pull request for anything else that needs doing",
      instruction: "Check the pull request for anything else that needs doing. Use the `pr-sweep` skill.",
    },
  ],
  preview: {
    title: "Add the widget endpoint",
    number: 42,
    url: "https://github.com/acme/widgets/pull/42",
    meta: "acme/widgets · conflict",
  },
};

describe("a pull request with more than one thread", () => {
  /**
   * Radix opens a dropdown on pointerdown, not click, and jsdom synthesizes
   * neither from `.click()`. Enter on the trigger is a real way a user opens
   * this menu.
   */
  async function openEarlierThreads(slot: Slot) {
    const trigger = await slot.findByRole("button", { name: /earlier thread/i });
    fireEvent.keyDown(trigger, { key: "Enter" });
    return trigger;
  }

  it("offers nothing extra on the common single-thread row", async () => {
    const slot = render(listing({ rows: [rowWithThreads(["thr_2"])] }));
    await slot.findByRole("button", { name: "Open thread" });
    expect(slot.queryByRole("button", { name: /earlier thread/i })).toBeNull();
  });

  it("counts the earlier threads on the trigger, in the singular for one", async () => {
    const three = render(listing({ rows: [rowWithThreads(["thr_3", "thr_2", "thr_1"])] }));
    await three.findByRole("button", { name: "2 earlier threads" });
    three.lifecycle.unmount();

    const two = render(listing({ rows: [rowWithThreads(["thr_2", "thr_1"])] }));
    await two.findByRole("button", { name: "1 earlier thread" });
  });

  it("opens the newest thread from Open thread", async () => {
    const slot = render(listing({ rows: [rowWithThreads(["thr_3", "thr_2", "thr_1"])] }));
    fireEvent.click(await slot.findByRole("button", { name: "Open thread" }));
    await waitFor(() =>
      expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_3" }),
    );
  });

  it("lists the earlier threads, newest of them first, and opens the one chosen", async () => {
    const slot = render(listing({ rows: [rowWithThreads(["thr_3", "thr_2", "thr_1"])] }));
    await openEarlierThreads(slot);

    const items = await slot.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Earlier thread 1", "Earlier thread 2"]);
    (await slot.findByRole("menuitem", { name: "Earlier thread 2" })).click();

    await waitFor(() =>
      expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_1" }),
    );
  });
});

describe("the Open pull request page", () => {
  const page = () => app.navPanels.find((panel) => panel.id === "open-pr")!;

  function renderPage(rpc: Record<string, unknown>) {
    const slot = renderSlot(page(), { subPath: "" }, { rpc });
    mounted = slot;
    return slot;
  }

  const resolved = {
    pr: {
      repo: "acme/widgets",
      number: 42,
      title: "Add the widget endpoint",
      headRef: "feat/widgets",
      url: "https://github.com/acme/widgets/pull/42",
      isDraft: false,
    },
    error: null,
  };

  it("has its own sidebar entry", () => {
    expect(page().title).toBe("Open pull request");
    expect(page().path).toBe("open-pr");
  });

  it("will not open anything until a pull request resolves", async () => {
    const slot = renderPage({ resolvePullRequest: () => ({ pr: null, error: null }) });
    const button = await slot.findByRole("button", { name: /^Open pull request$/ });
    expect(button).toBeDisabled();
  });

  it("confirms the title and branch before offering to open it", async () => {
    // The branch is the point of the page, so it is shown before committing.
    const slot = renderPage({ resolvePullRequest: () => resolved });
    const field = await slot.findByLabelText(/pull request/i);
    fireEvent.change(field, { target: { value: "42" } });
    fireEvent.blur(field);
    await slot.findByText(/Add the widget endpoint/);
    await slot.findByText(/feat\/widgets/);
    expect(await slot.findByRole("button", { name: /^Open pull request$/ })).not.toBeDisabled();
  });

  it("reports a bad reference in the form rather than opening", async () => {
    const slot = renderPage({
      resolvePullRequest: () => ({ pr: null, error: "Not a pull request number or URL: nope" }),
    });
    const field = await slot.findByLabelText(/pull request/i);
    fireEvent.change(field, { target: { value: "42" } });
    fireEvent.blur(field);
    await slot.findByText(/Not a pull request number or URL/);
    expect(await slot.findByRole("button", { name: /^Open pull request$/ })).toBeDisabled();
  });

  it("opens the thread it started", async () => {
    const slot = renderPage({
      resolvePullRequest: () => resolved,
      openPullRequest: () => ({
        threadId: "thr_1",
        worktree: "/Users/me/projects/widgets-pr-42",
        error: null,
      }),
    });
    const field = await slot.findByLabelText(/pull request/i);
    fireEvent.change(field, { target: { value: "42" } });
    fireEvent.blur(field);
    (await slot.findByRole("button", { name: /^Open pull request$/ })).click();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(slot.inspection.rpcCalls.some((call) => call.method === "openPullRequest")).toBe(true);
    expect(slot.inspection.navigateCalls.length).toBeGreaterThan(0);
  });

  it("says the worktree outlives the thread", async () => {
    // bb does not delete an unmanaged worktree on archive, so the page says so
    // rather than leaving it to be discovered later.
    const slot = renderPage({ resolvePullRequest: () => resolved });
    const field = await slot.findByLabelText(/pull request/i);
    fireEvent.change(field, { target: { value: "42" } });
    fireEvent.blur(field);
    await slot.findByText(/not removed when the thread is archived/i);
  });
});


describe("copy link", () => {
  // This jsdom ships Blob without Blob.prototype.text, and Node's Response
  // does not recognise jsdom's Blob either — it stringifies it to
  // "[object Blob]". FileReader is jsdom's own, so it can read jsdom's Blob.
  // Worth the detour: without a working read the stub throws, the component's
  // catch swallows it, and the test reports "nothing was copied" about a
  // component that copied correctly.
  const readBlob = (blob: Blob): Promise<string> =>
    typeof blob.text === "function"
      ? blob.text()
      : new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsText(blob);
        });

  function stubClipboard() {
    const writes: Array<Record<string, string>> = [];
    // jsdom has neither, so both are stood up rather than spied on.
    (globalThis as Record<string, unknown>).ClipboardItem = class {
      constructor(public items: Record<string, Blob>) {}
    };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        async write(items: Array<{ items: Record<string, Blob> }>) {
          const entry: Record<string, string> = {};
          for (const [type, blob] of Object.entries(items[0]!.items)) {
            entry[type] = await readBlob(blob);
          }
          writes.push(entry);
        },
        async writeText(text: string) {
          writes.push({ "text/plain": text });
        },
      },
    });
    return writes;
  }

  it("copies the title and link as HTML, with plain text alongside", async () => {
    const writes = stubClipboard();
    const slot = render(listing());

    fireEvent.click(await slot.findByRole("button", { name: "Copy link" }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!["text/html"]).toBe(
      '<a href="https://github.com/acme/widgets/pull/42">Add the widget endpoint (#42)</a>',
    );
    expect(writes[0]!["text/plain"]).toBe(
      "[Add the widget endpoint (#42)](https://github.com/acme/widgets/pull/42)",
    );
  });

  it("says Copied, then goes back", async () => {
    stubClipboard();
    const slot = render(listing());

    fireEvent.click(await slot.findByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(slot.getByRole("button", { name: "Copied" })).toBeInTheDocument());
    await waitFor(() => expect(slot.getByRole("button", { name: "Copy link" })).toBeInTheDocument(), {
      timeout: 3000,
    });
  });

  it("stays on Copy link when the clipboard refuses", async () => {
    // A denied permission must not claim success.
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        write: async () => {
          throw new Error("denied");
        },
        writeText: async () => {
          throw new Error("denied");
        },
      },
    });
    const slot = render(listing());
    fireEvent.click(await slot.findByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(slot.getByRole("button", { name: "Copy link" })).toBeInTheDocument());
    expect(slot.queryByRole("button", { name: "Copied" })).toBeNull();
  });
});

describe("harvest", () => {
  const available = (extra = {}) => listing({ harvest: { available: true, running: null, ...extra } });

  it("offers no clock when the Harvest plugin is not installed", async () => {
    const slot = render(listing(), HARVEST_RPC);
    await slot.findByRole("button", { name: "Start thread" });
    // The panel has to stay fully useful with no Harvest plugin present.
    expect(slot.queryByRole("button", { name: /track time/i })).toBeNull();
  });

  it("offers a clock on an open row when Harvest is available", async () => {
    const slot = render(available(), HARVEST_RPC);
    expect(await slot.findByRole("button", { name: /track time for #42/i })).toBeTruthy();
  });

  it("marks the row whose timer is running", async () => {
    const slot = render(
      listing({ harvest: { available: true, running: { externalId: "42", groupId: "widgets" } } }),
      HARVEST_RPC,
    );
    expect(await slot.findByRole("button", { name: /timer running for #42/i })).toBeTruthy();
  });

  it("keeps the row whose timer is running open, even when its tier would close it", async () => {
    // Awaiting review is in Later, one line by default.
    const slot = render(
      listing({
        rows: [waitingRow()],
        harvest: { available: true, running: { externalId: "42", groupId: "widgets" } },
      }),
      HARVEST_RPC,
    );
    expect(await slot.findByRole("button", { name: /timer running for #42/i })).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Collapse" })).toBeNull();
  });

  it("does not mark a row when the running timer is the same number in another repo", async () => {
    // Harvest can only filter references by id, so the group has to be part of
    // the comparison or every repository's #42 would light up together.
    const slot = render(
      listing({ harvest: { available: true, running: { externalId: "42", groupId: "somewhere-else" } } }),
      HARVEST_RPC,
    );
    await slot.findByRole("button", { name: /track time for #42/i });
    expect(slot.queryByRole("button", { name: /timer running/i })).toBeNull();
  });
});

describe("sync header", () => {
  function renderHeader(result: Record<string, unknown>, extraRpc: Record<string, unknown> = {}) {
    const slot = renderSlot(
      { component: app.navPanels.find((panel) => panel.path === "prs")!.headerContent! },
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

describe("navigation badge", () => {
  const listRows = vi.fn();

  function renderBadge(result: Record<string, unknown>) {
    const panel = app.navPanels.find((entry) => entry.path === "prs")!;
    const useBadge = panel.experimental_useBadge!;
    const Badge = () => <span data-testid="badge">{JSON.stringify(useBadge())}</span>;
    listRows.mockReset().mockReturnValue(result);
    const slot = renderSlot({ component: Badge }, {}, { rpc: { listRows } });
    mounted = slot;
    return slot;
  }

  it("counts the pull requests that need you in red", async () => {
    const slot = renderBadge(
      listing({
        rows: [
          rowFixture({ number: 1, flags: ["conflict"], group: "needs-action" }),
          rowFixture({ number: 2, flags: ["merge-ready"], group: "ready-to-merge" }),
          // Waiting on a machine, a reviewer, and nobody respectively.
          rowFixture({ number: 3, flags: ["ci-pending"], group: "needs-action" }),
          rowFixture({ number: 4, flags: [], group: "clean" }),
          rowFixture({ number: 5, flags: ["conflict"], group: "needs-action", isDraft: true }),
        ],
      }),
    );
    await waitFor(() =>
      expect(JSON.parse(slot.getByTestId("badge").textContent!)).toEqual({ count: 1, tone: "critical", label: "1 need you" }),
    );
  });

  it("drops the badge once a thread is running on the only row that needed you", async () => {
    const slot = renderBadge(
      listing({
        rows: [rowFixture({ flags: ["conflict"], group: "needs-action", threadId: "thr_1" })],
      }),
    );
    await waitFor(() => expect(listRows).toHaveBeenCalled());
    expect(slot.getByTestId("badge")).toHaveTextContent("null");
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
    expect(await slot.findByRole("img", { name: "A branch leaving the trunk, gathering commits, and merging back" })).toBeInTheDocument();
  });

  it("says what it is doing once, in the panel's own words", async () => {
    const slot = render({} as Record<string, unknown>, { listRows: pending });
    // role="status" carries the caption to a screen reader, so there is no
    // second hidden copy of it to read out.
    expect(await slot.findByText("Sweeping your open pull requests")).toBeInTheDocument();
    expect(slot.queryByText("Loading…")).toBeNull();
  });
});

