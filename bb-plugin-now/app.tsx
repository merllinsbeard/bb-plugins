// bb-plugin-now — the Now page: what needs doing now, from every source.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_useAppPanel,
  experimental_useFixedTabTarget,
  useBbNavigate,
  useRealtime,
  useRpc,
  type ExperimentalPluginFixedTabReference,
  type JsonValue,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import { SyncStatus } from "@danielbachhuber/bb-plugin-component-library/sync-status";
import { useThreadStatus } from "@danielbachhuber/bb-plugin-component-library/thread-status";

import type { rpcContract } from "./server";
import { listingSchema, PRIORITIES_CHANNEL, SYNC_CHANNEL, type EmailThread, type Listing } from "./now/contract.js";
import { EmailReader, EmailReaderNote } from "./now/email-reader.js";
import { ItemListView } from "./now/item-list.js";
import { mondayOf, priorityPrompt, priorityThreadId, weekLabel, type PriorityWeek, type StoredPriority } from "./now/priorities.js";
import { PrioritiesColumn, WithPriorities } from "./now/priorities-column.js";
import { latestMessageText } from "./now/email-text.js";
import { ReadingContext, type PendingAction, type RowActions } from "./now/item-row.js";
import { sidebarCounts } from "./now/sections.js";
import { hideSidePanel } from "./now/side-panel.js";
import { navBadgeRedContentScript, needsYouBadge } from "@danielbachhuber/bb-plugin-component-library/nav-badge";
import { useStartThreadBox, type StartThreadDraft } from "@danielbachhuber/bb-plugin-component-library/start-thread";
import { itemOrigin, threadPrompt } from "./now/thread-prompt.js";
import type { Item, TodoistProject } from "./now/types.js";

/** Opening the page syncs a stored list older than this. */
const STALE_ON_OPEN_MS = 60_000;

/** The Email tab in the page's side panel. Its target is the row it shows. */
const EMAIL_TAB: ExperimentalPluginFixedTabReference<{ id: string }> = {
  panelId: "now",
  id: "email",
  experimental_target: {
    validate: (value: JsonValue): value is { id: string } =>
      typeof value === "object" && value !== null && !Array.isArray(value) && typeof value.id === "string",
  },
};

const LISTING_KEY = "bb-plugin-now:listing";

/** The last list any copy of the page read, kept while the app is loaded. */
let lastListing: Listing | null = null;

