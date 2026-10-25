// bb-plugin-diff-viewed — frontend entry.
//
// This plugin has no React slot. It registers a single content script that
// works around bb's own Viewed checkboxes in the changes panel: it counts the
// viewed files in the toolbar, marks each file whose mark stays in bb, and
// asks the server to sync with GitHub when a checkbox changes. The panel is
// host-owned, so decorating existing app-shell DOM is what content scripts are
// for.
//
// This file is only the wiring — real fetch, real scheduler, real document.
// The behavior lives in viewed/engine.ts so it can be tested; see the comment
// there for why that split exists.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { STYLE_TEXT } from "./viewed/dom";
import { startEngine } from "./viewed/engine";
import type { rpcContract } from "./server";

type RpcMethod = keyof typeof rpcContract;

/** How long after a checkbox changes to sync, so a run of clicks syncs once. */
const SYNC_DELAY_MS = 400;

/**
 * A content script gets no `useRpc` — that is a React hook and there is no
 * component here — so it calls the plugin's own RPC route directly. The route
 * is same-origin and the app shell is already authenticated for it.
 */
async function callRpc<Result>(
  pluginId: string,
  method: string,
  input: unknown,
): Promise<Result> {
  const response = await fetch(
    `/api/v1/plugins/${encodeURIComponent(pluginId)}/rpc/${encodeURIComponent(method as RpcMethod)}`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  const body: unknown = await response.json().catch(() => null);
  const envelope = body as { ok?: boolean; result?: Result };
  if (!response.ok || envelope?.ok !== true || envelope.result === undefined) {
    throw new Error(`${method} failed (${response.status})`);
  }
  return envelope.result;
}

function mount(pluginId: string, signal: AbortSignal): () => void {
  const style = document.createElement("style");
  style.setAttribute("data-diff-viewed-style", "");
  style.textContent = STYLE_TEXT;
  document.head.append(style);

  const engine = startEngine({
    rpc: (method, input) => callRpc(pluginId, method, input),
    signal,
    doc: document,
    pathname: () => window.location.pathname,
    defer: (run) => {
      const frame = window.requestAnimationFrame(run);
      return () => window.cancelAnimationFrame(frame);
    },
    delay: (run) => {
      const timer = window.setTimeout(run, SYNC_DELAY_MS);
      return () => window.clearTimeout(timer);
    },
    warn: (cause) => {
      console.warn("[diff-viewed]", cause);
    },
  });

  // GitHub may have marked a file since this window last looked. This syncs
  // again when the window comes back to the front. The server reuses GitHub's
  // answer for half a minute, so focusing back and forth does not query it
  // each time.
  const onFocus = () => {
    engine.refresh();
  };
  window.addEventListener("focus", onFocus);

  return () => {
    window.removeEventListener("focus", onFocus);
    engine.dispose();
    style.remove();
  };
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "diff-viewed-sync",
    mount({ pluginId, signal }) {
      return mount(pluginId, signal);
    },
  });
});
