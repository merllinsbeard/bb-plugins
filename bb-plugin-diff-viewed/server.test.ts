import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import type { DiffFileEntry, DiffTarget } from "./viewed/marks";

afterEach(() => {
  vi.restoreAllMocks();
});

const ALL: DiffTarget = { type: "all", mergeBaseBranch: "main" };

const entry = (path: string, additions = 8, deletions = 4, revision = `rev-${path}`): DiffFileEntry => ({
  path,
  previousPath: null,
  changeKind: "modified",
  additions,
  deletions,
  binary: false,
  revision,
});

const A = entry("src/a.ts");
const B = entry("src/b.ts", 1, 0);

/**
 * bb's own Viewed marks for one environment, keyed by range and path, with
 * the calls the plugin made to change them.
 */
function fakeMarks() {
  const marks = new Map<string, string>();
  const writes: string[] = [];
  const key = (target: string, path: string) => `${target}|${path}`;
  const queryKey = (query: { target: string; mergeBaseBranch?: string; sha?: string }) =>
    `${query.target}:${query.mergeBaseBranch ?? query.sha ?? ""}`;
  const targetKey = (target: DiffTarget) =>
    queryKey({
      target: target.type,
      ...("mergeBaseBranch" in target ? { mergeBaseBranch: target.mergeBaseBranch } : {}),
      ...("sha" in target ? { sha: target.sha } : {}),
    });
  return {
    marks,
    writes,
    set(path: string, revision: string, target: DiffTarget = ALL) {
      marks.set(key(targetKey(target), path), revision);
    },
    get(path: string, target: DiffTarget = ALL) {
      return marks.get(key(targetKey(target), path));
    },
    environments: {
      experimental_diffViewed: async (args: {
        target: string;
        mergeBaseBranch?: string;
        sha?: string;
        paths: string[];
      }) => ({
        files: args.paths.flatMap((path) => {
          const revision = marks.get(key(queryKey(args), path));
          return revision === undefined ? [] : [{ path, revision }];
        }),
      }),
      experimental_markDiffViewed: async (args: { target: DiffTarget; path: string; revision: string }) => {
        writes.push(`mark ${args.path}`);
        marks.set(key(targetKey(args.target), args.path), args.revision);
        return { ok: true };
      },
      experimental_clearDiffViewed: async (args: { target: DiffTarget; path: string }) => {
        writes.push(`clear ${args.path}`);
        marks.delete(key(targetKey(args.target), args.path));
        return { ok: true };
      },
    },
  };
}

type FakeFile = { path: string; additions: number; deletions: number; viewerViewedState: string };

/**
 * A stand-in for `gh`: a script that appends its argv to a log and answers
 * the files query with `files`, or a mutation with an empty payload.
 * `setFiles` changes the answer, as a push does.
 */
