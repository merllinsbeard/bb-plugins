import { describe, expect, it } from "vitest";

import type { Limit } from "@/usage/contract";

import { urgentSession } from "./limit-spark";

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 20, 12, 20);

function session(over: Partial<Limit> = {}): Limit {
  return {
    providerId: "claude-code",
    accountKey: "acct_acme",
    label: "Current session",
    kind: "five-hour",
    usedPercent: 28,
    // Began 90 minutes ago: six slots gone, fourteen to come.
    resetsAt: NOW + 210 * MIN,
    sampledAt: NOW,
    pacePerHour: 19,
    projectedPercent: 94.5,
    runsOutAt: null,
    tone: "warning",
    lastHourTokens: 40_000_000,
    slots: [1, 2, 3, 4, 5, 6],
    ...over,
  };
}

describe("urgentSession", () => {
  it("picks the session closer to its limit and skips weekly limits", () => {
    const calm = session({ tone: "ok", usedPercent: 70, accountKey: "acct_gadgets" });
    const weekly = session({ kind: "weekly", label: "Weekly limit", tone: "error" });
    expect(urgentSession([calm, weekly, session()])?.accountKey).toBe("acct_acme");
    expect(urgentSession([weekly])).toBeNull();
  });

  it("breaks a tie on the percent used", () => {
    expect(urgentSession([session({ usedPercent: 20 }), session({ usedPercent: 60, accountKey: "acct_gadgets" })])?.usedPercent).toBe(60);
  });
});
