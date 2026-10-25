import { useCallback, useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { SyncStatus } from "@danielbachhuber/bb-plugin-component-library/sync-status";
import { useThreadStatus } from "@danielbachhuber/bb-plugin-component-library/thread-status";
import { useLastValue } from "@danielbachhuber/bb-plugin-component-library/last-value";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  useStartThreadBox,
  type StartThreadDraft,
} from "@danielbachhuber/bb-plugin-component-library/start-thread";
import type { HarvestTimerClient } from "bb-plugin-harvest/picker";
import type { rpcContract } from "./server.js";
import {
  IssueListView,
  type HarvestPanelState,
  type HarvestState,
  type Listing,
  type Row,
} from "./issues/list-view.js";

/**
 * The stored rows. The page opens on the listing it last read, so it draws
 * at once, and replaces it when this read lands.
 */
function useListing() {
  const rpc = useRpc<typeof rpcContract>();
  const [listing, setListing] = useLastValue<Listing>("bb-plugin-issue-sweep:listing");

  const load = useCallback(async () => {
    setListing((await rpc.call("listRows", null)) as Listing);
  }, [rpc, setListing]);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime("issues-updated", () => {
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
  const [state, setState] = useLastValue<HarvestState>("bb-plugin-issue-sweep:harvest");

  const load = useCallback(async () => {
    setState(await rpc.call("harvestState", null));
  }, [rpc, setState]);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime("issues-updated", () => {
    void load();
  });

  return { state, reload: load };
}

/**
 * Adapt Issue Sweep's proxy methods onto the picker's transport-agnostic
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
  const [busy, setBusy] = useState(false);
  // Per-row, not one flag: two statuses can be set in quick succession and a
  // single flag would lock the whole table for the first one.
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(new Set());
  const [starting, setStarting] = useState<ReadonlySet<string>>(new Set());
  const navigate = useBbNavigate();

  // Opening the issue or its thread is reading it, so the count it has now is
  // the one seen. Recorded on every open, not only when "N new" shows, so a
  // count that dropped when comments were deleted catches up too. Fire and
  // forget: the link or thread opens either way.
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

  const loadComments = useCallback(
    (row: Row) => rpc.call("listComments", { repo: row.repo, number: row.number }),
    [rpc],
  );

  const onOpen = useCallback(
    (row: Row) => {
      if (row.threadId) navigate.toThread(row.threadId);
      markSeen(row);
    },
    [markSeen, navigate],
  );

  const onNoteSave = useCallback(
    async (row: Row, body: string, onHold: boolean) => {
      const result = await rpc.call("setNote", { repo: row.repo, number: row.number, body, onHold });
      if (!result.ok) {
        toast.error("Could not save the note.");
        return false;
      }
      await reload();
      return true;
    },
    [reload, rpc],
  );

  const harvestClient = useHarvestClient(rpc);
  const harvestState = useHarvestState(rpc);
  const harvest: HarvestPanelState = {
    available: harvestState.state?.available === true,
    running: harvestState.state?.running ?? null,
    client: harvestClient,
    // Starting a timer changes which row is lit.
    onStarted: () => void harvestState.reload(),
  };

  // The issue whose Start thread box is open, with the seeds the backend
  // resolved for it, and the ones whose thread is starting.
  const box = useStartThreadBox<StartThreadDraft & { row: Row }>({
    navigate,
    submit: async ({ row }, request) => {
      const result = await rpc.call("startThreadSubmit", {
        repo: row.repo,
        number: row.number,
        request: request as never,
      });
      // Read again before the row stops saying Starting, so it goes straight
      // to its thread line rather than back to Start thread.
      if (result.threadId) await reload();
      return { threadId: result.threadId, existing: result.existing, error: result.reason };
    },
    announcement: ({ key }, { existing }) => (existing ? null : `Started a thread for ${key}`),
  });

  const onStart = useCallback(
    (row: Row) => {
      const key = `${row.repo}#${row.number}`;
      // The button that opened the box closes it, as Add note's does.
      if (box.isOpen(key)) {
        box.close();
        return;
      }
      // Marked before awaiting anything, so the button changes on the same tick
      // as the click rather than after the draft returns.
      setStarting((keys) => new Set(keys).add(key));

      void (async () => {
        try {
          const result = await rpc.call("startThreadDraft", {
            repo: row.repo,
            number: row.number,
          });
          // An issue that already has a thread never composes a second one.
          if (result.existingThreadId) {
            navigate.toThread(result.existingThreadId);
            return;
          }
          if (result.seed === null) {
            toast.error(result.reason ?? "Could not start a thread.");
            return;
          }
          box.open({ key, row, seed: result.seed, draftKey: `issue-sweep:${key}` });
        } finally {
          setStarting((keys) => {
            const next = new Set(keys);
            next.delete(key);
            return next;
          });
        }
      })();
    },
    [box, navigate, rpc],
  );

  const onPick = useCallback(
    async (row: Row, status: string) => {
      const key = `${row.repo}#${row.number}`;
      setBusyKeys((keys) => new Set(keys).add(key));
      try {
        const result = await rpc.call("setBoardStatus", {
          repo: row.repo,
          number: row.number,
          status,
        });
        if (!result.ok) {
          toast.error(result.error ?? "Could not update the board.");
          return;
        }
        toast.success(
          result.added
            ? `Added #${row.number} to the board as ${status}.`
            : `#${row.number} is now ${status}.`,
        );
        await reload();
      } finally {
        setBusyKeys((keys) => {
          const next = new Set(keys);
          next.delete(key);
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
    // 300ms matches the other two panels, so a tooltip in any of them waits
    // the same beat before appearing.
    <TooltipProvider delayDuration={300}>
      <IssueListView
        listing={listing}
        now={Date.now()}
        busyKeys={busyKeys}
        starting={starting}
        renderStartThread={(row) => box.boxFor(`${row.repo}#${row.number}`)}
        isThreadStarting={box.isStarting}
        harvest={harvest}
        onPick={(row, status) => void onPick(row, status)}
        onStart={onStart}
        onOpen={onOpen}
        onNoteSave={onNoteSave}
        onOpenLink={markSeen}
        loadComments={loadComments}
        threadStatus={threadStatus}
      />

    </TooltipProvider>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "issues",
    title: "Issues",
    icon: "ListTodo",
    path: "issues",
    component: Panel,
    headerContent: SyncHeader,
  });
});
