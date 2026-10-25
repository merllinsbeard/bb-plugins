// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app.js"));

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Relative to the real clock, since the panel samples Date.now() per render. */
function daysAgo(days: number) {
  return Date.now() - days * DAY;
}

/** A row in Now by default: requested four days ago, past the two-day setting. */
function rowFixture(overrides: Record<string, unknown> = {}) {
  return {
    repo: "acme/widgets",
    number: 42,
    title: "Add the widget endpoint",
    url: "https://github.com/acme/widgets/pull/42",
    author: "octocat",
    isDraft: false,
    state: "first-look",
    requestedAt: daysAgo(4),
    lastReviewedAt: null,
    requestedReviewers: ["you"],
    size: { additions: 120, deletions: 8, changedFiles: 6 },
    canSpawn: true,
    threadId: null,
    comments: 2,
    inlineComments: 0,
    checks: { pass: 3, fail: 0, skip: 1, pending: 0, cancelled: 0, total: 4 },
    reviewers: [],
    note: null,
    newComments: 0,
    ...overrides,
  };
}

/** Requested five hours ago: to review, so in Next. */
const freshRow = (overrides: Record<string, unknown> = {}) =>
  rowFixture({ requestedAt: Date.now() - 5 * HOUR, ...overrides });

function listing(overrides: Record<string, unknown> = {}) {
  return {
    rows: [rowFixture()],
    sweptAt: 1_700_000_000_000,
    skippedRepos: [],
    truncated: false,
    lastError: null,
    staleAfterDays: 2,
    // What `harvestState` answers. No Harvest plugin by default, which is the
    // state the panel has to stay fully usable in.
    harvest: { available: false, running: null },
    ...overrides,
  };
}

