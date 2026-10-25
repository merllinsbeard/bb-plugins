import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { localDay } from "@danielbachhuber/bb-plugin-component-library/parse-day";
import { REPO_SLUG_PATTERN, createSyncUsage, fetchFeedback } from "@danielb/gh-shared/gh";
import { prepareForPullRequest, runGit } from "@danielb/gh-shared/projects";
import { createHarvestBridge } from "bb-plugin-harvest/bridge";
import { rpcContract } from "./review/contract.js";
import { GhUnavailableError, createGhRunner, runSweep } from "./review/gh.js";
import { buildPromptParts, headerItem, suggestedSkills, trailerItem, type PromptParts } from "./review/prompt.js";
import type { ClassifiedRow } from "./review/types.js";
import type { z } from "zod";
import {
  parsePermissionMode,
  parseStaleAfterDays,
  threadTitle,
} from "./review/actions.js";
import {
  buildRepoFilter,
  matchProjectTargetForRepo,
  matchProjectForRepo,
  toProjectCandidates,
  type ProjectCandidate,
  type RepoFilter,
} from "./review/spawn-target.js";
import { MIGRATIONS, createStore } from "./review/store.js";
import { createSweepLinks, createThreadLinksBridge } from "bb-plugin-gh-context/links";

export { rpcContract };

const REALTIME_CHANNEL = "reviews-updated";

type SpawnArgs = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];
type StartResult = { threadId: string | null; existing: boolean; reason: string | null };
type ReviewSeed = NonNullable<z.infer<typeof rpcContract.reviewThisDraft.output>["seed"]>;

const NO_CHECKS = { pass: 0, fail: 0, skip: 0, pending: 0, cancelled: 0, total: 0 };

