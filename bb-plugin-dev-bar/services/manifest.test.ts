import { describe, expect, it } from "vitest";
import { parseManifest, parseStatus, pickManifest, serviceCommands, servicesToStop, type Manifest, type Service } from "./manifest";

const manifest: Manifest = {
  status: "pnpm status --json",
  start: "pnpm launch start {id}",
  stop: "pnpm launch stop {id}",
  actions: [{ label: "Start all", command: "pnpm launch" }],
};

describe("parseManifest", () => {
  it("reads a manifest and defaults actions to none", () => {
    const result = parseManifest(JSON.stringify({ status: "make status" }));
    expect(result).toEqual({ ok: true, value: { status: "make status", actions: [] } });
  });

  it("names the field that is wrong", () => {
    const result = parseManifest(JSON.stringify({ start: "x" }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/status/);
  });

  it("reports text that is not JSON", () => {
    expect(parseManifest("{").ok).toBe(false);
  });
});

describe("parseStatus", () => {
  it("skips the banner a package manager prints before the JSON", () => {
    const stdout = [
      "",
      "> widgets@1.0.0 status /tmp/widgets",
      "> node scripts/launch.mjs status --json",
      "",
      JSON.stringify({
        services: [
          { id: "vite", label: "Vite", state: "running", url: "http://localhost:5173" },
          { id: "app", state: "stopped" },
        ],
      }),
    ].join("\n");
    expect(parseStatus(stdout, manifest)).toEqual({
      ok: true,
      value: [
        {
          id: "vite",
          label: "Vite",
          state: "running",
          url: "http://localhost:5173",
          message: null,
          verbs: ["start", "stop", "restart"],
        },
        { id: "app", label: "app", state: "stopped", url: null, message: null, verbs: ["start", "stop", "restart"] },
      ],
    });
  });

  it("limits a service to the verbs it lists", () => {
    const stdout = JSON.stringify({ services: [{ id: "postgres", state: "running", actions: ["start"] }] });
    const result = parseStatus(stdout, manifest);
    expect(result.ok && result.value[0]!.verbs).toEqual(["start"]);
  });

  it("offers only the verbs the manifest has commands for", () => {
    const stdout = JSON.stringify({ services: [{ id: "vite", state: "running" }] });
    const result = parseStatus(stdout, { status: "x", start: "start {id}", actions: [] });
    expect(result.ok && result.value[0]!.verbs).toEqual(["start"]);
  });

  it("rejects an id that is unsafe to put in a command", () => {
    const stdout = JSON.stringify({ services: [{ id: "vite; rm -rf ~", state: "running" }] });
    expect(parseStatus(stdout, manifest).ok).toBe(false);
  });

  it("reports output with no JSON in it", () => {
    expect(parseStatus("command not found: pnpm", manifest)).toEqual({
      ok: false,
      error: "The status command printed no JSON object.",
    });
  });
});

describe("serviceCommands", () => {
  it("fills in the service id", () => {
    expect(serviceCommands(manifest, "start", "vite")).toEqual(["pnpm launch start vite"]);
  });

  it("restarts with stop and then start when there is no restart command", () => {
    expect(serviceCommands(manifest, "restart", "vite")).toEqual(["pnpm launch stop vite", "pnpm launch start vite"]);
  });

  it("uses the manifest's restart command when it has one", () => {
    expect(serviceCommands({ ...manifest, restart: "pnpm launch restart {id}" }, "restart", "vite")).toEqual([
      "pnpm launch restart vite",
    ]);
  });

  it("refuses an unsafe id", () => {
    expect(serviceCommands(manifest, "start", "$(whoami)")).toBeNull();
  });
});

describe("pickManifest", () => {
  it("prefers the committed manifest, then the local one, then the project's", () => {
    expect(pickManifest({ committed: "a", local: "b", project: "c" })).toEqual({ source: "committed", text: "a" });
    expect(pickManifest({ committed: null, local: "b", project: "c" })).toEqual({ source: "local", text: "b" });
    expect(pickManifest({ committed: null, local: null, project: "c" })).toEqual({ source: "project", text: "c" });
    expect(pickManifest({ committed: null, local: null, project: null })).toBeNull();
  });
});

describe("servicesToStop", () => {
  const service = (id: string, state: Service["state"], verbs: Service["verbs"] = ["start", "stop", "restart"]): Service => ({
    id,
    label: id,
    state,
    url: null,
    message: null,
    verbs,
  });

  it("stops the services that are running or starting", () => {
    expect(
      servicesToStop([service("web", "running"), service("worker", "starting"), service("db", "stopped"), service("desktop", "failed")]),
    ).toEqual(["web", "worker"]);
  });

  it("skips a service that cannot be stopped", () => {
    expect(servicesToStop([service("db", "running", ["start"])])).toEqual([]);
  });
});
