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
import { createStore } from "./sweep/store.js";
import plugin from "./server.js";

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
    // Never the real gh: a draft now resolves the pull request's branch, and a
    // test that reached GitHub would be slow and depend on the network.
    settings: { ghPath: "/nonexistent/gh-does-not-exist", ...options.settings },
    sdk: {
      ...sdk,
      plugins: { callRpc: ghContext.callRpc, ...(sdk.plugins as object | undefined) },
    } as never,
  });
}

describe("server", () => {
  it("registers the rpc methods, the service, and the settings", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "pr-sweep" });
    await plugin(bb);

    expect(harness.registrations.rpcMethods).toEqual(
      expect.arrayContaining([
        "listRows",
        "refresh",
        "workOnThisDraft",
        "workOnThisSubmit",
      ]),
    );
    expect(harness.registrations.services.map((service) => service.name)).toContain("sweep");
    expect(Object.keys(harness.registrations.settingsDescriptors)).toEqual(
      expect.arrayContaining(["syncIntervalMinutes", "ghPath"]),
    );
  });

  it("returns an empty list before the first sweep", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "pr-sweep",
      sdk: { projects: { list: async () => [] } },
    });
    await plugin(bb);

    const result = await harness.behavior.callRpc("listRows", null);
    expect(result).toMatchObject({ rows: [], sweptAt: null });
    // Through the contract, not the store: a field missing from the zod schema
    // is stripped here rather than erroring, and the panel just goes blank.
    expect(result.skippedRepos).toEqual([]);
  });

  it("does not hide itself over a single unreachable gh", async () => {
    // needs-configuration is one-way — the SDK clears it on the next load and
    // offers no way back — so latching on one blip takes the plugin's panels
    // out of the sidebar until someone thinks to reload it. That happened.
    const { bb, harness } = createFakePluginHost({
      pluginId: "pr-sweep",
      settings: { ghPath: "/nonexistent/gh-does-not-exist" },
    });
    await plugin(bb);

    const result = await harness.behavior.callRpc("refresh", null);
    expect(result.ok).toBe(false);
    expect(harness.needsConfigurationMessages).toEqual([]);
  });

  it("reports needs-configuration once gh is consistently unreachable", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "pr-sweep",
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
    const { bb, harness } = createFakePluginHost({
      pluginId: "pr-sweep",
      settings: { ghPath: "/nonexistent/gh-does-not-exist" },
    });
    await plugin(bb);

    const service = harness.behavior.runService("sweep");
    await new Promise((resolve) => setTimeout(resolve, 50));
    service.controller.abort();
    await service.done;

    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("stops mid-sweep when the service is stopped, and keeps the last listing", async () => {
    // A gh that hangs, as a slow sweep does when a reload lands in it. Before
    // the service passed its signal down, bb gave up waiting after five
    // seconds and the plugin stopped answering every RPC.
    const dir = mkdtempSync(join(tmpdir(), "pr-sweep-hang-"));
    const gh = join(dir, "gh");
    const started = join(dir, "started");
    writeFileSync(gh, `#!/bin/sh\ntouch '${started}'\nexec sleep 30\n`);
    chmodSync(gh, 0o755);
    const { bb, harness } = createFakePluginHost({
      pluginId: "pr-sweep",
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

  it("declines to spawn when no bb project matches the repository", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "pr-sweep",
      sdk: { projects: { list: async () => [] } },
    });
    await plugin(bb);

    // The refusal lands on the draft, before the composer ever opens: there
    // is no project to compose into, so there is nothing to show.
    const result = await harness.behavior.callRpc("workOnThisDraft", {
      repo: "acme/widgets",
      number: 1,
    });
    expect(result.seed).toBeNull();
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("never spawns for a pull request that left the sweep while the composer was open", async () => {
    // The composer can sit open for as long as the user likes, so the row is
    // re-read at submit rather than trusted from the draft.
    const { bb, harness } = createFakePluginHost({ pluginId: "pr-sweep" });
    await plugin(bb);

    const result = await harness.behavior.callRpc("workOnThisSubmit", {
      repo: "acme/widgets",
      number: 1,
      request: {
        projectId: "proj_a",
        input: [{ type: "text", text: "Work on it.", mentions: [] }],
      },
    });
    expect(result.reason).toMatch(/no longer in the sweep/);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });
});

let spawnCount = 0;

/** One classified row, as a sweep would have written it. */
/**
 * The whole panel gesture in one call: fetch the seeds, then submit them back
 * untouched, which is what happens when the user accepts BB's composer as it
 * opens. Tests that care about the seeds call `workOnThisDraft` directly;
 * tests that care about the spawn go through here.
 */
async function workOnThis(
  harness: { behavior: { callRpc: (method: string, input: unknown) => Promise<any> } },
  { repo, number }: { repo: string; number: number },
) {
  const draft = await harness.behavior.callRpc("workOnThisDraft", { repo, number });
  if (draft.existingThreadId) {
    return { threadId: draft.existingThreadId, existing: true, reason: null };
  }
  if (!draft.seed) return { threadId: null, existing: false, reason: draft.reason };

  // Stands in for what BB's composer resolves from those seeds. Only the
  // fields the plugin's own schema reads are asserted anywhere; the rest is
  // forwarded verbatim, so a faithful shape is enough.
  return await harness.behavior.callRpc("workOnThisSubmit", {
    repo,
    number,
    request: {
      projectId: draft.seed.projectId,
      ...(draft.seed.providerId ? { providerId: draft.seed.providerId } : {}),
      ...(draft.seed.model ? { model: draft.seed.model } : {}),
      permissionMode: draft.seed.permissionMode,
      environment: { type: "project-default" },
      input: [{ type: "text", text: draft.seed.prompt, mentions: [] }],
    },
  });
}

function seedRow() {
  return {
    repo: "acme/widgets",
    number: 42,
    title: "Add the widget endpoint",
    url: "https://github.com/acme/widgets/pull/42",
    isDraft: false,
    flags: ["conflict"],
    group: "needs-action",
    checks: { pass: 1, fail: 0, skip: 0, pending: 0, cancelled: 0, total: 1 },
    approvedBy: [],
    commentedBy: [],
    waitingOn: [],
    awaitingReReview: false,
    lastCommentBy: null,
    unresolvedThreads: 0,
    outdatedThreads: 0,
    notedBy: [],
  };
}


describe("workOnThisSubmit is one thread per pull request", () => {
  async function seededHost({ settings }: { settings?: Record<string, string> } = {}) {
    spawnCount = 0;
    const fixture = createFakePluginHost({
      pluginId: "pr-sweep",
      settings,
      sdk: {
        projects: {
          list: async () => [
            { id: "proj_a", gitRemoteUrl: "git@github.com:acme/widgets.git", sources: [] },
          ],
        },
        threads: {
          spawn: async () => {
            // Give a racing second call a window to slip through if the
            // in-flight guard is missing.
            await new Promise((resolve) => setTimeout(resolve, 20));
            return { id: `thr_${++spawnCount}` };
          },
        },
      },
    });
    await plugin(fixture.bb);

    // Seed a row the way a sweep would, through the plugin's own database.
    createStore(fixture.bb.storage.database() as never).replaceRepoRows("acme/widgets", [
      seedRow(),
    ] as never);
    return fixture;
  }

  it("says why the thread cannot start on the pull request's branch", async () => {
    const { harness } = await seededHost();
    const draft = await harness.behavior.callRpc("workOnThisDraft", { repo: "acme/widgets", number: 42 });
    expect(draft.seed!.workspace).toEqual({
      branch: null,
      note: "Could not read the branch of acme/widgets#42.",
    });
  });

  it("refuses rather than starting elsewhere when the promised branch is unavailable", async () => {
    const { harness } = await seededHost();
    const result = await harness.behavior.callRpc("workOnThisSubmit", {
      repo: "acme/widgets",
      number: 42,
      onBranch: true,
      request: { projectId: "proj_a", input: [{ type: "text", text: "Fix it.", mentions: [] }] },
    });
    expect(result).toEqual({
      threadId: null,
      existing: false,
      reason: "Could not read the branch of acme/widgets#42.",
    });
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("spawns once and reuses the thread on a second click", async () => {
    const { harness } = await seededHost();

    const first = await workOnThis(harness, { repo: "acme/widgets", number: 42 });
    const second = await workOnThis(harness, { repo: "acme/widgets", number: 42 });

    expect(first.existing).toBe(false);
    expect(second.existing).toBe(true);
    expect(second.threadId).toBe(first.threadId);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

  it("spawns once when two clicks race before the first returns", async () => {
    const { harness } = await seededHost();

    const [first, second] = await Promise.all([
      workOnThis(harness, { repo: "acme/widgets", number: 42 }),
      workOnThis(harness, { repo: "acme/widgets", number: 42 }),
    ]);

    expect(second.threadId).toBe(first.threadId);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

  it("puts the worktree rules back even when the composer's box was emptied", async () => {
    // The composer only ever holds the middle of the prompt. These rules are
    // in the trailer precisely so they hold whatever gets typed — an agent
    // that builds its worktree in /tmp leaves work bb cannot see.
    const { harness } = await seededHost();

    const draft = await harness.behavior.callRpc("workOnThisDraft", {
      repo: "acme/widgets",
      number: 42,
    });
    expect(draft.seed!.skills.map((skill) => skill.instruction).join("\n")).not.toMatch(
      /You already have a git worktree/,
    );

    await harness.behavior.callRpc("workOnThisSubmit", {
      repo: "acme/widgets",
      number: 42,
      request: {
        projectId: "proj_a",
        input: [{ type: "text", text: "just the conflict please", mentions: [] }],
      },
    });

    const [[args]] = harness.inspection.sdk.callsTo("threads.spawn") as [[
      { input: { type: string; text?: string }[] },
    ]];
    // Joined with nothing, which is how bb concatenates a message's text
    // items. The blank lines have to already be in them.
    const sent = args.input.map((item) => item.text ?? "").join("");
    expect(sent).toMatch(/You already have a git worktree/);
    // No seam: the URL ending the header, and the last word typed, each get
    // their own blank line rather than running into what follows.
    expect(sent).toContain("pull/42\n\njust the conflict please");
    expect(sent).toContain("just the conflict please\n\nI started this");
    expect(sent).toMatch(/my explicit request for this work/);
    expect(sent).toContain("acme/widgets#42");
    // And what was typed survives, between the two ends.
    expect(sent).toContain("just the conflict please");
  });

  it("titles the thread with the number and PR gist, not the repository or the flag", async () => {
    const { harness } = await seededHost();
    await workOnThis(harness, { repo: "acme/widgets", number: 42 });

    // callsTo returns each call's argument list, so [0] is spawn's only arg.
    const [[spawnArgs]] = harness.inspection.sdk.callsTo("threads.spawn") as [[
      { title: string },
    ]];
    expect(spawnArgs.title).toBe("Refine #42: Add the widget endpoint");
    expect(spawnArgs.title.length).toBeLessThanOrEqual(40);
  });

  it("spawns a conflict thread on the provider default model", async () => {
    const { harness } = await seededHost();
    await workOnThis(harness, { repo: "acme/widgets", number: 42 });

    const [[spawnArgs]] = harness.inspection.sdk.callsTo("threads.spawn") as [[
      { model?: string },
    ]];
    expect(spawnArgs.model).toBeUndefined();
  });

  it("spawns a conflict thread on the model the setting names", async () => {
    const { harness } = await seededHost({
      settings: { modelByAction: '{"conflict": "claude-sonnet-5"}' },
    });
    await workOnThis(harness, { repo: "acme/widgets", number: 42 });

    const [[spawnArgs]] = harness.inspection.sdk.callsTo("threads.spawn") as [[
      { model?: string; providerId?: string },
    ]];
    expect(spawnArgs.model).toBe("claude-sonnet-5");
    expect(spawnArgs.providerId).toBe("claude-code");
  });

  it("takes the provider default model for an action with none configured", async () => {
    spawnCount = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "pr-sweep",
      sdk: {
        projects: {
          list: async () => [
            { id: "proj_a", gitRemoteUrl: "git@github.com:acme/widgets.git", sources: [] },
          ],
        },
        threads: { spawn: async () => ({ id: `thr_${++spawnCount}` }), list: async () => [] },
      },
    });
    await plugin(bb);
    createStore(bb.storage.database() as never).replaceRepoRows("acme/widgets", [
      { ...seedRow(), flags: ["ci-failing"] },
    ] as never);

    await workOnThis(harness, { repo: "acme/widgets", number: 42 });
    const [[spawnArgs]] = harness.inspection.sdk.callsTo("threads.spawn") as [[
      { model?: string },
    ]];
    expect(spawnArgs.model).toBeUndefined();
  });

  it("spawns anyway when the model setting is malformed", async () => {
    spawnCount = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "pr-sweep",
      settings: { modelByAction: "{not json" },
      sdk: {
        projects: {
          list: async () => [
            { id: "proj_a", gitRemoteUrl: "git@github.com:acme/widgets.git", sources: [] },
          ],
        },
        threads: { spawn: async () => ({ id: `thr_${++spawnCount}` }), list: async () => [] },
      },
    });
    await plugin(bb);
    createStore(bb.storage.database() as never).replaceRepoRows("acme/widgets", [
      seedRow(),
    ] as never);

    const result = await workOnThis(harness, { repo: "acme/widgets", number: 42 });
    expect(result.threadId).toBe("thr_1");
    expect(harness.logEntries.some((entry) => /Model by action/.test(entry.message))).toBe(true);
  });

  it("reports the linked thread on the row", async () => {
    const { harness } = await seededHost();
    await workOnThis(harness, { repo: "acme/widgets", number: 42 });

    const listing = await harness.behavior.callRpc("listRows", null);
    expect(listing.rows[0]).toMatchObject({ number: 42, threadId: "thr_1" });
  });

  it("frees the row when a thread vanished with no event to witness it", async () => {
    // Lifecycle events only fire while the plugin is loaded, so a thread
    // deleted across a restart is invisible to them. Only reconciliation on
    // the next sweep can release the row.
    spawnCount = 0;
    const liveThreads: Array<{ id: string }> = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "pr-sweep",
      settings: { ghPath: "/nonexistent/gh-does-not-exist" },
      sdk: {
        projects: {
          list: async () => [
            { id: "proj_a", gitRemoteUrl: "git@github.com:acme/widgets.git", sources: [] },
          ],
        },
        threads: {
          spawn: async () => {
            const thread = { id: `thr_${++spawnCount}` };
            liveThreads.push(thread);
            return thread;
          },
          list: async () => [...liveThreads],
        },
      },
    });
    await plugin(bb);
    createStore(bb.storage.database() as never).replaceRepoRows("acme/widgets", [
      seedRow(),
    ] as never);

    await workOnThis(harness, { repo: "acme/widgets", number: 42 });
    expect((await harness.behavior.callRpc("listRows", null)).rows[0]!.threadId).toBe("thr_1");

    // The thread disappears. No event fires.
    liveThreads.length = 0;
    await harness.behavior.callRpc("refresh", null);

    expect((await harness.behavior.callRpc("listRows", null)).rows[0]!.threadId).toBeNull();
  });

  it("frees the row again when its thread is deleted", async () => {
    const { bb, harness } = await seededHost();
    await workOnThis(harness, { repo: "acme/widgets", number: 42 });

    await harness.behavior.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: "thr_1" }),
    });

    const listing = await harness.behavior.callRpc("listRows", null);
    expect(listing.rows[0]!.threadId).toBeNull();

    await workOnThis(harness, { repo: "acme/widgets", number: 42 });
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
  });
});