/** `localStorage`, or nothing where it is unavailable (a storage-blocked tab). */
function listingStore(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * The list the page last read, kept across app loads. Null when there is
 * none, or when it no longer fits the contract after an update.
 */
function storedListing(): Listing | null {
  try {
    const raw = listingStore()?.getItem(LISTING_KEY);
    if (raw == null) return null;
    const parsed = listingSchema.safeParse(JSON.parse(raw));
    // A sync that was running when it was kept is not running now as far as the page knows.
    return parsed.success ? { ...parsed.data, syncing: false } : null;
  } catch {
    return null;
  }
}

function rememberListing(listing: Listing): void {
  lastListing = listing;
  try {
    listingStore()?.setItem(LISTING_KEY, JSON.stringify(listing));
  } catch {
    // Full or blocked storage: the next app load shows Loading for a moment instead.
  }
}

/**
 * The stored list, re-read whenever a sync starts or finishes. The header and
 * the page mount separately, so each runs its own copy; both re-read on the
 * same event, so they cannot disagree for long.
 */
function useListing() {
  const rpc = useRpc<typeof rpcContract>();
  // The last list read, so the page opens on it rather than on Loading while the read runs.
  const [listing, setListing] = useState<Listing | null>(() => (lastListing ??= storedListing()));

  /** Resolves once the listing has been re-read, so a row can wait on it. */
  const load = useCallback(
    () =>
      rpc.call("items_list", null).then((next) => {
        rememberListing(next);
        setListing(next);
      }, () => undefined),
    [rpc],
  );

  useEffect(() => {
    void load();
  }, [load]);
  useRealtime(SYNC_CHANNEL, () => void load());

  return { listing, rpc, load };
}

/** When the list last synced, and the Refresh button, in the page's title bar. */
function SyncHeader() {
  const { listing, rpc } = useListing();
  const [busy, setBusy] = useState(false);

  const onRefresh = useCallback(async () => {
    setBusy(true);
    try {
      const result = await rpc.call("items_sync", null);
      if (result.error !== null) toast.error(result.error);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [rpc]);

  const fetchedAt = listing?.list?.fetchedAt;
  return (
    <SyncStatus
      syncedAt={fetchedAt === undefined ? null : Date.parse(fetchedAt)}
      busy={busy || listing?.syncing === true}
      onRefresh={() => void onRefresh()}
      usage={listing?.usage}
    />
  );
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The row buttons, each one RPC. The quick ones say what they did in a toast
 * with Undo, since a click can land on the wrong row. The page re-reads on the
 * server's signal, so none of them touch local state.
 */
/**
 * Which rows are waiting on a request, and a way to run one. A row stays
 * pending until the re-read listing has landed, so it goes straight from
 * "Completing…" to gone instead of flashing back to its normal state first.
 */
function usePending(load: () => Promise<unknown>) {
  const [pending, setPending] = useState<ReadonlyMap<string, PendingAction>>(() => new Map());

  const run = useCallback(
    async (id: string, action: PendingAction, request: () => Promise<void>) => {
      setPending((current) => new Map(current).set(id, action));
      try {
        await request();
        await load();
      } finally {
        setPending((current) => {
          const next = new Map(current);
          next.delete(id);
          return next;
        });
      }
    },
    [load],
  );

  return { pending, run };
}

type Run = ReturnType<typeof usePending>["run"];

/**
 * Undo from a toast: a loading toast that becomes the result, since the row
 * it restores is not on the page to show a pending state of its own.
 */
function undoAction(label: string, request: () => Promise<{ error: string | null } | void>) {
  return {
    label: "Undo",
    onClick: () => {
      const id = toast.loading(label);
      request().then(
        (result) => {
          if (result && result.error !== null) toast.error(result.error, { id });
          else toast.success("Restored", { id });
        },
        (cause) => toast.error(messageOf(cause), { id }),
      );
    },
  };
}

function useRowActions(
  rpc: ReturnType<typeof useListing>["rpc"],
  run: Run,
  threads: Pick<RowActions, "onStartThread" | "onOpenThread" | "startThreadBox">,
): RowActions {
  return useMemo(() => {
    const fail = (cause: unknown) => toast.error(messageOf(cause));
    const undo = (id: string) => undoAction("Restoring…", () => rpc.call("items_undo", { id }));

    return {
      ...threads,
      onArchive: (item) => {
        void run(item.id, "archive", async () => {
          const result = await rpc.call("items_archive", { id: item.id });
          if (result.error !== null) toast.error(result.error);
          else toast.success("Archived", { action: undo(item.id) });
        }).catch(fail);
      },
      onMarkRead: (item) => {
        void run(item.id, "read", async () => {
          const result = await rpc.call("items_mark_read", { id: item.id });
          if (result.error !== null) toast.error(result.error);
          else toast.success("Marked read", { action: undo(item.id) });
        }).catch(fail);
      },
      onComplete: (item) => {
        void run(item.id, "complete", async () => {
          const result = await rpc.call("items_complete", { id: item.id });
          if (result.error !== null) toast.error(result.error);
          else if (result.undoable) toast.success(`Completed "${item.title}"`, { action: undo(item.id) });
          else toast.success(`Completed "${item.title}". It recurs, so Todoist moved it to its next date.`);
        }).catch(fail);
      },
      onRsvp: (item, response) => {
        void run(item.id, `rsvp:${response}`, async () => {
          const result = await rpc.call("items_rsvp", { id: item.id, response });
          if (result.error !== null) toast.error(result.error);
          else toast.success(`Replied ${response === "accepted" ? "yes" : response === "declined" ? "no" : "maybe"}`);
        }).catch(fail);
      },
      onAcceptProposal: (item) => {
        void run(item.id, "accept", async () => {
          const result = await rpc.call("items_accept_proposal", { id: item.id });
          if (result.error !== null) toast.error(result.error);
          else toast.success("Moved to the proposed time, and emailed the guests");
        }).catch(fail);
      },
      onMerge: (item, method) => {
        void run(item.id, "merge", async () => {
          const result = await rpc.call("items_merge", { id: item.id, method });
          const name = `${item.github?.repo}#${item.github?.number}`;
          if (result.error !== null) toast.error(result.error);
          else if (result.merged) toast.success(`Merged ${name}`);
          else toast.success(`${name} is queued to merge`);
        }).catch(fail);
      },
      onEdit: async (item, draft) => {
        let saved = false;
        await run(item.id, "save", async () => {
          // bb's RPC takes JSON values only, so an unchanged deadline is left out rather than sent as undefined.
          const { deadline, ...rest } = draft;
          const input = deadline === undefined ? { id: item.id, ...rest } : { id: item.id, ...rest, deadline };
          const result = await rpc.call("items_edit", input);
          if (result.error !== null) toast.error(result.error);
          else {
            saved = true;
            toast.success(`Saved "${item.title}"`);
          }
        }).catch(fail);
        return saved;
      },
      onPostpone: (item, day) => {
        void run(item.id, "postpone", async () => {
          const result = await rpc.call("items_postpone", { id: item.id, day });
          if (result.error !== null) toast.error(result.error);
          else toast.success(`Postponed "${item.title}"`);
        }).catch(fail);
      },
      onDelete: (item) => {
        void run(item.id, "delete", async () => {
          const result = await rpc.call("items_delete", { id: item.id });
          if (result.error !== null) toast.error(result.error);
          else toast.success(`Deleted "${item.title}"`);
        }).catch(fail);
      },
      onLoadEmailText: async (item) => {
        try {
          const result = await rpc.call("email_thread", { id: item.id });
          if (result.thread === null) toast.error(result.error ?? "Could not read this email.");
          else {
            const text = latestMessageText(result.thread);
            if (text !== "") return text;
            toast.error("This email has no text to show.");
          }
        } catch (cause) {
          fail(cause);
        }
        return null;
      },
      onLoadComment: async (item, messageId) => {
        try {
          const result = await rpc.call("github_comment", { id: item.id, messageId });
          if (result.error === null) return { comment: result.comment, line: result.line };
          toast.error(result.error);
        } catch (cause) {
          fail(cause);
        }
        return null;
      },
      onReply: async (item, body) => {
        try {
          const result = await rpc.call("items_reply", { id: item.id, body });
          if (result.error !== null) {
            toast.error(result.error);
            return false;
          }
          toast.success(`Commented on ${item.github?.repo}#${item.github?.number}`);
          return true;
        } catch (cause) {
          fail(cause);
          return false;
        }
      },
    };
  }, [rpc, run, threads]);
}

/**
 * Start a thread about a row or a priority: `start` and `startPriority` open
 * bb's composer seeded with it, or close it when it is already open for that
 * one, and `boxFor` draws it under whichever row, priority, or email it is
 * open for.
 */
function useStartThread(rpc: ReturnType<typeof useListing>["rpc"], threadProjectId: string | null) {
  const navigate = useBbNavigate();
  // The open composer, keyed by the id the thread is linked under, with its
  // title for the toast, and the ones whose thread is starting. One scope for
  // the list and the Email tab, so a row starting from either shows in both.
  const box = useStartThreadBox<StartThreadDraft & { title: string }>({
    navigate,
    scope: "now",
    submit: async ({ key }, request) => {
      const result = await rpc.call("items_start_thread", { id: key, request: request as never });
      return { threadId: result.threadId, existing: result.existing, error: result.error };
    },
    announcement: ({ title }, { existing }) =>
      existing ? `Already started a thread for "${title}"` : `Started a thread for "${title}"`,
  });

  const start = useCallback(
    (item: Item) =>
      box.toggle({
        key: item.id,
        draftKey: `now:${item.id}`,
        title: item.title,
        seed: {
          projectId: threadProjectId,
          prompt: threadPrompt(item),
          preview: { title: item.title, url: item.url, meta: itemOrigin(item) },
        },
      }),
    [box, threadProjectId],
  );

  const startPriority = useCallback(
    (monday: string, priority: StoredPriority) => {
      const key = priorityThreadId(monday, priority.text);
      box.toggle({
        key,
        draftKey: `now:${key}`,
        title: priority.text,
        seed: {
          projectId: threadProjectId,
          prompt: priorityPrompt(monday, priority),
          preview: { title: priority.text, url: null, meta: `Priority for the ${weekLabel(monday).replace(/^Week/, "week")}` },
        },
      });
    },
    [box, threadProjectId],
  );

  return { start, startPriority, boxFor: box.boxFor, isStarting: box.isStarting, startedThread: box.startedThread };
}

function NowPage() {
  const { listing, rpc, load } = useListing();
  const { pending, run } = usePending(load);
  const navigate = useBbNavigate();
  const panel = experimental_useAppPanel();
  const reading = experimental_useFixedTabTarget(EMAIL_TAB)?.target.id ?? null;
  const { start, startPriority, boxFor, isStarting, startedThread } = useStartThread(rpc, listing?.threadProjectId ?? null);

  const threadActions = useMemo(
    () => ({
      onOpenThread: (threadId: string) => navigate.toThread(threadId),
      onStartThread: start,
      startThreadBox: (item: Item) => boxFor(item.id),
      isThreadStarting: (item: Item) => isStarting(item.id),
      startedThread: (item: Item) => startedThread(item.id),
    }),
    [boxFor, isStarting, navigate, start, startedThread],
  );
  const rowActions = useRowActions(rpc, run, threadActions);
  // Reading an email marks it read, as opening it in Gmail would.
  const actions = useMemo<RowActions>(
    () => ({
      ...rowActions,
      onRead: (item) => {
        panel.openFixedTab({ surface: { kind: "current" }, tab: EMAIL_TAB, target: { id: item.id } });
        if (item.gmail?.unread !== true) return;
        void run(item.id, "read", async () => {
          const result = await rpc.call("items_mark_read", { id: item.id });
          if (result.error !== null) toast.error(result.error);
        }).catch((cause) => toast.error(messageOf(cause)));
      },
    }),
    [panel, rowActions, rpc, run],
  );

  // Read once per visit, for every Todoist row's project picker.
  const [projects, setProjects] = useState<readonly TodoistProject[] | null>(null);
  const hasTodoist = listing?.list?.items.some((item) => item.source === "todoist") === true;
  useEffect(() => {
    if (!hasTodoist || projects !== null) return;
    rpc.call("todoist_projects", null).then(
      (result) => {
        if (result.error !== null) toast.error(`Todoist projects: ${result.error}`);
        else setProjects(result.projects);
      },
      () => undefined,
    );
  }, [hasTodoist, projects, rpc]);

  // Shows what is stored at once, and brings it up to date behind it. The
  // server skips this when the list is fresh, and joins a sync already running.
  useEffect(() => {
    rpc.call("items_sync", { ifOlderThanMs: STALE_ON_OPEN_MS }).catch(() => undefined);
  }, [rpc]);

  const priorities = usePriorities(rpc);
  // bb's sidebar, already on the page, says what each row's thread is doing.
  const threadStatus = useThreadStatus();

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <ReadingContext.Provider value={reading}>
        <WithPriorities
          priorities={
            priorities.week === null || priorities.week.items.length === 0 ? null : (
              <PrioritiesColumn
                week={priorities.week}
                now={new Date()}
                onToggle={priorities.toggle}
                threads={listing?.threads ?? {}}
                onStartThread={(priority) => startPriority(priorities.week!.monday, priority)}
                renderStartThread={(priority) => boxFor(priorityThreadId(priorities.week!.monday, priority.text))}
                isThreadStarting={(priority) => isStarting(priorityThreadId(priorities.week!.monday, priority.text))}
                startedThread={(priority) => startedThread(priorityThreadId(priorities.week!.monday, priority.text))}
                onOpenThread={(threadId) => navigate.toThread(threadId)}
              />
            )
          }
        >
          <ItemListView
            listing={listing}
            now={new Date()}
            actions={actions}
            pending={pending}
            projects={projects}
            threadStatus={threadStatus}
          />
        </WithPriorities>
      </ReadingContext.Provider>
    </div>
  );
}

/**
 * This week's priorities: one database read on open, again when another
 * plugin writes them, and a check saved at once and undone if it fails.
 */
function usePriorities(rpc: ReturnType<typeof useRpc<typeof rpcContract>>) {
  const [week, setWeek] = useState<PriorityWeek | null>(null);
  const load = useCallback(() => {
    rpc.call("priorities_get", { monday: mondayOf(new Date()) }).then(setWeek, () => undefined);
  }, [rpc]);
  useEffect(load, [load]);
  useRealtime(PRIORITIES_CHANNEL, load);

  const toggle = useCallback(
    (text: string, done: boolean) => {
      if (week === null) return;
      const monday = week.monday;
      const mark = (value: boolean) =>
        setWeek((current) =>
          current === null || current.monday !== monday
            ? current
            : {
                ...current,
                items: current.items.map((each) =>
                  each.text === text ? { ...each, doneAt: value ? (each.doneAt ?? new Date().toISOString()) : null } : each,
                ),
              },
        );
      mark(done);
      rpc.call("priority_done", { monday, text, done }).then(
        (result) => {
          if (result.error === null) return;
          mark(!done);
          toast.error(result.error);
        },
        (cause) => {
          mark(!done);
          toast.error(messageOf(cause));
        },
      );
    },
    [rpc, week],
  );
  return { week, toggle };
}

/**
 * The Email tab: the email row last opened, in full. It fetches the email
 * each time the target changes. Archive and Close both empty it and hide the
 * side panel.
 */
function EmailTab() {
  const { listing, rpc } = useListing();
  const navigate = useBbNavigate();
  const target = experimental_useFixedTabTarget(EMAIL_TAB);
  const id = target?.target.id ?? null;
  const item = id === null ? null : (listing?.list?.items.find((row) => row.id === id) ?? null);
  const { start, boxFor, isStarting } = useStartThread(rpc, listing?.threadProjectId ?? null);
  const [thread, setThread] = useState<{ id: string; thread: EmailThread | null; error: string | null } | null>(null);
  const [archiving, setArchiving] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (id === null) return;
    let current = true;
    setThread(null);
    rpc.call("email_thread", { id }).then(
      (result) => {
        if (current) setThread({ id, ...result });
      },
      (cause) => {
        if (current) setThread({ id, thread: null, error: messageOf(cause) });
      },
    );
    return () => {
      current = false;
    };
  }, [id, rpc]);

  const onArchive = useCallback(async () => {
    if (id === null) return;
    setArchiving(true);
    try {
      const result = await rpc.call("items_archive", { id });
      if (result.error !== null) toast.error(result.error);
      else {
        toast.success("Archived", { action: undoAction("Restoring…", () => rpc.call("items_undo", { id })) });
        hideSidePanel(root.current);
        target?.clear();
      }
    } catch (cause) {
      toast.error(messageOf(cause));
    } finally {
      setArchiving(false);
    }
  }, [id, rpc, target]);

  if (id === null) return <EmailReaderNote>Choose Open on an email to read it here.</EmailReaderNote>;
  if (thread === null || thread.id !== id) return <EmailReaderNote loading>Loading the email…</EmailReaderNote>;
  if (thread.thread === null) return <EmailReaderNote>{thread.error ?? "Could not read this email."}</EmailReaderNote>;
  return (
    <div ref={root} className="h-full">
      <EmailReader
        thread={thread.thread}
        archiving={archiving}
        onArchive={() => void onArchive()}
        onStartThread={item === null ? undefined : () => start(item)}
        startThread={item === null ? null : boxFor(item.id)}
        threadStarting={item !== null && isStarting(item.id)}
        onClose={() => {
          hideSidePanel(root.current);
          target?.clear();
        }}
        onOpenLink={(url) => navigate.openUrl(url)}
      />
    </div>
  );
}

/**
 * Now's badge in bb's sidebar and rail: the urgent count in red, or else the
 * due today count in amber. It re-reads on the same signal as the page, so
 * completing or archiving a row lowers it at once.
 */
function useNowBadge() {
  const { listing } = useListing();
  const { urgent, today } = sidebarCounts(listing?.list?.items ?? [], new Date());
  return needsYouBadge({ urgent, urgentLabel: `${urgent} urgent`, soon: today, soonLabel: `${today} due today` });
}

export default definePluginApp((app) => {
  app.contentScripts.register(navBadgeRedContentScript);
  app.slots.navPanel({
    id: "now",
    title: "Now",
    icon: "Target",
    path: "now",
    component: NowPage,
    headerContent: SyncHeader,
    fixedTabs: [{ ...EMAIL_TAB, title: "Email", icon: "Mail", component: EmailTab, layout: "flush" }],
    experimental_useBadge: useNowBadge,
  });
});
