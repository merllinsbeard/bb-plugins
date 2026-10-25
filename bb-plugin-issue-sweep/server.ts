import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createSyncUsage } from "@danielb/gh-shared/gh";
import { createHarvestBridge } from "bb-plugin-harvest/bridge";
import { isAdoptable } from "./issues/adopt.js";
import {
  createSweepLinks,
  createThreadLinksBridge,
  unclaimedPromptThreadIds,
} from "bb-plugin-gh-context/links";
import { rpcContract } from "./issues/contract.js";
import { boardForRow, parseBoardNames, parseStatusOrder, shouldAutoApply } from "./issues/board.js";
import { seenThroughOwn } from "./issues/comments.js";
import {
  GhUnavailableError,
  createGhRunner,
  fetchCommentAuthors,
  fetchComments,
  fetchViewerLogin,
  runSweep,
  type GhRunner,
} from "./issues/gh.js";
import {
  BoardUnavailableError,
  fetchBoardProjects,
  ownerOf,
  // Aliased: the RPC handler below has the same name, and a bare call inside
  // it would read as recursion.
  setBoardStatus as applyBoardStatus,
  type BoardProject,
} from "./issues/project.js";
import {
  buildPromptParts,
  headerItem,
  trailerItem,
  threadTitle,
} from "./issues/prompt.js";
import {
  buildRepoFilter,
  matchProjectTargetForRepo,
  matchProjectForRepo,
  toProjectCandidates,
  type ProjectCandidate,
  type RepoFilter,
} from "./issues/spawn-target.js";
import { MIGRATIONS, createStore } from "./issues/store.js";
import { parseStaleAfterDays } from "./issues/tiers.js";
import type { IssueRow } from "./issues/types.js";

export { rpcContract };

const REALTIME_CHANNEL = "issues-updated";

