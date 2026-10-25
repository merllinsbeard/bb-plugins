import { z } from "zod";

/**
 * The contract between this plugin and a repository: the manifest a repo
 * commits at `.bb/dev-bar.json`, and the JSON its status command prints.
 * README.md documents both for repo authors; keep the two in step.
 *
 * Nothing here touches the filesystem or spawns anything, so the whole
 * contract is testable on its own.
 */

export const MANIFEST_PATH = ".bb/dev-bar.json";
/** The same format, kept out of git, for a checkout whose repository commits none. */
export const LOCAL_MANIFEST_PATH = ".bb/dev-bar.local.json";

/** Where a manifest came from, in the order the plugin looks. */
export type ManifestSource = "committed" | "local" | "project";

export const SOURCE_LABEL: Record<ManifestSource, string> = {
  committed: MANIFEST_PATH,
  local: `${LOCAL_MANIFEST_PATH} (not committed)`,
  project: "the manifest saved for this bb project (bb dev-bar manifest show)",
};

/** The first manifest found, looking at the committed file, the local file, then the project's. */
export function pickManifest(
  candidates: Record<ManifestSource, string | null>,
): { source: ManifestSource; text: string } | null {
  for (const source of ["committed", "local", "project"] as const) {
    const text = candidates[source];
    if (text !== null) return { source, text };
  }
  return null;
}

/** A service id goes into a shell command, so it is held to a safe alphabet. */
const SERVICE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export const SERVICE_VERBS = ["start", "stop", "restart"] as const;
export type ServiceVerb = (typeof SERVICE_VERBS)[number];

const command = z.string().trim().min(1);

const actionSchema = z.object({
  label: z.string().trim().min(1).max(40),
  command,
  /** When set, the button asks this question before it runs the command. */
  confirm: z.string().trim().min(1).optional(),
});

export const manifestSchema = z.object({
  /** Prints the status JSON below. */
  status: command,
  /** Each runs with `{id}` replaced by a service's id. */
  start: command.optional(),
  stop: command.optional(),
  /** Without one, Restart runs `stop` and then `start`. */
  restart: command.optional(),
  /** Buttons at the end of the strip, such as "Start all", in this order. */
  actions: z.array(actionSchema).max(8).default([]),
});

export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestAction = z.infer<typeof actionSchema>;

export const SERVICE_STATES = ["running", "starting", "stopped", "failed"] as const;
export type ServiceState = (typeof SERVICE_STATES)[number];

const serviceSchema = z.object({
  id: z.string().regex(SERVICE_ID_PATTERN),
  label: z.string().trim().min(1).optional(),
  state: z.enum(SERVICE_STATES),
  /** Where the running service answers. The chip opens it. */
  url: z.string().url().optional(),
  /** One line shown on hover, such as why it failed. */
  message: z.string().optional(),
  /** Limits the menu to these verbs; omit for every verb the manifest has. */
  actions: z.array(z.enum(SERVICE_VERBS)).optional(),
});

export const statusSchema = z.object({ services: z.array(serviceSchema) });

export interface Service {
  id: string;
  label: string;
  state: ServiceState;
  url: string | null;
  message: string | null;
  verbs: ServiceVerb[];
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function describe(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
}

function parseJson(text: string): ParseResult<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function parseManifest(text: string, name: string = MANIFEST_PATH): ParseResult<Manifest> {
  const json = parseJson(text);
  if (!json.ok) return { ok: false, error: `${name} is not JSON: ${json.error}` };
  const parsed = manifestSchema.safeParse(json.value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: `${name}: ${describe(parsed.error)}` };
}

/** Which verbs a manifest can run at all. */
export function manifestVerbs(manifest: Manifest): ServiceVerb[] {
  return SERVICE_VERBS.filter((verb) =>
    verb === "restart" ? manifest.restart !== undefined || (manifest.start !== undefined && manifest.stop !== undefined) : manifest[verb] !== undefined,
  );
}

/**
 * The status command's output. Tools such as pnpm print a banner before the
 * script's own output, so this reads from the first line that opens a JSON
 * object rather than requiring stdout to be JSON from its first byte.
 */
export function parseStatus(stdout: string, manifest: Manifest): ParseResult<Service[]> {
  const start = stdout.search(/^\s*\{/m);
  if (start === -1) return { ok: false, error: "The status command printed no JSON object." };
  const json = parseJson(stdout.slice(start));
  if (!json.ok) return { ok: false, error: `The status command's output is not JSON: ${json.error}` };
  const parsed = statusSchema.safeParse(json.value);
  if (!parsed.success) return { ok: false, error: `The status command's output: ${describe(parsed.error)}` };
  const available = manifestVerbs(manifest);
  return {
    ok: true,
    value: parsed.data.services.map((service) => ({
      id: service.id,
      label: service.label ?? service.id,
      state: service.state,
      url: service.url ?? null,
      message: service.message ?? null,
      verbs: service.actions ? available.filter((verb) => service.actions!.includes(verb)) : available,
    })),
  };
}

/**
 * The shell commands one verb runs for one service, in order. Restart without
 * its own command is stop, then start. Null when the manifest lacks the verb
 * or the id is unsafe to put in a command.
 */
export function serviceCommands(manifest: Manifest, verb: ServiceVerb, id: string): string[] | null {
  if (!SERVICE_ID_PATTERN.test(id)) return null;
  const fill = (template: string) => template.replaceAll("{id}", id);
  if (verb === "restart" && manifest.restart === undefined) {
    if (manifest.stop === undefined || manifest.start === undefined) return null;
    return [fill(manifest.stop), fill(manifest.start)];
  }
  const template = manifest[verb];
  return template === undefined ? null : [fill(template)];
}

/** The last lines of a command's output, for showing beside a failure. */
export function tail(text: string, lines = 6): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

/** The services to stop when a checkout's last thread is archived: those running or starting that can be stopped. */
export function servicesToStop(services: Service[]): string[] {
  return services
    .filter((service) => (service.state === "running" || service.state === "starting") && service.verbs.includes("stop"))
    .map((service) => service.id);
}
