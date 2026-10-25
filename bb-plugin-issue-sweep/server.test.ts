import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost as createHost,
} from "@get-bb/plugin-sdk/testing";
import { createFakeGhContext, type FakeGhContext } from "bb-plugin-gh-context/links/testing";
import plugin from "./server.js";
import { createStore } from "./issues/store.js";

/** A gh that is guaranteed not to exist, so a sweep fails the way it would. */
const MISSING_GH = { ghPath: "/nonexistent/gh-does-not-exist" };

/**
 * The newest host's gh-context. Every host gets its own, empty, so links never
 * leak between tests; a test that needs one gh-context would have found in a
 * prompt pushes it onto `ghContext.links`.
 */
let ghContext: FakeGhContext = createFakeGhContext();

function createFakePluginHost(options: Parameters<typeof createHost>[0] = {}) {
  ghContext = createFakeGhContext();
  const sdk = (options.sdk ?? {}) as Record<string, unknown>;
  return createHost({
    ...options,
    sdk: {
      ...sdk,
      plugins: { callRpc: ghContext.callRpc, ...(sdk.plugins as object | undefined) },
    } as never,
  });
}

describe("server", () => {
  it("registers the rpc methods, the service, and the settings", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "issue-sweep" });
    await plugin(bb);

    expect(harness.registrations.rpcMethods).toEqual(
      expect.arrayContaining(["listRows", "refresh"]),
    );
    expect(harness.registrations.services.map((service) => service.name)).toContain("sweep");
    expect(Object.keys(harness.registrations.settingsDescriptors)).toEqual(
      expect.arrayContaining(["syncIntervalMinutes", "ghPath"]),
    );
  });

  /** A host with one issue in the sweep and a project it can spawn into. */
  async function seededHost(overrides: Record<string, unknown> = {}, settings: Record<string, string> = {}) {
    const fixture = createFakePluginHost({
      pluginId: "issue-sweep",
      settings,
      sdk: {
        projects: {
          list: async () => [
            {
              id: "proj_a",
              gitRemoteUrl: "git@github.com:acme/widgets.git",
              sources: [{ hostId: "host_1", path: "/checkout", isDefault: true }],
            },
          ],
        },
        threads: { spawn: async () => ({ id: "thr_1" }), list: async () => [] },
      },
    });
    await plugin(fixture.bb);
    createStore(fixture.bb.storage.database() as never).replaceAll({
      rows: [
        {
          repo: "acme/widgets",
          number: 42,
          title: "Add the widget endpoint",
          url: "https://github.com/acme/widgets/issues/42",
          labels: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          commentsCount: 0,
          blockedBy: 0,
          closingPr: null,
          subtasks: null,
          boardStatus: "Ready",
          onBoard: true,
          ...overrides,
        },
      ],
      truncated: false,
      failedRepos: [],
      skippedRepos: [],
      sweptAt: Date.now(),
    });
    return fixture;
  }

  it("opens the composer on a new worktree, not the main checkout", async () => {
    // An issue has no branch to land on, so the thread gets its own worktree
    // rather than the checkout everything else is using.
    const { harness } = await seededHost();

    const draft = await harness.behavior.callRpc("startThreadDraft", {
      repo: "acme/widgets",
      number: 42,
    });

    expect(draft.seed).not.toBeNull();
    // hostId included deliberately. bb's schema declares it optional and then
    // refuses the environment without it — "hostId is required unless
    // workspace.type is personal" — and in the composer that refusal is
    // silent: the picker just falls back to the local checkout.
    expect(draft.seed!.environment).toEqual({
      type: "host",
      hostId: "host_1",
      workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
    });
    expect(draft.seed!.projectId).toBe("proj_a");
    // Still a draft: nothing is created until the composer is submitted.
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("still opens the composer when the project reports no host", async () => {
    // hostId is best-effort: a project bb has not resolved a checkout host for
    // must not cost you the dialog. The composer falls back to its own default
    // environment, which is what it did before any of this was seeded.
    const fixture = createFakePluginHost({
      pluginId: "issue-sweep",
      sdk: {
        projects: {
          list: async () => [
            { id: "proj_a", gitRemoteUrl: "git@github.com:acme/widgets.git", sources: [] },
          ],
        },
      },
    });
    await plugin(fixture.bb);
    createStore(fixture.bb.storage.database() as never).replaceAll({
      rows: [
        {
          repo: "acme/widgets",
          number: 42,
          title: "Add the widget endpoint",
          url: "https://github.com/acme/widgets/issues/42",
          labels: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          commentsCount: 0,
          blockedBy: 0,
          closingPr: null,
          subtasks: null,
          boardStatus: "Ready",
          onBoard: true,
        },
      ],
      truncated: false,
      failedRepos: [],
      skippedRepos: [],
      sweptAt: Date.now(),
    });

    const draft = await fixture.harness.behavior.callRpc("startThreadDraft", {
      repo: "acme/widgets",
      number: 42,
    });

    expect(draft.seed).not.toBeNull();
    expect(draft.seed!.environment).not.toHaveProperty("hostId");
  });

  it("shows the issue as a card and offers only the steer for editing", async () => {
    const { harness } = await seededHost();
    const draft = await harness.behavior.callRpc("startThreadDraft", {
      repo: "acme/widgets",
      number: 42,
    });

    // The identifiers are the card, not the first paragraph of the prompt.
    expect(draft.seed!.preview).toMatchObject({
      title: "Add the widget endpoint",
      number: 42,
      url: "https://github.com/acme/widgets/issues/42",
    });
    expect(draft.seed!.prompt).not.toContain("https://github.com");
    expect(draft.seed!.prompt).not.toMatch(/Do not commit unless I ask/);
  });

  it("puts the commit rules back even when the composer's box was emptied", async () => {
    // The composer only ever holds the middle of the prompt, so the standing
    // rule against committing without an ask cannot depend on anyone leaving
    // the seeded text alone.
    const { harness } = await seededHost();

    await harness.behavior.callRpc("startThreadSubmit", {
      repo: "acme/widgets",
      number: 42,
      request: {
        projectId: "proj_a",
        input: [{ type: "text", text: "have a look first", mentions: [] }],
      },
    });

    const [[args]] = harness.inspection.sdk.callsTo("threads.spawn") as [[
      { input: { type: string; text?: string }[] },
    ]];
    // Joined with nothing, which is how bb concatenates a message's text
    // items. The blank lines have to already be in them.
    const sent = args.input.map((item) => item.text ?? "").join("");
    expect(sent).toMatch(/Do not commit unless I ask/);
    // No seam: the URL ending the header, and the last word typed, each get
    // their own blank line rather than running into what follows.
    expect(sent).toContain("issues/42\n\nhave a look first");
    expect(sent).toContain("have a look first\n\nRead it first");
    expect(sent).toContain("acme/widgets#42");
    // And what was typed survives, between the two ends.
    expect(sent).toContain("have a look first");
  });

  it("refuses a draft for an issue the sweep does not have", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "issue-sweep" });
    await plugin(bb);

    expect(await harness.behavior.callRpc("startThreadDraft", {
      repo: "acme/widgets",
      number: 41,
    })).toEqual({
      existingThreadId: null,
      reason: "#41 is no longer in the sweep.",
      seed: null,
    });
  });

  it("never spawns for an issue that left the sweep between draft and submit", async () => {
    // The composer can sit open for as long as the user likes, so the row is
    // re-read at submit rather than trusted from the draft.
    const { bb, harness } = createFakePluginHost({ pluginId: "issue-sweep" });
    await plugin(bb);

    const result = await harness.behavior.callRpc("startThreadSubmit", {
      repo: "acme/widgets",
      number: 41,
      request: {
        projectId: "proj_widgets",
        input: [{ type: "text", text: "Work on it.", mentions: [] }],
      },
    });

    expect(result).toMatchObject({ threadId: null, existing: false });
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("returns an empty list before the first sweep", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "issue-sweep" });
    await plugin(bb);

    const listing = await harness.behavior.callRpc("listRows", null);
    expect(listing).toMatchObject({
      rows: [],
      sweptAt: null,
      truncated: false,
      lastError: null,
    });
    // Through the contract, not the store: a field missing from the zod schema
    // is stripped here rather than erroring, and the panel just goes blank.
    expect(listing.skippedRepos).toEqual([]);
  });

  it("does not hide itself over a single unreachable gh", async () => {
    // needs-configuration is one-way — the SDK clears it on the next load and
    // offers no way back — so latching on one blip takes the plugin's panels
    // out of the sidebar until someone thinks to reload it. That happened.
    const { bb, harness } = createFakePluginHost({
      pluginId: "issue-sweep",
      settings: MISSING_GH,
    });
    await plugin(bb);

    const result = await harness.behavior.callRpc("refresh", null);
    expect(result.ok).toBe(false);
    expect(harness.needsConfigurationMessages).toEqual([]);
  });

  it("reports needs-configuration once gh is consistently unreachable", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "issue-sweep",
      settings: MISSING_GH,
    });
    await plugin(bb);

    // Three consecutive failures is a configuration problem rather than
    // weather, and by then the message is worth acting on.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await harness.behavior.callRpc("refresh", null);
    }
    expect(harness.needsConfigurationMessages.length).toBeGreaterThan(0);
    expect(harness.needsConfigurationMessages[0]).toMatch(/not found on PATH/i);
  });

  it("surfaces a failed sweep to the panel instead of throwing", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "issue-sweep",
      settings: MISSING_GH,
    });
    await plugin(bb);

    await harness.behavior.callRpc("refresh", null);
    const listing = await harness.behavior.callRpc("listRows", null);
    expect(listing.lastError).toContain("gh-does-not-exist");
  });

  it("keeps sweeping until its service is aborted", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "issue-sweep",
      settings: MISSING_GH,
    });
    await plugin(bb);

    const service = harness.behavior.runService("sweep");
    await new Promise((resolve) => setTimeout(resolve, 50));
    service.controller.abort();
    await service.done;

    // A failing sweep must not take the service down with it, or the panel
    // would never recover once gh came back.
    const listing = await harness.behavior.callRpc("listRows", null);
    expect(listing.lastError).not.toBeNull();
  });

  it("offers the stale and board stage settings, and no longer a status order", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "issue-sweep" });
    await plugin(bb);

    const descriptors = harness.registrations.settingsDescriptors as Record<string, { label: string; default: string }>;
    expect(descriptors.staleAfterDays).toMatchObject({ label: "Stale after (days)", default: "7" });
    expect(descriptors.boardStages).toMatchObject({
      label: "Board stages, in order",
      default: "Backlog,Ready,In Progress,In Review",
    });
    expect(descriptors).not.toHaveProperty("statusOrder");
  });

  it("returns what the list needs to place each row", async () => {
    const { harness } = await seededHost();
    const listing = await harness.behavior.callRpc("listRows", null);
    expect(listing.boardStages).toEqual(["Backlog", "Ready", "In Progress", "In Review"]);
    expect(listing.staleAfterDays).toBe(7);
    expect(listing.reviewStatus).toBe("In Review");
    expect(listing.rows[0]).toMatchObject({ note: null, newComments: 0, parent: null });
  });

  it("falls back to seven days when the stale setting is not a positive number", async () => {
    const { harness } = await seededHost({}, { staleAfterDays: "soon" });
    expect((await harness.behavior.callRpc("listRows", null)).staleAfterDays).toBe(7);
  });

  it("carries the parent issue through to the listing", async () => {
    const parent = { number: 140, title: "Widget export, second pass", url: "https://github.com/acme/widgets/issues/140" };
    const { harness } = await seededHost({ parent });
    expect((await harness.behavior.callRpc("listRows", null)).rows[0]!.parent).toEqual(parent);
  });

  it("saves a note and lists it with the row", async () => {
    const { harness } = await seededHost();
    expect(
      await harness.behavior.callRpc("setNote", { repo: "acme/widgets", number: 42, body: "Ask hubber first" }),
    ).toEqual({ ok: true });
    expect((await harness.behavior.callRpc("listRows", null)).rows[0]!.note).toBe("Ask hubber first");
  });

  it("deletes the note when it is saved empty, rather than keeping blank text", async () => {
    const { bb, harness } = await seededHost();
    await harness.behavior.callRpc("setNote", { repo: "acme/widgets", number: 42, body: "Ask hubber first" });
    await harness.behavior.callRpc("setNote", { repo: "acme/widgets", number: 42, body: "" });

    expect((await harness.behavior.callRpc("listRows", null)).rows[0]!.note).toBeNull();
    expect(createStore(bb.storage.database() as never).notes().size).toBe(0);
  });

  it("shows nothing new for an issue no sweep has recorded a count for", async () => {
    // The first listing after an upgrade, before the sweep has run.
    const { harness } = await seededHost({ commentsCount: 9 });
    expect((await harness.behavior.callRpc("listRows", null)).rows[0]!.newComments).toBe(0);
  });

  it("counts comments since the count was recorded, and clears them once seen", async () => {
    const { bb, harness } = await seededHost({ commentsCount: 2 });
    const store = createStore(bb.storage.database() as never);
    store.recordFirstSeen(store.readRows(), 1);
    store.replaceAll({
      rows: store.readRows().map((row) => ({ ...row, commentsCount: 5 })),
      truncated: false,
      failedRepos: [],
      skippedRepos: [],
      sweptAt: Date.now(),
    });
    expect((await harness.behavior.callRpc("listRows", null)).rows[0]!.newComments).toBe(3);

    expect(await harness.behavior.callRpc("markSeen", { repo: "acme/widgets", number: 42 })).toEqual({ ok: true });
    expect((await harness.behavior.callRpc("listRows", null)).rows[0]!.newComments).toBe(0);
  });

  it("never shows a negative count when comments were deleted", async () => {
    const { bb, harness } = await seededHost({ commentsCount: 1 });
    createStore(bb.storage.database() as never).markSeen("acme/widgets", 42, 4, 1);
    expect((await harness.behavior.callRpc("listRows", null)).rows[0]!.newComments).toBe(0);
  });

  it("lists the last move made from here, so a promoted issue is not stale", async () => {
    const { bb, harness } = await seededHost();
    expect((await harness.behavior.callRpc("listRows", null)).rows[0]!.movedAt).toBeNull();
    createStore(bb.storage.database() as never).recordMove("acme/widgets", 42, 1_700_000_000_000);
    expect((await harness.behavior.callRpc("listRows", null)).rows[0]!.movedAt).toBe(1_700_000_000_000);
  });

  it("refuses to mark an issue the sweep does not have", async () => {
    const { harness } = await seededHost();
    expect(await harness.behavior.callRpc("markSeen", { repo: "acme/widgets", number: 41 })).toEqual({ ok: false });
  });

  it("marks the issue seen when a thread is started for it", async () => {
    const { bb, harness } = await seededHost({ commentsCount: 6 });
    await harness.behavior.callRpc("startThreadSubmit", {
      repo: "acme/widgets",
      number: 42,
      request: { projectId: "proj_a", input: [{ type: "text", text: "Go", mentions: [] }] },
    });
    expect(createStore(bb.storage.database() as never).seenCounts().get("acme/widgets#42")).toBe(6);
  });
});

describe("the sweep service", () => {
  it("stops mid-sweep when the service is stopped, and keeps the last listing", async () => {
    // A gh that hangs, as a slow sweep does when a reload lands in it. A
    // service that waits on it misses bb's five-second stop window, and bb
    // then stops answering every RPC until the plugin is reloaded.
    const dir = mkdtempSync(join(tmpdir(), "issue-sweep-hang-"));
    const gh = join(dir, "gh");
    const started = join(dir, "started");
    writeFileSync(gh, `#!/bin/sh\ntouch '${started}'\nexec sleep 30\n`);
    chmodSync(gh, 0o755);
    const { bb, harness } = createFakePluginHost({
      pluginId: "issue-sweep",
      settings: { ghPath: gh, filterToProjects: "off" },
    });
    await plugin(bb);

    const service = harness.behavior.runService("sweep");
    await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: 5_000 });
    const stopping = Date.now();
    service.controller.abort();
    await service.done;

    expect(Date.now() - stopping).toBeLessThan(2_000);
    expect(await harness.behavior.callRpc("listRows", null)).toMatchObject({ sweptAt: null, lastError: null });
  });
});
