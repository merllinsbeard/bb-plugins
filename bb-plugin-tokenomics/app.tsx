// bb-plugin-tokenomics — the Tokenomics page, the thread header's token count,
// and the context meter above a thread's composer.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useComposerView,
  useRealtime,
  useRpc,
  experimental_useProviders,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";

import { SidebarLevels } from "@danielbachhuber/bb-plugin-component-library/sidebar-count";

import { ContextMeter } from "@/components/context-meter";
import { ThreadTokenCount, type ThreadTokens } from "@/components/thread-token-count";
import { TopBarLimits, urgentSession } from "@/components/limit-spark";
import { UsageView, type UsageData } from "@/components/usage-view";
import { TopBarSlot } from "@danielbachhuber/bb-plugin-component-library/top-bar";

import type { rpcContract } from "./server";
import { contextLevel, type ContextThresholds } from "./usage/context.js";
import { CONTEXT_CHANNEL, LIMITS_CHANNEL, USAGE_CHANNEL } from "./usage/channels.js";
import type { Limit, TurnDetail } from "./usage/contract.js";
import { fillBars, windowFor, type Bar, type RangeId } from "./usage/series.js";

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The window's usage, re-read whenever the server records more. */
function useUsage(range: RangeId) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    const span = windowFor(range, new Date());
    rpc.call("usage_window", { since: span.since }).then(
      (result) => {
        setData({
          since: span.since,
          bars: fillBars(span.bars, result.hours),
          unit: span.unit,
          threads: result.threads,
          recordingSince: result.recordingSince,
          contextThresholds: result.contextThresholds,
          turnTime: result.turnTime,
        });
        setError(null);
      },
      (cause) => setError(messageOf(cause)),
    );
  }, [rpc, range]);

  useEffect(() => {
    setData(null);
    load();
  }, [load]);
  // The newest bar keeps filling while a thread runs, and the window slides
  // forward every hour, so re-read on new usage and once a minute.
  useRealtime(USAGE_CHANNEL, load);
  useEffect(() => {
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [load]);

  return { data, error };
}

/** The subscriptions' usage limits, re-read after each reading the server stores and each turn's usage. */
function useLimits(): Limit[] {
  const rpc = useRpc<typeof rpcContract>();
  const [limits, setLimits] = useState<Limit[]>([]);
  const refresh = useRef<(() => void) | null>(null);
  const load = useCallback(() => refresh.current?.(), []);
  useEffect(() => {
    let active = true;
    let inFlight = false;
    let dirty = false;
    const read = async () => {
      if (!active) return;
      dirty = true;
      if (inFlight) return;
      inFlight = true;
      while (active && dirty) {
        dirty = false;
        try {
          const result = await rpc.call("usage_limits", null);
          if (active) setLimits(result.limits);
        } catch {
          // Keep the last reading until a later refresh succeeds.
        }
      }
      inFlight = false;
    };
    refresh.current = read;
    load();
    return () => {
      active = false;
      dirty = false;
      refresh.current = null;
    };
  }, [rpc, load]);
  useRealtime(LIMITS_CHANNEL, load);
  // The past hour's tokens and the session's spark change with each turn.
  useRealtime(USAGE_CHANNEL, load);
  return limits;
}

/**
 * The past day's tokens per hour for the title bar's popover, read from
 * Tokenomics' own database each time the popover opens.
 */
function usePastDayBars() {
  const rpc = useRpc<typeof rpcContract>();
  const [bars, setBars] = useState<Bar[] | null>(null);
  const load = useCallback(() => {
    const span = windowFor("day", new Date());
    rpc.call("usage_hours", { since: span.since }).then(
      (result) => setBars(fillBars(span.bars, result.hours)),
      () => undefined,
    );
  }, [rpc]);
  return { bars, load };
}

function useProviderName() {
  const providers = experimental_useProviders();
  return (providerId: string) =>
    providers.providers.find((provider) => provider.id === providerId)?.displayName ?? providerId;
}

/**
 * The session in bb's title bar, after the other plugins' buttons: its spark
 * chart, rings for the session's and the week's percent used, the page's
 * meters and the past day's chart on hover, and the page on click. With two
 * subscriptions it shows the one closer to its limit. Draws nothing until a
 * provider reports a session.
 */
function LimitsTopBar() {
  const limits = useLimits();
  const providerName = useProviderName();
  const navigate = useBbNavigate();
  const pastDay = usePastDayBars();
  // The spark's empty slots are the time left, so it redraws as time passes.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const session = urgentSession(limits);
  if (session === null) return null;
  const account = limits.filter(
    (limit) => limit.providerId === session.providerId && limit.accountKey === session.accountKey,
  );
  return (
    <TopBarSlot pluginId="tokenomics" order={4} activeOn={["/plugins/tokenomics/tokenomics"]}>
      <TopBarLimits
        session={session}
        limits={account}
        now={now}
        providerName={providerName}
        onOpen={() => navigate.toPluginPanel("tokenomics")}
        bars={pastDay.bars}
        onHover={pastDay.load}
      />
    </TopBarSlot>
  );
}

function TokenomicsPage() {
  const [range, setRange] = useState<RangeId>("day");
  const { data, error } = useUsage(range);
  const limits = useLimits();
  const providerName = useProviderName();
  const navigate = useBbNavigate();
  return (
    <UsageView
      range={range}
      onRange={setRange}
      data={data}
      error={error}
      onOpenThread={(threadId) => navigate.toThread(threadId)}
      limits={limits}
      providerName={providerName}
    />
  );
}

const plural = (count: number) => `${count} ${count === 1 ? "thread" : "threads"}`;

