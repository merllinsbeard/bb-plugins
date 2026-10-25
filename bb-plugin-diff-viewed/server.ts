// bb-plugin-diff-viewed — backend entry.
//
// bb keeps the Viewed marks itself. This side keeps them in step with GitHub's
// Viewed boxes when the thread has a pull request, and moves the marks this
// plugin kept before bb had its own into bb's. The rules for which side wins
// are pure functions in viewed/github.ts; this file is the boundary to bb's
// marks and storage and the wire contract, and viewed/pull-request.ts is every
// GitHub call.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { createGhRunner, type GhRunner } from "@danielb/gh-shared/gh";
import { z } from "zod";
import {
  reconcile,
  sameBaseline,
  withGithubViewed,
  type Baseline,
  type GithubState,
} from "./viewed/github";
import {
  legacyMarksToMove,
  legacyPendingKey,
  legacyRecordKey,
  targetKey,
  targetQuery,
  type DiffFileEntry,
  type DiffTarget,
  type LegacyRecord,
  type ViewedMap,
} from "./viewed/marks";
import { fetchPullRequest, setFileViewed, type FetchedPullRequest } from "./viewed/pull-request";

const githubSchema = z
  .object({
    number: z.number(),
    url: z.string(),
    files: z.array(
      z.object({
        path: z.string(),
        additions: z.number(),
        deletions: z.number(),
        viewed: z.boolean(),
      }),
    ),
  })
  .nullable();

const targetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("uncommitted") }).strict(),
  z.object({ type: z.literal("branch_committed"), mergeBaseBranch: z.string().min(1).max(500) }).strict(),
  z.object({ type: z.literal("all"), mergeBaseBranch: z.string().min(1).max(500) }).strict(),
  z.object({ type: z.literal("commit"), sha: z.string().regex(/^[0-9a-f]{4,40}$/i) }).strict(),
]);

const fileSchema = z.object({
  path: z.string().min(1).max(4096),
  previousPath: z.string().max(4096).nullable(),
  changeKind: z.string().max(50),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.boolean(),
  revision: z.string().min(1).max(1024),
});

