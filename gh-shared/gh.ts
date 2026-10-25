import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The one place any of the GitHub plugins spawns a process.
 *
 * This was byte-identical in pr-sweep, review-sweep and issue-sweep. What
 * each plugin does with the runner is not shared and should not be: their
 * fetch strategies genuinely differ, and their classifiers differ more.
 */
export const REPO_SLUG_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export interface GhRunner {
  run(args: string[]): Promise<string>;
}

export class GhUnavailableError extends Error {
  constructor(
    message: string,
    /** What gh actually said, for a log that has to explain a hidden panel. */
    readonly detail: string,
  ) {
    super(message);
    this.name = "GhUnavailableError";
  }
}

/**
 * Phrases gh uses when the problem is genuinely the credentials.
 *
 * Deliberately specific. The previous test was /auth|logged in|credentials|
 * token/i against the whole error, and an execFile error message contains the
 * entire argv — so any future flag or GraphQL field containing "token" or
 * "auth" would classify a network blip as a broken login. The cost of a false
 * positive is not a wrong log line: it latches the plugin into
 * needs-configuration, which hides its panels until someone reloads it.
 */
const AUTH_PATTERNS = [
  /gh auth login/i,
  /not logged in/i,
  /bad credentials/i,
  /requires authentication/i,
  /authentication required/i,
  /HTTP 401/,
];

/** gh writes the useful part to stderr; the message is mostly the argv. */
function ghStderr(error: unknown): string {
  const stderr = (error as { stderr?: unknown })?.stderr;
  return typeof stderr === "string" ? stderr : "";
}

/**
 * Argument-array spawn only. A shell string is never constructed.
 *
 * An aborted `signal` kills the gh call in flight and makes later calls fail
 * at once, so a background service can stop mid-sweep within bb's stop window.
 */
export function createGhRunner(ghPath: string, signal?: AbortSignal): GhRunner {
  return {
    async run(args: string[]) {
      try {
        const { stdout } = await execFileAsync(ghPath, args, {
          maxBuffer: 32 * 1024 * 1024,
          timeout: 60_000,
          signal,
        });
        return stdout;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stderr = ghStderr(error);
        if (/ENOENT/.test(message)) {
          throw new GhUnavailableError(`\`${ghPath}\` was not found on PATH.`, message);
        }
        // Against stderr, not the message: the message carries the argv.
        if (AUTH_PATTERNS.some((pattern) => pattern.test(stderr))) {
          throw new GhUnavailableError(
            "`gh` is not authenticated. Run `gh auth login`.",
            stderr.trim(),
          );
        }
        throw error;
      }
    },
  };
}


/**
 * Every git remote URL configured in a checkout, in `git config` order.
 *
 * A project record carries one remote — the one bb resolved when the project
 * was added, which for a fork-and-upstream checkout is the fork. The PRs are
 * against the upstream, so matching on that single URL finds nothing: the
 * sweep skips the repository and the panel reports no project is checked out
 * for it. Reading the checkout's own config is what closes that gap.
 *
 * Returns an empty list rather than throwing when the path is not a checkout,
 * is not on this machine, or git is missing. The caller still has the
 * project's recorded remote, so a failure here narrows matching back to
 * today's behaviour instead of breaking it.
 */
export async function readGitRemoteUrls(path: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", path, "config", "--get-regexp", "^remote\\..*\\.url$"],
      { maxBuffer: 1024 * 1024, timeout: 10_000 },
    );
    const urls: string[] = [];
    for (const line of stdout.split("\n")) {
      // "remote.origin.url git@github.com:acme/widgets.git"
      const separator = line.indexOf(" ");
      if (separator === -1) continue;
      const url = line.slice(separator + 1).trim();
      if (url) urls.push(url);
    }
    return urls;
  } catch {
    return [];
  }
}

// Served from this path rather than a `./stacks` export of its own: bb caches
// a package's exports map for as long as its server runs, so a new subpath
// would not load in a running bb until it restarted.
export * from "./stacks.js";
// The same, for the bot logins and one pull request's comments.
export * from "./bots.js";
export * from "./feedback.js";
// And what a sync costs against the GraphQL rate limit.
export * from "./usage.js";
