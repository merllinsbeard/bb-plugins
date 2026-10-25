// The session in bb's title bar: its tokens per 15 minutes from its start to
// its reset, with a dot for each 15 minutes still to come, and two rings for
// the percent used: the session outside, the week inside. Hovering shows the
// page's meters and its chart of the past day. Display only; app.tsx loads
// the limits and the bars.
import { useState } from "react";

import { TopBarButton } from "@danielbachhuber/bb-plugin-component-library/top-bar";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import type { Limit } from "@/usage/contract";
import { SLOT_MS } from "@/usage/limits";
import type { Bar } from "@/usage/series";

import { LimitMeters, paceText } from "./limit-meters";
import { UsageChart, UsageLegend } from "./usage-chart";
import { withProjection } from "./usage-view";

/** A session lasts five hours: 20 slots of 15 minutes. */
const SLOTS = 20;
const WIDTH = 80;
const HEIGHT = 18;
const AMBER = "#d97706";

function toneColor(limit: Limit): string | undefined {
  return limit.tone === "error" ? "var(--destructive)" : limit.tone === "warning" ? AMBER : undefined;
}

/** The session's tokens per 15 minutes from its start to its reset, with a dot for each slot still to come. */
export function SessionSpark({ limit, now }: { limit: Limit; now: number }) {
  const slots = (limit.slots ?? []).slice(0, SLOTS);
  const most = Math.max(1, ...slots);
  const slot = WIDTH / SLOTS;
  const bar = Math.max(1, slot - 1);
  const color = toneColor(limit) ?? "currentColor";
  const height = (tokens: number) => (tokens === 0 ? 0 : Math.max(1, (tokens / most) * HEIGHT));
  // The baseline runs to now; each slot still to come is a dot, so the empty
  // right side reads as time not yet reached rather than missing usage.
  const start = limit.resetsAt - SLOTS * SLOT_MS;
  const nowX = Math.min(WIDTH, Math.max(0, ((now - start) / (SLOTS * SLOT_MS)) * WIDTH));
  return (
    // Inline, because the top-bar button sizes every svg inside it as a 16px icon.
    <svg width={WIDTH} height={HEIGHT} aria-hidden className="shrink-0" style={{ width: WIDTH, height: HEIGHT }}>
      <line x1={0} x2={nowX} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} stroke="currentColor" opacity={0.2} />
      {Array.from({ length: Math.max(0, SLOTS - slots.length) }, (_, k) => (
        <rect
          key={`dot-${k}`}
          x={(slots.length + k) * slot + bar / 2 - 0.75}
          y={HEIGHT - 1.5}
          width={1.5}
          height={1.5}
          fill="currentColor"
          opacity={0.35}
        />
      ))}
      {slots.map((tokens, index) =>
        tokens === 0 ? null : (
          <rect key={index} x={index * slot} y={HEIGHT - height(tokens)} width={bar} height={height(tokens)} rx={0.5} style={{ fill: color }} />
        ),
      )}
    </svg>
  );
}

const RING_SIZE = 18;
const NONE_HIDDEN: ReadonlySet<never> = new Set();

/** One ring of the donut: a faint track, then an arc clockwise from the top for the percent used. */
function Ring({ limit, radius }: { limit: Limit; radius: number }) {
  const center = RING_SIZE / 2;
  const circumference = 2 * Math.PI * radius;
  const used = Math.max(0, Math.min(100, limit.usedPercent)) / 100;
  const color = toneColor(limit) ?? "currentColor";
  return (
    <>
      <circle cx={center} cy={center} r={radius} fill="none" stroke="currentColor" strokeWidth={2.5} opacity={0.15} />
      {used === 0 ? null : (
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          strokeWidth={2.5}
          strokeDasharray={`${used * circumference} ${circumference}`}
          transform={`rotate(-90 ${center} ${center})`}
          style={{ stroke: color }}
        />
      )}
    </>
  );
}

