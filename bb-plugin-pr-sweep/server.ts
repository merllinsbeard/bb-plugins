import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  branchHolder,
  buildOpenPrompt,
  checkoutForWorktree,
  parsePullRequestInput,
  resolvePullRequest as resolvePr,
  worktreePath,
  worktreePlan,
  type ResolvedPullRequest,
  type WorktreePlan,
} from "./sweep/open-pr.js";
import { isAdoptable } from "./sweep/adopt.js";
import { createHarvestBridge } from "bb-plugin-harvest/bridge";
import {
  createSweepLinks,
  createThreadLinksBridge,
  unclaimedPromptThreadIds,
} from "bb-plugin-gh-context/links";
import { rpcContract } from "./sweep/contract.js";
import { createSyncUsage, fetchFeedback } from "@danielb/gh-shared/gh";
import { prepareForPullRequest, runGit } from "@danielb/gh-shared/projects";
import { GhUnavailableError, REPO_SLUG_PATTERN, createGhRunner, runSweep } from "./sweep/gh.js";
import { buildPromptParts, headerItem, suggestedSkills, trailerItem } from "./sweep/prompt.js";
import {
  actionSummary,
  commentsToRead,
  modelForFlags,
  parseModelByAction,
  parsePermissionMode,
  scopedThreadTitle,
  threadTitle,
} from "./sweep/actions.js";
import {
  buildRepoFilter,
  matchProjectForRepo,
  parseRepositorySlugs,
  matchProjectTargetForRepo,
  toProjectCandidates,
  type ProjectCandidate,
  type RepoFilter,
} from "./sweep/spawn-target.js";
import { applyDismissal, checksFingerprint } from "./sweep/dismiss.js";
import { MIGRATIONS, createStore } from "./sweep/store.js";
import { parseStaleAfterDays } from "./sweep/tiers.js";

export { rpcContract };

const REALTIME_CHANNEL = "prs-updated";

const GH_CONTEXT_REQUIRED =
  "PR Sweep needs the gh-context plugin, which records which threads belong to which pull requests. Install it, then reload PR Sweep.";

