import { useEffect, useRef, useState, type ComponentType } from "react";

import { Icon } from "./icons";
import { BLUE_TEXT, type SweepLinkProps } from "./row";
import { cn } from "./lib/cn";

/**
 * The drawer a row's comment count opens: what people left on the pull
 * request, each entry a link to it on GitHub, oldest first. An inline comment
 * sits in a card headed by its file and line; reviews and top-level comments
 * do not. Yours and bots' carry a "you" or "bot" label. Each body is drawn as
 * the Markdown it was written in, cut at three lines with Show more under it
 * when it runs longer. The ones that arrived since it was last seen can be
 * marked new. Resolved threads wait
 * behind a toggle at the end. A long list opens on its newest entries, with
 * the earlier ones behind a button at the top.
 */

/** One entry, as `fetchFeedback` in `@danielb/gh-shared/gh` reads it. Each `body` is Markdown. */
export type FeedbackEntry =
  | {
      kind: "review";
      author: string;
      avatarUrl: string;
      bot?: boolean;
      you?: boolean;
      state: "changes_requested" | "approved" | "commented";
      body: string;
      url: string;
      at: number;
    }
  | {
      kind: "thread";
      author: string;
      avatarUrl: string;
      bot?: boolean;
      you?: boolean;
      path: string;
      line: number | null;
      status: "unanswered" | "replied" | "waiting" | "resolved";
      outdated: boolean;
      replies: number;
      body: string;
      url: string;
      at: number;
    }
  | {
      kind: "comment";
      author: string;
      avatarUrl: string;
      bot?: boolean;
      you?: boolean;
      body: string;
      url: string;
      at: number;
    };

export type FeedbackResult = {
  entries: FeedbackEntry[];
  /** How many the conversation has in all, when `entries` is only the latest of them. */
  total?: number;
  error: string | null;
};

function Label({ children }: { children: string }) {
  return <span className="rounded bg-surface-selected px-1 text-[10px] font-normal text-muted-foreground">{children}</span>;
}

function Who({ entry }: { entry: FeedbackEntry }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="inline-flex items-center gap-1 font-medium text-foreground">
      {entry.avatarUrl && !failed ? (
        <img src={entry.avatarUrl} alt="" loading="lazy" onError={() => setFailed(true)} className="size-3.5 rounded-full bg-surface-selected" />
      ) : null}
      {entry.author}
      {entry.bot ? <Label>bot</Label> : null}
      {entry.you ? <Label>you</Label> : null}
    </span>
  );
}

const REVIEW_TEXT = {
  changes_requested: <span className="font-medium text-destructive-text">requested changes</span>,
  approved: <span className="text-success">approved</span>,
  commented: <span>reviewed</span>,
} as const;

const THREAD_TEXT = { replied: "you replied", waiting: "waiting on a reply", resolved: "resolved" } as const;

/** What the entry did or where it stands, and when: "unanswered · 1 reply · 2d ago · new". */
function Context({ entry, age, isNew }: { entry: FeedbackEntry; age: (at: number) => string; isNew: boolean }) {
  const parts =
    entry.kind === "review"
      ? [REVIEW_TEXT[entry.state], <span>{age(entry.at)}</span>]
      : entry.kind === "comment"
        ? [<span>commented</span>, <span>{age(entry.at)}</span>]
        : [
            entry.status === "unanswered" ? (
              <span className="font-medium text-destructive-text">unanswered</span>
            ) : (
              <span>{THREAD_TEXT[entry.status]}</span>
            ),
            ...(entry.outdated ? [<span>outdated</span>] : []),
            ...(entry.replies > 0 ? [<span>{entry.replies === 1 ? "1 reply" : `${entry.replies} replies`}</span>] : []),
            <span>{age(entry.at)}</span>,
          ];
  if (isNew) parts.push(<span className={cn("font-medium", BLUE_TEXT)}>new</span>);
  return (
    <>
      {parts.map((part, index) => (
        <span key={index} className="inline-flex items-center gap-1.5">
          {index > 0 ? <span aria-hidden="true">·</span> : null}
          {part}
        </span>
      ))}
    </>
  );
}