/** The percent used as two rings: the session outside, the weekly limit inside when there is one. */
export function LimitDonut({ session, weekly }: { session: Limit; weekly: Limit | null }) {
  return (
    // Inline, because the top-bar button sizes every svg inside it as a 16px icon.
    <svg width={RING_SIZE} height={RING_SIZE} aria-hidden className="shrink-0" style={{ width: RING_SIZE, height: RING_SIZE }}>
      <Ring limit={session} radius={7.75} />
      {weekly === null ? null : <Ring limit={weekly} radius={4.25} />}
    </svg>
  );
}

/** The weekly limit beside a session: the account's limit named "weekly", else its first other one. */
export function weeklyLimit(limits: readonly Limit[]): Limit | null {
  const others = limits.filter((limit) => limit.kind !== "five-hour");
  return others.find((limit) => limit.kind === "weekly") ?? others[0] ?? null;
}

/** The title bar button's width with its spark chart: padding, the chart, the gap, and the rings. */
export const TOP_BAR_LIMITS_WIDTH = 8 + WIDTH + 6 + RING_SIZE + 8;

/**
 * The title bar's button: the session's spark chart and the rings for the
 * session's and the week's percent used, or the rings alone when `compact`. Hovering
 * opens the meters for every limit of the session's subscription and the
 * past day's tokens per hour; clicking opens the Tokenomics page.
 */
export function TopBarLimits({
  session,
  limits,
  now,
  providerName,
  onOpen,
  bars = null,
  onHover,
  initialOpen = false,
  compact = false,
}: {
  session: Limit;
  /** Every limit of the session's subscription, for the popover. */
  limits: readonly Limit[];
  now: number;
  providerName: (providerId: string) => string;
  onOpen: () => void;
  /** The past day's hourly bars for the popover's chart; null until loaded. */
  bars?: readonly Bar[] | null;
  /** Called each time the popover opens, so app.tsx can load the bars then. */
  onHover?: () => void;
  /** Opens the popover on first render, so a story can draw it. */
  initialOpen?: boolean;
  /** Leaves the spark chart out, for a sidebar too narrow for the whole button. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  const chart = bars === null ? null : withProjection(bars, "hour", limits, now);
  const weekly = weeklyLimit(limits);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <TopBarButton
          label={`${session.label}: ${Math.round(session.usedPercent)}% used. ${paceText(session)}.${
            weekly === null ? "" : ` ${weekly.label}: ${Math.round(weekly.usedPercent)}% used.`
          } Open Tokenomics`}
          onClick={() => {
            setOpen(false);
            onOpen();
          }}
          onPointerEnter={() => {
            setOpen(true);
            onHover?.();
          }}
          onPointerLeave={() => setOpen(false)}
          className="pr-2"
        >
          {compact ? null : <SessionSpark limit={session} now={now} />}
          <LimitDonut session={session} weekly={weekly} />
        </TopBarButton>
      </PopoverAnchor>
      <PopoverContent align="start" className="pointer-events-none w-[440px] p-3" onOpenAutoFocus={(event) => event.preventDefault()}>
        <LimitMeters limits={limits} providerName={providerName} className="" />
        {chart === null ? null : (
          <div className="mt-3 border-t border-border pt-3">
            <p className="mb-1 text-xs font-medium">Past day</p>
            <UsageChart bars={chart.bars} unit="hour" hidden={NONE_HIDDEN} projection={chart.projection} plotHeight={96} />
            <div className="pl-[44px]">
              <UsageLegend hidden={NONE_HIDDEN} onToggle={() => undefined} pace={chart.projection !== null} />
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The session the title bar shows: the most urgent one, then the most used,
 * so with two subscriptions the one closer to its limit wins.
 */
export function urgentSession(limits: readonly Limit[]): Limit | null {
  const rank = { error: 0, warning: 1, ok: 2 } as const;
  const sessions = limits.filter((limit) => limit.kind === "five-hour");
  return [...sessions].sort((a, b) => rank[a.tone] - rank[b.tone] || b.usedPercent - a.usedPercent)[0] ?? null;
}