describe("permission mode", () => {
  async function hostWithSettings(settings: Record<string, string>) {
    spawnCount = 0;
    const fixture = createFakePluginHost({
      pluginId: "pr-sweep",
      settings,
      sdk: {
        projects: {
          list: async () => [
            { id: "proj_a", gitRemoteUrl: "git@github.com:acme/widgets.git", sources: [] },
          ],
        },
        threads: { spawn: async () => ({ id: `thr_${++spawnCount}` }), list: async () => [] },
      },
    });
    await plugin(fixture.bb);
    createStore(fixture.bb.storage.database() as never).replaceRepoRows("acme/widgets", [
      seedRow(),
    ] as never);
    return fixture;
  }

  async function spawnedWith(settings: Record<string, string>) {
    const { harness } = await hostWithSettings(settings);
    await workOnThis(harness, { repo: "acme/widgets", number: 42 });
    const [[args]] = harness.inspection.sdk.callsTo("threads.spawn") as [[
      { permissionMode?: string },
    ]];
    return args.permissionMode;
  }

  it("defaults to full, the only mode that reaches the remote", async () => {
    // accept-edits stops at the first shell command; auto keeps the workspace
    // sandbox, which blocks network egress, so the commit lands and the push
    // fails. Only full carries a resolution through to the PR.
    expect(await spawnedWith({})).toBe("full");
  });

  it("honours a configured mode", async () => {
    expect(await spawnedWith({ permissionMode: "accept-edits" })).toBe("accept-edits");
    expect(await spawnedWith({ permissionMode: "auto" })).toBe("auto");
  });

  it("never passes a mode bb would reject", async () => {
    expect(await spawnedWith({ permissionMode: "bypass-everything" })).toBe("full");
  });
});