const HARVEST_RPC = {
  harvestAssignments: () => ({ projects: [] }),
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
    expect(app.navPanels[0]!.path).toBe("reviews");
  });

  it("lists a requested review, linked out to GitHub", async () => {
    const slot = render(listing());
    const link = await slot.findByRole("link", { name: "Add the widget endpoint" });
    expect(link).toHaveAttribute("href", "https://github.com/acme/widgets/pull/42");
    expect(await slot.findByText("#42")).toBeInTheDocument();
  });

  it("shows the age on the title line, then the author, reviewers, checks, and size as icons, in that order", async () => {
    const slot = render(
      listing({
        rows: [
          rowFixture({
            reviewers: [
              { login: "hubber", state: "approved", team: false },
              { login: "acme/reviewers", state: "pending", team: true },
            ],
          }),
        ],
      }),
    );
    const row = await rowFor(slot, /Add the widget endpoint/);
    expect(within(row).getByText("4d ago")).toBeInTheDocument();
    const parts = Array.from(row.querySelectorAll("[data-part]"), (part) => part.getAttribute("data-part"));
    expect(parts).toEqual(["author", "reviewers", "checks", "diff"]);
    const author = row.querySelector('[data-part="author"]')!;
    expect(author).toHaveTextContent("octocat");
    expect(author.querySelector("img")).toHaveAttribute("src", "https://github.com/octocat.png?size=40");
    expect(
      within(row).getByRole("img", { name: "Reviewers: hubber approved, @acme/reviewers review pending" }),
    ).toBeInTheDocument();
    const checks = row.querySelector('[data-part="checks"]')!;
    expect(checks).toHaveTextContent("3/3");
    expect(checks.querySelector('[data-icon="CircleCheck"]')).toHaveClass("text-success");
    expect(row.querySelector('[data-part="diff"]')).toHaveTextContent("+120 −8");
  });

  it("leaves out the reviewers when there are none and the checks when the pull request has none", async () => {
    const slot = render(
      listing({
        rows: [rowFixture({ checks: { pass: 0, fail: 0, skip: 0, pending: 0, cancelled: 0, total: 0 } })],
      }),
    );
    const row = await rowFor(slot, /Add the widget endpoint/);
    expect(row.querySelector('[data-part="reviewers"]')).toBeNull();
    expect(row.querySelector('[data-part="checks"]')).toBeNull();
    expect(row.querySelector('[data-part="diff"]')).toHaveTextContent("+120 −8");
  });

  it("counts failing checks in red", async () => {
    const slot = render(
      listing({ rows: [rowFixture({ checks: { pass: 5, fail: 2, skip: 1, pending: 0, cancelled: 0, total: 8 } })] }),
    );
    const checks = (await rowFor(slot, /Add the widget endpoint/)).querySelector('[data-part="checks"]')!;
    expect(checks).toHaveTextContent("2/7 failing");
    expect(checks.querySelector('[data-icon="CircleX"]')).toHaveClass("text-destructive-text");
  });

  it("marks an open pull request with a green icon and a draft with a muted one", async () => {
    const slot = render(
      listing({
        rows: [
          rowFixture({ number: 1, title: "Open one" }),
          freshRow({ number: 2, title: "Draft one", isDraft: true }),
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
          rowFixture({ number: 1, title: "Conflicted one", conflicted: true }),
          rowFixture({ number: 2, title: "Clean one" }),
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

  it("says so when nothing is waiting, over the empty diff", async () => {
    const slot = render(listing({ rows: [] }));
    await slot.findByText("Nothing to review.");
    await slot.findByText(/New requests appear here as they arrive/i);
    // "@@ -0,0 +0,0 @@" read aloud is noise, so the art carries one label.
    await slot.findByRole("img", { name: /empty diff/i });
  });

  it("names the repositories the project filter held back, instead of the usual line", async () => {
    // Otherwise an empty panel on a machine holding none of your checkouts
    // reads as a cleared queue.
    const slot = render(listing({ rows: [], skippedRepos: ["acme/widgets", "acme/gadgets"] }));
    await slot.findByText(/acme\/widgets, acme\/gadgets/);
    await slot.findByText(/Nothing from the repositories checked out here/i);
    expect(slot.queryByText(/New requests appear here as they arrive/i)).toBeNull();
    await slot.findByRole("img", { name: /empty diff/i });
  });

  it("names held-back repositories below the list, alongside rows that did match", async () => {
    const slot = render(listing({ skippedRepos: ["acme/gadgets"] }));
    const notice = await slot.findByRole("note", { name: /Not shown: acme\/gadgets/ });
    const list = (await rowFor(slot, /Add the widget endpoint/)).closest("ul")!;
    expect(list.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows no empty state while rows are present", async () => {
    const slot = render(listing());
    await slot.findByText(/Add the widget endpoint/);
    expect(slot.queryByText("Nothing to review.")).toBeNull();
  });

  it("surfaces a sweep error without blanking the rows", async () => {
    const slot = render(listing({ lastError: "`gh` is not authenticated. Run `gh auth login`." }));
    await slot.findByText(/gh auth login/);
    await slot.findByText(/Add the widget endpoint/);
  });

  it("warns when the sweep hit the search ceiling", async () => {
    const slot = render(listing({ truncated: true }));
    await slot.findByText(/search ceiling/i);
  });
});

describe("tiers", () => {
  it("keeps every row open, whatever its tier, with no chevron", async () => {
    const slot = render(
      listing({
        rows: [
          freshRow({ number: 1, title: "Draft item", isDraft: true }),
          freshRow({ number: 2, title: "Fresh item" }),
          rowFixture({ number: 3, title: "Overdue item" }),
        ],
      }),
    );
    for (const title of ["Overdue item", "Fresh item", "Draft item"]) {
      const row = await rowFor(slot, title);
      expect(within(row).getByRole("button", { name: "Start review" })).toBeInTheDocument();
      expect(within(row).getByRole("button", { name: "Add note" })).toBeInTheDocument();
      expect(within(row).getByText("octocat")).toBeInTheDocument();
    }
    expect(slot.queryByRole("button", { name: /^(Collapse|Expand)$/ })).toBeNull();
  });

  it("draws re-review, overdue, reviewing, to review, then drafts, whatever order the rows arrive in", async () => {
    const slot = render(
      listing({
        rows: [
          freshRow({ number: 2, title: "Draft", isDraft: true }),
          freshRow({ number: 3, title: "Fresh" }),
          freshRow({ number: 4, title: "Reviewing", threadId: "thr_1" }),
          rowFixture({ number: 5, title: "Overdue" }),
          freshRow({ number: 6, title: "Re-review", state: "re-review" }),
        ],
      }),
    );
    await slot.findByText("Draft");
    expect(titles(slot)).toEqual(["Re-review", "Overdue", "Reviewing", "Fresh", "Draft"]);
  });

  it("puts the oldest request first within a run", async () => {
    const slot = render(
      listing({
        rows: [
          freshRow({ number: 1, title: "Newer", requestedAt: Date.now() - 2 * HOUR }),
          freshRow({ number: 2, title: "Older", requestedAt: Date.now() - 9 * HOUR }),
        ],
      }),
    );
    await slot.findByText("Newer");
    expect(titles(slot)).toEqual(["Older", "Newer"]);
  });

  it("says in a red banner how long a request past the setting has waited, and honours the setting", async () => {
    const stale = render(listing({ rows: [rowFixture({ requestedAt: daysAgo(6) - HOUR })] }));
    const row = await rowFor(stale, /Add the widget endpoint/);
    const banner = row.querySelector("[data-tone]")!;
    expect(banner).toHaveAttribute("data-tone", "blocked");
    expect(banner).toHaveTextContent("Waiting on you for 6 days");
    // The banner says it once; the row keeps its red tint.
    expect(within(row).queryByText("Waiting 6 days")).toBeNull();
    expect(row).toHaveClass("border-l-destructive");
    stale.lifecycle.unmount();

    const patient = render(
      listing({ staleAfterDays: 14, rows: [rowFixture({ requestedAt: daysAgo(6) - HOUR })] }),
    );
    expect(patient.queryByText(/Waiting on you/)).toBeNull();
  });

  it("says in a blue banner that a re-review was asked for again", async () => {
    const slot = render(listing({ rows: [freshRow({ state: "re-review", lastReviewedAt: daysAgo(2) })] }));
    const banner = (await rowFor(slot, /Add the widget endpoint/)).querySelector("[data-tone]")!;
    expect(banner).toHaveAttribute("data-tone", "info");
    expect(banner).toHaveTextContent("Asked to review again");
  });

  it("draws no banner on a fresh first look", async () => {
    const slot = render(listing({ rows: [freshRow()] }));
    expect((await rowFor(slot, /Add the widget endpoint/)).querySelector("[data-tone]")).toBeNull();
  });

  it("shows the new comment count", async () => {
    const slot = render(listing({ rows: [rowFixture({ newComments: 3 })] }));
    expect(await slot.findByText("3 new")).toBeInTheDocument();
  });

  it("folds Later after five rows", async () => {
    const rows = Array.from({ length: 7 }, (_, index) =>
      freshRow({ number: index + 1, title: `Snoozed item ${index + 1}`, snoozedUntil: "2099-01-01" }),
    );
    const slot = render(listing({ rows }));
    expect(await slot.findByRole("button", { name: "2 more" })).toBeInTheDocument();
  });

  it("shows a tab of only Later rows as the list, not the empty state", async () => {
    const rows = Array.from({ length: 7 }, (_, index) =>
      freshRow({ number: index + 1, title: `Draft item ${index + 1}`, isDraft: true }),
    );
    const slot = render(listing({ rows }));
    expect(await slot.findByText("Draft item 1")).toBeInTheDocument();
    expect(slot.getByRole("group", { name: "Rows by run" })).toBeInTheDocument();
    expect(slot.getByRole("button", { name: "7 drafts" })).toBeInTheDocument();
    expect(slot.queryByText("Nothing to review.")).toBeNull();
  });
});

describe("track", () => {
  it("draws no stage track: the banner and the icons say where a review stands", async () => {
    const slot = render(listing());
    await slot.findByText(/Add the widget endpoint/);
    for (const stage of ["Requested", "Reviewing", "Re-review"]) expect(slot.queryByText(stage)).toBeNull();
  });
});

describe("snooze", () => {
  it("snoozes a request until a day picked from its menu, then reloads the listing", async () => {
    const calls: unknown[] = [];
    let loads = 0;
    const slot = render(listing(), {
      listRows: () => {
        loads += 1;
        return listing();
      },
      snooze: (input: unknown) => {
        calls.push(input);
        return { ok: true };
      },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Snooze" }));
    const field = await slot.findByRole("textbox", { name: "Snooze until a day" });
    fireEvent.change(field, { target: { value: "2099-01-05" } });
    fireEvent.submit(field.closest("form")!);
    await waitFor(() => expect(calls).toEqual([{ repo: "acme/widgets", number: 42, until: "2099-01-05" }]));
    await waitFor(() => expect(loads).toBeGreaterThan(1));
  });

  it("will not snooze until today or earlier", async () => {
    const slot = render(listing());
    fireEvent.click(await slot.findByRole("button", { name: "Snooze" }));
    fireEvent.change(await slot.findByRole("textbox", { name: "Snooze until a day" }), { target: { value: "today" } });
    expect(slot.getByText("Too early")).toBeInTheDocument();
  });

  it("closes a snoozed request to one line saying until when, opening to Unsnooze", async () => {
    const calls: unknown[] = [];
    const slot = render(listing({ rows: [rowFixture({ snoozedUntil: "2099-01-05" })] }), {
      snooze: (input: unknown) => {
        calls.push(input);
        return { ok: true };
      },
    });
    expect(await slot.findByText("Until Jan 5, 2099")).toBeInTheDocument();
    expect(slot.queryByRole("button", { name: "Add note" })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Expand" }));
    fireEvent.click(await slot.findByRole("button", { name: "Unsnooze" }));
    await waitFor(() => expect(calls).toEqual([{ repo: "acme/widgets", number: 42, until: null }]));
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

  it("marks the review seen when its title is clicked", async () => {
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
    const slot = render(listing({ rows: [rowFixture({ threadId: "thr_1" })] }), seen.rpc);
    fireEvent.click(await slot.findByRole("button", { name: "Open thread" }));
    await waitFor(() => expect(seen.calls).toEqual([{ repo: "acme/widgets", number: 42 }]));
  });
});

describe("comments drawer", () => {
  it("counts general and inline comments together in the action line", async () => {
    const slot = render(listing({ rows: [rowFixture({ comments: 1, inlineComments: 4 })] }));
    const row = await rowFor(slot, /Add the widget endpoint/);
    expect(within(row).getByRole("button", { name: "Show 5 comments" })).toHaveTextContent("5");
  });

  it("reads the comments when the count is clicked, and marks them seen", async () => {
    const feedbackCalls: unknown[] = [];
    const seenCalls: unknown[] = [];
    const slot = render(listing({ rows: [rowFixture({ comments: 2, newComments: 1 })] }), {
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
              status: "waiting",
              outdated: false,
              replies: 0,
              body: "Should this skip widgets whose owner is null?",
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
    expect(await within(row).findByText("Should this skip widgets whose owner is null?")).toBeInTheDocument();
    expect(within(row).getByText("waiting on a reply")).toBeInTheDocument();
    expect(feedbackCalls).toEqual([{ repo: "acme/widgets", number: 42 }]);
    await waitFor(() => expect(seenCalls).toEqual([{ repo: "acme/widgets", number: 42 }]));
  });
});

/** What `reviewThisDraft` hands the composer. */
const SEED = {
  projectId: "proj_widgets",
  providerId: "claude-code",
  model: null,
  permissionMode: "full" as const,
  skills: [
    {
      name: "code-review",
      reason: "A review was requested of you",
      instruction: "Review acme/widgets#42. Use the `code-review` skill.",
      selected: true,
    },
  ],
  preview: {
    title: "Add the widget endpoint",
    number: 42,
    url: "https://github.com/acme/widgets/pull/42",
    meta: "acme/widgets · by octocat",
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
  it("offers Start review on first looks and re-reviews alike", async () => {
    const slot = render(
      listing({
        rows: [
          rowFixture({ number: 1, state: "first-look" }),
          rowFixture({ number: 2, state: "re-review" }),
        ],
      }),
    );
    expect(await slot.findAllByRole("button", { name: "Start review" })).toHaveLength(2);
  });

  it("will not offer to start one for a repository with no checkout", async () => {
    const slot = render(listing({ rows: [rowFixture({ canSpawn: false })] }));
    expect(await slot.findByRole("button", { name: "No project here" })).toBeDisabled();
  });

  it("offers to open the thread once one exists, and navigates to it", async () => {
    const slot = render(listing({ rows: [rowFixture({ threadId: "thr_1" })] }));
    fireEvent.click(await slot.findByRole("button", { name: "Open thread" }));
    expect(slot.queryByRole("button", { name: "Start review" })).toBeNull();
    await waitFor(() =>
      expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_1" }),
    );
  });

  it("asks for a draft and opens the box under the row with the review skill picked, rather than spawning", async () => {
    const slot = render(listing(), {
      reviewThisDraft: () => ({ existingThreadId: null, reason: null, seed: SEED }),
    });
    fireEvent.click(await slot.findByRole("button", { name: "Start review" }));
    expect(await slot.findByRole("region", { name: "Start a thread" })).toBeInTheDocument();
    expect(slot.getByRole("button", { name: "code-review" })).toHaveAttribute("aria-pressed", "true");
    expect(slot.getByRole("button", { name: "Start review", expanded: true })).toBeInTheDocument();
    const call = slot.inspection.rpcCalls.find((entry) => entry.method === "reviewThisDraft");
    expect(call?.input).toEqual({ repo: "acme/widgets", number: 42 });
    expect(slot.inspection.rpcCalls.some((entry) => entry.method === "reviewThisSubmit")).toBe(false);
  });

  it("disables the button and says Starting while the draft is fetched, and fires once", async () => {
    let release: (() => void) | undefined;
    const slot = render(listing(), {
      reviewThisDraft: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { existingThreadId: null, reason: null, seed: SEED };
      },
    });

    fireEvent.click(await slot.findByRole("button", { name: "Start review" }));
    const starting = await slot.findByRole("button", { name: "Starting…" });
    expect(starting).toBeDisabled();
    fireEvent.click(starting);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "reviewThisDraft")).toHaveLength(1);

    release?.();
  });

  it("offers Archive thread on a row with a thread, and calls archiveThread", async () => {
    const slot = render(listing({ rows: [rowFixture({ threadId: "thr_1" })] }), {
      archiveThread: () => ({ ok: true, reason: null }),
    });
    fireEvent.click(await slot.findByRole("button", { name: "Archive thread" }));
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.some((call) => call.method === "archiveThread")).toBe(true),
    );
  });

  it("offers no Archive thread on a row without a thread", async () => {
    const slot = render(listing());
    await slot.findByRole("button", { name: "Start review" });
    expect(slot.queryByRole("button", { name: "Archive thread" })).toBeNull();
  });
});

describe("batch", () => {
  it("lists only the requests that can start, in the dialog Batch opens", async () => {
    const slot = render(
      listing({
        rows: [
          rowFixture({ number: 1, title: "First widget change" }),
          rowFixture({ number: 2, title: "Second widget change", threadId: "thr_1" }),
          rowFixture({ number: 3, title: "Third widget change", canSpawn: false }),
        ],
      }),
    );
    fireEvent.click(await slot.findByRole("button", { name: "Batch" }));

    expect(await slot.findByRole("checkbox", { name: "Pick #1" })).toBeInTheDocument();
    expect(slot.queryByRole("checkbox", { name: "Pick #2" })).toBeNull();
    expect(slot.queryByRole("checkbox", { name: "Pick #3" })).toBeNull();
  });

  it("disables Batch when nothing could start", async () => {
    const slot = render(listing({ rows: [rowFixture({ threadId: "thr_1" })] }));
    expect(await slot.findByRole("button", { name: "Batch" })).toBeDisabled();
  });

  it("starts each ticked review with its prompt, then closes", async () => {
    const slot = render(
      listing({ rows: [rowFixture({ number: 1 }), rowFixture({ number: 2 })] }),
      { reviewBatchStart: ({ number }: { number: number }) => ({ threadId: `thr_${number}`, existing: false, reason: null }) },
    );
    fireEvent.click(await slot.findByRole("button", { name: "Batch" }));
    fireEvent.click(await slot.findByRole("checkbox", { name: "Pick #1" }));
    fireEvent.click(await slot.findByRole("checkbox", { name: "Pick #2" }));
    fireEvent.change(slot.getByLabelText("Prompt for #2"), { target: { value: "Only the tests." } });
    fireEvent.click(slot.getByRole("button", { name: "Start 2 reviews" }));

    await waitFor(() =>
      expect(slot.inspection.rpcCalls.filter((call) => call.method === "reviewBatchStart")).toHaveLength(2),
    );
    const inputs = slot.inspection.rpcCalls
      .filter((call) => call.method === "reviewBatchStart")
      .map((call) => call.input as { number: number; prompt: string });
    expect(inputs.find((input) => input.number === 2)?.prompt).toBe("Only the tests.");
    expect(inputs.find((input) => input.number === 1)?.prompt).toMatch(/Use the `code-review` skill/);
    await waitFor(() => expect(slot.queryByRole("checkbox", { name: "Pick #1" })).toBeNull());
  });

  it("keeps the dialog open when a start fails", async () => {
    const slot = render(listing({ rows: [rowFixture({ number: 1 })] }), {
      reviewBatchStart: () => ({ threadId: null, existing: false, reason: "No bb project is checked out for acme/widgets." }),
    });
    fireEvent.click(await slot.findByRole("button", { name: "Batch" }));
    fireEvent.click(await slot.findByRole("checkbox", { name: "Pick #1" }));
    fireEvent.click(slot.getByRole("button", { name: "Start 1 review" }));

    await waitFor(() =>
      expect(slot.inspection.rpcCalls.some((call) => call.method === "reviewBatchStart")).toBe(true),
    );
    expect(slot.getByRole("checkbox", { name: "Pick #1" })).toBeInTheDocument();
  });
});

describe("navigation badge", () => {
  const listRows = vi.fn();

  function renderBadge(result: Record<string, unknown>) {
    const useBadge = app.navPanels[0]!.experimental_useBadge!;
    const Badge = () => <span data-testid="badge">{JSON.stringify(useBadge())}</span>;
    listRows.mockReset().mockReturnValue(result);
    const slot = renderSlot({ component: Badge }, { subPath: "" }, { rpc: { listRows } });
    mounted = slot;
    return slot;
  }

  const badge = (slot: ReturnType<typeof renderBadge>) => JSON.parse(slot.getByTestId("badge").textContent!);

  it("shows nothing for a review that has not waited too long", async () => {
    const slot = renderBadge(listing({ rows: [rowFixture({ requestedAt: daysAgo(1) })] }));
    await waitFor(() => expect(listRows).toHaveBeenCalled());
    expect(badge(slot)).toBeNull();
  });

  it("counts the reviews waiting too long in red", async () => {
    const slot = renderBadge(
      listing({
        rows: [
          rowFixture({ number: 1, requestedAt: daysAgo(4) }),
          rowFixture({ number: 2, requestedAt: daysAgo(1) }),
        ],
      }),
    );
    await waitFor(() => expect(badge(slot)).toEqual({ count: 1, tone: "critical", label: "1 waiting too long" }));
  });

  it("leaves snoozed requests out of the count", async () => {
    const slot = renderBadge(
      listing({
        rows: [
          rowFixture({ number: 1, requestedAt: daysAgo(4), snoozedUntil: "2099-01-01" }),
          rowFixture({ number: 2, requestedAt: daysAgo(1) }),
        ],
      }),
    );
    await waitFor(() => expect(listRows).toHaveBeenCalled());
    expect(badge(slot)).toBeNull();
  });
});

describe("harvest", () => {
  const available = (extra = {}) => listing({ harvest: { available: true, running: null, ...extra } });

  it("offers no clock when the Harvest plugin is not installed", async () => {
    const slot = render(listing(), HARVEST_RPC);
    await slot.findByRole("button", { name: "Start review" });
    expect(slot.queryByRole("button", { name: /track time/i })).toBeNull();
  });

  it("offers a clock on an open row when Harvest is available", async () => {
    const slot = render(available(), HARVEST_RPC);
    expect(await slot.findByRole("button", { name: /track time for #42/i })).toBeTruthy();
  });

  it("keeps the row whose timer is running open, even when its tier would close it", async () => {
    // A fresh request is in Next, which is closed to its number line by default.
    const slot = render(
      listing({
        rows: [freshRow()],
        harvest: { available: true, running: { externalId: "42", groupId: "widgets" } },
      }),
      HARVEST_RPC,
    );
    expect(await slot.findByRole("button", { name: /timer running for #42/i })).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Collapse" })).toBeNull();
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

describe("loading state", () => {
  // Never resolves, so the panel stays in the state it shows before its rows
  // arrive.
  const pending = () => new Promise<never>(() => {});

  it("counts in the same notation the empty state settles in", async () => {
    const slot = render({} as Record<string, unknown>, { listRows: pending });
    const frame = await slot.findByRole("status");
    expect(frame).toHaveAttribute("aria-busy", "true");
    // Six digits turning: two counts either side of the hunk header.
    expect(frame.querySelectorAll(".review-sweep-roll")).toHaveLength(6);
  });

  it("says what it is doing once, in the panel's own words", async () => {
    const slot = render({} as Record<string, unknown>, { listRows: pending });
    expect(
      await slot.findByText("Sweeping the reviews waiting on you"),
    ).toBeInTheDocument();
    expect(slot.queryByText("Loading…")).toBeNull();
  });
});

