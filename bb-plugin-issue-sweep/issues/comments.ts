import { commentMarkdown, feedbackPerson, type FeedbackEntry } from "@danielb/gh-shared/gh";

/**
 * How many of an issue's comments count as seen, given who wrote each one.
 *
 * A comment you wrote is not new to you, and neither is anything before it:
 * you read the thread to reply to it. So the seen count moves up to just past
 * your latest comment, and only what others wrote after that stays new. It
 * never moves down, so a deleted comment cannot make old ones new again.
 */
export function seenThroughOwn(authors: readonly string[], seen: number, viewer: string): number {
  const own = viewer.toLowerCase();
  let last = -1;
  authors.forEach((author, index) => {
    if (author.toLowerCase() === own) last = index;
  });
  return Math.max(seen, last + 1);
}

/** One comment on an issue, as the comments drawer in `sweep-ui/feedback` draws it. */
export type IssueComment = Extract<FeedbackEntry, { kind: "comment" }>;

/** How many comments the drawer reads: the latest ones, which hold anything new. */
export const COMMENTS_LIMIT = 50;

export const COMMENTS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      comments(last: ${COMMENTS_LIMIT}) {
        totalCount
        nodes { author { __typename login avatarUrl } body url createdAt }
      }
    }
  }
}`;

interface RawComment {
  author?: { __typename?: string; login?: string; avatarUrl?: string } | null;
  body?: string;
  url?: string;
  createdAt?: string;
}

/**
 * The latest comments, oldest first, each body the Markdown it was written
 * in, and how many the issue has in all. A deleted account's comment keeps
 * its place, under "ghost", so the new ones still line up with the end of the
 * list.
 */
export function parseComments(raw: string): { entries: IssueComment[]; total: number } {
  const parsed = JSON.parse(raw) as {
    data?: {
      viewer?: { login?: string };
      repository?: {
        issue?: { comments?: { totalCount?: number; nodes?: Array<RawComment | null> | null } } | null;
      } | null;
    };
  };
  const viewer = parsed.data?.viewer?.login;
  const connection = parsed.data?.repository?.issue?.comments;
  const entries = (connection?.nodes ?? []).flatMap((node): IssueComment[] => {
    if (!node) return [];
    const at = node.createdAt ? Date.parse(node.createdAt) : NaN;
    return [
      {
        kind: "comment",
        ...(feedbackPerson(node.author, viewer) ?? { author: "ghost", avatarUrl: "" }),
        body: commentMarkdown(node.body),
        url: node.url ?? "",
        at: Number.isNaN(at) ? 0 : at,
      },
    ];
  });
  return { entries, total: connection?.totalCount ?? entries.length };
}
