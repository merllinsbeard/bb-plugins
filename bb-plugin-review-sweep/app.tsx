import { useCallback, useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { HarvestTimerClient } from "bb-plugin-harvest/picker";
import { SyncStatus } from "@danielbachhuber/bb-plugin-component-library/sync-status";
import { useThreadStatus } from "@danielbachhuber/bb-plugin-component-library/thread-status";
import { useLastValue } from "@danielbachhuber/bb-plugin-component-library/last-value";
import {
  useStartThreadBox,
  type StartThreadDraft,
} from "@danielbachhuber/bb-plugin-component-library/start-thread";
import { TooltipProvider } from "@/components/ui/tooltip";
import { displaySection } from "./review/actions.js";
import { describeDay } from "@danielbachhuber/bb-plugin-component-library/parse-day";
import { runOf, sortReviews } from "./review/tiers.js";
import { BatchDialog, type BatchStart } from "./review/batch-dialog.js";
import { navBadgeRedContentScript, needsYouBadge } from "@danielbachhuber/bb-plugin-component-library/nav-badge";
import {
  ReviewListView,
  canBatch,
  type HarvestPanelState,
  type HarvestState,
  type Listing,
  type Row,
} from "./review/list-view.js";
import type { rpcContract } from "./server.js";

/**
 * Adapt this panel's proxy methods onto the picker's transport-agnostic
 * client, which is what lets the picker source be shared verbatim with the
 * Harvest plugin.
 */
function useHarvestClient(rpc: ReturnType<typeof useRpc<typeof rpcContract>>): HarvestTimerClient {
  return useMemo(
    () => ({
      assignments: () => rpc.call("harvestAssignments", null),
      trackedHours: (input) =>
        rpc.call("harvestTrackedHours", {
          externalId: input.externalId,
          groupId: input.groupId ?? null,
        }),
      startTimer: (input) => rpc.call("harvestStartTimer", input),
      lastSelection: (input) => rpc.call("harvestLastSelection", input),
      stopTimer: async (input) => {
        await rpc.call("harvestStopTimer", input);
      },
    }),
    [rpc],
  );
}

/**
 * The stored rows. The page opens on the listing it last read, so it draws
 * at once, and replaces it when this read lands.
 */
function useListing() {
  const rpc = useRpc<typeof rpcContract>();
  const [listing, setListing] = useLastValue<Listing>("bb-plugin-review-sweep:listing");

  const load = useCallback(async () => {
    setListing((await rpc.call("listRows", null)) as Listing);
  }, [rpc, setListing]);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime("reviews-updated", () => {
    void load();
  });

  return { listing, reload: load, rpc };
}

/**
 * Whether the clock shows, and which row's timer is running. Read after the
 * rows, since it waits on the Harvest API, and again on each sweep and timer
 * start. Kept like the listing, so the clocks do not pop in on every open.
 */
function useHarvestState(rpc: ReturnType<typeof useRpc<typeof rpcContract>>) {
  const [state, setState] = useLastValue<HarvestState>("bb-plugin-review-sweep:harvest");

  const load = useCallback(async () => {
    setState(await rpc.call("harvestState", null));
  }, [rpc, setState]);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime("reviews-updated", () => {
    void load();
  });

  return { state, reload: load };
}

/**
 * The sweep's freshness and its refresh control, in the panel's title bar
 * rather than at the top of its body.
 *
 * Mounted separately from the panel, so it runs its own listing subscription.
 * That is the cost of the slot; it is small, and both mounts reload from the
 * same realtime event, so a refresh started here updates the table too.
 */
function SyncHeader() {
  const { listing, reload, rpc } = useListing();
  const [busy, setBusy] = useState(false);

  const onRefresh = useCallback(async () => {
    setBusy(true);
    try {
      const result = await rpc.call("refresh", null);
      if (!result.ok) toast.error(result.error ?? "Sweep failed.");
      await reload();
    } finally {
      setBusy(false);
    }
  }, [reload, rpc]);

  return (
    <SyncStatus
      syncedAt={listing?.sweptAt ?? null}
      usage={listing?.usage}
      busy={busy}
      onRefresh={() => void onRefresh()}
    />
  );
}

function Panel() {
  // bb's sidebar, already on the page, says what each row's thread is doing.
  const threadStatus = useThreadStatus();
  const { listing, reload, rpc } = useListing();
  const harvestClient = useHarvestClient(rpc);
  const harvestState = useHarvestState(rpc);
  const harvest: HarvestPanelState = {
    available: harvestState.state?.available === true,
    running: harvestState.state?.running ?? null,
    client: harvestClient,
    // Starting a timer changes which row is lit.
    onStarted: () => void harvestState.reload(),
  };

  const navigate = useBbNavigate();
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState<Set<string>>(() => new Set());

  // Sampled once per render rather than read inside each row, so every wait in
  // one paint is measured against the same instant.
  const now = Date.now();

  // Opening the pull request or its thread is reading it, so the count it has
  // now is the one seen. Recorded on every open, not only when "N new" shows,
  // so a count that dropped when comments were deleted catches up too. Fire
  // and forget: the link or thread opens either way.
  const markSeen = useCallback(
    (row: Row) => {
      rpc
        .call("markSeen", { repo: row.repo, number: row.number })
        .then(reload)
        // Nothing to show for it: the count catches up on the next open.
        .catch((error: unknown) => console.warn(`could not mark #${row.number} seen`, error));
    },
    [reload, rpc],
  );

  const loadFeedback = useCallback(
    (row: Row) => rpc.call("listFeedback", { repo: row.repo, number: row.number }),
    [rpc],
  );

  const onOpen = useCallback(
    (row: Row, threadId: string) => {
      navigate.toThread(threadId);
      markSeen(row);
    },
    [markSeen, navigate],
  );

  const onNoteSave = useCallback(
    async (row: Row, body: string) => {
      const result = await rpc.call("setNote", { repo: row.repo, number: row.number, body });
      if (!result.ok) {
        toast.error("Could not save the note.");
        return false;
      }
      await reload();
      return true;
    },
    [reload, rpc],
  );

  // The review whose Start thread box is open, with the seeds the backend
  // resolved for it, and the ones whose thread is starting.
  const box = useStartThreadBox<StartThreadDraft & { row: Row }>({
    navigate,
    submit: async ({ row }, request) => {
      const result = await rpc.call("reviewThisSubmit", {
        repo: row.repo,
        number: row.number,
        request: request as never,
      });
      // Read again before the row stops saying Starting, so it goes straight
      // to its thread line rather than back to Start review.
      if (result.threadId) await reload();
      return { threadId: result.threadId, existing: result.existing, error: result.reason };
    },
    announcement: ({ key }, { existing }) => (existing ? null : `Started a review thread for ${key}`),
  });

  const onReview = useCallback(
    (row: Row) => {
      const key = `${row.repo}#${row.number}`;
      // The button that opened the box closes it, as Add note's does.
      if (box.isOpen(key)) {
        box.close();
        return;
      }
      // Mark it starting before awaiting anything, so the button changes on the
      // same tick as the click.
      setStarting((current) => new Set(current).add(key));

      void (async () => {
        try {
          const result = await rpc.call("reviewThisDraft", {
            repo: row.repo,
            number: row.number,
          });
          // A review that already has a thread never composes a second one.
          if (result.existingThreadId) {
            onOpen(row, result.existingThreadId);
            return;
          }
          if (result.seed === null) {
            toast.error(result.reason ?? "Could not start a thread.");
            return;
          }
          box.open({ key, row, seed: result.seed, draftKey: `review-sweep:${key}` });
        } finally {
          setStarting((current) => {
            const next = new Set(current);
            next.delete(key);
            return next;
          });
        }
      })();
    },
    [box, onOpen, rpc],
  );

  const onArchive = useCallback(
    (row: Row) => {
      void (async () => {
        const result = await rpc.call("archiveThread", { repo: row.repo, number: row.number });
        if (result.ok) toast.success(`Archived the thread for ${row.repo}#${row.number}`);
        else toast.error(result.reason ?? "Could not archive the thread.");
        await reload();
      })();
    },
    [reload, rpc],
  );

  const onSnooze = useCallback(
    (row: Row, until: string | null) => {
      void (async () => {
        await rpc.call("snooze", { repo: row.repo, number: row.number, until });
        toast.success(
          until
            ? `Snoozed ${row.repo}#${row.number} until ${describeDay(until, new Date())}`
            : `${row.repo}#${row.number} is back in the list`,
        );
        await reload();
      })();
    },
    [reload, rpc],
  );

  const [batchOpen, setBatchOpen] = useState(false);

  // Starts every ticked review at once. A review that fails stays ticked in
  // the dialog, which stays open to try it again; the ones that started leave
  // the dialog's list as their rows gain a thread.
  const onBatchStart = useCallback(
    async (starts: BatchStart[]) => {
      const keys = starts.map(({ row }) => `${row.repo}#${row.number}`);
      setStarting((current) => new Set([...current, ...keys]));
      try {
        const results = await Promise.all(
          starts.map(({ row, prompt }) =>
            rpc
              .call("reviewBatchStart", { repo: row.repo, number: row.number, prompt })
              .then((result) => ({ row, reason: result.threadId ? null : (result.reason ?? "Could not start a thread.") }))
              .catch((error: unknown) => ({ row, reason: error instanceof Error ? error.message : String(error) })),
          ),
        );
        const failed = results.filter((result) => result.reason !== null);
        const started = results.length - failed.length;
        if (started > 0) toast.success(`Started ${started} review ${started === 1 ? "thread" : "threads"}`);
        for (const { row, reason } of failed) toast.error(`#${row.number}: ${reason}`);
        if (failed.length === 0) setBatchOpen(false);
        await reload();
      } finally {
        setStarting((current) => {
          const next = new Set(current);
          for (const key of keys) next.delete(key);
          return next;
        });
      }
    },
    [reload, rpc],
  );

  const onRefresh = useCallback(async () => {
    setBusy(true);
    try {
      const result = await rpc.call("refresh", null);
      if (!result.ok) toast.error(result.error ?? "Sweep failed.");
      await reload();
    } finally {
      setBusy(false);
    }
  }, [reload, rpc]);

  return (
    <TooltipProvider delayDuration={300}>
      <ReviewListView
        listing={listing}
        now={now}
        starting={starting}
        renderStartThread={(row) => box.boxFor(`${row.repo}#${row.number}`)}
        isThreadStarting={box.isStarting}
        harvest={harvest}
        onReview={onReview}
        onOpen={onOpen}
        onArchive={onArchive}
        onSnooze={onSnooze}
        onNoteSave={onNoteSave}
        onOpenLink={markSeen}
        loadFeedback={loadFeedback}
        onBatch={() => setBatchOpen(true)}
        threadStatus={threadStatus}
      />

      <BatchDialog
        open={batchOpen}
        onOpenChange={setBatchOpen}
        rows={
          listing
            ? sortReviews(listing.rows, { staleAfterDays: listing.staleAfterDays, now }).filter(canBatch)
            : []
        }
        now={now}
        onStart={onBatchStart}
      />

    </TooltipProvider>
  );
}

/**
 * Reviews' badge in bb's sidebar and rail: the requests still to review that
 * have waited too long, in red, as Now counts its urgent rows.
 */
function useReviewsBadge() {
  const { listing } = useListing();
  if (!listing) return null;
  const inputs = { staleAfterDays: listing.staleAfterDays, now: Date.now() };
  const overdue = listing.rows.filter(
    (row) =>
      !row.snoozedUntil &&
      displaySection(Boolean(row.threadId), row.isDraft) === "needs-review" &&
      runOf(row, inputs) === "overdue",
  ).length;
  return needsYouBadge({ urgent: overdue, urgentLabel: `${overdue} waiting too long` });
}

export default definePluginApp((app) => {
  app.contentScripts.register(navBadgeRedContentScript);
  app.slots.navPanel({
    id: "reviews",
    title: "Reviews",
    icon: "Eye",
    path: "reviews",
    component: Panel,
    headerContent: SyncHeader,
    experimental_useBadge: useReviewsBadge,
  });
});
