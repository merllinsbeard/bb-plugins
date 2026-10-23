import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";

import plugin, { rpcContract } from "../server.js";
import { createStore } from "./store.js";

it("returns JSON-safe limits while preserving unsupported and pending sizes", async () => {
  const host = createFakePluginHost({ pluginId: "tokenomics" });
  try {
    await plugin(host.bb);
    const now = Date.now();
    const store = createStore(host.bb.storage.database());
    store.recordLimitSamples([
      { label: "Session", kind: "five-hour", model: null },
      { label: "Current session", kind: "custom", model: null },
      { label: "Weekly model", kind: "weekly", model: "example-model" },
    ].map((window) => ({
      ...window,
      providerId: "codex",
      accountKey: null,
      sampledAt: now,
      usedPercent: 90,
      resetsAt: now + 3_600_000,
    })));

    const result = rpcContract.usage_limits.output.parse(
      await host.harness.behavior.callRpc("usage_limits", null),
    );

    expect(result.limits).toHaveLength(3);
    expect(result.limits.find((limit) => limit.label === "Session")).toMatchObject({
      sizeTokens: null,
      slots: expect.any(Array),
    });
    for (const label of ["Current session", "Weekly model"]) {
      const limit = result.limits.find((limit) => limit.label === label);
      expect(limit).toMatchObject({ label, usedPercent: 90 });
      expect(limit).not.toHaveProperty("sizeTokens");
    }
  } finally {
    await host.harness.lifecycle.dispose();
  }
});