/**
 * Whether a body runs past its three lines, checked in a ResizeObserver
 * callback, which runs after layout and so reads sizes without making the
 * page lay out again. It watches the clamped box and the content inside it,
 * which grows when bb's Markdown finishes rendering while the box does not.
 * Showing the toggle changes neither.
 */
function useClamped(open: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [clamped, setClamped] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (element === null || open || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setClamped(element.scrollHeight > element.clientHeight + 1));
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [open]);
  return { ref, clamped };
}

/** bb's `Markdown` from `@get-bb/plugin-sdk/app`, which this package cannot import itself. */
export type FeedbackMarkdown = ComponentType<{ content: string; className?: string }>;

/** Compact Markdown, in the drawer's own text size. */
const MARKDOWN_CLASS =
  "text-xs leading-normal text-foreground [&_:is(p,ul,ol,pre,blockquote,h1,h2,h3,h4,h5,h6,table)]:mb-1.5 [&_:is(p,ul,ol,li,h1,h2,h3,h4,h5,h6,td,th)]:text-xs [&_li]:mb-0 [&>*:last-child]:mb-0";

/**
 * An inline comment in a card headed by its file and line; anything else as a
 * plain row. The heading links to GitHub. The body is the Markdown it was
 * written in, outside the link, so its own links work and its text can be
 * selected, and Show more opens it in place.
 */
function Entry({
  entry,
  isNew,
  age,
  Link,
  Markdown,
}: {
  entry: FeedbackEntry;
  isNew: boolean;
  age: (at: number) => string;
  Link: ComponentType<SweepLinkProps>;
  Markdown: FeedbackMarkdown;
}) {
  const [open, setOpen] = useState(false);
  const { ref, clamped } = useClamped(open);
  const heading = (
    <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
      <Who entry={entry} />
      <Context entry={entry} age={age} isNew={isNew} />
    </span>
  );
  const body = entry.body ? (
    <div ref={ref} className={open ? "mt-0.5" : "mt-0.5 line-clamp-3"}>
      <div>
        <Markdown content={entry.body} className={MARKDOWN_CLASS} />
      </div>
    </div>
  ) : null;
  const toggle =
    open || clamped ? (
      <button
        type="button"
        className="-mx-1 mt-0.5 rounded px-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={() => setOpen(!open)}
      >
        {open ? "Show less" : "Show more"}
      </button>
    ) : null;
  if (entry.kind !== "thread") {
    return (
      <li className="px-2 py-1.5">
        <Link href={entry.url} className="block rounded hover:underline">
          {heading}
        </Link>
        {body}
        {toggle}
      </li>
    );
  }
  return (
    <li className="py-0.5">
      <div className="overflow-hidden rounded border border-border bg-background">
        <Link href={entry.url} className="block hover:bg-accent">
          <span className="block border-b border-border bg-muted/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
            {entry.path}
            {entry.line !== null ? `:${entry.line}` : ""}
          </span>
          <span className="block px-2 pt-1.5">{heading}</span>
        </Link>
        <div className="px-2 pb-1.5">
          {body}
          {toggle}
        </div>
      </div>
    </li>
  );
}

export interface FeedbackListProps {
  entries: FeedbackEntry[];
  /** How long ago a time was, in the plugin's own words: "2d ago". */
  age: (at: number) => string;
  /** The pull request or issue, for the link at the bottom. */
  url: string;
  /** How many of the latest entries to mark new. */
  newCount?: number;
  /**
   * How many the conversation has in all, when `entries` is only the latest
   * of them. The link at the bottom then says "Open all N on GitHub".
   */
  total?: number;
  Link: ComponentType<SweepLinkProps>;
  /** Draws each body: pass bb's `Markdown` from `@get-bb/plugin-sdk/app`. */
  Markdown: FeedbackMarkdown;
}

/** How many of the newest entries show before "Show N earlier". */
export const RECENT_FEEDBACK = 10;

