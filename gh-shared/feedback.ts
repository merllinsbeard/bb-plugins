import { isBotLogin } from "./bots.js";
import type { GhRunner } from "./gh.js";

/**
 * What people left on one pull request, for the drawer under its row: the
 * reviews with something to say, every inline thread, and the general
 * comments, yours and bots' included and marked, since the comment count
 * includes them too.
 */

export type FeedbackEntry =
  | {
      kind: "review";
      author: string;
      avatarUrl: string;
      /** Written by a bot, such as a CI or deploy report. */
      bot?: boolean;
      /** Written by you. */
      you?: boolean;
      state: "changes_requested" | "approved" | "commented";
      /** Markdown, as written. */
      body: string;
      url: string;
      at: number;
    }
  | {
      kind: "thread";
      author: string;
      avatarUrl: string;
      /** Written by a bot, such as a CI or deploy report. */
      bot?: boolean;
      /** Written by you. */
      you?: boolean;
      path: string;
      /** The line on the current diff, or where it was before the code changed. */
      line: number | null;
      /**
       * "unanswered" when someone else spoke last, "replied" when you did, and
       * "waiting" when you started it and nobody has answered yet.
       */
      status: "unanswered" | "replied" | "waiting" | "resolved";
      outdated: boolean;
      /** Comments after the first. */
      replies: number;
      /** Markdown, as written. */
      body: string;
      url: string;
      at: number;
    }
  | {
      kind: "comment";
      author: string;
      avatarUrl: string;
      /** Written by a bot, such as a CI or deploy report. */
      bot?: boolean;
      /** Written by you. */
      you?: boolean;
      /** Markdown, as written. */
      body: string;
      url: string;
      at: number;
    };

export const FEEDBACK_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(last: 50) {
        nodes { author { __typename login avatarUrl } state body url submittedAt }
      }
      reviewThreads(first: 100) {
        nodes {
          isResolved
          isOutdated
          path
          line
          originalLine
          first: comments(first: 1) { nodes { author { __typename login avatarUrl } body url createdAt } }
          last: comments(last: 1) { totalCount nodes { author { login } } }
        }
      }
      comments(last: 50) {
        nodes { author { __typename login avatarUrl } body url createdAt }
      }
    }
  }
}`;

interface RawAuthor {
  __typename?: string;
  login?: string;
  avatarUrl?: string;
}

interface RawComment {
  author?: RawAuthor | null;
  body?: string;
  url?: string;
  createdAt?: string;
}

interface RawPull {
  reviews?: { nodes?: Array<(RawComment & { state?: string; submittedAt?: string }) | null> | null };
  reviewThreads?: {
    nodes?: Array<{
      isResolved?: boolean;
      isOutdated?: boolean;
      path?: string;
      line?: number | null;
      originalLine?: number | null;
      first?: { nodes?: Array<RawComment | null> | null };
      last?: { totalCount?: number; nodes?: Array<{ author?: { login?: string } | null } | null> | null };
    } | null> | null;
  };
  comments?: { nodes?: Array<RawComment | null> | null };
}

const REVIEW_STATE: Record<string, "changes_requested" | "approved" | "commented"> = {
  CHANGES_REQUESTED: "changes_requested",
  APPROVED: "approved",
  COMMENTED: "commented",
};

/** The author's login to show, and whether it is a bot or you. Null without a login. */
export function feedbackPerson(
  author: RawAuthor | null | undefined,
  viewer: string | undefined,
): { author: string; avatarUrl: string; bot?: true; you?: true } | null {
  const login = author?.login;
  if (!login) return null;
  const bot = author?.__typename === "Bot" || isBotLogin(login);
  return { author: login, avatarUrl: author?.avatarUrl ?? "", ...(bot ? { bot: true } : {}), ...(login === viewer ? { you: true } : {}) };
}

/** Code, whose text stays exactly as written: a fenced block or an inline span. */
const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/;

/** The HTML that bots and GitHub's templates wrap Markdown in. */
const HTML_TAG =
  /<\/?(?:a|b|br|code|dd|details|div|dl|dt|em|h[1-6]|hr|i|img|kbd|li|ol|p|picture|pre|source|span|strong|sub|summary|sup|table|tbody|td|th|thead|tr|ul)\b[^>]*>/gi;

/**
 * The Markdown a comment was written in, without the HTML comments bots hide
 * metadata in, so a body that is only those counts as empty, and without HTML
 * tags, which bb's Markdown would show as text. The text inside a tag stays.
 * Code is left alone, so `<summary>` in backticks still reads as written.
 */
export function commentMarkdown(body: string | undefined): string {
  return (body ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split(CODE)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(/<br\s*\/?>/gi, "\n").replace(HTML_TAG, "")))
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function time(iso: string | undefined): number {
  const parsed = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Reviews, threads, and comments together, oldest first, as they were posted. */
export function parseFeedback(raw: string): FeedbackEntry[] {
  const parsed = JSON.parse(raw) as {
    data?: { viewer?: { login?: string }; repository?: { pullRequest?: RawPull | null } | null };
  };
  const viewer = parsed.data?.viewer?.login;
  const pr = parsed.data?.repository?.pullRequest;
  if (!pr) return [];

  const entries: FeedbackEntry[] = [];
  for (const review of pr.reviews?.nodes ?? []) {
    const who = review && feedbackPerson(review.author, viewer);
    const state = review?.state ? REVIEW_STATE[review.state] : undefined;
    if (!who || !state) continue;
    const body = commentMarkdown(review!.body);
    // An approval or a comment with no words says nothing the reviewer avatars do not.
    if (!body && state !== "changes_requested") continue;
    entries.push({
      kind: "review",
      ...who,
      state,
      body,
      url: review!.url ?? "",
      at: time(review!.submittedAt),
    });
  }

  for (const thread of pr.reviewThreads?.nodes ?? []) {
    const first = thread?.first?.nodes?.[0];
    if (!thread || !first) continue;
    const who = feedbackPerson(first.author, viewer);
    if (!who) continue;
    const last = thread.last?.nodes?.[0]?.author?.login;
    const replies = Math.max(0, (thread.last?.totalCount ?? 1) - 1);
    const status = thread.isResolved
      ? "resolved"
      : viewer && last === viewer
        ? replies === 0 ? "waiting" : "replied"
        : "unanswered";
    entries.push({
      kind: "thread",
      ...who,
      path: thread.path ?? "",
      line: thread.line ?? thread.originalLine ?? null,
      status,
      outdated: thread.isOutdated === true,
      replies,
      body: commentMarkdown(first.body),
      url: first.url ?? "",
      at: time(first.createdAt),
    });
  }

  for (const comment of pr.comments?.nodes ?? []) {
    const who = comment && feedbackPerson(comment.author, viewer);
    const body = commentMarkdown(comment?.body);
    if (!who || !body) continue;
    entries.push({
      kind: "comment",
      ...who,
      body,
      url: comment!.url ?? "",
      at: time(comment!.createdAt),
    });
  }
  return entries.sort((a, b) => a.at - b.at);
}

/**
 * One pull request's feedback, in one GraphQL call. Runs when its drawer
 * opens, never during a sweep.
 */
export async function fetchFeedback(
  gh: GhRunner,
  repo: string,
  number: number,
): Promise<FeedbackEntry[]> {
  const [owner, name] = repo.split("/");
  const raw = await gh.run([
    "api", "graphql",
    "-f", `query=${FEEDBACK_QUERY}`,
    "-f", `owner=${owner}`,
    "-f", `name=${name}`,
    "-F", `number=${number}`,
  ]);
  return parseFeedback(raw);
}
