import { describe, expect, it } from "vitest";
import {
  countViewed,
  labelForEntry,
  legacyMarksToMove,
  legacyRecordKey,
  targetKey,
  targetQuery,
  threadIdFromPath,
  type DiffFileEntry,
} from "./marks";

const entry = (
  path: string,
  additions = 2,
  deletions = 2,
  extra: Partial<DiffFileEntry> = {},
): DiffFileEntry => ({
  path,
  previousPath: null,
  changeKind: "modified",
  additions,
  deletions,
  binary: false,
  revision: `rev-${path}-${additions}-${deletions}`,
  ...extra,
});

describe("threadIdFromPath", () => {
  it("resolves both thread routes to the same id", () => {
    expect(threadIdFromPath("/threads/thr_a")).toBe("thr_a");
    expect(threadIdFromPath("/projects/proj_x/threads/thr_a")).toBe("thr_a");
  });

  it("ignores the route remainder, so a panel tab is still the same thread", () => {
    expect(threadIdFromPath("/projects/proj_x/threads/thr_a/diff")).toBe("thr_a");
  });

  it("returns null off a thread route", () => {
    expect(threadIdFromPath("/projects/proj_x")).toBeNull();
    expect(threadIdFromPath("/threads/")).toBeNull();
  });
});

describe("targetKey", () => {
  it("names a range the way bb's server does", () => {
    expect(targetKey({ type: "uncommitted" })).toBe("uncommitted");
    expect(targetKey({ type: "all", mergeBaseBranch: "main" })).toBe("all:main");
    expect(targetKey({ type: "branch_committed", mergeBaseBranch: "main" })).toBe(
      "branch_committed:main",
    );
    expect(targetKey({ type: "commit", sha: "ABC123" })).toBe("commit:abc123");
  });
});

describe("targetQuery", () => {
  it("turns the panel's range into the query bb's diff reads take", () => {
    expect(targetQuery({ type: "all", mergeBaseBranch: "main" })).toEqual({
      target: "all",
      mergeBaseBranch: "main",
    });
    expect(targetQuery({ type: "uncommitted" })).toEqual({ target: "uncommitted" });
    expect(targetQuery({ type: "commit", sha: "abc123" })).toEqual({
      target: "commit",
      sha: "abc123",
    });
  });
});

describe("labelForEntry", () => {
  it("is the path for an ordinary file", () => {
    expect(labelForEntry(entry("src/a.ts"))).toBe("src/a.ts");
  });

  it("names both paths for a rename, the way the card does", () => {
    expect(
      labelForEntry(entry("src/new.ts", 1, 1, { changeKind: "renamed", previousPath: "src/old.ts" })),
    ).toBe("src/old.ts -> src/new.ts");
  });
});

describe("countViewed", () => {
  it("counts only files whose current revision bb has marked", () => {
    const a = entry("a.ts");
    const b = entry("b.ts");
    const c = entry("c.ts");
    const viewed = { "a.ts": a.revision, "b.ts": "an older revision" };
    expect(countViewed(viewed, [a, b, c])).toEqual({ viewed: 1, total: 3 });
  });
});

describe("legacyMarksToMove", () => {
  it("moves a mark whose counts still describe the file", () => {
    const a = entry("a.ts", 8, 4);
    expect(legacyMarksToMove({ "a.ts": "+8 -4" }, [a], {})).toEqual([a]);
  });

  it("drops a mark whose file has changed since", () => {
    expect(legacyMarksToMove({ "a.ts": "+8 -4" }, [entry("a.ts", 9, 4)], {})).toEqual([]);
  });

  it("skips a file bb already counts as viewed", () => {
    const a = entry("a.ts", 8, 4);
    expect(legacyMarksToMove({ "a.ts": "+8 -4" }, [a], { "a.ts": a.revision })).toEqual([]);
  });

  it("finds a rename under the label the card had", () => {
    const moved = entry("src/new.ts", 1, 1, { changeKind: "renamed", previousPath: "src/old.ts" });
    expect(legacyMarksToMove({ "src/old.ts -> src/new.ts": "+1 -1" }, [moved], {})).toEqual([moved]);
  });

  it("moves a binary file marked from its size", () => {
    const image = entry("logo.png", 0, 0, { binary: true });
    expect(legacyMarksToMove({ "logo.png": "none" }, [image], {})).toEqual([image]);
  });
});

describe("legacyRecordKey", () => {
  it("is the key the old marks were stored under", () => {
    expect(legacyRecordKey("thr_a")).toBe("viewed:thr_a");
  });
});
