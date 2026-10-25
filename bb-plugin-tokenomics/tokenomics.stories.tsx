import type { ReactNode } from "react";
import { StoryCard, StoryRow } from "@bb-ladle/story-card";
import { HugeiconsIcon } from "@hugeicons/react";
import ArrowLeft01Icon from "@hugeicons/core-free-icons/ArrowLeft01Icon";
import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon";
import PanelLeftIcon from "@hugeicons/core-free-icons/PanelLeftIcon";
import PanelRightIcon from "@hugeicons/core-free-icons/PanelRightIcon";

import { ContextMeter } from "./components/context-meter";
import { TopBarLimits } from "./components/limit-spark";
import {
  ThreadTokenCount,
  ThreadTokenSummary,
  type InitialHover,
  type ThreadTokens,
} from "./components/thread-token-count";
import { UsageView } from "./components/usage-view";
import type { Limit, TurnDetail } from "./usage/contract";
import { windowFor } from "./usage/series";
import {
  AfterComposerFocus,
  CALM,
  CONVERSATION,
  dataFor,
  HOUR,
  limit,
  LONG,
  LONG_TURNS,
  METER,
  noop,
  NOW,
  ON_PACE,
  Page,
  PRUNED,
  PRUNED_TURNS,
  RUNS_OUT,
  SESSION_SLOTS,
  SHORT,
  SHORT_TURNS,
  ThreadFrame,
  weekly,
  WITH_SUBAGENTS,
} from "./tokenomics.fixtures";

export default {
  title: "tokenomics/Page",
};

export const PastDay = () => <Page initial="day" />;

/** The past day with a busy hour hovered, so its tooltip shows. */
export const PastDayHovered = () => <Page initial="day" initialHovered={20} />;

/** A session on pace for 95% by its reset: the meter turns amber, and the chart runs on to the reset with hatched bars at the past hour's pace. */
export const LimitOnPace = () => <Page initial="day" limits={ON_PACE} />;

// The plugin's README embeds this one.
/** A session that runs out before it resets: red, with the hatched bars red past the point it runs out. */
export const LimitRunsOut = () => <Page initial="day" limits={RUNS_OUT} />;

/** Right after Tokenomics starts reading the limits, before there's a pace to project. */
export const LimitMeasuring = () => (
  <Page
    initial="day"
    limits={[
      limit({ usedPercent: 48, pacePerHour: null, projectedPercent: null, sizeTokens: null }),
      weekly({ usedPercent: 5, pacePerHour: null, projectedPercent: null, sizeTokens: null }),
    ]}
  />
);

/** Two subscriptions: each one's meters sit under its provider's name. */
export const LimitTwoSubscriptions = () => (
  <Page
    initial="day"
    limits={[
      ...ON_PACE,
      limit({ providerId: "codex", accountKey: "acct_gadgets", usedPercent: 4, pacePerHour: 1, projectedPercent: 8 }),
      weekly({ providerId: "codex", accountKey: "acct_gadgets", usedPercent: 12, pacePerHour: 0.1, projectedPercent: 26 }),
    ]}
  />
);

export const PastThreeDays = () => <Page initial="three-days" />;

export const PastWeek = () => <Page initial="week" recordingSince={NOW.getTime() - 4 * 24 * HOUR} />;

/** Over the past week, every thread in one list: active threads first, then the archived ones under their own heading, dimmed. */
export const ArchivedThreads = () => (
  <UsageView
    range="week"
    onRange={() => undefined}
    data={dataFor("week", NOW.getTime() - 7 * 24 * HOUR)}
    error={null}
    onOpenThread={() => undefined}
    now={NOW.getTime()}
  />
);

export const Empty = () => (
  <UsageView
    range="day"
    onRange={() => undefined}
    data={{
      ...dataFor("day"),
      bars: windowFor("day", NOW).bars,
      threads: [],
      turnTime: { turns: 0, split: { model: 0, tools: 0, waiting: 0 }, kinds: [], questions: 0, lengths: [], commands: [] },
    }}
    error={null}
    onOpenThread={() => undefined}
    now={NOW.getTime()}
  />
);

