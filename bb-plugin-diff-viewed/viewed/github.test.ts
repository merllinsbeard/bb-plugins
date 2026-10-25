import { describe, expect, it } from "vitest";
import {
  reconcile,
  sameBaseline,
  sameDiff,
  syncMode,
  withGithubViewed,
  type GithubState,
} from "./github";
import type { DiffFileEntry } from "./marks";

const pull = (files: GithubState["files"]): GithubState => ({
  number: 42,
  url: "https://github.com/acme/widgets/pull/42",
  files,
});

const entry = (path: string, additions = 2, deletions = 2, revision = `rev-${path}`): DiffFileEntry => ({
  path,
  previousPath: null,
  changeKind: "modified",
  additions,
  deletions,
  binary: false,
  revision,
});

const file = (path: string, viewed: boolean, additions = 2, deletions = 2) => ({
  path,
  additions,
  deletions,
  viewed,
});

describe("sameDiff", () => {
  it("matches on the counts", () => {
    expect(sameDiff(file("a.ts", false, 8, 4), entry("a.ts", 8, 4))).toBe(true);
    expect(sameDiff(file("a.ts", false, 8, 4), entry("a.ts", 8, 5))).toBe(false);
  });
});

describe("syncMode", () => {
  it("is none without a pull request", () => {
    expect(syncMode(null, entry("a.ts")).kind).toBe("none");
  });

  it("syncs a file whose diff is GitHub's", () => {
    const mode = syncMode(pull([file("a.ts", true)]), entry("a.ts"));
    expect(mode).toMatchObject({ kind: "synced", number: 42 });
  });

  it("is Local for a file whose diff differs, or that GitHub does not list", () => {
    const github = pull([file("a.ts", true, 2, 2)]);
    expect(syncMode(github, entry("a.ts", 3, 2)).kind).toBe("local");
    expect(syncMode(github, entry("b.ts")).kind).toBe("local");
  });
});

describe("withGithubViewed", () => {
  it("changes one file and keeps the rest of the state", () => {
    const before = { ...pull([file("a.ts", false), file("b.ts", false)]), id: "PR_1" };
    const after = withGithubViewed(before, "a.ts", true);
    expect(after.id).toBe("PR_1");
    expect(after.files.map((f) => f.viewed)).toEqual([true, false]);
  });
});

describe("reconcile", () => {
  const a = entry("a.ts");

  it("records agreement and changes nothing when both sides match", () => {
    const plan = reconcile([a], { "a.ts": a.revision }, pull([file("a.ts", true)]), {});
    expect(plan).toEqual({
      markInBb: [],
      clearInBb: [],
      pushToGithub: [],
      baseline: { "a.ts": { revision: a.revision, viewed: true } },
    });
  });

  it("sends a mark made in bb before the pull request existed", () => {
    const plan = reconcile([a], { "a.ts": a.revision }, pull([file("a.ts", false)]), {});
    expect(plan.pushToGithub).toEqual([{ path: "a.ts", viewed: true }]);
    expect(plan.baseline["a.ts"]).toEqual({ revision: a.revision, viewed: true });
  });

  it("brings in a mark made on GitHub that bb has not seen", () => {
    const plan = reconcile([a], {}, pull([file("a.ts", true)]), {});
    expect(plan.markInBb).toEqual([a]);
    expect(plan.pushToGithub).toEqual([]);
  });

  it("unmarks on GitHub when the file was unchecked in bb", () => {
    const baseline = { "a.ts": { revision: a.revision, viewed: true } };
    const plan = reconcile([a], {}, pull([file("a.ts", true)]), baseline);
    expect(plan.pushToGithub).toEqual([{ path: "a.ts", viewed: false }]);
    expect(plan.markInBb).toEqual([]);
    expect(plan.baseline["a.ts"]?.viewed).toBe(false);
  });

  it("clears bb's mark when the file was unmarked on GitHub", () => {
    const baseline = { "a.ts": { revision: a.revision, viewed: true } };
    const plan = reconcile([a], { "a.ts": a.revision }, pull([file("a.ts", false)]), baseline);
    expect(plan.clearInBb).toEqual([a]);
    expect(plan.pushToGithub).toEqual([]);
  });

  it("marks on GitHub when the file was checked in bb", () => {
    const baseline = { "a.ts": { revision: a.revision, viewed: false } };
    const plan = reconcile([a], { "a.ts": a.revision }, pull([file("a.ts", false)]), baseline);
    expect(plan.pushToGithub).toEqual([{ path: "a.ts", viewed: true }]);
  });

  it("starts over once the file changes, rather than trusting an old agreement", () => {
    const changed = entry("a.ts", 2, 2, "rev-new");
    const baseline = { "a.ts": { revision: "rev-old", viewed: true } };
    const plan = reconcile([changed], { "a.ts": changed.revision }, pull([file("a.ts", false)]), baseline);
    expect(plan.pushToGithub).toEqual([{ path: "a.ts", viewed: true }]);
  });

  it("leaves Local files alone and forgets their agreement", () => {
    const local = entry("a.ts", 9, 9);
    const baseline = { "a.ts": { revision: local.revision, viewed: true } };
    const plan = reconcile([local], { "a.ts": local.revision }, pull([file("a.ts", false)]), baseline);
    expect(plan).toEqual({ markInBb: [], clearInBb: [], pushToGithub: [], baseline: {} });
  });

  it("compares bb's mark against the file's current revision", () => {
    const plan = reconcile([a], { "a.ts": "an older revision" }, pull([file("a.ts", true)]), {});
    expect(plan.markInBb).toEqual([a]);
  });
});

describe("sameBaseline", () => {
  it("is true for the same agreement and false for any difference", () => {
    const one = { "a.ts": { revision: "r1", viewed: true } };
    expect(sameBaseline(one, { "a.ts": { revision: "r1", viewed: true } })).toBe(true);
    expect(sameBaseline(one, { "a.ts": { revision: "r1", viewed: false } })).toBe(false);
    expect(sameBaseline(one, {})).toBe(false);
  });
});
