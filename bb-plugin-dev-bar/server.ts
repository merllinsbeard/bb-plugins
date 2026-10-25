import { isAbsolute, resolve } from "node:path";
import { PluginCliError, cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract, type Failure, type RunTarget, type Strip } from "./services/contract";
import {
  LOCAL_MANIFEST_PATH,
  MANIFEST_PATH,
  SOURCE_LABEL,
  parseManifest,
  parseStatus,
  pickManifest,
  serviceCommands,
  servicesToStop,
  tail,
  type Manifest,
  type ManifestSource,
} from "./services/manifest";
import { threadRequest } from "./services/failure";
import { readCheckoutManifests, readText, runCommand } from "./services/shell";

const STATUS_TIMEOUT_MS = 20_000;
const ACTION_TIMEOUT_MS = 5 * 60_000;

interface ThreadLike {
  projectId?: string | null;
  environmentId?: string | null;
}

interface EnvironmentLike {
  path?: string | null;
}

type Loaded =
  | { kind: "none" }
  | { kind: "failed"; source: string; failure: Failure }
  | { kind: "ok"; source: string; root: string; manifest: Manifest };

/** A bb project's saved manifest, as text, in the plugin's own storage. */
const projectKey = (projectId: string) => `manifest:${projectId}`;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    providerId: {
      type: "string",
      label: "Provider for threads that fix a failure",
      // The thread follows the dev-bar skill, and skills belong to one provider.
      default: "claude-code",
    },
  });

  /** The checkout a thread runs in and its bb project; root is null when it has no checkout on this machine. */
  async function checkoutFor(threadId: string): Promise<{ root: string | null; projectId: string | null }> {
    const thread = (await bb.sdk.threads.get({ threadId })) as unknown as ThreadLike;
    const projectId = thread.projectId ?? null;
    if (!thread.environmentId) return { root: null, projectId };
    try {
      const environment = (await bb.sdk.environments.get({
        environmentId: thread.environmentId,
      })) as unknown as EnvironmentLike;
      return { root: environment.path ?? null, projectId };
    } catch {
      return { root: null, projectId };
    }
  }

  async function load(threadId: string): Promise<Loaded> {
    const { root, projectId } = await checkoutFor(threadId);
    if (!root) return { kind: "none" };
    const inCheckout = await readCheckoutManifests(root).catch(() => ({ committed: null, local: null }));
    const saved = projectId ? ((await bb.storage.kv.get<string>(projectKey(projectId))) ?? null) : null;
    const found = pickManifest({ ...inCheckout, project: saved });
    if (!found) return { kind: "none" };
    const source = `Services from ${SOURCE_LABEL[found.source]}`;
    const manifest = parseManifest(found.text, sourceName(found.source));
    if (!manifest.ok) return { kind: "failed", source, failure: { title: "Manifest", command: "", output: manifest.error } };
    return { kind: "ok", source, root, manifest: manifest.value };
  }

  function sourceName(source: ManifestSource): string {
    return source === "committed" ? MANIFEST_PATH : source === "local" ? LOCAL_MANIFEST_PATH : "The saved manifest";
  }

  /**
   * One status run per checkout at a time. Two panes on the same thread, or a
   * poll landing while an action's refresh is in flight, share it.
   */
  const inFlight = new Map<string, Promise<Strip>>();

  async function strip(threadId: string): Promise<Strip> {
    const loaded = await load(threadId);
    if (loaded.kind === "none") return { kind: "none" };
    if (loaded.kind === "failed") {
      return { kind: "services", source: loaded.source, services: [], actions: [], failure: loaded.failure };
    }
    const { root, manifest, source } = loaded;
    const existing = inFlight.get(root);
    if (existing) return existing;
    const pending = (async (): Promise<Strip> => {
      const actions = manifest.actions.map((action, index) => ({
        index,
        label: action.label,
        confirm: action.confirm ?? null,
      }));
      const result = await runCommand(manifest.status, root, STATUS_TIMEOUT_MS);
      const failed = (output: string): Strip => ({
        kind: "services",
        source,
        services: [],
        actions,
        failure: { title: "Status", command: manifest.status, output },
      });
      if (result.timedOut) return failed(`Timed out after ${STATUS_TIMEOUT_MS / 1000}s.\n${tail(result.output)}`);
      if (result.exitCode !== 0) return failed(tail(result.output) || `Exited with ${result.exitCode}.`);
      const services = parseStatus(result.stdout, manifest);
      if (!services.ok) return failed(services.error);
      return { kind: "services", source, services: services.value, actions, failure: null };
    })().finally(() => inFlight.delete(root));
    inFlight.set(root, pending);
    return pending;
  }

  async function run(threadId: string, target: RunTarget): Promise<Failure | null> {
    const loaded = await load(threadId);
    if (loaded.kind === "none") throw new Error("This thread's checkout has no Dev Bar manifest.");
    if (loaded.kind === "failed") return loaded.failure;
    const { root, manifest } = loaded;

    let title: string;
    let commands: string[];
    if (target.kind === "action") {
      const action = manifest.actions[target.index];
      if (!action) throw new Error(`No action ${target.index} in the manifest.`);
      title = action.label;
      commands = [action.command];
    } else {
      const found = serviceCommands(manifest, target.verb, target.id);
      if (!found) throw new Error(`The manifest cannot ${target.verb} ${target.id}.`);
      title = `${target.verb[0]!.toUpperCase()}${target.verb.slice(1)} ${target.id}`;
      commands = found;
    }

    for (const command of commands) {
      bb.log.info(`run in ${root}: ${command}`);
      const result = await runCommand(command, root, ACTION_TIMEOUT_MS);
      if (result.timedOut) {
        return { title, command, output: `Timed out after ${ACTION_TIMEOUT_MS / 60_000} minutes.\n${tail(result.output)}` };
      }
      if (result.exitCode !== 0) {
        return { title, command, output: tail(result.output) || `Exited with ${result.exitCode}.` };
      }
    }
    return null;
  }

  /** Environments whose services are being stopped, so a cascade archive stops them once. */
  const stopping = new Set<string>();

  /**
   * Stops the checkout's running services once its last live thread is
   * archived. Threads still working in the checkout may be using them, so
   * archiving one of several leaves them running.
   */
  async function stopOnArchive(thread: { id: string; environmentId?: string | null }): Promise<void> {
    const environmentId = thread.environmentId;
    if (!environmentId || stopping.has(environmentId)) return;
    stopping.add(environmentId);
    try {
      const live = await bb.sdk.threads.list({ environmentId, archived: false, includeHidden: true, limit: 1 });
      if (live.length > 0) return;
      const current = await strip(thread.id);
      if (current.kind !== "services" || current.failure) return;
      for (const id of servicesToStop(current.services)) {
        const failure = await run(thread.id, { kind: "service", verb: "stop", id });
        if (failure) bb.log.warn(`stop ${id} after archiving ${thread.id} failed: ${failure.output}`);
      }
    } finally {
      stopping.delete(environmentId);
    }
  }

  bb.events.on("thread.archived", async ({ thread }) => {
    await stopOnArchive(thread).catch((error) =>
      bb.log.warn(`stopping services after archiving ${thread.id} failed: ${error instanceof Error ? error.message : String(error)}`),
    );
  });

  bb.rpc.register(rpcContract, {
    strip: ({ threadId }) => strip(threadId),
    run: async ({ threadId, target }) => ({ failure: await run(threadId, target) }),
    startThread: async ({ threadId, failure }) => {
      const thread = (await bb.sdk.threads.get({ threadId })) as unknown as ThreadLike;
      if (!thread.projectId || !thread.environmentId) throw new Error("This thread has no checkout to start a thread in.");
      const providerId = (await settings.get()).providerId.trim();
      const started = await bb.sdk.threads.spawn({
        projectId: thread.projectId,
        environment: { type: "reuse", environmentId: thread.environmentId },
        ...(providerId === "" ? {} : { providerId }),
        ...threadRequest(failure),
      });
      return { threadId: started.id };
    },
  });
  /** The project a manifest command acts on: `--project`, or the thread or project it runs in. */
  async function projectFor(option: string | undefined, ctx: { projectId?: string; threadId?: string }): Promise<string> {
    if (option) return option;
    if (ctx.projectId) return ctx.projectId;
    if (ctx.threadId) {
      const { projectId } = await checkoutFor(ctx.threadId);
      if (projectId) return projectId;
    }
    throw new PluginCliError("No bb project to save the manifest for.", {
      code: "project_required",
      hint: "Run it from a thread, or add --project <id> (see bb project list).",
    });
  }

  const projectOption = {
    project: { type: "string", description: "The bb project id. Defaults to the thread or project the command runs in." },
  } as const;

  bb.cli.register(
    defineCli({
      name: "dev-bar",
      summary: "Save a Dev Bar manifest for a bb project whose repository commits none",
      description: `Dev Bar looks for ${MANIFEST_PATH} in the checkout, then ${LOCAL_MANIFEST_PATH}, then the manifest saved here for the thread's bb project.`,
      commands: {
        "manifest set": cliCommand({
          summary: "Save a manifest file for a bb project, shared by every checkout of it",
          positionals: [{ name: "file", description: "Path to a manifest JSON file", required: true }],
          options: projectOption,
          async run({ positionals, options }, ctx) {
            const projectId = await projectFor(options.project, ctx);
            const file = String(positionals.file);
            const path = isAbsolute(file) ? file : resolve(ctx.cwd ?? process.cwd(), file);
            const text = await readText(path);
            if (text === null) throw new PluginCliError(`No file at ${path}.`, { code: "not_found" });
            const parsed = parseManifest(text, file);
            if (!parsed.ok) throw new PluginCliError(parsed.error, { code: "invalid_manifest" });
            await bb.storage.kv.set(projectKey(projectId), text);
            return { exitCode: 0, stdout: `Saved the Dev Bar manifest for project ${projectId}.` };
          },
        }),
        "manifest show": cliCommand({
          summary: "Print the manifest saved for a bb project",
          options: projectOption,
          async run({ options }, ctx) {
            const projectId = await projectFor(options.project, ctx);
            const text = await bb.storage.kv.get<string>(projectKey(projectId));
            if (text === undefined) return { exitCode: 1, stderr: `No manifest is saved for project ${projectId}.` };
            return { exitCode: 0, stdout: text.trimEnd() };
          },
        }),
        "manifest clear": cliCommand({
          summary: "Remove the manifest saved for a bb project",
          options: projectOption,
          async run({ options }, ctx) {
            const projectId = await projectFor(options.project, ctx);
            await bb.storage.kv.delete(projectKey(projectId));
            return { exitCode: 0, stdout: `Removed the Dev Bar manifest for project ${projectId}.` };
          },
        }),
      },
    }),
  );
}