const GH_CONTEXT_REQUIRED =
  "Review Sweep needs the gh-context plugin, which records which threads belong to which pull requests. Install it, then reload Review Sweep.";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    syncIntervalMinutes: {
      type: "select",
      label: "Sync interval (minutes)",
      options: ["2", "5", "15"],
      default: "5",
    },
    ghPath: {
      type: "string",
      label: "Path to the gh CLI",
      default: "gh",
    },
    filterToProjects: {
      type: "select",
      label: "Only show repositories checked out here",
      // On: a review request is shown only when a bb project on this machine
      // has that repository's git remote. bb's project list is
      // per-installation, so this is what separates the computer a repository
      // lives on from every other one. Off shows every request GitHub returns.
      options: ["on", "off"],
      default: "on",
    },
    extraRepositories: {
      type: "string",
      label: "Also show these repositories",
      // Comma or newline separated owner/name, for a repository you review in
      // without a checkout here. Ignored when the filter is off.
      default: "",
    },
    staleAfterDays: {
      type: "string",
      label: "Stale after (days)",
      // How long a request may sit before it moves up into Now, flagged
      // "Waiting N days". A personal number rather than a universal one,
      // which is why it is a setting.
      default: "2",
    },
    model: {
      type: "string",
      label: "Model for review threads",
      // Blank takes the provider's default. There is only one action here, so
      // this is a single value rather than pr-sweep's model-by-action JSON.
      default: "",
    },
    permissionMode: {
      type: "select",
      label: "Permission mode for spawned threads",
      // auto keeps the workspace sandbox, which blocks network egress, so the
      // thread cannot reach GitHub to read the diff it was started for. full is
      // the only mode that lets a review happen unattended. Note what this does
      // NOT do: the sandbox cannot express "may read GitHub, may not write to
      // it", so the rule against posting lives in the prompt, not here.
      options: ["accept-edits", "auto", "full"],
      default: "full",
    },
    providerId: {
      type: "string",
      label: "Provider for spawned threads",
      // `code-review` is a Claude Code command, so it is invisible to a thread
      // running on any other provider, which would improvise a review instead
      // of following it. Blank falls back to bb's default.
      default: "claude-code",
    },
  });

  /** In-flight spawns, keyed repo#number, so racing clicks share one result. */
  const spawning = new Map<string, Promise<StartResult>>();

  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = createStore(db as never);
  // The past hour of sweeps and what each cost on GitHub, for the sync status.
  const syncUsage = createSyncUsage();
  // gh-context is the one record of which threads belong to which pull
  // requests; this sweep reads and writes its own links through it.
  const threadLinks = createThreadLinksBridge(bb);
  // The move out of this plugin's own old tables writes through a wrapper with
  // no hook, so the hook below cannot wait on itself.
  const legacyLinks = createSweepLinks(threadLinks, bb.pluginId, "pull");
  const links = createSweepLinks(threadLinks, bb.pluginId, "pull", {
    before: () => ensureLegacyMoved(),
  });

  /**
   * Finishes the one-time move of links this checkout kept before gh-context,
   * ahead of anything that reads or writes links. Concurrent callers share one
   * move; once the old tables are gone this is a flag check.
   */
  let legacyMoved = false;
  let legacyMove: Promise<void> | null = null;
  async function ensureLegacyMoved(): Promise<void> {
    if (legacyMoved) return;
    legacyMove ??= moveLegacyThreadLinks()
      .then(() => {
        legacyMoved = true;
      })
      .finally(() => {
        legacyMove = null;
      });
    await legacyMove;
  }

  /**
   * Drops links whose thread no longer exists or has been archived.
   *
   * The thread.deleted / thread.archived handlers below cover the live case, but
   * lifecycle events only fire while this plugin is loaded. A thread deleted
   * while bb was stopped would otherwise stay linked forever, leaving the row
   * offering to open a thread that is gone. Reconciling on every sweep makes the
   * link self-healing rather than dependent on having witnessed the event.
   */
  async function reconcileThreadLinks(): Promise<void> {
    const rows = store.readRows();
    if (rows.length === 0) return;
    const linked = [...new Set([...(await links.threadMap(rows)).values()].flat())];
    if (linked.length === 0) return;

    const live = new Set<string>();
    const pageSize = 100;
    for (let offset = 0; ; offset += pageSize) {
      const threads = await bb.sdk.threads.list({
        originPluginId: bb.pluginId,
        includeHidden: true,
        archived: false,
        limit: pageSize,
        offset,
      });
      for (const thread of threads) live.add(thread.id);
      if (threads.length < pageSize) break;
    }

    let dropped = 0;
    for (const threadId of linked) {
      if (!live.has(threadId)) {
        await links.release(threadId);
        dropped += 1;
      }
    }
    if (dropped > 0) bb.log.info(`released ${dropped} review(s) from missing threads`);
  }

  /**
   * Moves the links this checkout recorded before gh-context existed into it,
   * once, then drops the table that held them. Every one was a thread this
   * plugin started: it never adopted threads from the composer.
   */
  async function moveLegacyThreadLinks(): Promise<void> {
    const legacy = store.legacyThreadLinks();
    for (const link of legacy) {
      await legacyLinks.link(link.repo, link.number, link.threadId, "spawned");
    }
    if (legacy.length > 0) bb.log.info(`moved ${legacy.length} thread link(s) into gh-context`);
    store.dropLegacyThreadLinks();
  }

  /**
   * Consecutive sweeps that found no gh-context. One is gh-context still
   * loading after a restart; a run of them is a missing plugin, and
   * needs-configuration is one-way until reload, so it waits for the run.
   */
  let linksUnavailableRuns = 0;

  async function linksAvailable(): Promise<boolean> {
    if (await threadLinks.available()) {
      linksUnavailableRuns = 0;
      return true;
    }
    linksUnavailableRuns += 1;
    bb.log.warn(`gh-context unavailable (${linksUnavailableRuns} in a row)`);
    if (linksUnavailableRuns >= UNAVAILABLE_RUNS_BEFORE_CONFIG) {
      bb.status.needsConfiguration(GH_CONTEXT_REQUIRED);
    }
    return false;
  }

  /**
   * Consecutive sweeps that could not reach gh, and how many it takes before
   * the plugin declares itself misconfigured. Three at the default interval is
   * about fifteen minutes of consistent failure.
   */
  let unavailableRuns = 0;
  const UNAVAILABLE_RUNS_BEFORE_CONFIG = 3;

  /**
   * `signal` is the background service's: once it aborts, the gh call in
   * flight is killed and the rest of the sweep is skipped, so a reload never
   * waits on a sweep. bb degrades a plugin whose service misses its stop
   * window, and a degraded plugin answers no RPC until it is reloaded again.
   */
  async function sweepNow(signal?: AbortSignal): Promise<{ ok: boolean; error: string | null }> {
    const outcome = await fetchAndStore(signal);
    if (signal?.aborted) return outcome;

    // Reconciliation runs whether or not gh succeeded: a missing gh says
    // nothing about whether a linked thread still exists, and a row stuck on
    // "Open thread" for a deleted thread should heal even while the sweep
    // itself is broken.
    if (await linksAvailable()) {
      try {
        await ensureLegacyMoved();
      } catch (error) {
        bb.log.warn(`could not move thread links into gh-context: ${String(error)}`);
      }
      try {
        await reconcileThreadLinks();
      } catch (error) {
        bb.log.warn(`could not reconcile thread links: ${String(error)}`);
      }
    }

    return outcome;
  }

  /**
   * The repository filter for one sweep, rebuilt each time so a project added
   * since the last sweep is picked up without a reload.
   *
   * A failure to resolve projects leaves the filter unscoped rather than
   * empty: an unreachable project list is not evidence that nothing is checked
   * out here, and treating it as such would blank the panel over a blip.
   */
  async function repoFilter(): Promise<RepoFilter> {
    const { filterToProjects, extraRepositories } = await settings.get();
    if (filterToProjects !== "on") {
      return buildRepoFilter({ enabled: false, candidates: [], extras: "" });
    }
    try {
      return buildRepoFilter({
        enabled: true,
        candidates: await projectCandidates(),
        extras: extraRepositories,
      });
    } catch (error) {
      bb.log.warn(`could not resolve projects, showing every repository: ${String(error)}`);
      return buildRepoFilter({ enabled: false, candidates: [], extras: "" });
    }
  }

  async function fetchAndStore(signal?: AbortSignal): Promise<{ ok: boolean; error: string | null }> {
    const { ghPath } = await settings.get();
    try {
      const scope = await repoFilter();
      const result = await syncUsage.measure(createGhRunner(ghPath, signal), (gh) =>
        runSweep(gh, () => Date.now(), scope),
      );
      // A stopped sweep's repositories all read as failed. Keep the last
      // listing rather than storing that.
      if (signal?.aborted) return { ok: false, error: "Sweep stopped." };
      store.replaceAll(result);
      // Every row's count on first sight, so a row is never "N new" just
      // because this is the first sweep to list it.
      store.recordFirstSeen(result.rows, result.sweptAt);
      bb.realtime.publish(REALTIME_CHANNEL, { sweptAt: result.sweptAt });
      bb.log.info(
        `swept ${result.rows.length} review request(s)` +
          (result.skippedRepos.length
            ? `, dropped ${result.skippedRepos.length} repo(s) outside this machine's projects` +
              ` (${result.skippedRepos.join(", ")})`
            : ""),
      );
      // Reset here, not just on the failure path: three failures spread over a
      // day are weather, and only an unbroken run means the configuration is
      // actually wrong.
      unavailableRuns = 0;
      return { ok: true, error: null };
    } catch (error) {
      if (signal?.aborted) return { ok: false, error: "Sweep stopped." };
      const message = error instanceof Error ? error.message : String(error);
      store.recordFailure(message);
      bb.realtime.publish(REALTIME_CHANNEL, { sweptAt: null });
      if (error instanceof GhUnavailableError) {
        // Always logged. This is the branch that can hide the plugin's panels,
        // so it must never be the silent one — the first time it fired, the
        // only evidence was the panels being gone.
        unavailableRuns += 1;
        bb.log.warn(
          `gh unavailable (${unavailableRuns} in a row): ${message} — ${error.detail}`,
        );
        // needs-configuration is one-way: the SDK clears it on the next load
        // and offers no way back at runtime, so one blip would hide the panels
        // until someone thought to reload. Only a run of failures is a
        // configuration problem; one is weather.
        if (unavailableRuns >= UNAVAILABLE_RUNS_BEFORE_CONFIG) {
          bb.status.needsConfiguration(message);
        }
      } else {
        bb.log.warn(`sweep failed: ${message}`);
      }
      return { ok: false, error: message };
    }
  }

  /**
   * Every project bb knows about here, with every remote its checkout has.
   *
   * ProjectResponse carries one `gitRemoteUrl`, which for a fork-and-upstream
   * checkout is the fork. Reading the checkout's git config as well is what
   * lets a repository be matched by the remote the pull requests are actually
   * against.
   */
  async function projectCandidates(): Promise<ProjectCandidate[]> {
    return toProjectCandidates(await bb.sdk.projects.list());
  }

  const harvest = createHarvestBridge(bb);

  /**
   * Whether the clock should render at all, and which row it should be lit
   * on. Kept out of `listRows`, which would otherwise wait on two Harvest API
   * requests before returning rows already in the database.
   */
  async function harvestState() {
    if (!(await harvest.available())) return { available: false, running: null };
    return { available: true, running: await harvest.runningReference() };
  }

  /**
   * What Start review seeds the composer with, and what Batch starts with
   * directly: the project checked out for the repository, a new worktree in
   * it, and the settings' provider, model and permission mode.
   */
  async function seedFor(row: ClassifiedRow): Promise<{ seed: ReviewSeed } | { reason: string }> {
    const target = matchProjectTargetForRepo(row.repo, await projectCandidates());
    if (!target) return { reason: `No bb project is checked out for ${row.repo}.` };

    const { providerId, model, permissionMode } = await settings.get();
    const chosenModel = model.trim();

    return {
      seed: {
        projectId: target.id,
        providerId: providerId || null,
        model: chosenModel || null,
        permissionMode: parsePermissionMode(permissionMode),
        skills: suggestedSkills(row, Date.now()),
        preview: {
          title: row.title,
          number: row.number,
          url: row.url,
          meta: [row.repo, `by ${row.author}`, row.isDraft ? "draft" : null]
            .filter(Boolean)
            .join(" · "),
        },
        // A new worktree by default. A review is someone else's branch,
        // so the thread has nothing to land and every reason to stay out of
        // the main checkout while it reads. The composer still offers Work
        // locally and Existing worktree for the times that is not what you
        // want.
        environment: {
          type: "host",
          workspace: {
            type: "managed-worktree",
            baseBranch: { kind: "default" },
          },
          ...(target.hostId ? { hostId: target.hostId } : {}),
        } as const,
      },
    };
  }

  /**
   * Fetches the pull request's base and head into the project's checkout, and
   * starts a new default worktree from `<remote>/<base>`, which bb records as
   * its merge base. Without it, the thread diffs against bb's default branch,
   * and a pull request stacked on another shows the other's changes too. Any
   * other environment the composer chose is left as it is: the project
   * checkout or an existing worktree is shared with other threads.
   *
   * Two git fetches per thread started, and no GitHub API calls. A failure
   * here is logged and the thread starts anyway.
   */
  async function diffAgainstBase(row: ClassifiedRow, args: SpawnArgs): Promise<SpawnArgs> {
    if (!row.baseRefName) return args;
    try {
      const path = (await projectCandidates()).find((candidate) => candidate.id === args.projectId)?.path;
      if (!path) return args;
      const prepared = await prepareForPullRequest(
        runGit,
        path,
        { repo: row.repo, number: row.number, baseRef: row.baseRefName, headRef: row.headRefName },
        args.environment,
      );
      for (const warning of prepared.warnings) bb.log.warn(`${row.repo}#${row.number}: ${warning}`);
      return { ...args, environment: prepared.environment };
    } catch (error) {
      bb.log.warn(`could not prepare ${row.repo}#${row.number}'s checkout: ${String(error)}`);
      return args;
    }
  }

  /**
   * Starts the review's thread with what `spawnFor` builds, or returns the one
   * already linked to it.
   *
   * One thread per review, enforced on three levels: the durable link below,
   * the in-flight map for starts that race before the first spawn returns,
   * and a disabled button in the panel. The link alone is not enough — two
   * clicks a few hundred ms apart both read "no link yet".
   */
  function startReview(
    repo: string,
    number: number,
    spawnFor: (
      row: ClassifiedRow,
      parts: PromptParts,
    ) => Promise<{ args: SpawnArgs; projectId: string } | { reason: string }>,
  ): Promise<StartResult> {
    const key = `${repo}#${number}`;
    const inFlight = spawning.get(key);
    if (inFlight) return inFlight;

    const attempt = (async (): Promise<StartResult> => {
      const row = store
        .readRows()
        .find((entry) => entry.repo === repo && entry.number === number);
      // Starting or reopening the thread is reading the pull request, so its
      // new comments are no longer new.
      const markSeen = () => {
        if (row?.comments !== undefined) store.markSeen(repo, number, row.comments, Date.now());
      };

      const existingThreadId = await links.threadFor(repo, number);
      if (existingThreadId) {
        markSeen();
        return { threadId: existingThreadId, existing: true, reason: null };
      }

      if (!row) {
        return {
          threadId: null,
          existing: false,
          reason: "That review request is no longer in the sweep.",
        };
      }

      const built = await spawnFor(row, buildPromptParts(row, Date.now()));
      if ("reason" in built) return { threadId: null, existing: false, reason: built.reason };

      const thread = await bb.sdk.threads.spawn(await diffAgainstBase(row, built.args));
      bb.log.info(`started ${thread.id} for ${key} in ${built.projectId}`);
      await links.link(repo, number, thread.id, "spawned");
      markSeen();
      bb.realtime.publish(REALTIME_CHANNEL, { sweptAt: null });
      return { threadId: thread.id, existing: false, reason: null };
    })();

    spawning.set(key, attempt);
    return attempt.finally(() => spawning.delete(key));
  }

  bb.rpc.register(rpcContract, {
    harvestState() {
      return harvestState();
    },

    harvestAssignments() {
      return harvest.assignments();
    },

    harvestTrackedHours({ externalId, groupId }) {
      return harvest.trackedHours({ externalId, groupId });
    },

    harvestLastSelection({ scope }) {
      return harvest.lastSelection({ scope });
    },

    harvestStartTimer(input) {
      return harvest.startTimer(input);
    },

    async harvestStopTimer(input) {
      await harvest.stopTimer(input);
      return null;
    },

    async listRows() {
      const meta = store.readMeta();
      const rows = store.readRows();
      const notes = store.notes();
      const snoozes = store.snoozes();
      const today = localDay(new Date());
      const seen = store.seenCounts();
      const { staleAfterDays } = await settings.get();

      let candidates: ProjectCandidate[] = [];
      try {
        candidates = await projectCandidates();
      } catch (error) {
        bb.log.warn(`could not resolve projects: ${String(error)}`);
      }

      const spawnable = new Set(
        rows.map((row) => row.repo).filter((repo) => matchProjectForRepo(repo, candidates)),
      );
      // Without gh-context the rows cannot say which already have a thread, so
      // none offers to start one: a duplicate thread is the worse mistake.
      let threadMap: Map<string, string[]> | null = null;
      try {
        threadMap = await links.threadMap(rows);
      } catch (error) {
        bb.log.warn(`could not read thread links: ${String(error)}`);
      }

      return {
        rows: rows.map((row) => {
          const key = `${row.repo}#${row.number}`;
          const comments = row.comments ?? 0;
          // No record yet reads as nothing new: the sweep records the count on
          // first sight, and until it has, every comment is one already there.
          // Floored at zero, since deleted comments can drop the count.
          const seenCount = seen.get(key);
          // A snooze ends on its day, or sooner when the review is requested
          // again after it was snoozed.
          const snooze = snoozes.get(key);
          const snoozed = snooze !== undefined && snooze.until > today && row.requestedAt <= snooze.snoozedAt;
          return {
            ...row,
            snoozedUntil: snoozed ? snooze.until : null,
            comments,
            inlineComments: row.inlineComments ?? 0,
            // Rows stored before the sweep read these draw no checks and no reviewers.
            checks: row.checks ?? NO_CHECKS,
            reviewers: row.reviewers ?? [],
            stack: row.stack ?? null,
            conflicted: row.conflicted ?? false,
            note: notes.get(key) ?? null,
            newComments: seenCount === undefined ? 0 : Math.max(0, comments - seenCount),
            canSpawn: threadMap !== null && spawnable.has(row.repo),
            threadId: threadMap?.get(key)?.[0] ?? null,
          };
        }),
        sweptAt: meta.sweptAt,
        usage: syncUsage.snapshot(),
        skippedRepos: meta.skippedRepos,
        truncated: meta.truncated,
        lastError: threadMap === null ? GH_CONTEXT_REQUIRED : meta.lastError,
        staleAfterDays: parseStaleAfterDays(staleAfterDays),
      };
    },

    async refresh() {
      return sweepNow();
    },

    setNote({ repo, number, body }) {
      store.setNote(repo, number, body, Date.now());
      return { ok: true };
    },

    snooze({ repo, number, until }) {
      store.setSnooze(repo, number, until, Date.now());
      return { ok: true };
    },

    async listFeedback({ repo, number }) {
      if (!REPO_SLUG_PATTERN.test(repo)) return { entries: [], error: "Not a repository." };
      const { ghPath } = await settings.get();
      try {
        return { entries: await fetchFeedback(createGhRunner(ghPath), repo, number), error: null };
      } catch (error) {
        bb.log.warn(`could not read feedback on ${repo}#${number}: ${String(error)}`);
        return { entries: [], error: "Could not read the comments from GitHub." };
      }
    },

    markSeen({ repo, number }) {
      const row = store.readRows().find((entry) => entry.repo === repo && entry.number === number);
      if (!row) return { ok: false };
      // A row stored before counts were kept has none to record. Recording 0
      // would make every comment read as new once the sweep stores the count.
      if (row.comments !== undefined) store.markSeen(repo, number, row.comments, Date.now());
      return { ok: true };
    },

    async archiveThread({ repo, number }) {
      const threadId = await links.threadFor(repo, number);
      if (!threadId) return { ok: false, reason: "That review has no thread." };

      await bb.sdk.threads.archive({ threadId });
      // The thread.archived handler unlinks too, but doing it here means the row
      // updates even if the event is lost.
      await links.release(threadId);
      bb.realtime.publish(REALTIME_CHANNEL, { sweptAt: null });
      bb.log.info(`archived ${threadId} for ${repo}#${number}`);
      return { ok: true, reason: null };
    },

    async reviewThisDraft({ repo, number }) {
      const existingThreadId = await links.threadFor(repo, number);
      if (existingThreadId) return { existingThreadId, reason: null, seed: null };

      const row = store
        .readRows()
        .find((entry) => entry.repo === repo && entry.number === number);
      if (!row) {
        return {
          existingThreadId: null,
          reason: "That review request is no longer in the sweep.",
          seed: null,
        };
      }

      const resolved = await seedFor(row);
      if ("reason" in resolved) return { existingThreadId: null, reason: resolved.reason, seed: null };
      return { existingThreadId: null, reason: null, seed: resolved.seed };
    },

    async reviewThisSubmit({ repo, number, request }) {
      // Everything the composer resolved — project, environment, provider,
      // model, reasoning, permission mode, execution provenance — is
      // forwarded untouched. Only the title is the plugin's business: the
      // composer has no field for one, and the sidebar should name the
      // review.
      // The composer only ever held the middle of the prompt, so the two
      // ends are put back here — including the no-posting rule, which is in
      // the trailer precisely because it must not depend on anyone leaving
      // it in the box. Its own items sit between them untouched, which is
      // what keeps any @-mention or attachment that was added.
      return startReview(repo, number, async (row, parts) => ({
        args: {
          ...request,
          input: [
            { type: "text", text: headerItem(parts), mentions: [] },
            ...request.input,
            { type: "text", text: trailerItem(parts), mentions: [] },
          ],
          title: threadTitle(row.state, number, row.title),
        } as SpawnArgs,
        projectId: request.projectId,
      }));
    },

    async reviewBatchStart({ repo, number, prompt }) {
      // No composer resolved anything, so the seeds Start review would open
      // the composer with are the request: the settings' provider, model and
      // permission mode, and a new worktree in the matching project.
      return startReview(repo, number, async (row, parts) => {
        const resolved = await seedFor(row);
        if ("reason" in resolved) return resolved;
        const { seed } = resolved;
        return {
          args: {
            projectId: seed.projectId,
            environment: seed.environment,
            permissionMode: seed.permissionMode,
            ...(seed.providerId ? { providerId: seed.providerId } : {}),
            ...(seed.model ? { model: seed.model } : {}),
            // Marked as chosen, which is what keeps them: bb drops a provider
            // or model that carries no source and re-derives the project's
            // own defaults in its place.
            executionInputSources: {
              permissionMode: "explicit",
              ...(seed.providerId ? { providerId: "explicit" } : {}),
              ...(seed.model ? { model: "explicit" } : {}),
            },
            // The same three pieces the composer path sends, with the edited
            // middle in place of the composer's.
            input: [
              { type: "text", text: headerItem(parts), mentions: [] },
              { type: "text", text: prompt, mentions: [] },
              { type: "text", text: trailerItem(parts), mentions: [] },
            ],
            title: threadTitle(row.state, number, row.title),
          } as SpawnArgs,
          projectId: seed.projectId,
        };
      });
    },
  });

  // A thread the user archived or deleted should not keep its review pinned to
  // it, otherwise the row offers to open a thread that is gone.
  for (const event of ["thread.archived", "thread.deleted"] as const) {
    bb.events.on(event, async ({ thread }) => {
      try {
        await links.release(thread.id);
      } catch (error) {
        bb.log.warn(`could not release ${thread.id}: ${String(error)}`);
      }
      bb.realtime.publish(REALTIME_CHANNEL, { sweptAt: null });
    });
  }

  bb.background.service("sweep", {
    async start(signal) {
      while (!signal.aborted) {
        await sweepNow(signal);
        if (signal.aborted) return;

        const { syncIntervalMinutes } = await settings.get();
        const delay = Number(syncIntervalMinutes) * 60_000;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    },
  });
}