describe("archiveThread", () => {
  async function hostWithThread(link: boolean) {
    spawnCount = 0;
    const archived: string[] = [];
    const fixture = createFakePluginHost({
      pluginId: "pr-sweep",
      sdk: {
        projects: {
          list: async () => [
            { id: "proj_a", gitRemoteUrl: "git@github.com:acme/widgets.git", sources: [] },
          ],
        },
        threads: {
          spawn: async () => ({ id: `thr_${++spawnCount}` }),
          list: async () => [],
          archive: async ({ threadId }: { threadId: string }) => {
            archived.push(threadId);
            return {};
          },
        },
      },
    });
    await plugin(fixture.bb);
    createStore(fixture.bb.storage.database() as never).replaceRepoRows("acme/widgets", [
      { ...seedRow(), flags: [], group: "clean" },
    ] as never);

    if (link) {
      await workOnThis(fixture.harness, { repo: "acme/widgets", number: 42 });
    }
    return { ...fixture, archived };
  }

  it("archives the linked thread and frees the row", async () => {
    const { harness } = await hostWithThread(true);

    const result = await harness.behavior.callRpc("archiveThread", {
      repo: "acme/widgets",
      number: 42,
    });

    expect(result.ok).toBe(true);
    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(1);

    const listing = await harness.behavior.callRpc("listRows", null);
    expect(listing.rows[0]!.threadId).toBeNull();
  });

  it("declines when the pull request has no thread", async () => {
    const { harness } = await hostWithThread(false);
    const result = await harness.behavior.callRpc("archiveThread", {
      repo: "acme/widgets",
      number: 42,
    });
    expect(result.ok).toBe(false);
    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
  });
});