export const HeaderCount = () => (
  <StoryCard>
    <StoryRow label="a long thread" hint="token use over time; click to open the summary">
      <ThreadTokenCount usage={LONG} turns={LONG_TURNS} onOpenPage={() => undefined} now={NOW.getTime()} />
    </StoryRow>
    <StoryRow label="a short thread" hint="one turn, a thin bar at the right">
      <ThreadTokenCount usage={SHORT} turns={SHORT_TURNS} onOpenPage={() => undefined} now={NOW.getTime()} />
    </StoryRow>
    <StoryRow label="compact viewport" hint="the sparkline drops out">
      <ThreadTokenCount usage={LONG} turns={LONG_TURNS} isCompactViewport onOpenPage={() => undefined} now={NOW.getTime()} />
    </StoryRow>
  </StoryCard>
);

function Summary({
  usage,
  turns,
  initialHovered,
}: {
  usage: ThreadTokens;
  turns: TurnDetail[] | null;
  initialHovered?: InitialHover;
}) {
  return (
    <div className="w-[400px] rounded-md border border-border bg-popover p-4">
      <ThreadTokenSummary usage={usage} turns={turns} onOpenPage={() => undefined} initialHovered={initialHovered} />
    </div>
  );
}

/** The popover's contents, drawn open. */
export const HeaderSummary = () => (
  <StoryCard>
    <StoryRow label="a long thread" hint="hover a bar for the messages behind it">
      <Summary usage={LONG} turns={LONG_TURNS} />
    </StoryRow>
    <StoryRow label="the busiest stretch hovered" hint="the readout names the messages behind it">
      <Summary usage={LONG} turns={LONG_TURNS} initialHovered="largest" />
    </StoryRow>
    <StoryRow label="loading the turns" hint="the chart draws the recorded usage until the messages arrive">
      <Summary usage={LONG} turns={null} />
    </StoryRow>
    <StoryRow label="subagents counted" hint="bb leaves their tokens out; the summary adds them and says so">
      <Summary usage={WITH_SUBAGENTS} turns={LONG_TURNS} />
    </StoryRow>
    <StoryRow label="earlier turns pruned" hint="the provider's running total covers what bb deleted">
      <Summary usage={PRUNED} turns={PRUNED_TURNS} />
    </StoryRow>
  </StoryCard>
);

// The plugin's README embeds this one.
/**
 * The button where bb draws it, in a thread header's action row, with its
 * summary open on the busiest stretch.
 */
export const HeaderOpen = () => (
  <ThreadFrame
    headerAction={
      <AfterComposerFocus>
        <ThreadTokenCount usage={LONG} turns={LONG_TURNS} onOpenPage={noop} defaultOpen initialHovered="largest" now={NOW.getTime()} />
      </AfterComposerFocus>
    }
  />
);

/**
 * The meter above a thread's composer once its context passes the warning
 * setting, 300K tokens here, and red past the error setting, 550K, with a
 * button that compacts the thread.
 */
export const ContextMeterStates = () => (
  <StoryCard>
    <StoryRow label="past the warning" hint="amber past 300K; the ticks mark both settings">
      <div className="w-[720px]">
        <ContextMeter {...METER} />
      </div>
    </StoryRow>
    <StoryRow label="past the error" hint="red past 550K">
      <div className="w-[720px]">
        <ContextMeter {...METER} usedTokens={620_000} level="error" />
      </div>
    </StoryRow>
    <StoryRow label="a turn running" hint="bb compacts only an idle thread">
      <div className="w-[720px]">
        <ContextMeter {...METER} running />
      </div>
    </StoryRow>
    <StoryRow label="compacting" hint="until the smaller context arrives">
      <div className="w-[720px]">
        <ContextMeter {...METER} running compacting />
      </div>
    </StoryRow>
    <StoryRow label="no usable window" hint="the provider reported a window smaller than the context">
      <div className="w-[720px]">
        <ContextMeter {...METER} usedTokens={347_000} contextWindow={200_000} lastTurn={1_430_000} />
      </div>
    </StoryRow>
    <StoryRow label="compaction refused" hint="bb's reason, under the meter">
      <div className="w-[720px]">
        <ContextMeter {...METER} error="Context can only be compacted while the thread is idle or errored" />
      </div>
    </StoryRow>
    <StoryRow label="narrow composer" hint="the bar and the last turn drop out">
      <div className="w-[320px]">
        <ContextMeter {...METER} compact />
      </div>
    </StoryRow>
  </StoryCard>
);

/**
 * A thread whose context has grown past the error setting: the header's
 * sparkline and total, and the meter above the composer with Compact.
 */
