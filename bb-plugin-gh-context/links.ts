import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

/**
 * A sweep's link to gh-context, the one record of which threads are about
 * which GitHub issues and pull requests.
 *
 * Exported as `bb-plugin-gh-context/links`. bb plugins cannot share a
 * database, but they can call each other's RPC, so every link lives in
 * gh-context and this file is only a transport. `callRpc` validates each
 * response against the schema declared here.
 *
 * Unlike Harvest's bridge, reads do not quietly return nothing when gh-context
 * is missing. A sweep without its links offers "Start thread" on work already
 * underway, which looks right and is wrong, so every method throws and the
 * sweep checks `available()` to report that it needs gh-context instead.
 */
const GH_CONTEXT_PLUGIN_ID = "gh-context";

export type ItemKind = "issue" | "pull";

export interface ItemKey {
  repo: string;
  kind: ItemKind;
  number: number;
}

export interface ThreadLinkInput extends ItemKey {
  threadId: string;
  /** `spawned:<plugin id>` for a thread a sweep started, `adopted:<plugin id>` once it adopts one. */
  source: string;
}

export interface ItemThreads extends ItemKey {
  threads: { threadId: string; source: string }[];
}

export interface ThreadLinksBridge {
  available(): Promise<boolean>;
  linkThread(input: ThreadLinkInput): Promise<void>;
  /** Every link for the thread, or only those recorded with one source. */
  unlinkThread(input: { threadId: string; source?: string }): Promise<void>;
  /** In the order asked; an item with no thread comes back with `threads: []`. */
  threadsForItems(items: readonly ItemKey[]): Promise<ItemThreads[]>;
  itemsForThread(threadId: string): Promise<(ItemKey & { source: string })[]>;
}

const itemKind = z.enum(["issue", "pull"]);
const itemThreadsSchema = z.array(
  z.object({
    repo: z.string(),
    kind: itemKind,
    number: z.number(),
    threads: z.array(z.object({ threadId: z.string(), source: z.string() })),
  }),
);
const itemsSchema = z.array(
  z.object({ repo: z.string(), kind: itemKind, number: z.number(), source: z.string() }),
);

/** Only what the bridge uses, so a plugin pinned to another SDK version can pass its own `bb`. */
type BridgeHost = { sdk: { plugins: Pick<BbPluginApi["sdk"]["plugins"], "callRpc"> } };

export function createThreadLinksBridge(bb: BridgeHost): ThreadLinksBridge {
  function call<T>(method: string, outputSchema: z.ZodType<T>, input: unknown): Promise<T> {
    return bb.sdk.plugins.callRpc({
      pluginId: GH_CONTEXT_PLUGIN_ID,
      method,
      outputSchema,
      input: input as never,
    });
  }

  return {
    async available() {
      try {
        await call("threadsForItems", itemThreadsSchema, { items: [] });
        return true;
      } catch {
        return false;
      }
    },
    async linkThread(input) {
      await call("linkThread", z.null(), input);
    },
    async unlinkThread(input) {
      await call("unlinkThread", z.null(), input);
    },
    threadsForItems(items) {
      if (items.length === 0) return Promise.resolve([]);
      return call("threadsForItems", itemThreadsSchema, { items });
    },
    itemsForThread(threadId) {
      return call("itemsForThread", itemsSchema, { threadId });
    },
  };
}

/**
 * A sweep's view of the links, for one kind of item.
 *
 * A thread counts as the sweep's when its link was recorded as
 * `spawned:<id>` (the sweep started it) or `adopted:<id>` (someone started it
 * from the composer and the sweep claimed it). gh-context's own `prompt` links
 * are candidates for adoption, not yet any sweep's business.
 */

export function spawnedSource(pluginId: string): string {
  return `spawned:${pluginId}`;
}

export function adoptedSource(pluginId: string): string {
  return `adopted:${pluginId}`;
}

