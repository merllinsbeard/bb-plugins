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
import { OpenPullRequestPage } from "./sweep/open-panel.js";
import {
  FIXED_ENVIRONMENT_CSS,
  useStartThreadBox,
  type StartThreadDraft,
} from "@danielbachhuber/bb-plugin-component-library/start-thread";
import { TooltipProvider } from "@/components/ui/tooltip";
import { sectionForRow } from "./sweep/actions.js";
import { navBadgeRedContentScript, needsYouBadge } from "@danielbachhuber/bb-plugin-component-library/nav-badge";
import {
  PrListView,
  type HarvestPanelState,
  type HarvestState,
  type Listing,
  type Row,
} from "./sweep/list-view.js";
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
  const [listing, setListing] = useLastValue<Listing>("bb-plugin-pr-sweep:listing");

  const load = useCallback(async () => {
    setListing((await rpc.call("listRows", null)) as Listing);
  }, [rpc, setListing]);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime("prs-updated", () => {
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
  const [state, setState] = useLastValue<HarvestState>("bb-plugin-pr-sweep:harvest");

  const load = useCallback(async () => {
    setState(await rpc.call("harvestState", null));
  }, [rpc, setState]);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime("prs-updated", () => {
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

  const onDismissChecks = useCallback(
    async (row: Row, dismissed: boolean) => {
      const result = await rpc.call("dismissChecks", { repo: row.repo, number: row.number, dismissed });
      if (!result.ok) {
        toast.error(dismissed ? "Could not dismiss the failing checks." : "Could not restore the failing checks.");
        return;
      }
      await reload();
    },
    [reload, rpc],
  );

  // The pull request whose Start thread box is open, with the seeds the
  // backend resolved for it, and the ones whose thread is starting.
  const box = useStartThreadBox<StartThreadDraft & { row: Row }>({
    navigate,
    submit: async ({ row, seed }, request) => {
      const result = await rpc.call("workOnThisSubmit", {
        repo: row.repo,
        number: row.number,
        request: request as never,
        onBranch: Boolean(seed.workspace?.branch),
      });
      // Read again before the row stops saying Starting, so it goes straight
      // to its thread line rather than back to Start thread.
      if (result.threadId) await reload();
      return { threadId: result.threadId, existing: result.existing, error: result.reason };
    },
    announcement: ({ key }, { existing }) => (existing ? null : `Started a thread for ${key}`),
  });

  const onWork = useCallback(
    (row: Row) => {
      const key = `${row.repo}#${row.number}`;
      // The button that opened the box closes it, as Add note's does.
      if (box.isOpen(key)) {
        box.close();
        return;
      }
      // Mark it starting before awaiting anything, so the button changes on
      // the same tick as the click.
      setStarting((current) => new Set(current).add(key));

      void (async () => {
        try {
          const result = await rpc.call("workOnThisDraft", {
            repo: row.repo,
            number: row.number,
          });
          // A pull request that already has a thread never composes a second one.
          if (result.existingThreadId) {
            navigate.toThread(result.existingThreadId);
            return;
          }
          if (result.seed === null) {
            toast.error(result.reason ?? "Could not start a thread.");
            return;
          }
          box.open({ key, row, seed: result.seed, draftKey: `pr-sweep:${key}` });
        } catch (error) {
          // Most often the plugin itself is down, and a click that does
          // nothing is the only other evidence of it.
          const message = error instanceof Error ? error.message : String(error);
          toast.error(`Could not start a thread: ${message}`);
        } finally {
          setStarting((current) => {
            const next = new Set(current);
            next.delete(key);
            return next;
          });
        }
      })();
    },
    [box, navigate, rpc],
  );

  const onArchive = useCallback(
    (row: Row) => {
      void (async () => {
        const result = await rpc.call("archiveThread", {
          repo: row.repo,
          number: row.number,
        });
        if (result.ok) toast.success(`Archived the thread for ${row.repo}#${row.number}`);
        else toast.error(result.reason ?? "Could not archive the thread.");
        await reload();
      })();
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
      <PrListView
        listing={listing}
        now={Date.now()}
        starting={starting}
        renderStartThread={(row) => box.boxFor(`${row.repo}#${row.number}`)}
        isThreadStarting={box.isStarting}
        harvest={harvest}
        onWork={onWork}
        onOpen={onOpen}
        onArchive={onArchive}
        onNoteSave={onNoteSave}
        onDismissChecks={onDismissChecks}
        onOpenLink={markSeen}
        loadFeedback={loadFeedback}
        threadStatus={threadStatus}
      />

    </TooltipProvider>
  );
}

/** Pull requests' badge in bb's sidebar and rail: the rows that need you, in red. */
function usePrsBadge() {
  const { listing } = useListing();
  const needYou = listing?.rows.filter((row) => sectionForRow(row) === "needs-action").length ?? 0;
  return needsYouBadge({ urgent: needYou, urgentLabel: `${needYou} need you` });
}

export default definePluginApp((app) => {
  // The Start thread box marks a composer whose environment this plugin decides; this
  // hides that composer's pickers, which would otherwise offer choices the
  // server ignores.
  app.contentScripts.register({
    id: "hide-fixed-environment-pickers",
    mount({ signal }) {
      const style = document.createElement("style");
      style.dataset.prSweep = "hide-fixed-environment-pickers";
      style.textContent = FIXED_ENVIRONMENT_CSS;
      document.head.appendChild(style);
      const remove = () => style.remove();
      signal.addEventListener("abort", remove, { once: true });
      return remove;
    },
  });

  app.contentScripts.register(navBadgeRedContentScript);

  app.slots.navPanel({
    id: "open-pr",
    title: "Open pull request",
    icon: "FolderGit",
    path: "open-pr",
    component: OpenPullRequestPage,
  });

  app.slots.navPanel({
    id: "prs",
    title: "Pull requests",
    icon: "GitPullRequest",
    path: "prs",
    component: Panel,
    headerContent: SyncHeader,
    experimental_useBadge: usePrsBadge,
  });
});