export const ThreadWithMeter = () => (
  <ThreadFrame
    headerAction={<ThreadTokenCount usage={LONG} turns={LONG_TURNS} onOpenPage={noop} now={NOW.getTime()} />}
    stack={<ContextMeter {...METER} usedTokens={620_000} level="error" />}
  />
);

// A stand-in for the left end of bb's title bar: the sidebar toggle, then the button.
function TitleBarRow({ label, session, weeklyLimit }: { label: string; session: Limit; weeklyLimit: Limit }) {
  return (
    <StoryRow label={label}>
      <div className="flex h-10 w-80 items-center gap-1.5 bg-background px-3">
        <span className="inline-block size-7" />
        <TopBarLimits
          session={session}
          limits={[session, weeklyLimit]}
          now={NOW.getTime()}
          providerName={() => "Claude Code"}
          onOpen={() => undefined}
        />
      </div>
    </StoryRow>
  );
}

/** The session in bb's title bar, after the other plugins' buttons: its tokens per 15 minutes from its start to its reset, with a dot for each 15 minutes still to come, and two rings for the percent used: the session outside, the week inside. Hovering shows the page's meters; clicking opens the page. */
export const TitleBar = () => (
  <div data-screenshot-frame className="w-[720px] p-4">
  <StoryCard>
    <TitleBarRow label="Calm" session={limit({ slots: SESSION_SLOTS.map((m) => m * 0.35) })} weeklyLimit={CALM[1]!} />
    <TitleBarRow label="On pace for 95%" session={{ ...ON_PACE[0]!, slots: SESSION_SLOTS, lastHourTokens: 23_000_000 }} weeklyLimit={ON_PACE[1]!} />
    <TitleBarRow label="Runs out first" session={{ ...RUNS_OUT[0]!, slots: SESSION_SLOTS.map((m) => m * 1.6), lastHourTokens: 37_000_000 }} weeklyLimit={RUNS_OUT[1]!} />
    <TitleBarRow
      label="Used up"
      session={limit({ usedPercent: 100, runsOutAt: NOW.getTime(), tone: "error", projectedPercent: 205, slots: [...SESSION_SLOTS, 3, 11, 14, 6, 8, 13, 5, 10, 15, 9].map((m) => (m < 100 ? m * 1_000_000 : m)) })}
      weeklyLimit={RUNS_OUT[1]!}
    />
    <TitleBarRow label="Measuring" session={limit({ usedPercent: 48, pacePerHour: null, projectedPercent: null, slots: SESSION_SLOTS })} weeklyLimit={weekly({ usedPercent: 5, pacePerHour: null, projectedPercent: null })} />
  </StoryCard>
  </div>
);

/** Hovering the title bar's button: the meters for the session and the weekly limit, then the past day's tokens per hour, running on to the session's reset with hatched bars once it's amber or red. */
export const TitleBarHovered = () => (
  <div className="h-[460px] w-[720px] p-4">
    <div className="flex h-10 items-center gap-1.5 bg-background px-3">
      <span className="inline-block size-7" />
      <TopBarLimits
        session={{ ...ON_PACE[0]!, slots: SESSION_SLOTS, lastHourTokens: 12_000_000 }}
        limits={ON_PACE}
        now={NOW.getTime()}
        providerName={() => "Claude Code"}
        onOpen={() => undefined}
        bars={dataFor("day").bars}
        initialOpen
      />
    </div>
  </div>
);

// A stand-in for bb's title bar across the top of the window: the window
// controls, back and forward, and the sidebar toggle; then the plugin's
// button, at the right edge of the sidebar column while the sidebar is open
// (`sidebar` is its width) or beside the toggle while it is closed; and the
// right-panel toggle at the far end.
function WindowTitleBar({ children, sidebar = 300 }: { children: ReactNode; sidebar?: number | null }) {
  const icon = "inline-flex size-7 items-center justify-center text-muted-foreground [&_svg]:size-4";
  const controls = (
    <>
      <span className="flex shrink-0 gap-2 pr-3">
        <span className="size-3 rounded-full" style={{ background: "#ff5f57" }} />
        <span className="size-3 rounded-full" style={{ background: "#febc2e" }} />
        <span className="size-3 rounded-full" style={{ background: "#28c840" }} />
      </span>
      <span className={icon}>
        <HugeiconsIcon icon={ArrowLeft01Icon} />
      </span>
      <span className={icon}>
        <HugeiconsIcon icon={ArrowRight01Icon} />
      </span>
      <span className={icon}>
        <HugeiconsIcon icon={PanelLeftIcon} />
      </span>
    </>
  );
  return (
    <div className="flex h-10 shrink-0 items-center gap-1.5 border-x border-t border-border bg-background px-3">
      {sidebar === null ? (
        <>
          {controls}
          {children}
        </>
      ) : (
        <div className="-ml-3 flex h-full shrink-0 items-center gap-1.5 border-r border-border pl-3 pr-2" style={{ width: sidebar }}>
          {controls}
          <span className="ml-auto flex">{children}</span>
        </div>
      )}
      <span className={`ml-auto ${icon}`}>
        <HugeiconsIcon icon={PanelRightIcon} />
      </span>
    </div>
  );
}

