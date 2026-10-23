// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, useEffect, type ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  rpc: { call: vi.fn() },
  listeners: new Map<string, Set<() => void>>(),
  page: null as ComponentType | null,
}));

vi.mock("@get-bb/plugin-sdk/app", () => ({
  definePluginApp: (setup: (app: {
    slots: {
      navPanel: (slot: { component: ComponentType }) => void;
      experimental_appOverlay: () => void;
      experimental_threadHeaderAction: () => void;
    };
    composer: { customize: () => void };
  }) => void) => setup({
    slots: {
      navPanel: (slot) => { harness.page = slot.component; },
      experimental_appOverlay: () => undefined,
      experimental_threadHeaderAction: () => undefined,
    },
    composer: { customize: () => undefined },
  }),
  useRpc: () => harness.rpc,
  useRealtime: (channel: string, listener: () => void) => {
    useEffect(() => {
      const listeners = harness.listeners.get(channel) ?? new Set<() => void>();
      harness.listeners.set(channel, listeners);
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }, [channel, listener]);
  },
  useBbNavigate: () => ({ toThread: vi.fn() }),
  experimental_useProviders: () => ({ providers: [] }),
}));

import "../app";
import { USAGE_CHANNEL } from "../usage/channels";
import type { TurnTimeBreakdown } from "../usage/contract";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = new Date(2026, 9, 20, 12, 59).getTime();
const pending: Array<{
  since: number;
  resolve: (value: {
    hours: { hour: number; input: number; cacheRead: number; output: number }[];
    threads: [];
    recordingSince: number;
    contextThresholds: { warning: null; error: null };
    turnTime: TurnTimeBreakdown;
  }) => void;
  reject: (error: Error) => void;
}> = [];

function mount(strict = false) {
  if (harness.page === null) throw new Error("The native page was not registered");
  const Page = harness.page;
  return render(strict ? <StrictMode><Page /></StrictMode> : <Page />);
}

function emit(count = 1) {
  act(() => {
    for (let i = 0; i < count; i++) {
      for (const listener of harness.listeners.get(USAGE_CHANNEL) ?? []) listener();
    }
  });
}

async function resolve(index: number, tokens: number) {
  await act(async () => {
    pending[index]!.resolve({
      hours: [{ hour: pending[index]!.since, input: tokens, cacheRead: 0, output: 0 }],
      threads: [],
      recordingSince: 0,
      contextThresholds: { warning: null, error: null },
      turnTime: {
        turns: 0,
        split: { model: 0, tools: 0, waiting: 0 },
        kinds: [],
        questions: 0,
        lengths: [],
        commands: [],
      },
    });
  });
}

async function reject(index: number) {
  await act(async () => { pending[index]!.reject(new Error("transport unavailable")); });
}

function expectTotal(tokens: number) {
  expect(screen.getByText(String(tokens), { selector: "p" }).textContent).toBe(`${tokens}tokens`);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  });
  pending.length = 0;
  harness.rpc.call.mockReset();
  harness.rpc.call.mockImplementation((method: string, input: { since: number } | null) => {
    if (method === "usage_limits") return Promise.resolve({ limits: [] });
    if (method !== "usage_window" || input === null) throw new Error(`Unexpected RPC ${method}`);
    return new Promise((resolve, reject) => { pending.push({ since: input.since, resolve, reject }); });
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("registered usage page refresh with a pending transport", () => {
  it("coalesces a burst and drains events received during the trailing read", async () => {
    mount();
    emit(200);
    expect(pending).toHaveLength(1);
    await resolve(0, 111);
    expectTotal(111);
    expect(pending).toHaveLength(2);
    emit(200);
    expect(pending).toHaveLength(2);
    await resolve(1, 222);
    expect(pending).toHaveLength(3);
    await resolve(2, 333);
    expectTotal(333);
    expect(pending).toHaveLength(3);
  });

  it("retains data on error, drains dirty work and recovers on a later event", async () => {
    mount();
    await resolve(0, 111);
    emit();
    emit();
    expect(pending).toHaveLength(2);
    await reject(1);
    expectTotal(111);
    expect(screen.getByRole("alert").textContent).toBe("transport unavailable");
    expect(pending).toHaveLength(3);
    await reject(2);
    expect(pending).toHaveLength(3);
    expectTotal(111);
    emit();
    await resolve(3, 333);
    expectTotal(333);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(pending).toHaveLength(4);
  });

  it.each(["resolve", "reject"])("ignores the old range's late %s and refreshes the new range", async (settlement) => {
    mount();
    emit();
    fireEvent.click(screen.getByRole("radio", { name: "Past week" }));
    expect(pending).toHaveLength(2);
    expect(pending[0]!.since - pending[1]!.since).toBe(5 * 24 * HOUR + 13 * HOUR);
    expect(screen.getByRole("status", { name: "Loading usage" })).toBeTruthy();
    await resolve(1, 222);
    if (settlement === "resolve") await resolve(0, 111);
    else await reject(0);
    expectTotal(222);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(pending).toHaveLength(2);
    emit();
    expect(pending[2]!.since).toBe(pending[1]!.since);
    await resolve(2, 333);
    expectTotal(333);
  });

  it("clears the old reading on range change and retains an error until recovery", async () => {
    mount();
    await resolve(0, 111);
    emit();
    await reject(1);
    fireEvent.click(screen.getByRole("radio", { name: "Past 3 days" }));
    expect(pending[0]!.since - pending[2]!.since).toBe(48 * HOUR);
    expect(screen.getByRole("status", { name: "Loading usage" })).toBeTruthy();
    expect(screen.queryByText("111", { selector: "p" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("transport unavailable");
    await resolve(2, 222);
    expectTotal(222);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("recomputes the current window for minute-triggered and queued reads", async () => {
    mount();
    act(() => { vi.advanceTimersByTime(MINUTE); });
    expect(pending).toHaveLength(1);
    await resolve(0, 111);
    expect(pending).toHaveLength(2);
    expect(pending[1]!.since - pending[0]!.since).toBe(HOUR);
    await resolve(1, 222);
    act(() => { vi.advanceTimersByTime(MINUTE); });
    expect(pending).toHaveLength(3);
    expect(pending[2]!.since).toBe(pending[1]!.since);
    await resolve(2, 333);
    expectTotal(333);
    expect(pending).toHaveLength(3);
  });

  it.each(["resolve", "reject"])("makes an unmounted page's late %s inert and starts fresh", async (settlement) => {
    const view = mount();
    emit(100);
    view.unmount();
    emit();
    act(() => { vi.advanceTimersByTime(2 * MINUTE); });
    if (settlement === "resolve") await resolve(0, 111);
    else await reject(0);
    expect(pending).toHaveLength(1);
    mount();
    expect(pending).toHaveLength(2);
    await resolve(1, 222);
    expectTotal(222);
  });

  it.each(["resolve", "reject"])("keeps StrictMode's old %s inert", async (settlement) => {
    mount(true);
    expect(pending).toHaveLength(2);
    emit(100);
    await resolve(1, 222);
    expect(pending).toHaveLength(3);
    if (settlement === "resolve") await resolve(0, 111);
    else await reject(0);
    expectTotal(222);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(pending).toHaveLength(3);
    await resolve(2, 333);
    expectTotal(333);
  });
});