function isOwn(source: string, pluginId: string): boolean {
  return source === spawnedSource(pluginId) || source === adoptedSource(pluginId);
}

/** A sweep's threads for one item, newest first, each once. */
export function ownThreadIds(entry: ItemThreads, pluginId: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  // gh-context answers oldest first, in the order links were recorded.
  for (const thread of [...entry.threads].reverse()) {
    if (!isOwn(thread.source, pluginId) || seen.has(thread.threadId)) continue;
    seen.add(thread.threadId);
    ids.push(thread.threadId);
  }
  return ids;
}

/** Threads whose first prompt names the item and that the sweep has not claimed. */
export function unclaimedPromptThreadIds(entry: ItemThreads, pluginId: string): string[] {
  const own = new Set(ownThreadIds(entry, pluginId));
  const ids: string[] = [];
  for (const thread of entry.threads) {
    if (thread.source !== "prompt" || own.has(thread.threadId) || ids.includes(thread.threadId)) {
      continue;
    }
    ids.push(thread.threadId);
  }
  return ids;
}

export interface SweepLinks {
  /** Each item's entry, in the order asked. */
  entries(items: readonly { repo: string; number: number }[]): Promise<ItemThreads[]>;
  /** The sweep's threads per item, newest first, keyed `repo#number` as given. */
  threadMap(items: readonly { repo: string; number: number }[]): Promise<Map<string, string[]>>;
  /** The newest of the sweep's threads on the item, the one its row acts on. */
  threadFor(repo: string, number: number): Promise<string | null>;
  link(repo: string, number: number, threadId: string, how: "spawned" | "adopted"): Promise<void>;
  /** Drops the sweep's claim on a thread, leaving gh-context's own links alone. */
  release(threadId: string): Promise<void>;
}

export interface SweepLinksOptions {
  /**
   * Runs before every read and write. A sweep moving links it kept before
   * gh-context existed uses this to finish the move before anything reads the
   * links, so a row never offers "Start thread" on a thread still in the old
   * table, and an old thread is never recorded after a newer one.
   */
  before?: () => Promise<void>;
  /** Waits between attempts to record a link. Tests pass zero. */
  retryDelayMs?: number;
}

/** A spawned thread with no link would be spawned again on the next click. */
const LINK_ATTEMPTS = 3;

export function createSweepLinks(
  bridge: ThreadLinksBridge,
  pluginId: string,
  kind: ItemKind,
  options: SweepLinksOptions = {},
): SweepLinks {
  const before = options.before ?? (async () => {});
  const retryDelayMs = options.retryDelayMs ?? 500;

  async function entries(items: readonly { repo: string; number: number }[]) {
    await before();
    return bridge.threadsForItems(items.map((item) => ({ repo: item.repo, kind, number: item.number })));
  }

  return {
    entries,
    async threadMap(items) {
      const found = await entries(items);
      const map = new Map<string, string[]>();
      items.forEach((item, index) => {
        const entry = found[index];
        map.set(`${item.repo}#${item.number}`, entry ? ownThreadIds(entry, pluginId) : []);
      });
      return map;
    },
    async threadFor(repo, number) {
      const [entry] = await entries([{ repo, number }]);
      return entry ? (ownThreadIds(entry, pluginId)[0] ?? null) : null;
    },
    async link(repo, number, threadId, how) {
      await before();
      const input = {
        threadId,
        repo,
        kind,
        number,
        source: how === "spawned" ? spawnedSource(pluginId) : adoptedSource(pluginId),
      };
      for (let attempt = 1; ; attempt += 1) {
        try {
          await bridge.linkThread(input);
          return;
        } catch (error) {
          if (attempt >= LINK_ATTEMPTS) throw error;
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      }
    },
    async release(threadId) {
      await before();
      await bridge.unlinkThread({ threadId, source: spawnedSource(pluginId) });
      await bridge.unlinkThread({ threadId, source: adoptedSource(pluginId) });
    },
  };
}