describe("a restored thread", () => {
  it("is linked to its row again on the next sweep", async () => {
    // Archiving drops the link. bb fires no event when a thread comes back, so
    // a thread the user unarchived is invisible to the panel until a sweep
    // reads it again — and the row keeps offering to start a second thread on
    // a pull request that already has one open.
    spawnCount = 0;
    const liveThreads: Array<ReturnType<typeof makeThreadResponse>> = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "pr-sweep",
      settings: { ghPath: "/nonexistent/gh-does-not-exist" },
      sdk: {
        projects: {
          list: async () => [
            { id: "proj_a", gitRemoteUrl: "git@github.com:acme/widgets.git", sources: [] },
          ],
        },
        threads: {
          spawn: async () => {
            // A full DTO, since adoption reads `originPluginId` and
            // `archivedAt` off the listing.
            const thread = makeThreadResponse({
              id: `thr_${++spawnCount}`,
              originPluginId: "pr-sweep",
              archivedAt: null,
            });
            liveThreads.push(thread);
            return thread;
          },
          list: async () => [...liveThreads],
          events: {
            list: async () => [
              {
                data: {
                  input: [
                    { type: "text", text: "https://github.com/acme/widgets/pull/42" },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    await plugin(bb);
    createStore(bb.storage.database() as never).replaceRepoRows("acme/widgets", [
      seedRow(),
    ] as never);

    await workOnThis(harness, { repo: "acme/widgets", number: 42 });
    // What gh-context records on reading the thread's first prompt, which
    // names the pull request. It keeps that link through an archive.
    ghContext.links.push({
      threadId: "thr_1",
      repo: "acme/widgets",
      kind: "pull",
      number: 42,
      source: "prompt",
    });
    // Archived, which drops the sweep's own link, then restored: still live,
    // still this plugin's own.
    await harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: "thr_1" }),
    });
    expect((await harness.behavior.callRpc("listRows", null)).rows[0]!.threadId).toBeNull();

    await harness.behavior.callRpc("refresh", null);

    expect((await harness.behavior.callRpc("listRows", null)).rows[0]!.threadId).toBe("thr_1");
    // Re-linking is all the sweep does. Closing a thread is the user's call,
    // so nothing in a sweep archives one.
    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
  });
});

describe("gh-context", () => {
  it("offers no thread starts while gh-context is missing, and says why", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "pr-sweep",
      sdk: {
        projects: {
          list: async () => [
            { id: "proj_a", gitRemoteUrl: "git@github.com:acme/widgets.git", sources: [] },
          ],
        },
      },
    });
    await plugin(bb);
    createStore(bb.storage.database() as never).replaceRepoRows("acme/widgets", [
      seedRow(),
    ] as never);
    ghContext.setAvailable(false);

    const listing = await harness.behavior.callRpc("listRows", null);
    // A row that cannot know whether it has a thread must not offer to start
    // a second one.
    expect(listing.rows[0]!.canSpawn).toBe(false);
    expect(listing.lastError).toMatch(/gh-context/);
  });

  it("moves links recorded before gh-context into it, once", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "pr-sweep",
      settings: { ghPath: "/nonexistent/gh-does-not-exist" },
      sdk: {
        threads: {
          list: async () => [
            makeThreadResponse({ id: "thr_mine", originPluginId: "pr-sweep" }),
            makeThreadResponse({ id: "thr_typed", originPluginId: null }),
          ],
        },
      },
    });
    const db = bb.storage.database();
    await plugin(bb);
    const insert = db.prepare(
      `INSERT INTO pr_thread_links (thread_id, repo, number, created_at) VALUES (?, ?, ?, ?)`,
    );
    insert.run("thr_mine", "acme/widgets", 42, 1);
    insert.run("thr_typed", "acme/widgets", 43, 2);

    await harness.behavior.callRpc("refresh", null);
    expect(ghContext.links).toEqual([
      { threadId: "thr_mine", repo: "acme/widgets", kind: "pull", number: 42, source: "spawned:pr-sweep" },
      { threadId: "thr_typed", repo: "acme/widgets", kind: "pull", number: 43, source: "adopted:pr-sweep" },
    ]);

    await harness.behavior.callRpc("refresh", null);
    expect(ghContext.links).toHaveLength(2);
  });
});