const GH_CONTEXT_REQUIRED =
  "Issue Sweep needs the gh-context plugin, which records which threads belong to which issues. Install it, then reload Issue Sweep.";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    syncIntervalMinutes: {
      type: "select",
      label: "Sync interval (minutes)",
      options: ["2", "5", "15"],
      default: "5",
    },
    projectBoard: {
      type: "string",
      label: "Project boards",
      description:
        "Board names, separated by commas, such as \"Team Board, Personal\". Each issue shows its status from the first board listed that it is on. An issue on none of them is added to the first board listed that its repository's owner has. Blank reads the status from any board.",
      // Names, not ids, and a setting rather than a constant: they identify
      // private projects and this repository is public. The key keeps its
      // old singular name so a saved board carries over.
      default: "",
    },
    boardStages: {
      type: "string",
      label: "Board stages, in order",
      // The track drawn on every row, one column per status. A status the
      // board has that is not named here shows its name in place of the track.
      default: "Backlog,Ready,In Progress,In Review",
    },
    staleAfterDays: {
      type: "string",
      label: "Stale after (days)",
      // A counted issue untouched for this long moves up into Now, flagged.
      default: "7",
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
      // every other one. Off sweeps every repository with an issue assigned to
      // you.
      options: ["on", "off"],
      default: "on",
    },
    extraRepositories: {
      type: "string",
      label: "Also sweep these repositories",
      // Comma or newline separated owner/name, for a repository worth
      // watching without a checkout here. Ignored when the filter is off.
      default: "",
    },
    model: {
      type: "string",
      label: "Model for issue threads",
      // Blank takes the provider's default. One action here, so one value
      // rather than pr-sweep's model-by-action JSON.
      default: "",
    },
    permissionMode: {
      type: "select",
      label: "Permission mode for spawned threads",
      // auto keeps the workspace sandbox, which blocks network egress, so the
      // thread could not reach GitHub to read the issue it was started for.
      options: ["accept-edits", "auto", "full"],
      default: "full",
    },
    providerId: {
      type: "string",
      label: "Provider for spawned threads",
      // Blank falls back to bb's default.
      default: "claude-code",
    },
    countedStatuses: {
      type: "string",
      label: "Statuses that are on you",
      // "What is on me right now" is a smaller question than "what is
      // assigned to me". Blank counts everything.
      default: "In Progress,Ready",
    },
    statusOnStart: {
      type: "string",
      label: "Board status when a thread starts",
      // Blank turns the move off. A name rather than a fixed constant because
      // a board is free to call this column whatever it likes.
      default: "In Progress",
    },
    statusOnPullRequest: {
      type: "string",
      label: "Board status when a closing pull request opens",
      default: "In Review",
    },
    adoptHandStartedThreads: {
      type: "select",
      label: "Adopt threads started by hand",
      // On: a thread typed into the composer whose prompt links exactly one
      // issue in the sweep gets this plugin's title, the issue's link, and the
      // board move a thread started from the panel would have made.
      //
      // It renames a title someone may have chosen, which is why it can be
      // turned off. In practice the title it replaces is bb's own reading of
      // the prompt ("Work on issue 5837"), not a typed one.
      options: ["on", "off"],
      default: "on",
    },
  });

  const PERMISSION_MODES = ["accept-edits", "auto", "full"] as const;
  type PermissionMode = (typeof PERMISSION_MODES)[number];

  /**
   * Narrows the stored setting, typed only as `string` by the SDK, to the
   * union `threads.spawn` accepts. An unrecognised value falls back to the
   * declared default rather than reaching the spawn call.
   */
  function parsePermissionMode(raw: string | undefined): PermissionMode {
    return (PERMISSION_MODES as readonly string[]).includes(raw ?? "")
      ? (raw as PermissionMode)
      : "full";
  }

  /**
   * One thread per issue, enforced on three levels: the durable link in the
   * store, this in-flight map for clicks that race before the first spawn
   * returns, and a disabled button in the panel. The link alone is not enough —
   * two clicks a few hundred ms apart both read "no link yet".
   */
  const spawning = new Map<string, Promise<{ threadId: string | null; existing: boolean; reason: string | null }>>();

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
   * The listed boards each owner has, resolved on first use and kept for the
   * process.
   *
   * A board's id and its Status options change far less often than its
   * contents, and resolving them costs one `gh project` call per owner plus
   * one per board. Keyed by owner because a board belongs to the org or user
   * that owns it, and by the setting too, so changing the list reads the new
   * boards rather than the ones cached under the old list.
   */
  const boards = new Map<string, BoardProject[]>();

  function boardsKey(owner: string, projectBoard: string): string {
    return `${owner}\n${projectBoard}`;
  }

  async function boardsFor(owner: string): Promise<BoardProject[]> {
    const { ghPath, projectBoard } = await settings.get();
    const key = boardsKey(owner, projectBoard);
    const cached = boards.get(key);
    if (cached) return cached;
    const projects = await fetchBoardProjects(
      createGhRunner(ghPath),
      owner,
      parseBoardNames(projectBoard),
    );
    boards.set(key, projects);
    return projects;
  }

  /** The board a row's moves go to; see boardForRow for which one. */
  async function boardOf(row: { repo: string; onBoard: boolean; board?: string | null }): Promise<BoardProject> {
    const owner = ownerOf(row.repo);
    const project = boardForRow(row, await boardsFor(owner));
    if (!project) {
      throw new BoardUnavailableError(
        `${row.repo} is on ${row.board ?? "a board"}, which ${owner} does not own, so it cannot be moved from here.`,
      );
    }
    return project;
  }

  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = createStore(db as never);
  // The past hour of sweeps and what each cost on GitHub, for the sync status.
  const syncUsage = createSyncUsage();
  // gh-context is the one record of which threads belong to which issues;
  // this sweep reads and writes its own links through it.
  const threadLinks = createThreadLinksBridge(bb);
  // The move out of this plugin's own old tables writes through a wrapper with
  // no hook, so the hook below cannot wait on itself.
  const legacyLinks = createSweepLinks(threadLinks, bb.pluginId, "issue");
  const links = createSweepLinks(threadLinks, bb.pluginId, "issue", {
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
      bb.log.warn(`could not resolve projects, sweeping every repository: ${String(error)}`);
      return buildRepoFilter({ enabled: false, candidates: [], extras: "" });
    }
  }

  /**
   * `signal` is the background service's: once it aborts, the gh call in
   * flight is killed and the rest of the sweep is skipped, so a reload never
   * waits on a sweep. bb degrades a plugin whose service misses its stop
   * window, and a degraded plugin answers no RPC until it is reloaded again.
   */
  async function sweepNow(signal?: AbortSignal): Promise<{ ok: boolean; error: string | null }> {
    const { ghPath, projectBoard } = await settings.get();
    try {
      const scope = await repoFilter();
      // Measured as one sync through to the board moves, since every step
      // here can call GitHub. Only runSweep and absorbOwnComments go through
      // the counting runner, so the call count leaves out the board's calls,
      // but the points include them.
      const result = await syncUsage.measure(createGhRunner(ghPath, signal), async (gh) => {
        const swept = await runSweep(gh, () => Date.now(), projectBoard, scope);
        // A stopped sweep's repositories all read as failed. Keep the last
        // listing rather than storing that.
        signal?.throwIfAborted();
        store.replaceAll(swept);
        // Every row's count on first sight, so a row is never "N new" just
        // because this is the first sweep to list it.
        store.recordFirstSeen(swept.rows, swept.sweptAt);
        await absorbOwnComments(gh, swept.rows);
        // The board steps make their own gh calls, outside the signal.
        signal?.throwIfAborted();
        // Before the publish, so the panel's reload finds the options already
        // there and renders pickers on its first paint rather than its second.
        await warmBoards(swept.rows);
        signal?.throwIfAborted();
        // Also before the publish. The rows it works from are the ones just
        // stored, so a promotion patches the stored row too and the moved cards
        // show their new status on this sweep rather than the next one.
        await promoteIssuesInReview(swept.rows);
        return swept;
      });
      // Last, and inside the try: a failure there must not lose the sweep that
      // succeeded.
      if (await linksAvailable()) {
        try {
          await ensureLegacyMoved();
        } catch (error) {
          bb.log.warn(`could not move thread links into gh-context: ${String(error)}`);
        }
        try {
          await adoptHandStartedThreads(result.rows);
        } catch (error) {
          bb.log.warn(`could not adopt hand-started threads: ${String(error)}`);
        }
      }
      bb.realtime.publish(REALTIME_CHANNEL, { sweptAt: result.sweptAt });
      bb.log.info(
        `swept ${result.rows.length} open issue(s)` +
          (result.skippedRepos.length
            ? `, skipped ${result.skippedRepos.length} repo(s) outside this machine's projects` +
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
      // The last good rows stay in the store, so a broken sweep degrades to a
      // stale panel with a banner rather than an empty one.
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

  let viewerLogin: string | null = null;

  /**
   * Marks your own comments seen, and everything before them, so an issue is
   * "N new" only for what others wrote since you last commented. Only issues
   * whose count has grown since they were seen are fetched, which on most
   * sweeps is none. A failure leaves the counts as they were, which at worst
   * shows your own comment as new until the next sweep.
   */
  async function absorbOwnComments(gh: GhRunner, rows: readonly IssueRow[]): Promise<void> {
    const seen = store.seenCounts();
    const grown = rows.filter((row) => {
      const count = seen.get(`${row.repo}#${row.number}`);
      return count !== undefined && row.commentsCount > count;
    });
    if (grown.length === 0) return;
    try {
      viewerLogin ??= await fetchViewerLogin(gh);
      for (const row of grown) {
        const before = seen.get(`${row.repo}#${row.number}`)!;
        const authors = await fetchCommentAuthors(gh, row.repo, row.number);
        const after = Math.min(row.commentsCount, seenThroughOwn(authors, before, viewerLogin));
        if (after > before) store.markSeen(row.repo, row.number, after, Date.now());
      }
    } catch (error) {
      bb.log.warn(`could not read comment authors: ${String(error)}`);
    }
  }

  /**
   * Resolves the board for every owner in the listing, ignoring failures.
   *
   * Called from the sweep rather than from `listRows` so the panel never waits
   * on it. Resolving costs two `gh project` calls, and doing that inline made
   * the first paint after a reload block for five seconds.
   */
  async function warmBoards(rows: readonly { repo: string }[]): Promise<void> {
    const { projectBoard } = await settings.get();
    for (const owner of new Set(rows.map((row) => ownerOf(row.repo)))) {
      if (owner === "" || boards.has(boardsKey(owner, projectBoard))) continue;
      try {
        await boardsFor(owner);
      } catch (error) {
        // A missing or misnamed board is a configuration matter, not a sweep
        // failure: the listing is still correct, it just has no picker.
        if (error instanceof BoardUnavailableError) continue;
        bb.log.warn(`could not read the board for ${owner}: ${String(error)}`);
      }
    }
  }

  /**
   * The Status options of the board a row's moves go to.
   *
   * Reads the cache only — an unwarmed cache yields no options, which
   * degrades to statuses as text with no picker.
   */
  function statusOptionsFor(
    row: { repo: string; onBoard: boolean; board?: string | null },
    projectBoard: string,
  ): string[] {
    const cached = boards.get(boardsKey(ownerOf(row.repo), projectBoard));
    const project = cached ? boardForRow(row, cached) : null;
    return project ? project.statusOptions.map((option) => option.name) : [];
  }

  /**
   * Moves an issue's card on the board, on this plugin's own initiative rather
   * than because someone picked a status.
   *
   * Applied at most once per target, which is what `board_auto` records. The
   * sweep runs every few minutes and a pull request stays open for days, so
   * without that a card dragged back by hand would be dragged forward again
   * before you finished reading the row.
   *
   * Everything here fails quietly. These moves are a convenience on top of the
   * listing; a board that cannot be reached, or has no column by this name,
   * must not turn into an error banner over a listing that is perfectly good.
   */
  async function autoSetStatus(
    row: {
      repo: string;
      number: number;
      url: string;
      boardStatus: string | null;
      onBoard: boolean;
      board?: string | null;
    },
    target: string,
  ): Promise<boolean> {
    const wanted = target.trim();
    const applied = store.autoAppliedStatus(row.repo, row.number);
    if (!shouldAutoApply(row.boardStatus, applied, wanted)) return false;

    try {
      const { ghPath } = await settings.get();
      const project = await boardOf(row);
      const option = project.statusOptions.find(
        (candidate) => candidate.name.toLowerCase() === wanted.toLowerCase(),
      );
      if (!option) {
        bb.log.warn(`${project.title} has no "${wanted}" status; leaving ${row.repo}#${row.number}`);
        return false;
      }

      await applyBoardStatus(createGhRunner(ghPath), {
        project,
        repo: row.repo,
        number: row.number,
        url: row.url,
        option,
      });
      const movedAt = Date.now();
      store.recordAutoStatus(row.repo, row.number, option.name, movedAt);
      store.recordMove(row.repo, row.number, movedAt);
      // The board has the move; the stored row does not until the next sweep.
      // Patching it here is what lets a card show its new status on the paint
      // that follows the click, rather than up to five minutes later.
      store.setRowStatus(row.repo, row.number, option.name);
      bb.log.info(`moved ${row.repo}#${row.number} to ${option.name}`);
      return true;
    } catch (error) {
      if (error instanceof BoardUnavailableError) return false;
      bb.log.warn(`could not move ${row.repo}#${row.number} to ${wanted}: ${String(error)}`);
      return false;
    }
  }

  /** Pages threads.list, which caps a page however large a limit is asked for. */
  async function everyThread(): Promise<
    Array<{ id: string; title: string | null; originPluginId: string | null; archivedAt: number | null }>
  > {
    const all: Array<{
      id: string;
      title: string | null;
      originPluginId: string | null;
      archivedAt: number | null;
    }> = [];
    const pageSize = 100;
    for (let offset = 0; ; offset += pageSize) {
      const page = await bb.sdk.threads.list({ archived: false, limit: pageSize, offset });
      all.push(...page);
      if (page.length < pageSize) break;
    }
    return all;
  }

  /**
   * Adopts threads started from the composer for an issue this sweep knows.
   *
   * Runs at the end of a sweep, on the rows just stored, so the title it
   * writes is built from the same row the panel is about to render.
   *
   * gh-context reads every thread's first prompt once and links the one issue
   * it names; this claims those links for the rows in the sweep. Only a
   * `prompt` link, not an opening-line one: a handoff thread that opens with
   * "issue #N" was titled by the thread that handed it off, for the part of
   * the issue it takes on. Recording `adopted:` makes the rename and the board
   * move happen once.
   */
  async function adoptHandStartedThreads(rows: readonly IssueRow[]): Promise<boolean> {
    const { adoptHandStartedThreads: enabled, statusOnStart } = await settings.get();
    if (enabled !== "on" || rows.length === 0) return false;

    const entries = await links.entries(rows);
    const candidates = rows.flatMap((row, index) => {
      const entry = entries[index];
      return entry ? unclaimedPromptThreadIds(entry, bb.pluginId).map((threadId) => ({ row, threadId })) : [];
    });
    if (candidates.length === 0) return false;

    const threads = await everyThread();
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    // Every title currently in the sidebar, so a rename cannot manufacture a
    // duplicate. Mutated as titles are assigned, so two adoptions in one pass
    // cannot collide with each other either.
    const titlesInUse = new Set(threads.map((thread) => thread.title));
    let adopted = 0;

    for (const { row, threadId } of candidates) {
      const thread = byId.get(threadId);
      // Not listed means archived or gone; not adoptable means a thread some
      // plugin started, which is that plugin's business.
      if (!thread || !isAdoptable(thread)) continue;

      // Linked either way, because an issue may have several threads. The
      // board move is guarded by its own record, so a second thread on one
      // issue does not move it twice.
      await links.link(row.repo, row.number, thread.id, "adopted");
      await autoSetStatus(row, statusOnStart);
      adopted += 1;

      const canonical = threadTitle(row.number, row.title);
      // Unlike pr-sweep there is no scope to fall back on: an issue carries no
      // flag saying what a particular thread is for. So when the canonical
      // title is already in the sidebar, the thread keeps its own. bb derived
      // that title from this thread's prompt, which makes it a description of
      // this thread's scope — the very thing the canonical title cannot
      // express twice.
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

    return adopted > 0;
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
        (await everyThread()).map((thread) => [thread.id, thread.originPluginId]),
      );
      for (const link of legacy) {
        const how = origins.get(link.threadId) === bb.pluginId ? "spawned" : "adopted";
        await legacyLinks.link(link.repo, link.number, link.threadId, how);
      }
      bb.log.info(`moved ${legacy.length} thread link(s) into gh-context`);
    }
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
   * Promotes every issue whose closing pull request is open.
   *
   * Driven from the sweep rather than from an event because nothing tells this
   * plugin that a pull request was opened — the "Fixes #n" link is a fact about
   * the issue, discovered by asking.
   */
  async function promoteIssuesInReview(rows: readonly IssueRow[]): Promise<boolean> {
    const { statusOnPullRequest } = await settings.get();
    if (statusOnPullRequest.trim() === "") return false;

    let moved = false;
    for (const row of rows) {
      if (row.closingPr === null) continue;
      if (await autoSetStatus(row, statusOnPullRequest)) moved = true;
    }
    return moved;
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

    async listRows() {
      const meta = store.readMeta();
      const { boardStages, staleAfterDays, statusOnPullRequest, projectBoard, countedStatuses } =
        await settings.get();
      const rows = store.readRows();
      const notes = store.notes();
      const holds = store.holds();
      const seen = store.seenCounts();
      const moves = store.moves();

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
        // The board's columns are the user's, so the track's order is a
        // setting rather than something the panel invents.
        boardStages: parseStatusOrder(boardStages),
        staleAfterDays: parseStaleAfterDays(staleAfterDays),
        reviewStatus: statusOnPullRequest.trim(),
        countedStatuses: parseStatusOrder(countedStatuses),
        rows: rows.map((row) => {
          const key = `${row.repo}#${row.number}`;
          // No record yet reads as nothing new: the sweep records the count on
          // first sight, and until it has, every comment is one already there.
          // Floored at zero, since deleted comments can drop the count.
          const seenCount = seen.get(key);
          return {
            ...row,
            board: row.board ?? null,
            // Offered options come from the row's board, not from boardStages:
            // that setting is a display preference and can name a column the
            // board does not have, and the picker must only offer what
            // `item-edit` will accept.
            statusOptions: statusOptionsFor(row, projectBoard),
            parent: row.parent ?? null,
            note: notes.get(key) ?? null,
            onHold: holds.has(key),
            newComments: seenCount === undefined ? 0 : Math.max(0, row.commentsCount - seenCount),
            movedAt: moves.get(key) ?? null,
            canSpawn: threadMap !== null && spawnable.has(row.repo),
            threadId: threadMap?.get(key)?.[0] ?? null,
          };
        }),
        sweptAt: meta.sweptAt,
        usage: syncUsage.snapshot(),
        skippedRepos: meta.skippedRepos,
        truncated: meta.truncated,
        lastError: threadMap === null ? GH_CONTEXT_REQUIRED : meta.lastError,
      };
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

    async startThreadDraft({ repo, number }) {
      const existingThreadId = await links.threadFor(repo, number);
      if (existingThreadId) return { existingThreadId, reason: null, seed: null };

      const row = store.readRows().find((entry) => entry.repo === repo && entry.number === number);
      if (!row) {
        return {
          existingThreadId: null,
          reason: `#${number} is no longer in the sweep.`,
          seed: null,
        };
      }

      const target = matchProjectTargetForRepo(repo, await projectCandidates());
      if (!target) {
        return {
          existingThreadId: null,
          reason: `No bb project is checked out for ${repo}.`,
          seed: null,
        };
      }

      const { providerId, model, permissionMode } = await settings.get();
      const chosenModel = model.trim();

      return {
        existingThreadId: null,
        reason: null,
        seed: {
          projectId: target.id,
          providerId: providerId || null,
          model: chosenModel || null,
          permissionMode: parsePermissionMode(permissionMode),
          prompt: buildPromptParts(row).body,
          preview: {
            title: row.title,
            number: row.number,
            url: row.url,
            meta: [row.repo, row.boardStatus].filter(Boolean).join(" · "),
          },
          // A new worktree by default. An issue names work that has not
          // started, so there is no branch to land on and nothing to be gained
          // from sharing the main checkout with whatever else is going on
          // there. The composer still offers Work locally and Existing
          // worktree for the times that is not what you want.
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
    },

    async startThreadSubmit({ repo, number, request }) {
      const key = `${repo}#${number}`;

      const inFlight = spawning.get(key);
      if (inFlight) return inFlight;

      const attempt = (async () => {
        const row = store.readRows().find((entry) => entry.repo === repo && entry.number === number);
        // Starting or reopening the thread is reading the issue, so its new
        // comments are no longer new.
        const markSeen = () => {
          if (row) store.markSeen(repo, number, row.commentsCount, Date.now());
        };

        const existingThreadId = await links.threadFor(repo, number);
        if (existingThreadId) {
          markSeen();
          return { threadId: existingThreadId, existing: true, reason: null };
        }

        if (!row) {
          return { threadId: null, existing: false, reason: `#${number} is no longer in the sweep.` };
        }

        // Everything the composer resolved — project, environment, provider,
        // model, reasoning, permission mode, execution provenance — is
        // forwarded untouched. Only the title is the plugin's business: the
        // composer has no field for one, and the sidebar should name the issue.
        // The composer only ever held the middle of the prompt, so the two
        // ends are put back here. Its own items sit between them untouched,
        // which is what keeps any @-mention or attachment that was added.
        const parts = buildPromptParts(row);
        const thread = await bb.sdk.threads.spawn({
          ...request,
          input: [
            { type: "text", text: headerItem(parts), mentions: [] },
            ...request.input,
            { type: "text", text: trailerItem(parts), mentions: [] },
          ],
          title: threadTitle(number, row.title),
        } as Parameters<typeof bb.sdk.threads.spawn>[0]);

        bb.log.info(`started ${thread.id} for ${key} in ${request.projectId}`);
        await links.link(repo, number, thread.id, "spawned");
        markSeen();

        // Starting work is the one moment the plugin knows more than the board
        // does, so it says so. After the spawn deliberately: a board that
        // cannot be reached must not stop a thread from being created.
        const { statusOnStart } = await settings.get();
        await autoSetStatus(row, statusOnStart);

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

    setNote({ repo, number, body, onHold }) {
      store.setNote(repo, number, body, Date.now(), onHold ?? false);
      return { ok: true };
    },

    async listComments({ repo, number }) {
      const { ghPath } = await settings.get();
      try {
        return { ...(await fetchComments(createGhRunner(ghPath), repo, number)), error: null };
      } catch (error) {
        bb.log.warn(`could not read the comments on ${repo}#${number}: ${String(error)}`);
        return { entries: [], total: 0, error: "Could not read the comments from GitHub." };
      }
    },

    markSeen({ repo, number }) {
      const row = store.readRows().find((entry) => entry.repo === repo && entry.number === number);
      if (!row) return { ok: false };
      store.markSeen(repo, number, row.commentsCount, Date.now());
      return { ok: true };
    },

    async setBoardStatus({ repo, number, status }) {
      const row = store.readRows().find((entry) => entry.repo === repo && entry.number === number);
      if (!row) return { ok: false, added: false, error: `#${number} is not in this listing.` };

      try {
        const { ghPath } = await settings.get();
        const project = await boardOf(row);
        const option = project.statusOptions.find(
          (candidate) => candidate.name.toLowerCase() === status.trim().toLowerCase(),
        );
        if (!option) {
          return { ok: false, added: false, error: `${project.title} has no "${status}" status.` };
        }

        const { added } = await applyBoardStatus(createGhRunner(ghPath), {
          project,
          repo,
          number,
          url: row.url,
          option,
        });

        store.recordMove(repo, number, Date.now());

        // Shown first, reconciled second. The board is the source of truth and
        // a status change can trip its own automations, so the sweep still
        // runs and still wins — but it is a full gh round trip, and making the
        // panel sit on the old status for its duration reads as a failed
        // click.
        if (store.setRowStatus(repo, number, option.name)) {
          bb.realtime.publish(REALTIME_CHANNEL, { sweptAt: null });
        }
        await sweepNow();
        bb.log.info(`${repo}#${number} -> ${option.name}${added ? " (added)" : ""}`);
        return { ok: true, added, error: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        bb.log.warn(`could not set ${repo}#${number} to ${status}: ${message}`);
        return { ok: false, added: false, error: message };
      }
    },

    async refresh() {
      return sweepNow();
    },
  });

  // A thread the user archived or deleted should not keep its issue pinned to
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
