// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { StrictMode, useEffect, type ComponentType, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  rpc: { call: vi.fn() },
  listeners: new Map<string, Set<() => void>>(),
  overlay: null as ComponentType | null,
}));

vi.mock("@get-bb/plugin-sdk/app", () => ({
  definePluginApp: (setup: (app: {
    slots: {
      navPanel: () => void;
      experimental_appOverlay: (slot: { component: ComponentType }) => void;
      experimental_threadHeaderAction: () => void;
    };
    composer: { customize: () => void };
  }) => void) => setup({
    slots: {
      navPanel: () => undefined,
      experimental_appOverlay: (slot) => { harness.overlay = slot.component; },
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
  useBbNavigate: () => ({ toPluginPanel: vi.fn() }),
  experimental_useProviders: () => ({ providers: [] }),
}));

vi.mock("@danielbachhuber/bb-plugin-component-library/top-bar", () => ({
  TopBarSlot: ({ children }: { children: ReactNode }) => children,
  useTopBarRoom: () => null,
}));
vi.mock("@/components/limit-spark", () => ({
  urgentSession: (limits: { usedPercent: number }[]) => limits[0] ?? null,
  TopBarLimits: ({ session }: { session: { usedPercent: number } }) => (
    <span data-testid="limit-reading">{session.usedPercent}</span>
  ),
}));

import "../app";
import { LIMITS_CHANNEL, USAGE_CHANNEL } from "../usage/channels";

const pending: Array<{
  resolve: (value: { limits: { usedPercent: number }[] }) => void;
  reject: (error: Error) => void;
}> = [];

function mount(strict = false) {
  if (harness.overlay === null) throw new Error("The native topbar slot was not registered");
  const Overlay = harness.overlay;
  return render(strict ? <StrictMode><Overlay /></StrictMode> : <Overlay />);
}

function emit(channel: string, count = 1) {
  act(() => {
    for (let i = 0; i < count; i++) {
      for (const listener of harness.listeners.get(channel) ?? []) listener();
    }
  });
}

async function resolve(index: number, usedPercent: number) {
  await act(async () => { pending[index]!.resolve({ limits: [{ usedPercent }] }); });
}

beforeEach(() => {
  pending.length = 0;
  harness.rpc.call.mockReset();
  harness.rpc.call.mockImplementation(() => new Promise((resolve, reject) => {
    pending.push({ resolve, reject });
  }));
});
afterEach(cleanup);

describe("topbar usage limits refresh with a pending transport", () => {
  it("coalesces event bursts and reads the latest value after the pending response", async () => {
    mount();
    emit(USAGE_CHANNEL, 100);
    emit(LIMITS_CHANNEL, 100);
    expect(harness.rpc.call).toHaveBeenCalledTimes(1);
    await resolve(0, 10);
    expect(screen.getByTestId("limit-reading").textContent).toBe("10");
    expect(harness.rpc.call).toHaveBeenCalledTimes(2);
    await resolve(1, 25);
    expect(screen.getByTestId("limit-reading").textContent).toBe("25");
    expect(harness.rpc.call).toHaveBeenCalledTimes(2);
  });

  it("keeps the last reading on error and refreshes on a later event", async () => {
    mount();
    await resolve(0, 10);
    emit(USAGE_CHANNEL);
    await act(async () => { pending[1]!.reject(new Error("transport unavailable")); });
    expect(screen.getByTestId("limit-reading").textContent).toBe("10");
    expect(harness.rpc.call).toHaveBeenCalledTimes(2);
    emit(LIMITS_CHANNEL);
    await resolve(2, 30);
    expect(screen.getByTestId("limit-reading").textContent).toBe("30");
  });

  it("reads again for events during the trailing refresh and stops when drained", async () => {
    const view = mount();
    emit(USAGE_CHANNEL);
    await resolve(0, 10);
    expect(harness.rpc.call).toHaveBeenCalledTimes(2);
    emit(LIMITS_CHANNEL, 100);
    emit(USAGE_CHANNEL, 100);
    expect(harness.rpc.call).toHaveBeenCalledTimes(2);
    await resolve(1, 20);
    expect(harness.rpc.call).toHaveBeenCalledTimes(3);
    await resolve(2, 30);
    const Overlay = harness.overlay!;
    view.rerender(<Overlay />);
    expect(screen.getByTestId("limit-reading").textContent).toBe("30");
    expect(harness.rpc.call).toHaveBeenCalledTimes(3);
  });

  it("drains a pending event after rejection while retaining the last reading", async () => {
    mount();
    await resolve(0, 10);
    emit(USAGE_CHANNEL);
    emit(LIMITS_CHANNEL);
    expect(harness.rpc.call).toHaveBeenCalledTimes(2);
    await act(async () => { pending[1]!.reject(new Error("transport unavailable")); });
    expect(screen.getByTestId("limit-reading").textContent).toBe("10");
    expect(harness.rpc.call).toHaveBeenCalledTimes(3);
    await resolve(2, 30);
    expect(screen.getByTestId("limit-reading").textContent).toBe("30");
    expect(harness.rpc.call).toHaveBeenCalledTimes(3);
  });

  it.each(["resolve", "reject"])("keeps StrictMode's old %s inert while the current lifetime is dirty", async (settlement) => {
    mount(true);
    expect(harness.rpc.call).toHaveBeenCalledTimes(2);
    emit(USAGE_CHANNEL, 100);
    await resolve(1, 30);
    expect(harness.rpc.call).toHaveBeenCalledTimes(3);
    if (settlement === "resolve") await resolve(0, 10);
    else await act(async () => { pending[0]!.reject(new Error("transport unavailable")); });
    expect(screen.getByTestId("limit-reading").textContent).toBe("30");
    expect(harness.rpc.call).toHaveBeenCalledTimes(3);
    await resolve(2, 40);
    expect(screen.getByTestId("limit-reading").textContent).toBe("40");
    expect(harness.rpc.call).toHaveBeenCalledTimes(3);
  });

  it("drops an unmounted view's queued refresh and starts fresh when remounted", async () => {
    const view = mount();
    emit(USAGE_CHANNEL, 100);
    view.unmount();
    emit(LIMITS_CHANNEL);
    emit(USAGE_CHANNEL);
    await resolve(0, 10);
    expect(harness.rpc.call).toHaveBeenCalledTimes(1);
    mount();
    expect(harness.rpc.call).toHaveBeenCalledTimes(2);
    await resolve(1, 40);
    expect(screen.getByTestId("limit-reading").textContent).toBe("40");
  });
});