describe("upgrading from links kept here", () => {
  it("shows a row's old thread before any sweep has moved it", async () => {
    // Between installing this version and its first sweep, a row that already
    // had a thread must not offer to start another.
    const { bb, harness } = createFakePluginHost({
      pluginId: "pr-sweep",
      sdk: {
        threads: {
          list: async () => [makeThreadResponse({ id: "thr_mine", originPluginId: "pr-sweep" })],
        },
      },
    });
    const db = bb.storage.database();
    await plugin(bb);
    createStore(db as never).replaceRepoRows("acme/widgets", [seedRow()] as never);
    db.prepare(
      `INSERT INTO pr_thread_links (thread_id, repo, number, created_at) VALUES (?, ?, ?, ?)`,
    ).run("thr_mine", "acme/widgets", 42, 1);

    const listing = await harness.behavior.callRpc("listRows", null);
    expect(listing.rows[0]!.threadId).toBe("thr_mine");
  });
});

describe("notes, seen counts, and the stale setting", () => {
  async function seededHost(overrides: Record<string, unknown> = {}, settings: Record<string, string> = {}) {
    spawnCount = 0;
    const fixture = createFakePluginHost({
      pluginId: "pr-sweep",
      settings,
      sdk: {
        projects: {
          list: async () => [
            { id: "proj_a", gitRemoteUrl: "git@github.com:acme/widgets.git", sources: [] },
          ],
        },
        threads: { spawn: async () => ({ id: `thr_${++spawnCount}` }) },
      },
    });
    await plugin(fixture.bb);
    createStore(fixture.bb.storage.database() as never).replaceRepoRows("acme/widgets", [
      { ...seedRow(), updatedAt: 1_700_000_000_000, commentsCount: 0, ...overrides },
    ] as never);
    return fixture;
  }

  it("offers the stale setting, defaulting to three days", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "pr-sweep" });
    await plugin(bb);
    const descriptors = harness.registrations.settingsDescriptors as Record<string, { label: string; default: string }>;
    expect(descriptors.staleAfterDays).toMatchObject({ label: "Stale after (days)", default: "3" });
    expect(harness.registrations.rpcMethods).toEqual(expect.arrayContaining(["setNote", "markSeen"]));
  });

  it("returns what the list needs to place each row", async () => {
    const { harness } = await seededHost();
    const listing = await harness.behavior.callRpc("listRows", null);
    expect(listing.staleAfterDays).toBe(3);
    expect(listing.rows[0]).toMatchObject({
      updatedAt: 1_700_000_000_000,
      commentsCount: 0,
      note: null,
      newComments: 0,
    });
  });

  it("falls back to three days when the stale setting is not a positive number", async () => {
    const { harness } = await seededHost({}, { staleAfterDays: "soon" });
    expect((await harness.behavior.callRpc("listRows", null)).staleAfterDays).toBe(3);
  });

  it("reads a row stored before updatedAt existed as updated at the last sweep, so it is not stale", async () => {
    const { bb, harness } = await seededHost({ updatedAt: undefined, commentsCount: undefined });
    const store = createStore(bb.storage.database() as never);
    store.replaceAll({
      rows: store.readRows(),
      repos: ["acme/widgets"],
      failedRepos: [],
      skippedRepos: [],
      truncated: false,
      sweptAt: 1_750_000_000_000,
    });
    const row = (await harness.behavior.callRpc("listRows", null)).rows[0]!;
    expect(row.updatedAt).toBe(1_750_000_000_000);
    expect(row.commentsCount).toBe(0);
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

  it("dismisses failing checks until a new push, and restores them on undo", async () => {
    const failing = {
      flags: ["ci-failing"],
      group: "needs-action",
      checks: { pass: 0, fail: 1, skip: 0, pending: 0, cancelled: 0, total: 1 },
      headSha: "abc123",
      failingChecks: ["validate"],
    };
    const { bb, harness } = await seededHost(failing);
    const listed = async () => (await harness.behavior.callRpc("listRows", null)).rows[0]!;

    expect(
      await harness.behavior.callRpc("dismissChecks", { repo: "acme/widgets", number: 42, dismissed: true }),
    ).toEqual({ ok: true });
    expect(await listed()).toMatchObject({ flags: [], group: "clean", dismissedChecks: ["validate"] });

    const store = createStore(bb.storage.database() as never);
    store.replaceRepoRows(
      "acme/widgets",
      store.readRows().map((row) => ({ ...row, headSha: "def456" })),
    );
    expect(await listed()).toMatchObject({ flags: ["ci-failing"] });
    expect((await listed()).dismissedChecks).toBeUndefined();

    await harness.behavior.callRpc("dismissChecks", { repo: "acme/widgets", number: 42, dismissed: true });
    await harness.behavior.callRpc("dismissChecks", { repo: "acme/widgets", number: 42, dismissed: false });
    expect(await listed()).toMatchObject({ flags: ["ci-failing"] });
  });

  it("refuses to dismiss checks on a row with none failing", async () => {
    const { harness } = await seededHost();
    expect(
      await harness.behavior.callRpc("dismissChecks", { repo: "acme/widgets", number: 42, dismissed: true }),
    ).toEqual({ ok: false });
  });

  it("shows nothing new for a pull request no sweep has recorded a count for", async () => {
    // The first listing after an upgrade, before the sweep has run.
    const { harness } = await seededHost({ commentsCount: 9 });
    expect((await harness.behavior.callRpc("listRows", null)).rows[0]!.newComments).toBe(0);
  });

  it("counts comments since the count was recorded, and clears them once seen", async () => {
    const { bb, harness } = await seededHost({ commentsCount: 2 });
    const store = createStore(bb.storage.database() as never);
    store.recordSeen(store.readRows(), 1);
    store.replaceRepoRows(
      "acme/widgets",
      store.readRows().map((row) => ({ ...row, commentsCount: 5 })),
    );
    expect((await harness.behavior.callRpc("listRows", null)).rows[0]!.newComments).toBe(3);

    expect(await harness.behavior.callRpc("markSeen", { repo: "acme/widgets", number: 42 })).toEqual({ ok: true });
    expect((await harness.behavior.callRpc("listRows", null)).rows[0]!.newComments).toBe(0);
  });

  it("never shows a negative count when comments were deleted", async () => {
    const { bb, harness } = await seededHost({ commentsCount: 1 });
    createStore(bb.storage.database() as never).markSeen("acme/widgets", 42, 4, 1);
    expect((await harness.behavior.callRpc("listRows", null)).rows[0]!.newComments).toBe(0);
  });

  it("refuses to mark a pull request the sweep does not have", async () => {
    const { harness } = await seededHost();
    expect(await harness.behavior.callRpc("markSeen", { repo: "acme/widgets", number: 41 })).toEqual({ ok: false });
  });

  it("records nothing when a row stored before the count existed is opened", async () => {
    // Recording 0 would make every comment on it read as new once the next
    // sweep stores the real count.
    const { bb, harness } = await seededHost({ commentsCount: undefined });
    expect(await harness.behavior.callRpc("markSeen", { repo: "acme/widgets", number: 42 })).toEqual({ ok: true });
    await workOnThis(harness, { repo: "acme/widgets", number: 42 });
    expect(createStore(bb.storage.database() as never).seenCounts().has("acme/widgets#42")).toBe(false);
  });

  it("marks the pull request seen when a thread is started for it", async () => {
    const { bb, harness } = await seededHost({ commentsCount: 6 });
    await workOnThis(harness, { repo: "acme/widgets", number: 42 });
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
   * A stand-in for acme/widgets on GitHub with #42, `feat/widgets`, stacked on
   * `feat/base`; a checkout of it whose local `feat/widgets` is a commit
   * behind; and a gh that answers `pr view` for #42.
   */
  function setup() {
    const root = mkdtempSync(join(tmpdir(), "pr-sweep-base-"));
    const github = join(root, "github");
    git(root, "init", "-q", "-b", "main", github);
    commit(github, "a.txt");
    git(github, "checkout", "-q", "-b", "feat/base");
    commit(github, "b.txt");
    git(github, "checkout", "-q", "-b", "feat/widgets");
    commit(github, "c.txt");
    git(github, "checkout", "-q", "main");
    const checkout = join(root, "widgets");
    git(root, "clone", "-q", github, checkout);
    git(checkout, "remote", "set-url", "origin", "git@github.com:acme/widgets.git");
    git(checkout, "config", `url.${github}.insteadOf`, "git@github.com:acme/widgets.git");
    // `git remote -v` shows the rewritten URL, so the worktree's own fetch
    // falls back to the repository's https URL; rewrite that one too.
    git(checkout, "config", "--add", `url.${github}.insteadOf`, "https://github.com/acme/widgets.git");
    git(checkout, "branch", "feat/widgets", "origin/feat/widgets");
    git(github, "checkout", "-q", "feat/widgets");
    const head = commit(github, "d.txt");
    git(github, "update-ref", "refs/pull/42/head", head);

    const gh = join(root, "gh");
    const pr = {
      number: 42,
      title: "Add the widget endpoint",
      url: "https://github.com/acme/widgets/pull/42",
      headRefName: "feat/widgets",
      baseRefName: "feat/base",
      isDraft: false,
      isCrossRepository: false,
      maintainerCanModify: true,
    };
    writeFileSync(gh, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(pr)}\nJSON\n`);
    chmodSync(gh, 0o755);
    return { checkout, gh, head };
  }

  let polls = 0;

  async function host(checkout: string, gh: string) {
    polls = 0;
    const fixture = createFakePluginHost({
      pluginId: "pr-sweep",
      settings: { ghPath: gh },
      sdk: {
        projects: {
          list: async () => [
            { id: "proj_a", gitRemoteUrl: "git@github.com:acme/widgets.git", sources: [{ hostId: "host_1", path: checkout, isDefault: true }] },
          ],
        },
        // As bb does for an unmanaged workspace: no environment when spawn
        // returns, and one a moment later.
        threads: {
          spawn: async () => ({ id: "thr_1", environmentId: null }),
          get: async () => ({ id: "thr_1", environmentId: (polls += 1) > 1 ? "env_1" : null }),
        },
        environments: { update: async () => ({}) },
      },
    });
    await plugin(fixture.bb);
    createStore(fixture.bb.storage.database() as never).replaceRepoRows("acme/widgets", [
      { ...seedRow(), baseRefName: "feat/base" },
    ] as never);
    return fixture;
  }

  it("opens a pull request on its own branch, brought up to date, and diffs it against origin/<base>", async () => {
    const { checkout, gh, head } = setup();
    const { harness } = await host(checkout, gh);

    const result = await harness.behavior.callRpc("openPullRequest", { input: "https://github.com/acme/widgets/pull/42", instructions: "" });

    expect(result).toMatchObject({ threadId: "thr_1", error: null });
    expect(git(`${checkout}-pr-42`, "rev-parse", "HEAD")).toBe(head);
    await vi.waitFor(() =>
      expect(harness.inspection.sdk.callsTo("environments.update")).toEqual([
        [{ environmentId: "env_1", mergeBaseBranch: "origin/feat/base" }],
      ]),
    );
  });

  it("does the same for Work on this on the pull request's branch", async () => {
    const { checkout, gh, head } = setup();
    const { harness } = await host(checkout, gh);

    await harness.behavior.callRpc("workOnThisSubmit", {
      repo: "acme/widgets",
      number: 42,
      onBranch: true,
      request: { projectId: "proj_a", input: [{ type: "text", text: "Fix it.", mentions: [] }] },
    });

    expect(git(`${checkout}-pr-42`, "rev-parse", "HEAD")).toBe(head);
    await vi.waitFor(() =>
      expect(harness.inspection.sdk.callsTo("environments.update")).toEqual([
        [{ environmentId: "env_1", mergeBaseBranch: "origin/feat/base" }],
      ]),
    );
  });

  it("starts a new default worktree from origin/<base> when the thread is not on the branch", async () => {
    const { checkout, gh } = setup();
    const { harness } = await host(checkout, gh);
    const worktree = { type: "host", hostId: "host_1", workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } };

    await harness.behavior.callRpc("workOnThisSubmit", {
      repo: "acme/widgets",
      number: 42,
      request: { projectId: "proj_a", environment: worktree, input: [{ type: "text", text: "Fix it.", mentions: [] }] },
    });

    const [[args]] = harness.inspection.sdk.callsTo("threads.spawn") as [[{ environment: unknown }]];
    expect(args.environment).toEqual({ ...worktree, workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "origin/feat/base" } } });
    // bb records a named base as the merge base itself.
    expect(harness.inspection.sdk.callsTo("environments.update")).toEqual([]);
  });
});