/**
 * Beside Tokenomics in the sidebar: how many active threads have their
 * context past the warning, in amber, and past the error, in red. Re-read
 * when a context size or an archive is recorded, and once a minute for a
 * changed setting.
 */
function ContextLevelsAccessory() {
  const rpc = useRpc<typeof rpcContract>();
  const [levels, setLevels] = useState<{ warning: number; error: number } | null>(null);
  const load = useCallback(() => {
    rpc.call("context_levels", null).then(setLevels, () => undefined);
  }, [rpc]);
  useEffect(() => {
    load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [load]);
  useRealtime(CONTEXT_CHANNEL, load);
  useRealtime(USAGE_CHANNEL, load);
  if (levels === null) return null;
  return (
    <SidebarLevels
      warning={levels.warning}
      error={levels.error}
      warningLabel={`${plural(levels.warning)} past the context warning`}
      errorLabel={`${plural(levels.error)} past the context limit`}
    />
  );
}

function isForThread(payload: unknown, threadId: string): boolean {
  const ids = (payload as { threadIds?: unknown } | null)?.threadIds;
  return Array.isArray(ids) && ids.includes(threadId);
}

function ThreadTokensAction({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [usage, setUsage] = useState<ThreadTokens | null>(null);
  // Loaded when the summary first opens, because it reads bb's turn events.
  const [turns, setTurns] = useState<TurnDetail[] | null>(null);
  const [wantsTurns, setWantsTurns] = useState(false);

  const load = useCallback(() => {
    rpc.call("thread_usage", { threadId }).then(setUsage, () => undefined);
  }, [rpc, threadId]);
  const loadTurns = useCallback(() => {
    rpc.call("thread_turns", { threadId }).then(({ turns: loaded }) => setTurns(loaded), () => undefined);
  }, [rpc, threadId]);

  useEffect(() => {
    setUsage(null);
    setTurns(null);
    setWantsTurns(false);
    load();
  }, [load]);
  useEffect(() => {
    if (wantsTurns) loadTurns();
  }, [wantsTurns, loadTurns]);
  const onChange = useMemo(
    () => (payload: unknown) => {
      if (!isForThread(payload, threadId)) return;
      load();
      if (wantsTurns) loadTurns();
    },
    [load, loadTurns, threadId, wantsTurns],
  );
  useRealtime(USAGE_CHANNEL, onChange);

  if (usage === null || usage.total === 0) return null;
  return (
    <ThreadTokenCount
      usage={usage}
      turns={turns}
      onOpen={() => setWantsTurns(true)}
      isCompactViewport={isCompactViewport}
      onOpenPage={() => navigate.toPluginPanel("tokenomics")}
    />
  );
}

interface ContextState {
  context: { usedTokens: number; contextWindow: number | null; at: number } | null;
  lastTurn: number | null;
  thresholds: ContextThresholds;
  archived: boolean;
}

/** The meter above the composer, drawn only once the thread's context passes the setting. */
function ContextMeterBanner() {
  const view = useComposerView();
  const threadId = view.scope.kind === "thread" ? view.scope.threadId : null;
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<ContextState | null>(null);
  // When Compact was pressed; cleared once a newer context size arrives.
  const [requestedAt, setRequestedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(threadId);
  current.current = threadId;

  const load = useCallback(() => {
    if (threadId === null) return;
    rpc.call("thread_context", { threadId }).then(
      (next: ContextState) => {
        if (current.current === threadId) setState(next);
      },
      () => undefined,
    );
  }, [rpc, threadId]);

  useEffect(() => {
    setState(null);
    setRequestedAt(null);
    setError(null);
    load();
  }, [load]);
  const onChange = useMemo(
    () => (payload: unknown) => {
      if (threadId !== null && isForThread(payload, threadId)) load();
    },
    [load, threadId],
  );
  useRealtime(CONTEXT_CHANNEL, onChange);
  useRealtime(USAGE_CHANNEL, onChange);

  useEffect(() => {
    if (requestedAt !== null && state?.context != null && state.context.at > requestedAt) setRequestedAt(null);
  }, [requestedAt, state]);

  if (threadId === null || state === null || state.archived) return null;
  if (state.context === null) return null;
  const level = contextLevel(state.context.usedTokens, state.thresholds);
  if (level === null) return null;

  const onCompact = () => {
    setError(null);
    setRequestedAt(Date.now());
    rpc.call("compact_thread", { threadId }).catch((cause: unknown) => {
      setRequestedAt(null);
      setError(messageOf(cause));
    });
  };

  return (
    <ContextMeter
      usedTokens={state.context.usedTokens}
      contextWindow={state.context.contextWindow}
      thresholds={state.thresholds}
      level={level}
      lastTurn={state.lastTurn}
      running={view.run.isRunning}
      compacting={requestedAt !== null}
      error={error}
      compact={view.layout === "compact"}
      onCompact={onCompact}
    />
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "tokenomics",
    title: "Tokenomics",
    // The plugin's own coin stack, declared under bb.branding.experimental_icons.
    icon: "tokenomics/coins",
    path: "tokenomics",
    component: TokenomicsPage,
    experimental_sidebarAccessory: ContextLevelsAccessory,
  });

  app.slots.experimental_appOverlay({ id: "limits-top-bar", component: LimitsTopBar });

  app.slots.experimental_threadHeaderAction({
    id: "thread-tokens",
    title: "Tokens used",
    component: ThreadTokensAction,
  });

  app.composer.customize({
    id: "context-meter",
    scopes: ["thread"],
    // Bare: the meter draws its own card, and a thread under the setting
    // draws nothing at all.
    banners: [{ id: "context-meter", chrome: "bare", component: ContextMeterBanner }],
  });
});
