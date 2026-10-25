import { describe, expect, it } from "vitest";
import { GhUnavailableError, REPO_SLUG_PATTERN, createGhRunner } from "./gh.js";

describe("REPO_SLUG_PATTERN", () => {
  it("accepts ordinary slugs", () => {
    expect(REPO_SLUG_PATTERN.test("acme/widgets")).toBe(true);
    expect(REPO_SLUG_PATTERN.test("acme-co/my.repo_v2")).toBe(true);
  });

  it("rejects anything that could smuggle an argument", () => {
    for (const bad of ["--version", "acme/widgets;rm -rf /", "acme widgets", "acme/", "a/b/c"]) {
      expect(REPO_SLUG_PATTERN.test(bad)).toBe(false);
    }
  });
});

describe("createGhRunner", () => {
  it("reports a missing binary as a configuration problem, not a crash", async () => {
    const gh = createGhRunner("/nonexistent/gh-does-not-exist");
    await expect(gh.run(["--version"])).rejects.toBeInstanceOf(GhUnavailableError);
  });

  it("runs a real binary and returns its stdout", async () => {
    // `echo` stands in for gh: the point is the argument-array spawn, which is
    // what keeps a repository slug from ever reaching a shell.
    const runner = createGhRunner("/bin/echo");
    expect((await runner.run(["hello", "world"])).trim()).toBe("hello world");
  });

  it("kills a call in flight when its signal aborts", async () => {
    const controller = new AbortController();
    const runner = createGhRunner("/bin/sleep", controller.signal);
    const started = Date.now();
    const call = runner.run(["30"]);
    controller.abort();
    await expect(call).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("refuses a call once its signal has aborted", async () => {
    const runner = createGhRunner("/bin/echo", AbortSignal.abort());
    await expect(runner.run(["hello"])).rejects.toMatchObject({ name: "AbortError" });
  });
});