export const rpcContract = defineRpcContract({
  /**
   * Bring bb's marks and GitHub's Viewed boxes into line for the range the
   * changes panel shows, and return bb's marks afterwards.
   */
  viewed_sync: {
    input: z
      .object({
        threadId: z.string().trim().min(1).max(200),
        target: targetSchema,
        files: z.array(fileSchema).max(5000),
      })
      .strict(),
    output: z.object({ viewed: z.record(z.string(), z.string()), github: githubSchema }),
  },
  problem_report: {
    input: z.object({ message: z.string().trim().min(1).max(1000) }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
});

/**
 * How long a pull request's files are reused before GitHub is asked again.
 * The panel syncs on every open, window focus, and checkbox change; this caps
 * the reads at one query a thread per half minute.
 */
const GITHUB_TTL_MS = 30_000;

/** bb's built-in plugin that finds each environment's pull request. */
const PR_STATUS_PLUGIN = "bb--github-pr-status";

/** The parts of its `pullRequests` answer this plugin reads. */
const pullRequestsSchema = z.record(
  z.string(),
  z.looseObject({
    outcome: z.string(),
    pullRequest: z.looseObject({ state: z.string(), url: z.string() }).optional(),
  }),
);

/** bb takes at most this many paths in one read of its marks. */
const VIEWED_PATHS_PER_READ = 500;

interface GithubEntry {
  value: FetchedPullRequest | null;
  fetchedAt: number;
}

/** Storage key for what bb and GitHub last agreed on, per environment and range. */
function baselineKey(environmentId: string, target: DiffTarget): string {
  return `baseline:${environmentId}:${targetKey(target)}`;
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    syncGithub: {
      type: "select",
      label: "Sync with GitHub",
      // On: a thread with a pull request shares bb's Viewed marks with
      // GitHub's own Viewed boxes, for files whose diff matches GitHub's.
      options: ["on", "off"],
      default: "on",
    },
    ghPath: {
      type: "string",
      label: "Path to the gh CLI",
      default: "gh",
    },
  });

  let runner: { path: string; gh: GhRunner } | null = null;
  function ghFor(path: string): GhRunner {
    if (runner?.path !== path) runner = { path, gh: createGhRunner(path) };
    return runner.gh;
  }

  const githubCache = new Map<string, GithubEntry>();
  const inFlight = new Map<string, Promise<FetchedPullRequest | null>>();
  // Failures already logged, so a missing gh is one log line, not one a pass.
  const logged = new Set<string>();
  function warnOnce(message: string): void {
    if (logged.has(message)) return;
    logged.add(message);
    bb.log.warn(message);
  }

  async function environmentOf(threadId: string): Promise<string | null> {
    const thread = await bb.sdk.threads.get({ threadId });
    return (thread as { environmentId?: string | null }).environmentId ?? null;
  }

  /**
   * The URL of the environment's open pull request, draft or not, or null.
   * bb's own GitHub PR Status plugin finds it, and keeps it fresh.
   */
  async function pullRequestUrl(environmentId: string): Promise<string | null> {
    const rows = await bb.sdk.plugins.callRpc({
      pluginId: PR_STATUS_PLUGIN,
      method: "pullRequests",
      input: { keys: [environmentId] },
      outputSchema: pullRequestsSchema,
    });
    const row = rows[environmentId];
    if (row?.outcome !== "available" || row.pullRequest === undefined) return null;
    const { state, url } = row.pullRequest;
    return state === "open" || state === "draft" ? url : null;
  }

  async function loadGithub(environmentId: string, ghPath: string): Promise<FetchedPullRequest | null> {
    try {
      const url = await pullRequestUrl(environmentId);
      return url === null ? null : await fetchPullRequest(ghFor(ghPath), url);
    } catch (error) {
      warnOnce(`GitHub sync unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** The pull request's files, cached, with one request in flight. */
  async function github(environmentId: string, ghPath: string): Promise<FetchedPullRequest | null> {
    const cached = githubCache.get(environmentId);
    if (cached && Date.now() - cached.fetchedAt < GITHUB_TTL_MS) return cached.value;
    const running = inFlight.get(environmentId);
    if (running) return running;
    const request = loadGithub(environmentId, ghPath)
      .then((value) => {
        githubCache.set(environmentId, { value, fetchedAt: Date.now() });
        return value;
      })
      .finally(() => inFlight.delete(environmentId));
    inFlight.set(environmentId, request);
    return request;
  }

  /** Remember the cache's new Viewed state without resetting its age. */
  function cacheGithub(environmentId: string, value: FetchedPullRequest): void {
    const cached = githubCache.get(environmentId);
    githubCache.set(environmentId, { value, fetchedAt: cached?.fetchedAt ?? Date.now() });
  }

  /** What the content script sees: everything but the node id. */
  function wire(value: FetchedPullRequest | null): GithubState | null {
    if (value === null) return null;
    return { number: value.number, url: value.url, files: value.files };
  }

  /** bb's marks on these files, read in batches bb accepts. */
  async function readViewed(
    environmentId: string,
    target: DiffTarget,
    files: readonly DiffFileEntry[],
  ): Promise<ViewedMap> {
    const viewed: ViewedMap = {};
    for (let start = 0; start < files.length; start += VIEWED_PATHS_PER_READ) {
      const paths = files.slice(start, start + VIEWED_PATHS_PER_READ).map((file) => file.path);
      const result = await bb.sdk.environments.experimental_diffViewed({
        environmentId,
        ...targetQuery(target),
        paths,
      });
      for (const file of result.files) viewed[file.path] = file.revision;
    }
    return viewed;
  }

  async function markInBb(
    environmentId: string,
    target: DiffTarget,
    entry: DiffFileEntry,
    viewed: ViewedMap,
  ): Promise<void> {
    await bb.sdk.environments.experimental_markDiffViewed({
      environmentId,
      target,
      path: entry.path,
      revision: entry.revision,
    });
    viewed[entry.path] = entry.revision;
  }

  /**
   * Move the marks this plugin kept per thread before bb had its own Viewed
   * checkbox into bb's, once. Only the All changes range takes them, since
   * that is the range they were nearly always made in, and the old record is
   * deleted afterwards so a mark cleared in bb does not come back.
   */
  async function moveLegacyMarks(
    threadId: string,
    environmentId: string,
    target: DiffTarget,
    files: readonly DiffFileEntry[],
    viewed: ViewedMap,
  ): Promise<void> {
    if (target.type !== "all") return;
    const record = await bb.storage.kv.get<LegacyRecord>(legacyRecordKey(threadId));
    if (record === undefined) return;
    const moving = legacyMarksToMove(record, files, viewed);
    for (const entry of moving) await markInBb(environmentId, target, entry, viewed);
    await bb.storage.kv.delete(legacyRecordKey(threadId));
    await bb.storage.kv.delete(legacyPendingKey(threadId));
    if (moving.length > 0) bb.log.info(`Moved ${moving.length} Viewed marks into bb for ${threadId}`);
  }

  async function sync(
    threadId: string,
    target: DiffTarget,
    files: readonly DiffFileEntry[],
  ): Promise<{ viewed: ViewedMap; github: GithubState | null }> {
    const environmentId = await environmentOf(threadId);
    if (environmentId === null) return { viewed: {}, github: null };
    const viewed = await readViewed(environmentId, target, files);
    await moveLegacyMarks(threadId, environmentId, target, files, viewed);

    const { syncGithub, ghPath } = await settings.get();
    if (syncGithub !== "on") return { viewed, github: null };
    let pull = await github(environmentId, ghPath);
    if (pull === null) return { viewed, github: null };

    const key = baselineKey(environmentId, target);
    const before = (await bb.storage.kv.get<Baseline>(key)) ?? {};
    const plan = reconcile(files, viewed, pull, before);
    const baseline = { ...plan.baseline };

    for (const entry of plan.markInBb) await markInBb(environmentId, target, entry, viewed);
    for (const entry of plan.clearInBb) {
      await bb.sdk.environments.experimental_clearDiffViewed({
        environmentId,
        target,
        path: entry.path,
      });
      delete viewed[entry.path];
    }
    for (const { path, viewed: value } of plan.pushToGithub) {
      try {
        await setFileViewed(ghFor(ghPath), pull.id, path, value);
        pull = withGithubViewed(pull, path, value);
      } catch (error) {
        bb.log.warn(`Could not mark ${path} ${value ? "viewed" : "unviewed"} on GitHub: ${String(error)}`);
        // Keep the old agreement, so the next sync still sees bb as the side
        // that changed and tries again.
        const previous = before[path];
        if (previous === undefined) delete baseline[path];
        else baseline[path] = previous;
      }
    }
    if (plan.pushToGithub.length > 0) cacheGithub(environmentId, pull);
    if (!sameBaseline(before, baseline)) await bb.storage.kv.set(key, baseline);
    return { viewed, github: wire(pull) };
  }

  // One sync at a time per thread and range, so two windows, or a click
  // during a focus sync, cannot both push the same change to GitHub.
  const queues = new Map<string, Promise<unknown>>();
  function queued<Result>(key: string, run: () => Promise<Result>): Promise<Result> {
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.then(run, run);
    const settled = next.catch(() => {});
    queues.set(key, settled);
    void settled.then(() => {
      if (queues.get(key) === settled) queues.delete(key);
    });
    return next;
  }

  bb.rpc.register(rpcContract, {
    viewed_sync: ({ threadId, target, files }) =>
      queued(`${threadId}:${targetKey(target)}`, () => sync(threadId, target, files)),
    // The content script calls this when it cannot read bb's DOM the way it
    // expects, so a bb update that breaks the plugin shows up in
    // `bb plugin logs diff-viewed` and not only in a devtools console.
    problem_report: async ({ message }) => {
      bb.log.warn(message);
      return { ok: true as const };
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
