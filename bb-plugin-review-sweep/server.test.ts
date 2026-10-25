import { localDay } from "@danielbachhuber/bb-plugin-component-library/parse-day";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost as createHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { createFakeGhContext, type FakeGhContext } from "bb-plugin-gh-context/links/testing";
import { createStore } from "./review/store.js";
import type { ClassifiedRow } from "./review/types.js";
import plugin from "./server.js";

const PLUGIN_ID = "review-sweep";
const PROJECT = {
  id: "proj_a",
  gitRemoteUrl: "git@github.com:acme/widgets.git",
  sources: [{ hostId: "host_1", path: "/checkout", isDefault: true }],
};

let spawnCount = 0;

/** One classified row, as a sweep would have written it. */
function seedRow(overrides: Partial<ClassifiedRow> = {}): ClassifiedRow {
  return {
    repo: "acme/widgets",
    number: 42,
    title: "Add the widget endpoint",
    url: "https://github.com/acme/widgets/pull/42",
    author: "octocat",
    isDraft: false,
    state: "first-look",
    requestedAt: Date.parse("2026-03-06T12:00:00Z"),
    lastReviewedAt: null,
    requestedReviewers: ["you"],
    size: { additions: 40, deletions: 6, changedFiles: 3 },
    ...overrides,
  };
}

/** A host with a matching project, a spawn stub, and one row already swept. */
async function seededHost(
  options: { settings?: Record<string, string>; row?: Partial<ClassifiedRow>; project?: typeof PROJECT } = {},
) {
  spawnCount = 0;
  const liveThreads: Array<{ id: string }> = [];
  const fixture = createFakePluginHost({
    pluginId: PLUGIN_ID,
    ...(options.settings ? { settings: options.settings } : {}),
    sdk: {
      projects: { list: async () => [options.project ?? PROJECT] },
      threads: {
        spawn: async () => {
          // Give a racing second call a window to slip through if the
          // in-flight guard is missing.
          await new Promise((resolve) => setTimeout(resolve, 20));
          const thread = { id: `thr_${++spawnCount}` };
          liveThreads.push(thread);
          return thread;
        },
        list: async () => [...liveThreads],
        archive: async () => ({}),
      },
    },
  });
  await plugin(fixture.bb);
  createStore(fixture.bb.storage.database() as never).replaceAll({
    rows: [seedRow(options.row)],
    skippedRepos: [],
    truncated: false,
    sweptAt: Date.parse("2026-03-10T12:00:00Z"),
  });
  return { ...fixture, liveThreads };
}

/**
 * The whole panel gesture in one call: fetch the seeds, then submit them back
 * untouched, which is what happens when the user accepts BB's composer as it
 * opens. Tests that care about the seeds call `reviewThisDraft` directly;
 * tests that care about the spawn go through here.
 */
async function reviewThis(
  harness: Awaited<ReturnType<typeof seededHost>>["harness"],
  { repo, number }: { repo: string; number: number },
) {
  const draft = await harness.behavior.callRpc("reviewThisDraft", { repo, number });
  if (draft.existingThreadId) {
    return { threadId: draft.existingThreadId, existing: true, reason: null };
  }
  if (!draft.seed) return { threadId: null, existing: false, reason: draft.reason };

  // Stands in for what BB's composer resolves from those seeds. Only the
  // fields the plugin's own schema reads are asserted anywhere; the rest is
  // forwarded verbatim, so a faithful shape is enough.
  return await harness.behavior.callRpc("reviewThisSubmit", {
    repo,
    number,
    request: {
      projectId: draft.seed.projectId,
      providerId: draft.seed.providerId ?? undefined,
      model: draft.seed.model ?? undefined,
      permissionMode: draft.seed.permissionMode,
      environment: { type: "project-default" },
      input: [{ type: "text", text: draft.seed.prompt, mentions: [] }],
    },
  });
}