/** How long a thread's unmanaged workspace may take to attach before its merge base is given up on. */
const ENVIRONMENT_WAIT_MS = 15_000;
const ENVIRONMENT_POLL_MS = 200;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    syncIntervalMinutes: {
      type: "select",
      label: "Sync interval (minutes)",
      options: ["2", "5", "15"],
      default: "5",
    },
    staleAfterDays: {
      type: "string",
      label: "Stale after (days)",
      // A pull request awaiting review untouched for this long is flagged, so
      // a reviewer who has gone quiet gets a nudge.
      default: "3",
    },
    ghPath: {
      type: "string",
      label: "Path to the gh CLI",
      default: "gh",
    },
    filterToProjects: {
      type: "select",
      label: "Only sweep repositories checked out here",
      // On: a repository is swept only when a bb project on this machine has
      // its git remote. bb's project list is per-installation, so this is the
      // difference between the computer a repository is checked out on and
      // every other one — the work computer's repositories stop filling the
      // laptop's panel. Off restores sweeping every repository you have an
      // open pull request in.
      options: ["on", "off"],
      default: "on",
    },
    extraRepositories: {
      type: "string",
      label: "Also sweep these repositories",
      // Comma or newline separated owner/name, for a repository worth watching
      // without a checkout here — a deploy repository you only ever open pull
      // requests against. Ignored when the filter is off.
      default: "",
    },
    reviewerOptionalRepositories: {
      type: "string",
      label: "Repositories that do not need a reviewer",
      // Comma or newline separated owner/name. In these repositories nobody is
      // ever assigned, so an unassigned pull request is the normal state and
      // the no-reviewer flag is noise. Every other flag still applies.
      default: "",
    },
    modelByAction: {
      type: "string",
      label: "Model by action",
      experimental_multiline: true,
      // A JSON object keyed by flag: {"conflict": "claude-sonnet-5"}.
      // An unlisted flag takes the provider's default model, and blank
      // gives every flag the provider's default.
      default: "",
    },
    permissionMode: {
      type: "select",
      label: "Permission mode for spawned threads",
      // accept-edits sandboxes the workspace and routes every escalation to
      // the user, so a thread stops at its first shell command. auto keeps
      // that same sandbox with automatic approval, which is enough to do the
      // work but not to finish it: the sandbox blocks network egress, so the
      // commit lands and the push fails with a proxy authentication error.
      // full bypasses the sandbox and the approval, and is the only mode that
      // carries a resolution through to the PR unattended.
      options: ["accept-edits", "auto", "full"],
      default: "full",
    },
    providerId: {
      type: "string",
      label: "Provider for spawned threads",
      // The skills these prompts route to (resolve-merge-conflicts,
      // address-code-review, pr-sweep) are Claude Code user skills, so they
      // are invisible to a thread running on any other provider. Spawning on
      // bb's default provider produced threads that reported the skill "was
      // not installed" and improvised the workflow instead. Blank falls back
      // to bb's default.
      default: "claude-code",
    },
    adoptHandStartedThreads: {
      type: "select",
      label: "Adopt threads started by hand",
      // On: a thread typed into the composer whose prompt links exactly one
      // pull request in the sweep gets this plugin's title, and its link when
      // the pull request has no thread yet.
      //
      // It renames a title someone may have chosen, which is why it can be
      // turned off. In practice the title it replaces is bb's own reading of
      // the prompt, not a typed one.
      options: ["on", "off"],
      default: "on",
    },
  });

  /** In-flight spawns, keyed repo#number, so racing clicks share one result. */
  const spawning = new Map<
    string,
    Promise<{ threadId: string | null; existing: boolean; reason: string | null }>
  >();

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
   * The thread.deleted / thread.archived handlers below cover the live case,
   * but lifecycle events only fire while this plugin is loaded. A thread
   * deleted while bb was stopped, or while the plugin was disabled, would
   * otherwise stay linked forever and leave the row offering to open a thread
   * that is gone. Reconciling on every sweep makes the link self-healing
   * rather than dependent on having witnessed the event.
   */
  /** Pages threads.list, which caps a page however large a limit is asked for. */
  async function everyThread(options: { includeHidden?: boolean } = {}): Promise<
    Array<{
      id: string;
      title: string | null;
      originPluginId: string | null;
      archivedAt: number | null;
    }>
  > {
    const all: Array<{
      id: string;
      title: string | null;
      originPluginId: string | null;
      archivedAt: number | null;
    }> = [];
    const pageSize = 100;
    for (let offset = 0; ; offset += pageSize) {
      const page = await bb.sdk.threads.list({
        ...(options.includeHidden ? { includeHidden: true } : {}),
        archived: false,
        limit: pageSize,
        offset,
      });
      all.push(...page);
      if (page.length < pageSize) break;
    }
    return all;
  }

  /**
   * The title for a new thread on `row`, avoiding one a live thread already has.
   *
   * Checked against the world rather than against the link table, because the
   * link table is not the whole story: a thread whose link was dropped — by
   * the archive sweep, or by an archive later undone — is still in the
   * sidebar, still carrying its title, and still something a new thread can
   * collide with. That is exactly how #5840 came to have three unarchived
   * threads reading the same thing.
   *
   * Falls back to the canonical title if the threads cannot be listed. A
   * duplicate title is a much smaller problem than a thread that fails to
   * start.
   */
  async function titleForNewThread(
    row: { number: number; title: string; flags: readonly string[] },
    scope: string,
  ): Promise<string> {
    const canonical = threadTitle(row.number, row.title);
    try {
      const taken = new Set((await everyThread({ includeHidden: true })).map((t) => t.title));
      if (!taken.has(canonical)) return canonical;
      return scopedThreadTitle(row.number, scope);
    } catch (error) {
      bb.log.warn(`could not check existing thread titles: ${String(error)}`);
      return canonical;
    }
  }

  /**
   * Adopts threads started from the composer for a pull request this sweep
   * knows.
   *
   * gh-context reads every thread's first prompt once and links the pull
   * request a prompt names; this claims those links for the rows in the sweep,
   * then gives each newly claimed thread this sweep's title. Recording
   * `adopted:` is what makes the rename happen once.
   */
  async function adoptHandStartedThreads(): Promise<void> {
    const { adoptHandStartedThreads: enabled } = await settings.get();
    if (enabled !== "on") return;

    const rows = store.readRows();
    if (rows.length === 0) return;

    const entries = await links.entries(rows);
    const candidates = rows.flatMap((row, index) => {
      const entry = entries[index];
      return entry ? unclaimedPromptThreadIds(entry, bb.pluginId).map((threadId) => ({ row, threadId })) : [];
    });
    if (candidates.length === 0) return;

    const threads = await everyThread();
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    // Every title currently in the sidebar, so a rename cannot manufacture a
    // duplicate. Mutated as titles are assigned, so two adoptions in one pass
    // cannot collide with each other either.
    const titlesInUse = new Set(threads.map((thread) => thread.title));

    for (const { row, threadId } of candidates) {
      const thread = byId.get(threadId);
      // Not listed means archived or gone; not adoptable means another
      // plugin's thread, which is that plugin's business.
      if (!thread || !isAdoptable(thread, bb.pluginId)) continue;

      await links.link(row.repo, row.number, thread.id, "adopted");

      // One of this plugin's own, restored after being archived: it already
      // has the title this pass would give it, and its own scope in the title
      // if it was the second thread on the pull request. Renaming is for the
      // composer's threads.
      if (thread.originPluginId !== null) {
        bb.log.info(`re-linked ${thread.id} for ${row.repo}#${row.number}`);
        continue;
      }

      const canonical = threadTitle(row.number, row.title);
      // The scope-based alternative needs a flag, and a thread started from
      // the composer has none — so when the canonical title is already in the
      // sidebar, the thread keeps its own. bb derived that title from this
      // thread's prompt, which makes it a description of this thread's scope:
      // the very thing the canonical title cannot express twice.
      if (thread.title === canonical) {
        bb.log.info(`adopted ${thread.id} for ${row.repo}#${row.number}, already titled`);
        continue;
      }
      if (titlesInUse.has(canonical)) {
        bb.log.info(
          `adopted ${thread.id} for ${row.repo}#${row.number}; kept "${thread.title}", ` +
            `since another thread is already "${canonical}"`,
        );
        continue;
      }

      await bb.sdk.threads.update({ threadId: thread.id, title: canonical });
      titlesInUse.add(canonical);
      bb.log.info(`adopted ${thread.id} for ${row.repo}#${row.number} as "${canonical}"`);
    }
  }

  /**
   * Moves the links this checkout recorded before gh-context existed into it,
   * once, then drops the tables that held them. A thread this plugin started
   * is recorded as spawned; one it adopted from the composer, as adopted.
   */
  async function moveLegacyThreadLinks(): Promise<void> {
    const legacy = store.legacyThreadLinks();
    if (legacy.length > 0) {
      const origins = new Map(
        (await everyThread({ includeHidden: true })).map((thread) => [thread.id, thread.originPluginId]),
      );
      for (const link of legacy) {
        const how = origins.get(link.threadId) === bb.pluginId ? "spawned" : "adopted";
        await legacyLinks.link(link.repo, link.number, link.threadId, how);
      }
      bb.log.info(`moved ${legacy.length} thread link(s) into gh-context`);
    }
    store.dropLegacyThreadLinks();
  }

  async function reconcileThreadLinks(): Promise<void> {
    const rows = store.readRows();
    if (rows.length === 0) return;
    const linked = [...new Set([...(await links.threadMap(rows)).values()].flat())];
    if (linked.length === 0) return;

    // Every thread, not just this plugin's own. A link can point at a thread
    // someone started from the composer that the sweep adopted, and filtering
    // by originPluginId made every one of those look deleted — the link would
    // be dropped on the sweep after the one that created it, and the row would
    // go back to offering to start a thread for work underway.
    const live = new Set((await everyThread({ includeHidden: true })).map((thread) => thread.id));

    let dropped = 0;
    for (const threadId of linked) {
      if (!live.has(threadId)) {
        await links.release(threadId);
        dropped += 1;
      }
    }
    if (dropped > 0) bb.log.info(`released ${dropped} pull request(s) from missing threads`);
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
   * `signal` is the background service's: once it aborts, the gh call in
   * flight is killed and the rest of the sweep is skipped, so a reload never
   * waits on a sweep. bb degrades a plugin whose service misses its stop
   * window, and a degraded plugin answers no RPC until it is reloaded again.
   */
  async function sweepNow(signal?: AbortSignal): Promise<{ ok: boolean; error: string | null }> {
    const outcome = await fetchAndStore(signal);
    if (signal?.aborted) return outcome;

    // Reconciliation runs whether or not gh succeeded. The two are unrelated:
    // a missing gh says nothing about whether a linked thread still exists,
    // and a row stuck on "Open thread" for a deleted thread should heal even
    // while the sweep itself is broken.
    // Before reconciliation, so a link made here is seen as live rather than
    // being created and dropped within the same sweep.
    if (!(await linksAvailable())) return outcome;

    try {
      await ensureLegacyMoved();
    } catch (error) {
      bb.log.warn(`could not move thread links into gh-context: ${String(error)}`);
    }

    try {
      await adoptHandStartedThreads();
    } catch (error) {
      bb.log.warn(`could not adopt hand-started threads: ${String(error)}`);
    }

    try {
      await reconcileThreadLinks();
    } catch (error) {
      bb.log.warn(`could not reconcile thread links: ${String(error)}`);
    }

    return outcome;
  }

  /**
   * Consecutive sweeps that could not reach gh, and how many it takes before
   * the plugin declares itself misconfigured. Three at the default interval is
   * about fifteen minutes of consistent failure.
   */
  let unavailableRuns = 0;
  const UNAVAILABLE_RUNS_BEFORE_CONFIG = 3;

  /**
   * The repository filter for one sweep, rebuilt each time so a project added
   * since the last sweep is picked up without a reload.
   *
   * A failure to resolve projects leaves the filter unscoped rather than
   * empty: an unreachable project list is not evidence that nothing is checked
   * out, and treating it as such would blank every panel over a transient
   * error.
   */
  async function repoFilter(): Promise<RepoFilter> {
    const { filterToProjects, extraRepositories } = await settings.get();
    const enabled = filterToProjects === "on";
    if (!enabled) return buildRepoFilter({ enabled: false, candidates: [], extras: "" });
    try {
      return buildRepoFilter({
        enabled: true,
        candidates: await projectCandidates(),
        extras: extraRepositories,
      });
    } catch (error) {
      bb.log.warn(`could not resolve projects, sweeping every repository: ${String(error)}`);
      return buildRepoFilter({ enabled: false, candidates: [], extras: "" });
    }
  }

  /**
   * The repositories where nobody is ever assigned as a reviewer, read fresh
   * each sweep so the setting takes effect without a reload.
   */
  async function reviewerOptionalRepos(): Promise<(repo: string) => boolean> {
    const { reviewerOptionalRepositories } = await settings.get();
    const waived = new Set(parseRepositorySlugs(reviewerOptionalRepositories));
    return (repo: string) => waived.has(repo.toLowerCase());
  }

  async function fetchAndStore(signal?: AbortSignal): Promise<{ ok: boolean; error: string | null }> {
    const { ghPath } = await settings.get();
    try {
      const scope = await repoFilter();
      const optional = await reviewerOptionalRepos();
      const result = await syncUsage.measure(createGhRunner(ghPath, signal), (gh) =>
        runSweep(gh, () => Date.now(), scope, optional),
      );
      // A stopped sweep's repositories all read as failed. Keep the last
      // listing rather than storing that.
      if (signal?.aborted) return { ok: false, error: "Sweep stopped." };
      store.replaceAll(result);
      // Every row's count on first sight, and again whenever you commented
      // last, so a row is never "N new" just because this is the first sweep
      // to list it or because the newest comment is your own.
      store.recordSeen(result.rows, result.sweptAt);
      bb.realtime.publish(REALTIME_CHANNEL, { sweptAt: result.sweptAt });
      bb.log.info(
        `swept ${result.repos.length} repo(s), ${result.rows.length} open PR(s)` +
          (result.failedRepos.length ? `, ${result.failedRepos.length} failed` : "") +
          (result.skippedRepos.length
            ? `, ${result.skippedRepos.length} outside this machine's projects` +
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

  /**
   * The stored rows with dismissed failing checks taken off, which is how the
   * panel shows them and what a spawned thread is told to work on.
   */
  function currentRows() {
    const dismissals = store.dismissals();
    return store.readRows().map((row) => applyDismissal(row, dismissals.get(`${row.repo}#${row.number}`)));
  }

  /** The repository a bare "#123" should be read against: the only one swept. */
  async function defaultRepo(): Promise<string> {
    const repos = new Set(store.readRows().map((row) => row.repo));
    return repos.size === 1 ? [...repos][0]! : "";
  }

  /** The project checked out for a repository, with its local path. */
  /**
   * The checked-out project for a repository, with the host its source lives
   * on.
   *
   * The host matters: spawning into an unmanaged workspace is a request to use
   * a path on a specific machine, and bb rejects it outright without one
   * ("hostId is required unless workspace.type is personal"). The source that
   * gives us the path is the same source that names the host, so they are read
   * together and cannot drift.
   */
  async function projectForRepo(
    repo: string,
  ): Promise<{ id: string; path: string; hostId: string } | null> {
    const target = matchProjectTargetForRepo(repo, await projectCandidates());
    if (!target?.path || !target.hostId) return null;
    return { id: target.id, path: target.path, hostId: target.hostId };
  }

  /**
   * Creates the worktree on the pull request's branch, or reuses one already
   * there. Argument-array spawn, never a shell string.
   */
  /**
   * A branch can only be checked out in one worktree, so `git worktree add`
   * fails while another holds it. Names that worktree, since git's own message
   * buries the path in a sentence about preparing a checkout.
   */
  function describeBranchInUse(message: string, branch: string): string | null {
    const held = /already used by worktree at '([^']+)'/.exec(message);
    if (!held) return null;
    return `${branch} is already checked out at ${held[1]}. Close or archive whatever is using it, then try again.`;
  }

  /** Runs git and reports the outcome, for the checks that expect to fail. */
  function git(
    repoPath: string,
    args: string[],
  ): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile("git", ["-C", repoPath, ...args], (error, stdout, stderr) =>
        resolve({
          ok: !error,
          stdout: stdout ?? "",
          stderr: (stderr ?? "").trim() || (error ? error.message : ""),
        }),
      );
    });
  }

  /** The same, for the steps whose failure is the end of the attempt. */
  async function mustGit(repoPath: string, args: string[]): Promise<string> {
    const result = await git(repoPath, args);
    if (!result.ok) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
    return result.stdout;
  }

  async function remotesOf(repoPath: string): Promise<{ name: string; url: string }[]> {
    const result = await git(repoPath, ["remote", "-v"]);
    const remotes = new Map<string, string>();
    for (const line of result.stdout.split("\n")) {
      const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
      if (match) remotes.set(match[1]!, match[2]!);
    }
    return [...remotes].map(([name, url]) => ({ name, url }));
  }

  /**
   * Brings a fork's branch into a local branch of the same name.
   *
   * A fork's branch is not on origin, so fetching it by name fails with
   * "couldn't find remote ref" — the error this panel used to report for every
   * cross-repository pull request. GitHub keeps every pull request's head at
   * `refs/pull/<n>/head` on the base repository, which is reachable whatever
   * the fork does, including after the fork is deleted.
   */
  async function fetchForkBranch(
    repoPath: string,
    plan: Extract<WorktreePlan, { kind: "fork" }>,
  ): Promise<void> {
    await mustGit(repoPath, ["fetch", plan.fetchFrom, plan.prRef]);
    const head = (await mustGit(repoPath, ["rev-parse", "FETCH_HEAD"])).trim();

    const existing = await git(repoPath, ["rev-parse", "--verify", `refs/heads/${plan.branch}`]);
    if (!existing.ok) {
      await mustGit(repoPath, ["branch", plan.branch, head]);
      return;
    }

    const local = existing.stdout.trim();
    if (local === head) return;
    // Ahead of the pull request means an earlier thread committed here and has
    // not pushed. Overwriting that would throw the work away.
    if ((await git(repoPath, ["merge-base", "--is-ancestor", head, local])).ok) return;
    if ((await git(repoPath, ["merge-base", "--is-ancestor", local, head])).ok) {
      await mustGit(repoPath, ["branch", "--force", plan.branch, head]);
      return;
    }
    throw new Error(
      `A local branch ${plan.branch} already exists and has diverged from ${plan.repo}#${plan.number}. Rename or delete it, then try again.`,
    );
  }

  /**
   * Points the branch at the fork, so a push updates the pull request.
   *
   * This writes to the checkout's shared config rather than the worktree's,
   * which is what makes it visible in the worktree at all. It is the same
   * configuration `gh pr checkout` writes for a fork.
   */
  async function configurePush(
    repoPath: string,
    plan: Extract<WorktreePlan, { kind: "fork" }>,
  ): Promise<void> {
    if (!plan.pushTo) return;
    for (const [key, value] of [
      [`branch.${plan.branch}.remote`, plan.pushTo],
      [`branch.${plan.branch}.pushRemote`, plan.pushTo],
      [`branch.${plan.branch}.merge`, `refs/heads/${plan.branch}`],
    ] as const) {
      const result = await git(repoPath, ["config", key, value]);
      if (!result.ok) bb.log.warn(`could not set ${key}: ${result.stderr}`);
    }
  }

  /**
   * Fetches the pull request's base and head into the checkout, and returns
   * `<remote>/<base>` for the thread's merge base, or null when the checkout
   * has no remote for the repository. Without it bb diffs the thread against
   * its default branch, and a pull request stacked on another one shows the
   * other's changes too.
   *
   * A local copy of the head branch is brought up to date when that loses no
   * commits, so a branch rebased or pushed to on GitHub is not stale here.
   * In a worktree this panel made earlier, that is a fast-forward, which git
   * refuses when it would touch uncommitted changes.
   */
  async function fetchForThread(repoPath: string, path: string, pr: ResolvedPullRequest): Promise<string | null> {
    const exists = existsSync(path);
    const prepared = await prepareForPullRequest(
      runGit,
      repoPath,
      { repo: pr.repo, number: pr.number, baseRef: pr.baseRef, ...(exists ? {} : { headRef: pr.headRef }) },
      undefined,
    );
    for (const warning of prepared.warnings) bb.log.warn(`${pr.repo}#${pr.number}: ${warning}`);
    if (exists && prepared.head !== null) {
      const merged = await git(path, ["merge", "--ff-only", prepared.head]);
      if (!merged.ok) bb.log.warn(`could not fast-forward ${path} to ${pr.repo}#${pr.number}'s head: ${merged.stderr}`);
    }
    return prepared.mergeBase;
  }

  /**
   * Sets the thread's merge base, logging rather than failing a thread that
   * already started.
   *
   * bb attaches an unmanaged workspace to the thread after `threads.spawn`
   * returns, which comes back with no environment id, so this reads the thread
   * until it has one. One `threads.get` per poll, for at most
   * {@link ENVIRONMENT_WAIT_MS}.
   */
  async function setMergeBase(thread: { id: string; environmentId?: string | null }, mergeBase: string | null) {
    if (mergeBase === null) return;
    try {
      let environmentId = thread.environmentId ?? null;
      for (const started = Date.now(); environmentId === null && Date.now() - started < ENVIRONMENT_WAIT_MS; ) {
        await new Promise((resolve) => setTimeout(resolve, ENVIRONMENT_POLL_MS));
        environmentId = (await bb.sdk.threads.get({ threadId: thread.id })).environmentId;
      }
      if (environmentId === null) {
        bb.log.warn(`${thread.id} had no environment after ${ENVIRONMENT_WAIT_MS} ms, so its merge base is not ${mergeBase}`);
        return;
      }
      await bb.sdk.environments.update({ environmentId, mergeBaseBranch: mergeBase });
    } catch (error) {
      bb.log.warn(`could not set ${thread.id}'s merge base to ${mergeBase}: ${String(error)}`);
    }
  }

  async function addWorktree(repoPath: string, path: string, plan: WorktreePlan): Promise<void> {
    if (existsSync(path)) return;

    // Prune first. Threads spawned from this panel are told to nest their own
    // worktrees under the directory bb owns, and bb deletes that directory when
    // the thread is archived — but the registration in this repository outlives
    // it, and git keeps refusing the branch on behalf of a path that is no
    // longer there. Pruning is safe: it only drops registrations whose
    // directory has actually gone.
    await git(repoPath, ["worktree", "prune"]);

    if (plan.kind === "fork") await fetchForkBranch(repoPath, plan);
    else await mustGit(repoPath, ["fetch", plan.fetchFrom, plan.branch]);

    try {
      await mustGit(repoPath, ["worktree", "add", path, plan.branch]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const inUse = describeBranchInUse(message, plan.branch);
      throw inUse ? new Error(inUse) : error;
    }

    if (plan.kind === "fork") await configurePush(repoPath, plan);
  }

  /**
   * Where a "Work on this" thread for a pull request can start: a worktree on
   * its own branch, beside the checkout. Nothing is created here; this only
   * decides, so the dialog can say what will happen before anything does.
   *
   * The answer is no, with the reason, when the pull request or its checkout
   * cannot be found, or when another worktree holds the branch. That is most
   * often the thread that opened the pull request, and taking the branch from
   * it is not this panel's call. A worktree this panel made earlier for the
   * same pull request, by either action, is reused rather than counted.
   */
  async function branchWorkspace(
    repo: string,
    number: number,
  ): Promise<
    | { ok: true; pr: ResolvedPullRequest; project: { id: string; path: string; hostId: string }; path: string }
    | { ok: false; reason: string }
  > {
    const { ghPath } = await settings.get();
    let pr: ResolvedPullRequest;
    try {
      pr = await resolvePr(createGhRunner(ghPath), repo, number);
    } catch {
      return { ok: false, reason: `Could not read the branch of ${repo}#${number}.` };
    }
    const project = await projectForRepo(repo);
    if (!project) return { ok: false, reason: `No checkout of ${repo} was found on this machine.` };

    const path = worktreePath(project.path, number);
    // Pruned first for the same reason as in addWorktree: a registration
    // whose directory bb already deleted still claims the branch.
    await git(project.path, ["worktree", "prune"]);
    const listed = await git(project.path, ["worktree", "list", "--porcelain"]);
    if (!listed.ok) return { ok: false, reason: `Could not list the worktrees of ${project.path}.` };
    const holder = branchHolder(listed.stdout, pr.headRef);
    if (holder && holder.replace(/\/+$/, "") !== path) {
      return { ok: false, reason: `${pr.headRef} is already checked out at ${holder}.` };
    }
    return { ok: true, pr, project, path };
  }

  /**
   * For a thread the composer starts in a new worktree on the default base,
   * which is where it goes when the pull request's branch is taken: fetches
   * the base and head, and starts the worktree from `<remote>/<base>` instead,
   * which bb records as its merge base. Any other environment the composer
   * chose is left as it is, since other threads share it. A failure is logged
   * and the thread starts as the composer asked.
   */
  async function worktreeOnBase(
    repo: string,
    number: number,
    baseRef: string,
    request: { projectId: string; environment?: unknown },
  ): Promise<Record<string, unknown>> {
    try {
      const path = (await projectCandidates()).find((candidate) => candidate.id === request.projectId)?.path;
      if (!path) return {};
      const prepared = await prepareForPullRequest(runGit, path, { repo, number, baseRef }, request.environment);
      for (const warning of prepared.warnings) bb.log.warn(`${repo}#${number}: ${warning}`);
      return prepared.environment === request.environment ? {} : { environment: prepared.environment };
    } catch (error) {
      bb.log.warn(`could not prepare ${repo}#${number}'s checkout: ${String(error)}`);
      return {};
    }
  }

  /**
   * Removes the worktree an archived or deleted thread ran in, when this
   * panel made it and nothing else uses it.
   *
   * bb deletes only the worktrees it manages. Without this, every thread
   * started on a pull request's branch would leave a checkout beside the
   * project for good. `git worktree remove` without `--force` refuses a
   * worktree with uncommitted or untracked changes, which is the one case
   * worth keeping; the branch and its commits stay either way.
   */
  async function removeThreadWorktree(thread: { id: string; projectId: string; environmentId: string | null }) {
    if (!thread.environmentId) return;
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    if (environment.managed || !environment.path) return;
    const checkout = checkoutForWorktree(
      environment.path,
      (await projectCandidates()).map((candidate) => candidate.path).filter((path): path is string => !!path),
    );
    if (!checkout) return;

    const others = await bb.sdk.threads.list({ projectId: thread.projectId, archived: false });
    if (others.some((other) => other.id !== thread.id && other.environmentId === thread.environmentId)) return;

    const removed = await git(checkout, ["worktree", "remove", environment.path]);
    if (removed.ok) bb.log.info(`removed ${environment.path} after ${thread.id} ended`);
    else bb.log.info(`kept ${environment.path} after ${thread.id} ended: ${removed.stderr}`);
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
      const rows = currentRows();
      const notes = store.notes();
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
        staleAfterDays: parseStaleAfterDays(staleAfterDays),
        rows: rows.map((row) => {
          const key = `${row.repo}#${row.number}`;
          const threadIds = threadMap?.get(key) ?? [];
          const commentsCount = row.commentsCount ?? 0;
          // No record yet reads as nothing new: the sweep records the count on
          // first sight, and until it has, every comment is one already there.
          // Floored at zero, since deleted comments can drop the count.
          const seenCount = seen.get(key);
          return {
            ...row,
            // A row stored before the field existed reads as updated at the
            // last sweep, which is never stale, until the next sweep fills it.
            updatedAt: row.updatedAt || meta.sweptAt || Date.now(),
            commentsCount,
            note: notes.get(key) ?? null,
            newComments: seenCount === undefined ? 0 : Math.max(0, commentsCount - seenCount),
            canSpawn: threadMap !== null && spawnable.has(row.repo),
            threadId: threadIds[0] ?? null,
            threadIds,
          };
        }),
        sweptAt: meta.sweptAt,
        failedRepos: meta.failedRepos,
        skippedRepos: meta.skippedRepos,
        truncated: meta.truncated,
        lastError: threadMap === null ? GH_CONTEXT_REQUIRED : meta.lastError,
        usage: syncUsage.snapshot(),
      };
    },

    async refresh() {
      return sweepNow();
    },

    /**
     * Resolves what the user typed, so the form can confirm the title and
     * branch before anything is created. A typo fails here rather than in a
     * spawned thread.
     */
    async resolvePullRequest({ input }) {
      const { ghPath } = await settings.get();
      const parsed = parsePullRequestInput(input, await defaultRepo());
      if ("error" in parsed) return { pr: null, error: parsed.error };

      try {
        const pr = await resolvePr(createGhRunner(ghPath), parsed.repo, parsed.number);
        return { pr, error: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof GhUnavailableError) bb.status.needsConfiguration(message);
        return { pr: null, error: `Could not read ${parsed.repo}#${parsed.number}.` };
      }
    },

    /**
     * Creates a worktree on the pull request's own branch and attaches a
     * thread to it as an unmanaged environment.
     *
     * bb's managed worktree always cuts a fresh `bb/<thread>` branch off the
     * base, so a thread on one is not on the pull request and a push does not
     * update it. Attaching to a worktree we made ourselves puts the thread on
     * the branch — and bb then reports the pull request, its checks and its
     * review state on the thread, which it cannot do for a branch that has no
     * pull request.
     *
     * bb does not delete an unmanaged worktree when the thread is archived,
     * so the thread.archived handler below does, when it is clean.
     */
    async openPullRequest({ input, instructions }) {
      const { ghPath, providerId, permissionMode } = await settings.get();
      const parsed = parsePullRequestInput(input, await defaultRepo());
      if ("error" in parsed) return { threadId: null, worktree: null, error: parsed.error };

      let pr;
      try {
        pr = await resolvePr(createGhRunner(ghPath), parsed.repo, parsed.number);
      } catch {
        return {
          threadId: null,
          worktree: null,
          error: `Could not read ${parsed.repo}#${parsed.number}.`,
        };
      }

      const project = await projectForRepo(pr.repo);
      if (!project) {
        return {
          threadId: null,
          worktree: null,
          error: `No bb project is checked out for ${pr.repo}.`,
        };
      }

      const path = worktreePath(project.path, pr.number);
      let mergeBase: string | null = null;
      try {
        mergeBase = await fetchForThread(project.path, path, pr);
        await addWorktree(project.path, path, worktreePlan(pr, await remotesOf(project.path)));
      } catch (error) {
        // addWorktree already explains the one failure with a useful answer;
        // wrapping that in "Could not create a worktree at <path>" buries the
        // sentence that tells you what to do.
        const message = error instanceof Error ? error.message : String(error);
        const explained = message.includes("already checked out at");
        return {
          threadId: null,
          worktree: null,
          error: explained ? message : `Could not create a worktree at ${path}: ${message}`,
        };
      }

      let thread;
      try {
        thread = await bb.sdk.threads.spawn({
          projectId: project.id,
          environment: {
            type: "host",
            hostId: project.hostId,
            workspace: {
              type: "unmanaged",
              path,
              branch: { kind: "existing", name: pr.headRef },
            },
          },
          ...(providerId ? { providerId } : {}),
          permissionMode: parsePermissionMode(permissionMode),
          prompt: buildOpenPrompt(pr, instructions),
          // The same title the panel's own action produces. A thread opened
          // here does the same kind of work on the same pull request, so the
          // sidebar should not tell them apart by accident of which button
          // started them.
          title: threadTitle(pr.number, pr.title),
        });
      } catch (error) {
        // Reported rather than thrown: an unhandled rejection here reaches the
        // panel as a generic failure, and the worktree is already on disk, so
        // the one visible symptom is a button that does nothing.
        const message = error instanceof Error ? error.message : String(error);
        bb.log.warn(`could not open ${pr.repo}#${pr.number}: ${message}`);
        return {
          threadId: null,
          worktree: path,
          error: `The worktree at ${path} is ready, but the thread could not start: ${message}`,
        };
      }

      // Not awaited: it waits for bb to attach the workspace, and the panel
      // should not wait with it.
      void setMergeBase(thread, mergeBase);
      await links.link(pr.repo, pr.number, thread.id, "spawned");
      bb.realtime.publish(REALTIME_CHANNEL, { sweptAt: null });
      bb.log.info(`opened ${pr.repo}#${pr.number} at ${path} as ${thread.id}`);
      return { threadId: thread.id, worktree: path, error: null };
    },

    setNote({ repo, number, body }) {
      store.setNote(repo, number, body, Date.now());
      return { ok: true };
    },

    dismissChecks({ repo, number, dismissed }) {
      if (!dismissed) {
        store.setDismissal(repo, number, null, Date.now());
        return { ok: true };
      }
      const row = store.readRows().find((entry) => entry.repo === repo && entry.number === number);
      const fingerprint = row ? checksFingerprint(row) : null;
      if (fingerprint === null) return { ok: false };
      store.setDismissal(repo, number, fingerprint, Date.now());
      bb.log.info(`dismissed failing checks on ${repo}#${number}: ${row!.failingChecks!.join(", ")}`);
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
      if (row.commentsCount !== undefined) store.markSeen(repo, number, row.commentsCount, Date.now());
      return { ok: true };
    },

    async archiveThread({ repo, number }) {
      const threadId = await links.threadFor(repo, number);
      if (!threadId) return { ok: false, reason: "That pull request has no thread." };

      await bb.sdk.threads.archive({ threadId });
      // The thread.archived handler unlinks too, but doing it here means the
      // row updates even if the event is lost, and makes the rpc's effect
      // complete on its own.
      await links.release(threadId);
      bb.realtime.publish(REALTIME_CHANNEL, { sweptAt: null });
      bb.log.info(`archived ${threadId} for ${repo}#${number}`);
      return { ok: true, reason: null };
    },

    async workOnThisDraft({ repo, number }) {
      const existingThreadId = await links.threadFor(repo, number);
      if (existingThreadId) return { existingThreadId, reason: null, seed: null };

      const row = currentRows().find((entry) => entry.repo === repo && entry.number === number);
      if (!row) {
        return {
          existingThreadId: null,
          reason: "That pull request is no longer in the sweep.",
          seed: null,
        };
      }

      const projectId = matchProjectForRepo(repo, await projectCandidates());
      if (!projectId) {
        return {
          existingThreadId: null,
          reason: `No bb project is checked out for ${repo}.`,
          seed: null,
        };
      }

      const { providerId, modelByAction, permissionMode } = await settings.get();
      const { models, error } = parseModelByAction(modelByAction);
      if (error) bb.log.warn(`"Model by action" setting: ${error}`);

      return {
        existingThreadId: null,
        reason: null,
        seed: {
          projectId,
          providerId: providerId || null,
          // Still per-flag: the setting picks the model the work deserves, and
          // the composer is where you disagree with it for one thread.
          model: modelForFlags(row.flags, models) || null,
          permissionMode: parsePermissionMode(permissionMode),
          skills: suggestedSkills(row),
          workspace: await (async () => {
            const found = await branchWorkspace(repo, number);
            return found.ok
              ? { branch: found.pr.headRef, note: null }
              : { branch: null, note: found.reason };
          })(),
          preview: {
            title: row.title,
            number: row.number,
            url: row.url,
            meta: [row.repo, ...row.flags, row.isDraft ? "draft" : null]
              .filter(Boolean)
              .join(" · "),
          },
        },
      };
    },

    async workOnThisSubmit({ repo, number, request, onBranch }) {
      const key = `${repo}#${number}`;

      // One thread per PR, enforced on three levels: the durable link below,
      // this in-flight map for submits that race before the first spawn
      // returns, and a disabled button in the panel. The link alone is not
      // enough — two clicks a few hundred ms apart both read "no link yet".
      const inFlight = spawning.get(key);
      if (inFlight) return inFlight;

      const attempt = (async () => {
        const row = currentRows().find((entry) => entry.repo === repo && entry.number === number);
        // Starting or reopening the thread is reading the pull request, so its
        // new comments are no longer new.
        const markSeen = () => {
          if (row?.commentsCount !== undefined) store.markSeen(repo, number, row.commentsCount, Date.now());
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
            reason: "That pull request is no longer in the sweep.",
          };
        }

        // Everything the composer resolved — project, environment, provider,
        // model, reasoning, permission mode, execution provenance — is
        // forwarded untouched. Only the title is the plugin's business: the
        // composer has no field for one, and the sidebar should say what this
        // thread is for.
        // The composer only ever held the middle of the prompt, so the two
        // ends are put back here — including the worktree rules, which are in
        // the trailer precisely because they must not depend on anyone leaving
        // them in the box. Its own items sit between them untouched, which is
        // what keeps any @-mention or attachment that was added.
        let environment: Record<string, unknown> = {};
        let branchPr: ResolvedPullRequest | undefined;
        let mergeBase: string | null = null;
        if (onBranch) {
          // Decided again rather than trusted from the draft: the dialog can
          // sit open while another thread takes the branch.
          const found = await branchWorkspace(repo, number);
          if (!found.ok) return { threadId: null, existing: false, reason: found.reason };
          try {
            mergeBase = await fetchForThread(found.project.path, found.path, found.pr);
            await addWorktree(
              found.project.path,
              found.path,
              worktreePlan(found.pr, await remotesOf(found.project.path)),
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { threadId: null, existing: false, reason: `Could not create a worktree at ${found.path}: ${message}` };
          }
          branchPr = found.pr;
          environment = {
            projectId: found.project.id,
            environment: {
              type: "host",
              hostId: found.project.hostId,
              workspace: {
                type: "unmanaged",
                path: found.path,
                branch: { kind: "existing", name: found.pr.headRef },
              },
            },
          };
        } else if (row.baseRefName) {
          environment = await worktreeOnBase(row.repo, row.number, row.baseRefName, request);
        }

        const parts = buildPromptParts(row, branchPr);
        const thread = await bb.sdk.threads.spawn({
          ...request,
          ...environment,
          input: [
            { type: "text", text: headerItem(parts), mentions: [] },
            ...request.input,
            { type: "text", text: trailerItem(parts), mentions: [] },
          ],
          // The pull request's own words for its first thread; what this
          // thread is for once another thread already carries them.
          title: await titleForNewThread(row, actionSummary(row.flags, commentsToRead(row))),
        } as Parameters<typeof bb.sdk.threads.spawn>[0]);

        void setMergeBase(thread, mergeBase);
        bb.log.info(`started ${thread.id} for ${key} in ${request.projectId}`);
        await links.link(repo, number, thread.id, "spawned");
        markSeen();
        bb.realtime.publish(REALTIME_CHANNEL, { sweptAt: null });
        return { threadId: thread.id, existing: false, reason: null };
      })();

      spawning.set(key, attempt);
      try {
        return await attempt;
      } finally {
        spawning.delete(key);
      }
    },
  });

  // A thread the user archived or deleted should not keep its PR pinned to it,
  // otherwise the row offers to open a thread that is gone.
  for (const event of ["thread.archived", "thread.deleted"] as const) {
    bb.events.on(event, async ({ thread }) => {
      try {
        await links.release(thread.id);
      } catch (error) {
        bb.log.warn(`could not release ${thread.id}: ${String(error)}`);
      }
      try {
        await removeThreadWorktree(thread);
      } catch (error) {
        bb.log.warn(`could not remove the worktree of ${thread.id}: ${String(error)}`);
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