function fakeGh(files: FakeFile[]) {
  const dir = mkdtempSync(join(tmpdir(), "diff-viewed-gh-"));
  const log = join(dir, "calls.jsonl");
  const answerFile = join(dir, "answer.json");
  const setFiles = (next: FakeFile[]) =>
    writeFileSync(
      answerFile,
      JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              id: "PR_node",
              files: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: next },
            },
          },
        },
      }),
    );
  setFiles(files);
  const script = join(dir, "gh");
  writeFileSync(
    script,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const query = args.find((arg) => arg.startsWith("query=")) ?? "";
process.stdout.write(query.includes("mutation") ? "{}" : fs.readFileSync(${JSON.stringify(answerFile)}, "utf8"));
`,
  );
  chmodSync(script, 0o755);
  const calls = (): string[][] => {
    try {
      return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  return { path: script, calls, setFiles };
}

/** The mutations sent to GitHub, as `mark <path>` or `unmark <path>`. */
const mutations = (calls: string[][]) =>
  calls
    .filter((args) => args.some((arg) => arg.includes("mutation")))
    .map((args) => {
      const verb = args.some((arg) => arg.includes("unmarkFileAsViewed")) ? "unmark" : "mark";
      const path = args.find((arg) => arg.startsWith("path="))?.slice("path=".length);
      return `${verb} ${path}`;
    });

async function start(
  options: {
    marks?: ReturnType<typeof fakeMarks>;
    gh?: { path: string };
    /** Whether the environment has an open pull request. */
    pullRequest?: boolean;
    syncGithub?: "on" | "off";
  } = {},
) {
  const marks = options.marks ?? fakeMarks();
  const gh = options.gh ?? fakeGh([]);
  const host = createFakePluginHost({
    pluginId: "diff-viewed",
    settings: { syncGithub: options.syncGithub ?? "on", ghPath: gh.path },
    sdk: {
      threads: {
        get: async () => makeThreadResponse({ id: "thr_a", environmentId: "env_a" }),
      },
      environments: marks.environments,
      plugins: {
        callRpc: async (args: { pluginId: string; method: string; input: { keys: string[] } }) => {
          expect(args).toMatchObject({ pluginId: "bb--github-pr-status", method: "pullRequests" });
          return Object.fromEntries(
            args.input.keys.map((key) => [
              key,
              options.pullRequest === false
                ? { outcome: "absent" }
                : {
                    outcome: "available",
                    pullRequest: {
                      number: 42,
                      state: "open",
                      url: "https://github.com/acme/widgets/pull/42",
                    },
                  },
            ]),
          );
        },
      },
    } as never,
  });
  await plugin(host.bb);
  return { ...host, marks, sync: (files: DiffFileEntry[], target: DiffTarget = ALL) =>
    host.harness.behavior.callRpc("viewed_sync", { threadId: "thr_a", target, files }) };
}

describe("viewed_sync without GitHub", () => {
  it("returns bb's marks for the range", async () => {
    const marks = fakeMarks();
    marks.set("src/a.ts", A.revision);
    marks.set("src/b.ts", "rev-other", { type: "uncommitted" });
    const { sync } = await start({ marks, syncGithub: "off" });
    expect(await sync([A, B])).toEqual({ viewed: { "src/a.ts": A.revision }, github: null });
  });

  it("returns no pull request when the environment has none", async () => {
    const gh = fakeGh([]);
    const { sync } = await start({ gh, pullRequest: false });
    expect(await sync([A])).toEqual({ viewed: {}, github: null });
    expect(gh.calls()).toEqual([]);
  });

  it("reads a long diff in batches bb accepts", async () => {
    const marks = fakeMarks();
    const files = Array.from({ length: 1200 }, (_, index) => entry(`f${index}.ts`));
    for (const file of files) marks.set(file.path, file.revision);
    const { sync } = await start({ marks, syncGithub: "off" });
    const result = (await sync(files)) as { viewed: Record<string, string> };
    expect(Object.keys(result.viewed)).toHaveLength(1200);
  });

  it("rejects an empty thread id at the wire boundary", async () => {
    const { harness } = await start({ syncGithub: "off" });
    await expect(
      harness.behavior.callRpc("viewed_sync", { threadId: "", target: ALL, files: [] }),
    ).rejects.toThrow();
  });
});

describe("moving the marks this plugin kept before bb had its own", () => {
  it("marks them in bb once, then forgets them", async () => {
    const { sync, marks, bb } = await start({ syncGithub: "off" });
    await bb.storage.kv.set("viewed:thr_a", { "src/a.ts": "+8 -4", "src/b.ts": "+9 -9" });
    await bb.storage.kv.set("pending:thr_a", ["src/a.ts"]);

    expect(await sync([A, B])).toEqual({ viewed: { "src/a.ts": A.revision }, github: null });
    expect(marks.writes).toEqual(["mark src/a.ts"]);
    expect(await bb.storage.kv.get("viewed:thr_a")).toBeUndefined();
    expect(await bb.storage.kv.get("pending:thr_a")).toBeUndefined();

    marks.marks.clear();
    await sync([A, B]);
    expect(marks.writes).toEqual(["mark src/a.ts"]);
  });

  it("waits for the All changes range", async () => {
    const started = await start({ syncGithub: "off" });
    await started.bb.storage.kv.set("viewed:thr_a", { "src/a.ts": "+8 -4" });
    await started.sync([A], { type: "uncommitted" });
    expect(started.marks.writes).toEqual([]);
    expect(await started.bb.storage.kv.get("viewed:thr_a")).toBeDefined();
  });
});

describe("viewed_sync with GitHub", () => {
  it("lists the pull request's files with the viewer's Viewed state", async () => {
    const gh = fakeGh([
      { path: "src/a.ts", additions: 8, deletions: 4, viewerViewedState: "UNVIEWED" },
      { path: "src/b.ts", additions: 1, deletions: 0, viewerViewedState: "DISMISSED" },
    ]);
    const { sync } = await start({ gh });
    expect(await sync([A, B])).toEqual({
      viewed: {},
      github: {
        number: 42,
        url: "https://github.com/acme/widgets/pull/42",
        files: [
          { path: "src/a.ts", additions: 8, deletions: 4, viewed: false },
          { path: "src/b.ts", additions: 1, deletions: 0, viewed: false },
        ],
      },
    });
  });

  it("brings a file viewed on GitHub into bb", async () => {
    const gh = fakeGh([{ path: "src/a.ts", additions: 8, deletions: 4, viewerViewedState: "VIEWED" }]);
    const { sync, marks } = await start({ gh });
    const result = await sync([A]);
    expect(result).toMatchObject({ viewed: { "src/a.ts": A.revision } });
    expect(marks.get("src/a.ts")).toBe(A.revision);
    expect(mutations(gh.calls())).toEqual([]);
  });

  it("marks a file checked in bb viewed on GitHub", async () => {
    const gh = fakeGh([{ path: "src/a.ts", additions: 8, deletions: 4, viewerViewedState: "UNVIEWED" }]);
    const { sync, marks } = await start({ gh });
    marks.set("src/a.ts", A.revision);
    const result = await sync([A]);
    expect(mutations(gh.calls())).toEqual(["mark src/a.ts"]);
    expect(result).toMatchObject({ github: { files: [{ path: "src/a.ts", viewed: true }] } });
  });

  it("unmarks on GitHub a file unchecked in bb after they agreed", async () => {
    const gh = fakeGh([{ path: "src/a.ts", additions: 8, deletions: 4, viewerViewedState: "VIEWED" }]);
    const { sync, marks } = await start({ gh });
    await sync([A]);
    marks.marks.clear();
    await sync([A]);
    expect(mutations(gh.calls())).toEqual(["unmark src/a.ts"]);
  });

  it("clears bb's mark when the file is unmarked on GitHub", async () => {
    const gh = fakeGh([{ path: "src/a.ts", additions: 8, deletions: 4, viewerViewedState: "VIEWED" }]);
    const { sync, marks } = await start({ gh });
    await sync([A]);
    gh.setFiles([{ path: "src/a.ts", additions: 8, deletions: 4, viewerViewedState: "UNVIEWED" }]);
    // Past the half minute GitHub's answer is reused for.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
    expect(await sync([A])).toMatchObject({ viewed: {} });
    expect(marks.writes).toEqual(["mark src/a.ts", "clear src/a.ts"]);
    expect(mutations(gh.calls())).toEqual([]);
  });

  it("leaves GitHub alone for a file whose diff differs from the pull request's", async () => {
    const gh = fakeGh([{ path: "src/a.ts", additions: 5, deletions: 4, viewerViewedState: "UNVIEWED" }]);
    const { sync, marks } = await start({ gh });
    marks.set("src/a.ts", A.revision);
    await sync([A]);
    expect(mutations(gh.calls())).toEqual([]);
  });

  it("asks GitHub once while its answer is fresh", async () => {
    const gh = fakeGh([{ path: "src/a.ts", additions: 8, deletions: 4, viewerViewedState: "UNVIEWED" }]);
    const { sync } = await start({ gh });
    await Promise.all([sync([A]), sync([A])]);
    await sync([A]);
    expect(gh.calls()).toHaveLength(1);
  });

  it("does not send the same change twice when two syncs overlap", async () => {
    const gh = fakeGh([{ path: "src/a.ts", additions: 8, deletions: 4, viewerViewedState: "UNVIEWED" }]);
    const { sync, marks } = await start({ gh });
    marks.set("src/a.ts", A.revision);
    await Promise.all([sync([A]), sync([A])]);
    expect(mutations(gh.calls())).toEqual(["mark src/a.ts"]);
  });

  it("makes no GitHub calls with sync off", async () => {
    const gh = fakeGh([{ path: "src/a.ts", additions: 8, deletions: 4, viewerViewedState: "VIEWED" }]);
    const { sync } = await start({ gh, syncGithub: "off" });
    await sync([A]);
    expect(gh.calls()).toEqual([]);
  });
});

describe("problem_report", () => {
  it("accepts a problem from the content script", async () => {
    const { harness } = await start();
    expect(
      await harness.behavior.callRpc("problem_report", {
        message: "Could not read the changes panel's file list",
      }),
    ).toEqual({ ok: true });
  });
});
