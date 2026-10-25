import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

const ARCHIVED = makeThreadResponse({ id: "thr_one", environmentId: "env_one", archivedAt: 1_700_000_000_000 });

/** A checkout whose stop command appends each id it stops to stopped.log. */
function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), "dev-bar-archive-"));
  mkdirSync(join(root, ".bb"));
  writeFileSync(
    join(root, ".bb/dev-bar.json"),
    JSON.stringify({ status: "cat status.json", start: "true", stop: "echo {id} >> stopped.log" }),
  );
  writeFileSync(
    join(root, "status.json"),
    JSON.stringify({
      services: [
        { id: "web", state: "running" },
        { id: "worker", state: "starting" },
        { id: "db", state: "stopped" },
      ],
    }),
  );
  return root;
}

async function archive(root: string, liveThreads: string[]) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "dev-bar",
    sdk: {
      threads: {
        get: async () => ARCHIVED,
        list: async () => liveThreads.map((id) => makeThreadResponse({ id, environmentId: "env_one" })),
      },
      environments: {
        get: async () => ({ id: "env_one", path: root }),
      },
    },
  });
  await plugin(bb);
  return harness.emitThreadEvent("thread.archived", { thread: ARCHIVED });
}

describe("archiving a thread", () => {
  it("stops the running services when it was the checkout's last live thread", async () => {
    const root = checkout();
    const { errors } = await archive(root, []);
    expect(errors).toEqual([]);
    expect(readFileSync(join(root, "stopped.log"), "utf8")).toBe("web\nworker\n");
  });

  it("leaves them running while another thread uses the checkout", async () => {
    const root = checkout();
    await archive(root, ["thr_two"]);
    expect(existsSync(join(root, "stopped.log"))).toBe(false);
  });
});
