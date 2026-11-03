// Copies token usage from bb's thread events into the ledger, and reads the
// turns that usage belongs to. The only module that talks to bb; the store and
// the arithmetic stay pure.
import { splitBreakdown, type ProviderTokenBreakdown } from "./breakdown.js";
import { contextRowOf, type ContextRow } from "./context.js";
import { isEmpty, timingRowsOf } from "./timing.js";
import type { Store, ThreadInfo, UsageRow } from "./store.js";
import type { OutlineItem, TurnEvent } from "./turns.js";

export const TOKEN_USAGE_EVENT = "thread/tokenUsage/updated";

/** bb's limit for one page of events or threads. */
const PAGE_SIZE = 100;

/** The fields of bb's thread DTOs this module reads. */
export interface ThreadLike {
  id: string;
  title: string | null;
  titleFallback?: string | null;
  projectId: string;
  providerId: string;
  archivedAt?: number | null;
  deletedAt?: number | null;
}

/** The fields of a token usage event row this module reads. */
export interface UsageEventLike {
  id: string;
  seq: number;
  createdAt: number;
  type: string;
  scope?: { kind: string; turnId?: string } | null;
  data: unknown;
}

export type TurnEventType = "turn/started" | "turn/completed";

export interface EventSource {
  /** The thread's token usage, context window, and timing events after `afterSeq`, oldest first. */
  listUsage(args: { threadId: string; afterSeq: number | null; limit: number }): Promise<UsageEventLike[]>;
  listTurnEvents?(args: {
    threadId: string;
    type: TurnEventType;
    afterSeq: number | null;
    limit: number;
  }): Promise<Array<{ seq: number; createdAt: number; scope: { kind: string; turnId?: string } }>>;
  outline?(threadId: string): Promise<OutlineItem[]>;
  listThreads(args: { archived: boolean; offset: number; limit: number }): Promise<ThreadLike[]>;
}

interface UsagePayload {
  tokenUsage?: { total?: ProviderTokenBreakdown; last?: ProviderTokenBreakdown };
}

/** The ledger row for one event, or null when the event carries no usage. */
export function usageRowOf(event: UsageEventLike): UsageRow | null {
  if (event.type !== TOKEN_USAGE_EVENT) return null;
  const usage = (event.data as UsagePayload | null)?.tokenUsage;
  if (usage?.last === undefined) return null;
  const tokens = splitBreakdown(usage.last);
  return {
    eventId: event.id,
    createdAt: event.createdAt,
    tokens,
    runningTotal: Math.max(0, usage.total?.totalTokens ?? 0),
  };
}

export function threadInfoOf(thread: ThreadLike): ThreadInfo {
  return {
    threadId: thread.id,
    title: thread.title ?? thread.titleFallback ?? null,
    projectId: thread.projectId,
    providerId: thread.providerId,
    archivedAt: thread.deletedAt ?? thread.archivedAt ?? null,
  };
}

async function* eventPages<T extends { seq: number }>(
  read: (afterSeq: number | null, limit: number) => Promise<T[]>,
  afterSeq: number | null = null,
): AsyncGenerator<T[]> {
  let limit = PAGE_SIZE;
  for (;;) {
    let events: T[];
    try {
      events = await read(afterSeq, limit);
    } catch (error) {
      if (limit === 1 || typeof error !== "object" || error === null || !("status" in error) || error.status !== 413) throw error;
      limit = Math.max(1, Math.floor(limit / 2));
      continue;
    }
    yield events;
    if (events.length < limit) return;
    afterSeq = events.at(-1)!.seq;
    limit = Math.min(PAGE_SIZE, limit * 2);
  }
}

export interface SyncHooks {
  /** Called after rows are added for a thread, however the read started. */
  onAdded?: (threadId: string) => void;
  /** Called after context rows are added for a thread. */
  onContext?: (threadId: string) => void;
  onError?: (threadId: string, error: unknown) => void;
}

export function createSync(store: Store, source: EventSource, hooks: SyncHooks = {}) {
  // One read per thread at a time; a request that arrives mid-read runs once
  // more afterwards, so an event that landed during the read is not missed.
  const running = new Map<string, Promise<number>>();
  const again = new Map<string, ThreadLike>();

  async function read(thread: ThreadLike): Promise<number> {
    const info = threadInfoOf(thread);
    let cursor = store.cursor(thread.id);
    let added = 0;
    let contextAdded = 0;
    for await (const events of eventPages(
      (afterSeq, limit) => source.listUsage({ threadId: thread.id, afterSeq, limit }),
      cursor,
    )) {
      const rows = events.map(usageRowOf).filter((row): row is UsageRow => row !== null);
      const contextRows = events.map(contextRowOf).filter((row): row is ContextRow => row !== null);
      const lastSeq = events.reduce((seq, event) => Math.max(seq, event.seq), cursor ?? 0);
      // Before the cursor moves, so a failure here reads these events again.
      contextAdded += store.recordContext(thread.id, contextRows);
      const timings = timingRowsOf(events);
      if (!isEmpty(timings)) store.recordTimings(thread.id, timings);
      added += store.record(info, rows, lastSeq);
      cursor = lastSeq;
    }
    if (added > 0) hooks.onAdded?.(thread.id);
    if (contextAdded > 0) hooks.onContext?.(thread.id);
    return added;
  }

  /** Reads the thread's new usage events. Resolves with the rows added. */
  function syncThread(thread: ThreadLike): Promise<number> {
    const current = running.get(thread.id);
    if (current !== undefined) {
      again.set(thread.id, thread);
      return current;
    }
    const run = read(thread).finally(() => {
      running.delete(thread.id);
      const next = again.get(thread.id);
      if (next !== undefined) {
        again.delete(thread.id);
        syncThread(next).catch((error: unknown) => hooks.onError?.(thread.id, error));
      }
    });
    running.set(thread.id, run);
    return run;
  }

  /**
   * Reads every thread, archived ones included, so usage bb still holds from
   * before the plugin was installed reaches the ledger. Returns the ids of
   * threads that gained rows; `onAdded` is called for each of them as well.
   */
  async function syncAll(signal: AbortSignal): Promise<string[]> {
    const changed: string[] = [];
    for (const archived of [false, true]) {
      for (let offset = 0; !signal.aborted; offset += PAGE_SIZE) {
        const threads = await source.listThreads({ archived, offset, limit: PAGE_SIZE });
        for (const thread of threads) {
          if (signal.aborted) return changed;
          if ((await syncThread(thread)) > 0) changed.push(thread.id);
        }
        if (threads.length < PAGE_SIZE) break;
      }
    }
    return changed;
  }

  /** Every start or end of a turn in the thread, oldest first. */
  async function turnEvents(threadId: string, type: TurnEventType): Promise<TurnEvent[]> {
    const listTurnEvents = source.listTurnEvents;
    if (listTurnEvents === undefined) return [];
    const found: TurnEvent[] = [];
    for await (const events of eventPages(
      (afterSeq, limit) => listTurnEvents({ threadId, type, afterSeq, limit }),
    )) {
      for (const event of events) {
        if (event.scope.turnId !== undefined) found.push({ turnId: event.scope.turnId, at: event.createdAt });
      }
    }
    return found;
  }

  /** What `attributeUsage` needs from bb for one thread. */
  async function turnContext(threadId: string) {
    const [started, completed, outline] = await Promise.all([
      turnEvents(threadId, "turn/started"),
      turnEvents(threadId, "turn/completed"),
      source.outline?.(threadId) ?? Promise.resolve([]),
    ]);
    return { started, completed, outline };
  }

  return { syncThread, syncAll, turnContext };
}