/**
 * The newest host's gh-context. Every host gets its own, empty, so links never
 * leak between tests.
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
    const { bb, harness } = createFakePluginHost({ pluginId: PLUGIN_ID });
    await plugin(bb);

    expect(harness.registrations.rpcMethods).toEqual(
      expect.arrayContaining([
        "listRows",
        "refresh",
        "reviewThisDraft",
        "reviewThisSubmit",
        "reviewBatchStart",
        "archiveThread",
        "setNote",
        "markSeen",
      ]),
    );
    expect(harness.registrations.services.map((service) => service.name)).toContain("sweep");
    expect(Object.keys(harness.registrations.settingsDescriptors)).toEqual(
      expect.arrayContaining(["syncIntervalMinutes", "ghPath", "staleAfterDays"]),
    );
  });

  it("returns an empty list before the first sweep", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: PLUGIN_ID,
      sdk: { projects: { list: async () => [] } },
    });
    await plugin(bb);

    const listing = await harness.behavior.callRpc("listRows", null);
    expect(listing).toMatchObject({
      rows: [],
      sweptAt: null,
      staleAfterDays: 2,
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
      pluginId: PLUGIN_ID,
      settings: { ghPath: "/nonexistent/gh-does-not-exist" },
    });
    await plugin(bb);

    const result = await harness.behavior.callRpc("refresh", null);
    expect(result.ok).toBe(false);
    expect(harness.needsConfigurationMessages).toEqual([]);
  });

  it("reports needs-configuration once gh is consistently unreachable", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: PLUGIN_ID,
      settings: { ghPath: "/nonexistent/gh-does-not-exist" },
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

  it("never reaches threads.spawn from the background sweep", async () => {
    // The sweep is deterministic and spends no model tokens. Only a click does.
    const { bb, harness } = createFakePluginHost({
      pluginId: PLUGIN_ID,
      settings: { ghPath: "/nonexistent/gh-does-not-exist" },
    });
    await plugin(bb);

    const service = harness.behavior.runService("sweep");
    await new Promise((resolve) => setTimeout(resolve, 50));
    service.controller.abort();
    await service.done;

    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("resolves the stale threshold server-side so the panel does not re-parse it", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: PLUGIN_ID,
      settings: { staleAfterDays: "not a number" },
      sdk: { projects: { list: async () => [] } },
    });
    await plugin(bb);
    expect((await harness.behavior.callRpc("listRows", null)).staleAfterDays).toBe(2);
  });

  it("declines to spawn when no bb project matches the repository", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: PLUGIN_ID,
      sdk: { projects: { list: async () => [] } },
    });
    await plugin(bb);

    // The refusal lands on the draft, before the composer ever opens: there
    // is no project to compose into, so there is nothing to show.
    const result = await harness.behavior.callRpc("reviewThisDraft", {
      repo: "acme/widgets",
      number: 1,
    });
    expect(result.seed).toBeNull();
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("declines to spawn for a review no longer in the sweep", async () => {
    const { harness } = await seededHost();
    const result = await harness.behavior.callRpc("reviewThisDraft", {
      repo: "acme/widgets",
      number: 999,
    });
    expect(result.reason).toMatch(/no longer in the sweep/);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("never spawns for a review that left the sweep while the composer was open", async () => {
    // The composer can sit open for as long as the user likes, so the row is
    // re-read at submit rather than trusted from the draft.
    const { harness } = await seededHost();
    const result = await harness.behavior.callRpc("reviewThisSubmit", {
      repo: "acme/widgets",
      number: 999,
      request: {
        projectId: "proj_widgets",
        input: [{ type: "text", text: "Review it.", mentions: [] }],
      },
    });
    expect(result.reason).toMatch(/no longer in the sweep/);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });
});

describe("reviewThisSubmit is one thread per review", () => {
  it("spawns once and reuses the thread on a second click", async () => {
    const { harness } = await seededHost();

    const first = await reviewThis(harness, { repo: "acme/widgets", number: 42 });
    const second = await reviewThis(harness, { repo: "acme/widgets", number: 42 });

    expect(first.existing).toBe(false);
    expect(second.existing).toBe(true);
    expect(second.threadId).toBe(first.threadId);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

  it("spawns once when two clicks race before the first returns", async () => {
    const { harness } = await seededHost();

    const [first, second] = await Promise.all([
      reviewThis(harness, { repo: "acme/widgets", number: 42 }),
      reviewThis(harness, { repo: "acme/widgets", number: 42 }),
    ]);

    expect(second.threadId).toBe(first.threadId);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

  it("titles the thread with the action, number and PR gist, not the repository", async () => {
    const { harness } = await seededHost({ row: { state: "re-review" } });
    await reviewThis(harness, { repo: "acme/widgets", number: 42 });

    // callsTo returns each call's argument list, so [0] is spawn's only arg.
    const [[args]] = harness.inspection.sdk.callsTo("threads.spawn") as [[{ title: string }]];
    expect(args.title).toBe("Re-review #42: Add the widget endpoint");
    expect(args.title.length).toBeLessThanOrEqual(40);
  });

  it("pins the provider that can actually see the code-review skill", async () => {
    const { harness } = await seededHost();
    await reviewThis(harness, { repo: "acme/widgets", number: 42 });

    const [[args]] = harness.inspection.sdk.callsTo("threads.spawn") as [[
      { providerId?: string; model?: string },
    ]];
    expect(args.providerId).toBe("claude-code");
    // Blank model setting must not reach spawn as an empty string.
    expect(args.model).toBeUndefined();
  });

  it("honours a configured model", async () => {
    const { harness } = await seededHost({ settings: { model: " claude-sonnet-5 " } });
    await reviewThis(harness, { repo: "acme/widgets", number: 42 });

    const [[args]] = harness.inspection.sdk.callsTo("threads.spawn") as [[{ model?: string }]];
    expect(args.model).toBe("claude-sonnet-5");
  });

  it("opens the composer on a new worktree, not the main checkout", async () => {
    const { harness } = await seededHost();
    const draft = await harness.behavior.callRpc("reviewThisDraft", {
      repo: "acme/widgets",
      number: 42,
    });

    // hostId included deliberately. bb's schema declares it optional and then
    // refuses the environment without it — "hostId is required unless
    // workspace.type is personal" — and in the composer that refusal is
    // silent: the picker just falls back to the local checkout.
    expect(draft.seed!.environment).toEqual({
      type: "host",
      hostId: "host_1",
      workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
    });
  });

  it("carries the no-posting instruction even though the composer never shows it", async () => {
    // This is the whole safety story for the action, so it is asserted at the
    // wire. It is deliberately NOT in the seed the composer opens with: the
    // rule must hold whatever gets typed in that box, which is exactly why it
    // sits in the trailer the server reassembles at submit.
    const { harness } = await seededHost();

    const draft = await harness.behavior.callRpc("reviewThisDraft", {
      repo: "acme/widgets",
      number: 42,
    });
    expect(draft.seed!.skills.map((skill) => skill.instruction).join("\n")).not.toMatch(
      /Do NOT post anything to GitHub/,
    );

    // Submitted with the box emptied to nothing but a stray word, the way a
    // user who deleted the seeded text would.
    await harness.behavior.callRpc("reviewThisSubmit", {
      repo: "acme/widgets",
      number: 42,
      request: {
        projectId: "proj_widgets",
        input: [{ type: "text", text: "just look at it", mentions: [] }],
      },
    });

    const [[args]] = harness.inspection.sdk.callsTo("threads.spawn") as [[
      { input: { type: string; text?: string }[] },
    ]];
    // Joined with nothing, which is how bb concatenates a message's text
    // items. The blank lines have to already be in them.
    const sent = args.input.map((item) => item.text ?? "").join("");
    expect(sent).toMatch(/Do NOT post anything to GitHub/);
    // No seam: the URL ending the header, and the last word typed, each get
    // their own blank line rather than running into what follows.
    expect(sent).toContain("pull/42\n\njust look at it");
    expect(sent).toContain("just look at it\n\nReport your findings");
    expect(sent).toContain("acme/widgets#42");
    // And what was typed survives, between the two ends.
    expect(sent).toContain("just look at it");
  });

  it("reports the linked thread on the row", async () => {
    const { harness } = await seededHost();
    await reviewThis(harness, { repo: "acme/widgets", number: 42 });

    const listing = await harness.behavior.callRpc("listRows", null);
    expect(listing.rows[0]).toMatchObject({ number: 42, threadId: "thr_1" });
  });

  it("frees the row when its thread is deleted", async () => {
    const { harness } = await seededHost();
    await reviewThis(harness, { repo: "acme/widgets", number: 42 });

    await harness.behavior.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: "thr_1" }),
    });

    expect((await harness.behavior.callRpc("listRows", null)).rows[0]!.threadId).toBeNull();

    await reviewThis(harness, { repo: "acme/widgets", number: 42 });
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
  });

  it("frees the row when a thread vanished with no event to witness it", async () => {
    // Lifecycle events only fire while the plugin is loaded, so a thread
    // deleted across a restart is invisible to them. Only reconciliation on the
    // next sweep can release the row.
    const { harness, liveThreads } = await seededHost({
      settings: { ghPath: "/nonexistent/gh-does-not-exist" },
    });

    await reviewThis(harness, { repo: "acme/widgets", number: 42 });
    expect((await harness.behavior.callRpc("listRows", null)).rows[0]!.threadId).toBe("thr_1");

    liveThreads.length = 0;
    // The sweep itself fails here; reconciliation must still run.
    await harness.behavior.callRpc("refresh", null);

    expect((await harness.behavior.callRpc("listRows", null)).rows[0]!.threadId).toBeNull();
  });
});

describe("reviewBatchStart", () => {
  type SpawnedArgs = {
    projectId: string;
    providerId?: string;
    model?: string;
    permissionMode?: string;
    environment: unknown;
    executionInputSources?: Record<string, string>;
    input: { type: string; text?: string }[];
    title: string;
  };

  function spawned(harness: Awaited<ReturnType<typeof seededHost>>["harness"]): SpawnedArgs {
    const [[args]] = harness.inspection.sdk.callsTo("threads.spawn") as [[SpawnedArgs]];
    return args;
  }

  it("starts with the settings Start review seeds, in a new worktree, and marks them chosen", async () => {
    const { harness } = await seededHost({ settings: { model: "claude-sonnet-5" } });

    const result = await harness.behavior.callRpc("reviewBatchStart", {
      repo: "acme/widgets",
      number: 42,
      prompt: "Look at the endpoint's error handling first.",
    });

    expect(result).toEqual({ threadId: "thr_1", existing: false, reason: null });
    const args = spawned(harness);
    expect(args).toMatchObject({
      projectId: "proj_a",
      providerId: "claude-code",
      model: "claude-sonnet-5",
      permissionMode: "full",
      environment: {
        type: "host",
        hostId: "host_1",
        workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
      },
      title: "Review #42: Add the widget endpoint",
    });
    // Without a source, bb drops the provider and model and re-derives the
    // project's own defaults, which would undo the settings.
    expect(args.executionInputSources).toEqual({
      permissionMode: "explicit",
      providerId: "explicit",
      model: "explicit",
    });
  });

  it("leaves a blank model out rather than marking it chosen", async () => {
    const { harness } = await seededHost();
    await harness.behavior.callRpc("reviewBatchStart", { repo: "acme/widgets", number: 42, prompt: "Review it." });

    const args = spawned(harness);
    expect(args.model).toBeUndefined();
    expect(args.executionInputSources).not.toHaveProperty("model");
  });

  it("sends the edited prompt between the pull request and the no-posting rule", async () => {
    const { harness } = await seededHost();
    await harness.behavior.callRpc("reviewBatchStart", {
      repo: "acme/widgets",
      number: 42,
      prompt: "just look at it",
    });

    const sent = spawned(harness).input.map((item) => item.text ?? "").join("");
    expect(sent).toContain("acme/widgets#42");
    expect(sent).toContain("pull/42\n\njust look at it");
    expect(sent).toContain("just look at it\n\nReport your findings");
    expect(sent).toMatch(/Do NOT post anything to GitHub/);
  });

  it("returns the thread a review already has rather than starting another", async () => {
    const { harness } = await seededHost();
    const first = await reviewThis(harness, { repo: "acme/widgets", number: 42 });

    const second = await harness.behavior.callRpc("reviewBatchStart", {
      repo: "acme/widgets",
      number: 42,
      prompt: "Review it.",
    });

    expect(second).toEqual({ threadId: first.threadId, existing: true, reason: null });
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

  it("starts one thread when Batch and Start review race", async () => {
    const { harness } = await seededHost();

    const [batch, single] = await Promise.all([
      harness.behavior.callRpc("reviewBatchStart", { repo: "acme/widgets", number: 42, prompt: "Review it." }),
      reviewThis(harness, { repo: "acme/widgets", number: 42 }),
    ]);

    expect(single.threadId).toBe(batch.threadId);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

  it("says why when no project here has the repository", async () => {
    const { harness } = await seededHost({ row: { repo: "acme/gadgets" } });

    const result = await harness.behavior.callRpc("reviewBatchStart", {
      repo: "acme/gadgets",
      number: 42,
      prompt: "Review it.",
    });

    expect(result).toEqual({
      threadId: null,
      existing: false,
      reason: "No bb project is checked out for acme/gadgets.",
    });
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("refuses an empty prompt", async () => {
    const { harness } = await seededHost();
    await expect(
      harness.behavior.callRpc("reviewBatchStart", { repo: "acme/widgets", number: 42, prompt: "   " }),
    ).rejects.toThrow();
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });
});

describe("permission mode", () => {
  async function spawnedWith(settings: Record<string, string>) {
    const { harness } = await seededHost({ settings });
    await reviewThis(harness, { repo: "acme/widgets", number: 42 });
    const [[args]] = harness.inspection.sdk.callsTo("threads.spawn") as [[
      { permissionMode?: string },
    ]];
    return args.permissionMode;
  }

  it("defaults to full, the only mode that can reach GitHub to read the diff", async () => {
    // auto keeps the workspace sandbox, which blocks network egress, so the
    // thread could not fetch the diff it was started for.
    expect(await spawnedWith({})).toBe("full");
  });

  it("honours a configured mode", async () => {
    expect(await spawnedWith({ permissionMode: "auto" })).toBe("auto");
  });

  it("never passes a mode bb would reject", async () => {
    expect(await spawnedWith({ permissionMode: "bypass-everything" })).toBe("full");
  });
});

describe("archiveThread", () => {
  it("archives the linked thread and frees the row", async () => {
    const { harness } = await seededHost();
    await reviewThis(harness, { repo: "acme/widgets", number: 42 });

    const result = await harness.behavior.callRpc("archiveThread", {
      repo: "acme/widgets",
      number: 42,
    });

    expect(result.ok).toBe(true);
    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(1);
    expect((await harness.behavior.callRpc("listRows", null)).rows[0]!.threadId).toBeNull();
  });

  it("declines when the review has no thread", async () => {
    const { harness } = await seededHost();
    const result = await harness.behavior.callRpc("archiveThread", {
      repo: "acme/widgets",
      number: 42,
    });
    expect(result.ok).toBe(false);
    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
  });
});

describe("gh-context", () => {
  it("moves links recorded before gh-context into it, once", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: PLUGIN_ID,
      settings: { ghPath: "/nonexistent/gh-does-not-exist" },
    });
    const db = bb.storage.database();
    await plugin(bb);
    db.prepare(
      `INSERT INTO review_threads (repo, number, thread_id, created_at) VALUES (?, ?, ?, ?)`,
    ).run("acme/widgets", 7, "thr_1", 1);

    await harness.behavior.callRpc("refresh", null);
    await harness.behavior.callRpc("refresh", null);
    expect(ghContext.links).toEqual([
      { threadId: "thr_1", repo: "acme/widgets", kind: "pull", number: 7, source: "spawned:review-sweep" },
    ]);
  });

  it("offers no thread starts while gh-context is missing, and says why", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: PLUGIN_ID });
    await plugin(bb);
    createStore(bb.storage.database() as never).replaceAll({
      rows: [seedRow()],
      repos: ["acme/widgets"],
      skippedRepos: [],
      truncated: false,
      sweptAt: 1,
    } as never);
    ghContext.setAvailable(false);
    const listing = await harness.behavior.callRpc("listRows", null);
    expect(listing.rows.every((row: { canSpawn: boolean }) => row.canSpawn === false)).toBe(true);
    expect(listing.lastError).toMatch(/gh-context/);
  });
});

describe("notes and seen counts", () => {
  /**
   * A stand-in for gh that prints one search result, so a real sweep runs
   * without the network. The pull request has `comments` comments.
   */
  function fakeGh(comments: number): string {
    const dir = mkdtempSync(join(tmpdir(), "review-sweep-gh-"));
    const path = join(dir, "gh");
    const response = {
      data: {
        viewer: { login: "hubber" },
        search: {
          nodes: [
            {
              number: 42,
              title: "Add the widget endpoint",
              url: "https://github.com/acme/widgets/pull/42",
              isDraft: false,
              createdAt: "2026-03-01T12:00:00Z",
              additions: 40,
              deletions: 6,
              changedFiles: 3,
              repository: { nameWithOwner: "acme/widgets" },
              author: { login: "octocat" },
              comments: { totalCount: comments },
              reviews: { nodes: [] },
              reviewRequests: { nodes: [{ requestedReviewer: { login: "hubber" } }] },
              timelineItems: {
                nodes: [
                  { createdAt: "2026-03-06T12:00:00Z", requestedReviewer: { login: "hubber" } },
                ],
              },
            },
          ],
        },
      },
    };
    writeFileSync(path, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(response)}\nJSON\n`);
    chmodSync(path, 0o755);
    return path;
  }

  it("returns each row's comment count, note, and new comments", async () => {
    const { harness } = await seededHost({ row: { comments: 3 } });
    expect((await harness.behavior.callRpc("listRows", null)).rows[0]).toMatchObject({
      comments: 3,
      note: null,
      newComments: 0,
    });
  });

  it("reads a row stored before the count existed as having none", async () => {
    const { harness } = await seededHost();
    expect((await harness.behavior.callRpc("listRows", null)).rows[0]!.comments).toBe(0);
  });

  it("lists each row's checks and other reviewers", async () => {
    const checks = { pass: 5, fail: 1, skip: 0, pending: 0, cancelled: 0, total: 6 };
    const reviewers = [{ login: "hubber", state: "approved" as const, team: false }];
    const { harness } = await seededHost({ row: { checks, reviewers } });
    expect((await harness.behavior.callRpc("listRows", null)).rows[0]).toMatchObject({ checks, reviewers });
  });

  it("reads a row stored before checks and reviewers existed as having none", async () => {
    const { harness } = await seededHost();
    expect((await harness.behavior.callRpc("listRows", null)).rows[0]).toMatchObject({
      checks: { pass: 0, fail: 0, skip: 0, pending: 0, cancelled: 0, total: 0 },
      reviewers: [],
    });
  });

  it("saves a note and lists it with the row", async () => {
    const { harness } = await seededHost();
    expect(
      await harness.behavior.callRpc("setNote", {
        repo: "acme/widgets",
        number: 42,
        body: "Ask hubber first",
      }),
    ).toEqual({ ok: true });
    expect((await harness.behavior.callRpc("listRows", null)).rows[0]!.note).toBe(
      "Ask hubber first",
    );
  });

  it("lists a snoozed request as snoozed until its day, or until your review is requested again", async () => {
    const { bb, harness } = await seededHost();
    const later = localDay(new Date(Date.now() + 3 * 86_400_000));
    expect(await harness.behavior.callRpc("snooze", { repo: "acme/widgets", number: 42, until: later })).toEqual({ ok: true });
    expect((await harness.behavior.callRpc("listRows", null)).rows[0]!.snoozedUntil).toBe(later);

    // Its day has come.
    const store = createStore(bb.storage.database() as never);
    store.setSnooze("acme/widgets", 42, localDay(new Date()), Date.now());
    expect((await harness.behavior.callRpc("listRows", null)).rows[0]!.snoozedUntil).toBeNull();

    // Snoozed before the request was made, as if it was requested again since.
    store.setSnooze("acme/widgets", 42, later, 0);
    expect((await harness.behavior.callRpc("listRows", null)).rows[0]!.snoozedUntil).toBeNull();

    await harness.behavior.callRpc("snooze", { repo: "acme/widgets", number: 42, until: null });
    expect(store.snoozes().size).toBe(0);
  });

  it("deletes the note when it is saved empty, rather than keeping blank text", async () => {
    const { bb, harness } = await seededHost();
    await harness.behavior.callRpc("setNote", { repo: "acme/widgets", number: 42, body: "Later" });
    await harness.behavior.callRpc("setNote", { repo: "acme/widgets", number: 42, body: "" });

    expect((await harness.behavior.callRpc("listRows", null)).rows[0]!.note).toBeNull();
    expect(createStore(bb.storage.database() as never).notes().size).toBe(0);
  });

  it("shows nothing new on the first sweep after an upgrade", async () => {
    const { harness } = await seededHost({
      settings: { ghPath: fakeGh(9), filterToProjects: "off" },
    });
    expect((await harness.behavior.callRpc("refresh", null)).ok).toBe(true);
    const row = (await harness.behavior.callRpc("listRows", null)).rows[0]!;
    expect(row.comments).toBe(9);
    expect(row.newComments).toBe(0);
  });

  it("counts comments since the first sweep saw it, and clears them once seen", async () => {
    const { bb, harness } = await seededHost({ row: { comments: 2 } });
    const store = createStore(bb.storage.database() as never);
    store.recordFirstSeen(store.readRows(), 1);
    store.replaceAll({
      rows: [seedRow({ comments: 5 })],
      skippedRepos: [],
      truncated: false,
      sweptAt: 2,
    });
    expect((await harness.behavior.callRpc("listRows", null)).rows[0]!.newComments).toBe(3);

    expect(
      await harness.behavior.callRpc("markSeen", { repo: "acme/widgets", number: 42 }),
    ).toEqual({ ok: true });
    expect((await harness.behavior.callRpc("listRows", null)).rows[0]!.newComments).toBe(0);
  });

  it("never shows a negative count when comments were deleted", async () => {
    const { bb, harness } = await seededHost({ row: { comments: 1 } });
    createStore(bb.storage.database() as never).markSeen("acme/widgets", 42, 4, 1);
    expect((await harness.behavior.callRpc("listRows", null)).rows[0]!.newComments).toBe(0);
  });

  it("refuses to mark a review the sweep does not have", async () => {
    const { harness } = await seededHost();
    expect(
      await harness.behavior.callRpc("markSeen", { repo: "acme/widgets", number: 41 }),
    ).toEqual({ ok: false });
  });

  it("records nothing when a row stored before the count existed is opened", async () => {
    // Recording 0 would make every comment on it read as new once the next
    // sweep stores the real count.
    const { bb, harness } = await seededHost();
    expect(
      await harness.behavior.callRpc("markSeen", { repo: "acme/widgets", number: 42 }),
    ).toEqual({ ok: true });
    await reviewThis(harness, { repo: "acme/widgets", number: 42 });
    expect(createStore(bb.storage.database() as never).seenCounts().has("acme/widgets#42")).toBe(false);
  });

  it("marks the review seen when a thread is started for it", async () => {
    const { bb, harness } = await seededHost({ row: { comments: 6 } });
    await reviewThis(harness, { repo: "acme/widgets", number: 42 });
    expect(createStore(bb.storage.database() as never).seenCounts().get("acme/widgets#42")).toBe(6);
  });
});

describe("the thread's diff base", () => {
  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "octocat", GIT_AUTHOR_EMAIL: "octocat@example.com", GIT_COMMITTER_NAME: "octocat", GIT_COMMITTER_EMAIL: "octocat@example.com" },
    }).trim();
  }

  function commit(cwd: string, file: string): string {
    writeFileSync(join(cwd, file), file);
    git(cwd, "add", file);
    git(cwd, "commit", "-q", "-m", file);
    return git(cwd, "rev-parse", "HEAD");
  }

  /**
   * A stand-in for acme/widgets on GitHub, with #42 stacked on `parent`, and a
   * checkout of it whose origin is acme/widgets. Both branches move after the
   * clone, as they do when someone pushes or rebases on GitHub.
   */
  function checkout() {
    const root = mkdtempSync(join(tmpdir(), "review-sweep-base-"));
    const github = join(root, "github");
    git(root, "init", "-q", "-b", "main", github);
    commit(github, "a.txt");
    git(github, "checkout", "-q", "-b", "parent");
    commit(github, "b.txt");
    const path = join(root, "checkout");
    git(root, "clone", "-q", github, path);
    git(path, "remote", "set-url", "origin", "git@github.com:acme/widgets.git");
    git(path, "config", `url.${github}.insteadOf`, "git@github.com:acme/widgets.git");
    const parent = commit(github, "c.txt");
    git(github, "checkout", "-q", "-b", "child");
    git(github, "update-ref", "refs/pull/42/head", commit(github, "d.txt"));
    return { path, parent, project: { ...PROJECT, sources: [{ hostId: "host_1", path, isDefault: true }] } };
  }

  function environmentOf(harness: Awaited<ReturnType<typeof seededHost>>["harness"]) {
    const [[args]] = harness.inspection.sdk.callsTo("threads.spawn") as [[{ environment: unknown }]];
    return args.environment;
  }

  it("starts a stacked pull request's worktree from origin/<its base>, fetched first", async () => {
    const { path, parent, project } = checkout();
    const { harness } = await seededHost({ project, row: { baseRefName: "parent", headRefName: "child" } });

    await harness.behavior.callRpc("reviewBatchStart", { repo: "acme/widgets", number: 42, prompt: "Review it." });

    expect(environmentOf(harness)).toEqual({
      type: "host",
      hostId: "host_1",
      workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "origin/parent" } },
    });
    expect(git(path, "rev-parse", "origin/parent")).toBe(parent);
  });

  it("uses origin/main for a pull request based on main", async () => {
    const { project } = checkout();
    const { harness } = await seededHost({ project, row: { baseRefName: "main", headRefName: "child" } });

    // Through the composer, which submits the new worktree Start review seeds.
    const draft = await harness.behavior.callRpc("reviewThisDraft", { repo: "acme/widgets", number: 42 });
    await harness.behavior.callRpc("reviewThisSubmit", {
      repo: "acme/widgets",
      number: 42,
      request: { projectId: "proj_a", environment: draft.seed!.environment, input: [{ type: "text", text: "Review it.", mentions: [] }] },
    } as never);

    expect(environmentOf(harness)).toMatchObject({ workspace: { baseBranch: { kind: "named", name: "origin/main" } } });
  });

  it("leaves an environment the user picked in the composer alone", async () => {
    const { project } = checkout();
    const { harness } = await seededHost({ project, row: { baseRefName: "parent" } });
    const local = { type: "host", hostId: "host_1", workspace: { type: "unmanaged", path: null } };

    await harness.behavior.callRpc("reviewThisSubmit", {
      repo: "acme/widgets",
      number: 42,
      request: { projectId: "proj_a", environment: local, input: [{ type: "text", text: "Review it.", mentions: [] }] },
    } as never);

    expect(environmentOf(harness)).toEqual(local);
  });

  it("keeps bb's default for a row swept before it carried the base", async () => {
    const { harness } = await seededHost();
    await harness.behavior.callRpc("reviewBatchStart", { repo: "acme/widgets", number: 42, prompt: "Review it." });
    expect(environmentOf(harness)).toMatchObject({ workspace: { baseBranch: { kind: "default" } } });
  });
});

describe("the sweep service", () => {
  it("stops mid-sweep when the service is stopped, and keeps the last listing", async () => {
    // A gh that hangs, as a slow sweep does when a reload lands in it. A
    // service that waits on it misses bb's five-second stop window, and bb
    // then stops answering every RPC until the plugin is reloaded.
    const dir = mkdtempSync(join(tmpdir(), "review-sweep-hang-"));
    const gh = join(dir, "gh");
    const started = join(dir, "started");
    writeFileSync(gh, `#!/bin/sh\ntouch '${started}'\nexec sleep 30\n`);
    chmodSync(gh, 0o755);
    const { bb, harness } = createFakePluginHost({
      pluginId: "review-sweep",
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
