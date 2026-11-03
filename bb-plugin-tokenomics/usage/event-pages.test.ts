import Database from "better-sqlite3";
import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { createStore, MIGRATIONS } from "./store.js";
import { createSync, TOKEN_USAGE_EVENT, type EventSource, type UsageEventLike } from "./sync.js";

const thread = { id: "thr_widgets", title: "CSV export", projectId: "prj_acme", providerId: "codex" };
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(events: UsageEventLike[], status = 200) {
  const db = new Database(":memory:");
  cleanup.push(() => { db.close(); });
  for (const statement of MIGRATIONS) db.exec(statement);
  db.exec("CREATE TABLE source_events (seq INTEGER PRIMARY KEY, type TEXT, event TEXT)");
  const insert = db.prepare("INSERT INTO source_events VALUES (?, ?, ?)");
  for (const event of events) insert.run(event.seq, event.type, JSON.stringify(event));
  const requests: Array<{ afterSeq: number; limit: number; status: number }> = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    const afterSeq = Number(url.searchParams.get("afterSeq") ?? 0);
    const limit = Number(url.searchParams.get("limit"));
    const type = url.searchParams.get("type");
    const rows = db.prepare("SELECT event FROM source_events WHERE seq > ? AND (? IS NULL OR type = ?) ORDER BY seq LIMIT ?").all(afterSeq, type, type, limit) as Array<{ event: string }>;
    const body = `[${rows.map((row) => row.event).join(",")}]`;
    const responseStatus = status !== 200 ? status : Buffer.byteLength(body) > 8 * 1024 * 1024 ? 413 : 200;
    requests.push({ afterSeq, limit, status: responseStatus });
    response.writeHead(responseStatus, { "content-type": "application/json" });
    response.end(responseStatus === 200 ? body : JSON.stringify({ code: "event_data_too_large" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP address");
  const port = address.port;
  async function list({ afterSeq, limit, type }: { afterSeq: number | null; limit: number; type?: string }): Promise<UsageEventLike[]> {
    const query = new URLSearchParams({ afterSeq: String(afterSeq ?? 0), limit: String(limit) });
    if (type) query.set("type", type);
    const response = await fetch(`http://127.0.0.1:${port}/events?${query}`);
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    return response.json();
  }
  const source: EventSource = {
    listUsage: list,
    listTurnEvents: async (args) => (await list(args)).map((event) => ({ seq: event.seq, createdAt: event.createdAt, scope: { kind: "turn", turnId: "turn_widgets" } })),
    listThreads: async () => [],
  };
  const store = createStore(db);
  return { requests, store, sync: createSync(store, source) };
}

function event(seq: number, type: string, padding = ""): UsageEventLike {
  return {
    id: `evt_${seq}`,
    seq,
    type,
    createdAt: 1_000 + seq,
    scope: { kind: "turn", turnId: "turn_widgets" },
    data: type === TOKEN_USAGE_EVENT
      ? { tokenUsage: { total: { totalTokens: seq * 100 }, last: { totalTokens: 100 } } }
      : { item: { id: "item_widgets", type: "fileChange" }, padding },
  };
}

describe("event pagination over HTTP", () => {
  it("reads every page after an oversized response and resumes at the stored cursor", async () => {
    const large = "x".repeat(4_500_000);
    const { requests, store, sync } = await fixture([
      event(1, TOKEN_USAGE_EVENT),
      event(2, "item/started", large),
      event(3, "item/completed", large),
      event(4, TOKEN_USAGE_EVENT),
      event(5, "turn/started", large),
      event(6, "turn/started", large),
      event(7, "turn/completed"),
      event(8, "turn/completed"),
    ]);
    expect(await sync.syncThread(thread)).toBe(2);
    expect(store.cursor(thread.id)).toBe(8);
    expect(await sync.syncThread(thread)).toBe(0);
    const context = await sync.turnContext(thread.id);
    expect(context.started.map((turn) => turn.at)).toEqual([1_005, 1_006]);
    expect(context.completed.map((turn) => turn.at)).toEqual([1_007, 1_008]);
    expect(requests.some((request) => request.status === 413)).toBe(true);
    expect(requests.some((request) => request.limit === 1 && request.status === 200)).toBe(true);
  });

  it("reports a single event that cannot fit without advancing the cursor", async () => {
    const { requests, store, sync } = await fixture([event(1, "item/started", "x".repeat(9_000_000))]);
    await expect(sync.syncThread(thread)).rejects.toMatchObject({ status: 413 });
    expect(requests.at(-1)?.limit).toBe(1);
    expect(store.cursor(thread.id)).toBe(null);
  });

  it("propagates other HTTP errors without retrying", async () => {
    const { requests, sync } = await fixture([], 503);
    await expect(sync.syncThread(thread)).rejects.toMatchObject({ status: 503 });
    expect(requests).toHaveLength(1);
  });
});