/**
 * The entries as they come, with resolved threads folded behind a toggle and
 * all but the newest `RECENT_FEEDBACK` behind "Show N earlier". The last
 * `newCount` are marked new.
 */
export function FeedbackList({ entries, age, url, newCount = 0, total, Link, Markdown }: FeedbackListProps) {
  const [showResolved, setShowResolved] = useState(false);
  const [showEarlier, setShowEarlier] = useState(false);
  const resolved = entries.filter((entry) => entry.kind === "thread" && entry.status === "resolved");
  const unfolded = showResolved ? entries : entries.filter((entry) => !resolved.includes(entry));
  const earlier = showEarlier ? 0 : Math.max(0, unfolded.length - RECENT_FEEDBACK);
  const shown = unfolded.slice(earlier);
  const firstNew = entries.length - newCount;
  return (
    <>
      {earlier > 0 ? (
        <div className="mb-1.5 border-b border-border pb-1.5 text-xs text-muted-foreground">
          <button
            type="button"
            className="-mx-1 rounded px-1 hover:bg-accent hover:text-foreground"
            onClick={() => setShowEarlier(true)}
          >
            Show {earlier} earlier
          </button>
        </div>
      ) : null}
      {shown.length > 0 ? (
        <ul className="-mx-2 space-y-0.5">
          {shown.map((entry, index) => (
            <Entry
              key={`${entry.url}-${index}`}
              entry={entry}
              isNew={entries.indexOf(entry) >= firstNew}
              age={age}
              Link={Link}
              Markdown={Markdown}
            />
          ))}
        </ul>
      ) : (
        <p className="py-1 text-xs text-muted-foreground">{entries.length === 0 ? "No comments yet." : "Nothing open."}</p>
      )}
      <div className="mt-1.5 flex items-center gap-3 border-t border-border pt-1.5 text-xs text-muted-foreground">
        <Link href={url} className="inline-flex items-center gap-1 hover:text-foreground hover:underline">
          {total !== undefined && total > entries.length ? `Open all ${total} on GitHub` : "Open the conversation on GitHub"}
          <Icon name="ArrowUpRight" className="size-3" />
        </Link>
        {resolved.length > 0 ? (
          <button
            type="button"
            className="-mx-1 rounded px-1 hover:bg-accent hover:text-foreground"
            onClick={() => setShowResolved(!showResolved)}
          >
            {showResolved ? "Hide resolved" : `${resolved.length} resolved`}
          </button>
        ) : null}
      </div>
    </>
  );
}

export interface FeedbackDrawerProps {
  /** Reads the entries. Called once, when the drawer opens. */
  load: () => Promise<FeedbackResult>;
  age: (at: number) => string;
  url: string;
  /** How many of the latest entries to mark new, as it was when the drawer opened. */
  newCount?: number;
  Link: ComponentType<SweepLinkProps>;
  Markdown: FeedbackMarkdown;
}

/** Loads the entries when it mounts, then draws them. */
export function FeedbackDrawer({ load, age, url, newCount = 0, Link, Markdown }: FeedbackDrawerProps) {
  const [result, setResult] = useState<FeedbackResult | null>(null);
  // Held from the open, since reading the comments can mark them seen and the count drop to zero.
  const [shownNew] = useState(newCount);
  useEffect(() => {
    let live = true;
    load()
      .then((loaded) => live && setResult(loaded))
      .catch(() => live && setResult({ entries: [], error: "Could not read the comments from GitHub." }));
    return () => {
      live = false;
    };
    // Once per open: the drawer remounts when it is opened again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
      {result === null ? (
        <p className="inline-flex items-center gap-1.5 py-1 text-xs text-muted-foreground">
          <Icon name="Spinner" className="size-3 animate-spin" />
          Reading comments…
        </p>
      ) : result.error ? (
        <p className="py-1 text-xs text-destructive-text">{result.error}</p>
      ) : (
        <FeedbackList
          entries={result.entries}
          total={result.total}
          newCount={shownNew}
          age={age}
          url={url}
          Link={Link}
          Markdown={Markdown}
        />
      )}
    </div>
  );
}