// The Store's first screenshot and the README's lead image: every surface
// inside a thread, in one window.
/**
 * The whole window: the title bar's limits open, with a session on pace to run
 * out before it resets, over a thread whose header has its sparkline and whose
 * context has grown past the error setting, with Compact above the composer.
 */
export const WindowWithLimits = () => (
  <div className="flex h-[900px] flex-col">
    <WindowTitleBar>
      <AfterComposerFocus>
        <TopBarLimits
          session={{ ...RUNS_OUT[0]!, slots: SESSION_SLOTS.map((m) => m * 1.6), lastHourTokens: 37_000_000 }}
          limits={RUNS_OUT}
          now={NOW.getTime()}
          providerName={() => "Claude Code"}
          onOpen={noop}
          bars={dataFor("day").bars}
          initialOpen
        />
      </AfterComposerFocus>
    </WindowTitleBar>
    <ThreadFrame
      height="min-h-0 flex-1"
      headerAction={<ThreadTokenCount usage={LONG} turns={LONG_TURNS} onOpenPage={noop} now={NOW.getTime()} />}
      stack={<ContextMeter {...METER} usedTokens={620_000} level="error" />}
    />
  </div>
);

/**
 * The session in bb's title bar, at the right edge of the open sidebar, with
 * its limits open: a session on pace for 95% by its reset, so the button and
 * the meter are amber.
 */
export const TitleBarInWindow = () => (
  <div data-screenshot-frame className="w-[1400px] bg-background" style={{ height: 420 }}>
    <WindowTitleBar>
      <TopBarLimits
        session={{ ...ON_PACE[0]!, slots: SESSION_SLOTS, lastHourTokens: 12_000_000 }}
        limits={ON_PACE}
        now={NOW.getTime()}
        providerName={() => "Claude Code"}
        onOpen={noop}
        bars={dataFor("day").bars}
        initialOpen
      />
    </WindowTitleBar>
  </div>
);

/**
 * The session in bb's title bar when the sidebar has no room for the spark
 * chart: dragged narrow, the rings sit alone at its edge; closed, they sit
 * beside the sidebar toggle.
 */
export const TitleBarNarrowSidebar = () => {
  const session = { ...ON_PACE[0]!, slots: SESSION_SLOTS, lastHourTokens: 12_000_000 };
  const button = (
    <TopBarLimits session={session} limits={ON_PACE} now={NOW.getTime()} providerName={() => "Claude Code"} onOpen={noop} compact />
  );
  return (
    <div data-screenshot-frame className="w-[720px] p-4">
      <StoryCard>
        <StoryRow label="Narrow sidebar" hint="Too narrow for the spark chart, so only the rings show.">
          <div className="w-[520px]">
            <WindowTitleBar sidebar={220}>{button}</WindowTitleBar>
          </div>
        </StoryRow>
        <StoryRow label="Sidebar closed" hint="The rings sit beside the sidebar toggle.">
          <div className="w-[520px]">
            <WindowTitleBar sidebar={null}>{button}</WindowTitleBar>
          </div>
        </StoryRow>
      </StoryCard>
    </div>
  );
};

// The README's image for the context meter, and the store's.
/**
 * A thread whose context has passed the warning setting: its last exchange,
 * then the amber meter above the composer, with Compact.
 */
export const ContextMeterInThread = () => (
  <div data-screenshot-frame className="w-[1400px]" style={{ height: 480 }}>
    <ThreadFrame
      height="h-full"
      headerAction={<ThreadTokenCount usage={LONG} turns={LONG_TURNS} onOpenPage={noop} now={NOW.getTime()} />}
      stack={<ContextMeter {...METER} />}
      conversation={CONVERSATION.slice(-3)}
    />
  </div>
);
