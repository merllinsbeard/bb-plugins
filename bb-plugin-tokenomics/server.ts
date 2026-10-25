// bb-plugin-tokenomics — how many tokens each thread uses, and when.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { CONTEXT_CHANNEL, LIMITS_CHANNEL, MAX_ROWS, MAX_WINDOW_MS, rpcContract, USAGE_CHANNEL } from "./usage/contract.js";
import { limitViews, samplesFromUsage, sizeOf, SLOT_MS, windowKey } from "./usage/limits.js";
import {
  formatCommands,
  formatThreads,
  slowestCommands,
  sortReports,
  turnTimeSummary,
  type SortKey,
  type ThreadReport,
} from "./usage/report.js";
import { readTranscripts, subagentsDir } from "./usage/subagent-files.js";
import { TIMING_EVENTS, timeBreakdown, turnSplits } from "./usage/timing.js";
import { CONTEXT_EVENT, contextRowOf, countLevels, parseThreshold, type ContextThresholds } from "./usage/context.js";
import { createStore, MIGRATIONS } from "./usage/store.js";
import { createSync, TOKEN_USAGE_EVENT, type EventSource } from "./usage/sync.js";
import { attributeUsage, promptsByTurn } from "./usage/turns.js";

export { rpcContract } from "./usage/contract.js";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = createStore(db);
  const recordingSince = store.startedAt(Date.now());
  const settings = bb.settings.define({
    contextWarningAt: {
      type: "string",
      label: "Warn when a thread's context passes (tokens)",
      // Every model call re-reads the whole context, so past this a turn
      // costs tens of millions of tokens. Claude Code's own auto-compact on a
      // 1M-token model waits until about 967K. Empty turns the warning off.
      default: "300K",
    },
    contextErrorAt: {
      type: "string",
      label: "Mark a thread's context as too large past (tokens)",
      // Past this the meter and the page row turn from amber to red. Empty
      // leaves only the warning.
      default: "550K",
    },
  });

  const source: EventSource = {
    async listUsage({ threadId, afterSeq, limit }) {
      return bb.sdk.threads.events.list({
        threadId,
        types: [TOKEN_USAGE_EVENT, CONTEXT_EVENT, ...TIMING_EVENTS],
        order: "asc",
        limit: String(limit),
        ...(afterSeq === null ? {} : { afterSeq: String(afterSeq) }),
      });
    },
    async listTurnEvents({ threadId, type, afterSeq, limit }) {
      return bb.sdk.threads.events.list({
        threadId,
        types: [type],
        order: "asc",
        limit: String(limit),
        ...(afterSeq === null ? {} : { afterSeq: String(afterSeq) }),
      });
    },
    async outline(threadId) {
      return (await bb.sdk.threads.conversationOutline({ threadId })).items;
    },
    async listThreads({ archived, offset, limit }) {
      return bb.sdk.threads.list({ archived, includeHidden: true, offset, limit });
    },
  };
  const warn = (threadId: string, error: unknown) =>
    bb.log.warn(`reading usage for ${threadId} failed: ${messageOf(error)}`);
  // Open pages re-read on this. The backfill announces once at the end rather
  // than once per thread.
  let backfilling = false;
  const sync = createSync(store, source, {
    onAdded: (threadId) => {
      if (!backfilling) bb.realtime.publish(USAGE_CHANNEL, { threadIds: [threadId] });
      // A turn ended, so its subagents have written their calls.
      scanSubagents(threadId)
        .then((calls) => {
          if (calls > 0 && !backfilling) bb.realtime.publish(USAGE_CHANNEL, { threadIds: [threadId] });
        })
        .catch((error: unknown) => warn(threadId, error));
    },
    onContext: (threadId) => bb.realtime.publish(CONTEXT_CHANNEL, { threadIds: [threadId] }),
    onError: warn,
  });

  /**
   * Reads the thread's Claude Code subagent transcripts past where it last
   * stopped. bb does not report subagents' usage, so this is the only record
   * of it. Returns the calls read.
   */
  async function scanSubagents(threadId: string): Promise<number> {
    let sessionId = store.sessionId(threadId);
    if (sessionId === null) {
      const [event] = await bb.sdk.threads.events.list({
        threadId,
        types: [TOKEN_USAGE_EVENT, CONTEXT_EVENT],
        order: "desc",
        limit: "1",
      });
      const found = (event?.data as { providerThreadId?: unknown } | undefined)?.providerThreadId;
      if (typeof found !== "string") return 0;
      sessionId = found;
      store.setSessionId(threadId, sessionId);
    }
    const dir = await subagentsDir(sessionId);
    if (dir === null) return 0;
    const reads = await readTranscripts(dir, store.subagentOffsets(threadId));
    const wroteAt = Math.max(0, ...reads.flatMap((read) => read.calls.map((call) => call.createdAt)));
    if (wroteAt > (liveSubagents.get(threadId) ?? 0)) liveSubagents.set(threadId, wroteAt);
    return store.recordSubagents(threadId, reads);
  }

  // Background subagents keep writing after their parent's turn ends, and
  // the parent records no usage while it waits on them, so nothing above
  // reads them again. Threads whose subagents wrote recently are read again
  // on a timer: a directory listing and one stat per transcript, no request
  // to bb. A thread drops off once its subagents stop writing.
  const SUBAGENTS_EVERY_MS = 15_000;
  const SUBAGENTS_QUIET_MS = 10 * 60_000;
  const liveSubagents = new Map<string, number>();
  bb.background.service("subagents", {
    async start(signal) {
      while (!signal.aborted) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, SUBAGENTS_EVERY_MS);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        const changed: string[] = [];
        for (const [threadId, wroteAt] of liveSubagents) {
          if (signal.aborted) break;
          if (Date.now() - wroteAt > SUBAGENTS_QUIET_MS) {
            liveSubagents.delete(threadId);
            continue;
          }
          try {
            if ((await scanSubagents(threadId)) > 0) changed.push(threadId);
          } catch (error) {
            warn(threadId, error);
          }
        }
        if (changed.length > 0) bb.realtime.publish(USAGE_CHANNEL, { threadIds: changed });
      }
    },
  });

  /**
   * The thread's latest context size. A thread read before the plugin
   * recorded context has its older events behind the cursor, so the first
   * ask reads bb's latest one directly.
   */
  async function latestContext(threadId: string) {
    const recorded = store.latestContext(threadId);
    if (recorded !== null) return recorded;
    const [event] = await bb.sdk.threads.events.list({
      threadId,
      types: [CONTEXT_EVENT],
      order: "desc",
      limit: "1",
    });
    const row = event === undefined ? null : contextRowOf(event);
    if (row !== null) store.recordContext(threadId, [row]);
    return row;
  }

  // Archiving writes no thread events, so these keep the page's Active and
  // Archived lists right without waiting for the next load's backfill.
  const markArchived = (threadId: string, at: number | null) => {
    store.setArchived(threadId, at);
    bb.realtime.publish(USAGE_CHANNEL, { threadIds: [threadId] });
  };
  bb.events.on("thread.archived", ({ thread }) => markArchived(thread.id, thread.archivedAt ?? Date.now()));
  bb.events.on("thread.unarchived", ({ thread }) => markArchived(thread.id, null));
  bb.events.on("thread.deleted", ({ thread }) => markArchived(thread.id, thread.deletedAt ?? Date.now()));

  bb.events.on("experimental_thread.events", ({ thread }) => {
    sync.syncThread(thread).catch((error: unknown) => warn(thread.id, error));
  });

  // Catches up on every thread once per load: usage bb still holds from before
  // the plugin was installed, and turns that ran while it was not loaded.
  bb.background.service("backfill", {
    async start(signal) {
      backfilling = true;
      try {
        const changed = await sync.syncAll(signal);
        bb.log.info(`backfill found new usage in ${changed.length} threads`);
        // Threads read before the plugin recorded context have their context
        // events behind the cursor. One request each, once, for the latest.
        const missing = store.activeWithoutContext();
        let found = 0;
        for (const threadId of missing) {
          if (signal.aborted) break;
          try {
            if ((await latestContext(threadId)) !== null) found += 1;
          } catch (error) {
            warn(threadId, error);
          }
        }
        if (missing.length > 0) bb.log.info(`backfill read the latest context of ${missing.length} threads, ${found} had one`);
        // Every Claude Code thread's subagents, including ones that finished
        // after their turn's usage was recorded. The first load looks up each
        // thread's session id once, one request per thread; later loads only
        // read transcripts that grew.
        let subagentCalls = 0;
        for (const threadId of store.claudeCodeThreads()) {
          if (signal.aborted) break;
          const thread = { threadId };
          try {
            subagentCalls += await scanSubagents(thread.threadId);
          } catch (error) {
            warn(thread.threadId, error);
          }
        }
        if (subagentCalls > 0) bb.log.info(`backfill read ${subagentCalls} subagent calls`);
        if (changed.length > 0 || found > 0 || subagentCalls > 0) bb.realtime.publish(USAGE_CHANNEL, { threadIds: changed });
      } finally {
        backfilling = false;
      }
    },
  });

  // Every five minutes, one reading of each provider's usage limits: one
  // request to bb, which asks each provider that reports usage. The pace the
  // page shows comes from these readings, so they run whether or not the page
  // is open.
  const LIMITS_EVERY_MS = 5 * 60_000;
  // A reading older than three polls means the provider stopped reporting.
  const LIMITS_STALE_MS = 3 * LIMITS_EVERY_MS;
  let limitsPolledAt: number | null = null;
  let limitsError: string | null = null;
  async function pollLimits(): Promise<void> {
    const now = Date.now();
    try {
      store.recordLimitSamples(samplesFromUsage(await bb.sdk.system.usageLimits(), now));
      store.pruneLimitSamples(now - MAX_WINDOW_MS);
      limitsPolledAt = now;
      limitsError = null;
    } catch (error) {
      limitsError = messageOf(error);
      bb.log.warn(`reading usage limits failed: ${limitsError}`);
    }
    bb.realtime.publish(LIMITS_CHANNEL, {});
  }
  bb.background.service("limits", {
    async start(signal) {
      while (!signal.aborted) {
        await pollLimits();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, LIMITS_EVERY_MS);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
  });

  async function contextThresholds(): Promise<ContextThresholds> {
    const { contextWarningAt, contextErrorAt } = await settings.get();
    return { warning: parseThreshold(contextWarningAt), error: parseThreshold(contextErrorAt) };
  }

  async function projectNames(): Promise<Map<string, string>> {
    try {
      const projects = await bb.sdk.projects.list();
      return new Map(projects.map((project) => [project.id, project.name]));
    } catch (error) {
      bb.log.warn(`listing projects failed: ${messageOf(error)}`);
      return new Map();
    }
  }

  /** One report per thread that used tokens since `since`. */
  async function threadReports(since: number): Promise<ThreadReport[]> {
    const names = await projectNames();
    const subagents = store.subagentsSince(since);
    const peaks = store.peakContextsSince(since);
    const latest = store.latestContexts();
    const turnTimes = store.turnTimesSince(since);
    const waits = store.waitingSince(since);
    const commandsByThread = new Map<string, Array<{ label: string; ms: number }>>();
    for (const run of store.commandsSince(since)) {
      commandsByThread.set(run.threadId, [...(commandsByThread.get(run.threadId) ?? []), run]);
    }
    return store.threadsSince(since).map((thread) => ({
      threadId: thread.threadId,
      title: thread.title,
      project: names.get(thread.projectId) ?? null,
      provider: thread.providerId,
      archived: thread.archivedAt !== null,
      turns: thread.turns,
      tokens: {
        input: thread.input,
        cacheRead: thread.cacheRead,
        output: thread.output,
        total: thread.input + thread.cacheRead + thread.output,
      },
      subagents: subagents.get(thread.threadId) ?? { count: 0, tokens: 0 },
      context: { peak: peaks.get(thread.threadId) ?? null, latest: latest.get(thread.threadId) ?? null },
      turnTime: turnTimeSummary((turnTimes.get(thread.threadId) ?? []).map((turn) => turn.ms)),
      waitingOnYou: waits.get(thread.threadId) ?? { count: 0, ms: 0 },
      slowestCommands: slowestCommands(commandsByThread.get(thread.threadId) ?? [], 3),
    }));
  }

  const CLI_USAGE = [
    "bb tokenomics threads [--days N] [--sort tokens|time|context] [--limit N] [--active] [--json]",
    "  One entry per thread that used tokens in the past N days (default 7, at most 30): tokens",
    "  (Claude Code subagents included), turns, peak and latest context, turn times, time spent",
    "  waiting on your answers, and its slowest shell commands. Context sizes, turn times, and",
    "  command times go back only to when Tokenomics began recording them.",
    "bb tokenomics commands [--days N] [--limit N] [--json]",
    "  The shell commands that took the most time across all threads.",
  ].join("\n");

  function flag(argv: string[], name: string): string | undefined {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  }

  bb.cli.register({
    name: "tokenomics",
    summary: "Report token use, context size, and turn times per thread",
    commands: [
      {
        name: "threads",
        summary: "One entry per thread: tokens, context, turn times, slowest commands",
        usage: "bb tokenomics threads [--days N] [--sort tokens|time|context] [--limit N] [--active] [--json]",
      },
      {
        name: "commands",
        summary: "The shell commands that took the most time",
        usage: "bb tokenomics commands [--days N] [--limit N] [--json]",
      },
    ],
    async run(argv) {
      const [command] = argv.filter((arg, index) => !arg.startsWith("--") && !argv[index - 1]?.startsWith("--"));
      if (command === undefined || command === "help") return { exitCode: 0, stdout: CLI_USAGE };
      const json = argv.includes("--json");
      const days = Number(flag(argv, "--days") ?? 7);
      if (!Number.isFinite(days) || days <= 0 || days > 30) {
        return { exitCode: 1, stderr: "--days takes a number from 1 to 30." };
      }
      const since = Date.now() - days * 86_400_000;
      if (command === "threads") {
        const sort = (flag(argv, "--sort") ?? "tokens") as SortKey;
        if (!["tokens", "time", "context"].includes(sort)) {
          return { exitCode: 1, stderr: "--sort takes tokens, time, or context." };
        }
        const limit = Number(flag(argv, "--limit") ?? 20);
        let reports = sortReports(await threadReports(since), sort);
        if (argv.includes("--active")) reports = reports.filter((report) => !report.archived);
        reports = reports.slice(0, Math.max(1, limit));
        return { exitCode: 0, stdout: json ? JSON.stringify(reports, null, 2) : formatThreads(reports, days) };
      }
      if (command === "commands") {
        const limit = Number(flag(argv, "--limit") ?? 15);
        const commands = slowestCommands(store.commandsSince(since), Math.max(1, limit));
        return { exitCode: 0, stdout: json ? JSON.stringify(commands, null, 2) : formatCommands(commands, days) };
      }
      return { exitCode: 1, stderr: `Unknown command "${command}".\n\n${CLI_USAGE}` };
    },
  });

  /** Commands the page lists under Shell commands. */
  const TOP_COMMANDS = 3;

  bb.rpc.register(rpcContract, {
    usage_limits: () => {
      const now = Date.now();
      // A weekly pace reads the past day and its baseline the day before;
      // a size can read last week's window.
      const samples = store.limitSamplesSince(now - MAX_WINDOW_MS);
      const lastHour = store.providerTokens(now - 3_600_000, now);
      // A subscription bb reports but no thread used this week, such as one
      // signed in once, shows only when it's close to a limit.
      const thisWeek = store.providerTokens(now - 7 * 86_400_000, now);
      return {
        limits: limitViews(samples, now, LIMITS_STALE_MS)
          .filter((view) => thisWeek.has(view.providerId) || view.tone !== "ok")
          .map((view) => {
            // A query for each of up to ten past windows and the current one.
            const sizeTokens = sizeOf(
              samples.filter((sample) => windowKey(sample) === windowKey(view)).sort((a, b) => a.sampledAt - b.sampledAt),
              (from, to) => store.providerTokens(from, to).get(view.providerId) ?? 0,
            );
            return {
              ...view,
              lastHourTokens: lastHour.get(view.providerId) ?? 0,
              ...(sizeTokens === undefined ? {} : { sizeTokens }),
              // A session lasts five hours and resets on the hour's minute it began.
              ...(view.kind === "five-hour"
                ? { slots: store.providerSlots(view.providerId, view.resetsAt - 5 * 3_600_000, now, SLOT_MS) }
                : {}),
            };
          }),
        polledAt: limitsPolledAt,
        error: limitsError,
      };
    },
    usage_hours: ({ since }) => ({ hours: store.hoursSince(Math.max(since, Date.now() - MAX_WINDOW_MS)) }),
    usage_window: async ({ since }) => {
      const floor = Math.max(since, Date.now() - MAX_WINDOW_MS);
      const [names, thresholds] = await Promise.all([projectNames(), contextThresholds()]);
      const contexts = store.latestContexts();
      const turnTimes = store.turnTimesSince(floor);
      const hoursByThread = new Map<string, Array<{ hour: number; total: number }>>();
      for (const { threadId, hour, total } of store.threadHoursSince(floor)) {
        const hours = hoursByThread.get(threadId) ?? [];
        hours.push({ hour, total });
        hoursByThread.set(threadId, hours);
      }
      return {
        hours: store.hoursSince(floor),
        threads: store.threadsSince(floor).map((thread) => ({
          ...thread,
          projectName: names.get(thread.projectId) ?? null,
          context: contexts.get(thread.threadId) ?? null,
          turnTimes: turnTimes.get(thread.threadId) ?? [],
          hours: hoursByThread.get(thread.threadId) ?? [],
          // One local query per listed thread, the same total its header shows.
          lifetime: store.threadTotal(thread.threadId).total,
        })),
        recordingSince,
        contextThresholds: thresholds,
        turnTime: {
          ...timeBreakdown(store.timingsSince(floor)),
          commands: slowestCommands(store.commandsSince(floor), TOP_COMMANDS),
        },
      };
    },
    thread_usage: ({ threadId }) => {
      const { tokens, total, turns, subagents } = store.threadTotal(threadId);
      return { ...tokens, total, turns, subagents, recent: store.threadRows(threadId, MAX_ROWS) };
    },
    thread_context: async ({ threadId }) => {
      const [context, thresholds] = await Promise.all([latestContext(threadId), contextThresholds()]);
      const [last] = store.threadRows(threadId, 1);
      return {
        context:
          context === null
            ? null
            : {
                usedTokens: context.usedTokens,
                contextWindow: context.contextWindow,
                autoCompactAt: context.autoCompactAt,
                at: context.createdAt,
              },
        lastTurn: last === undefined ? null : last.input + last.cacheRead + last.output,
        thresholds,
        archived: store.isArchived(threadId),
      };
    },
    context_levels: async () => countLevels(store.activeLatestContexts(), await contextThresholds()),
    compact_thread: async ({ threadId }) => {
      await bb.sdk.threads.compact({ threadId });
      return { ok: true as const };
    },
    thread_turns: async ({ threadId }) => {
      const { started, completed, outline } = await sync.turnContext(threadId);
      const rows = store.threadRows(threadId, MAX_ROWS);
      const splits = turnSplits(store.threadTimings(threadId));
      const turns = attributeUsage(rows, started, completed, promptsByTurn(outline));
      return { turns: turns.map((turn) => ({ ...turn, time: turn.turnId === null ? null : (splits.get(turn.turnId) ?? null) })) };
    },
  });
}
