// A "list" layout view in the side panel: the whole view as one list. The
// items to decide sit at the top as dashed rows with their buttons, and move
// into the list below once one of their buttons goes through. The items with
// no buttons are that list. An item with a draft shows it in a text field to
// edit before a button sends it. Kept free of RPC so a story can render it with
// fixture props.
import { useState } from "react";
import { Markdown, UrlLink } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { firstLine } from "./banner.js";
import { dismissLabelOf, fillDraft, isQuiet, needsConfirm, usesDraft, type Item } from "./schema.js";
import type { ItemRecord, StoredView } from "./store.js";
import { TONE_CLASS } from "./view-panel.js";

export interface ListPanelProps {
  stored: StoredView;
  /** Which item has an action in flight. */
  busyItem: string | null;
  /** `draft` is the item's draft as the user edited it; absent when unchanged. */
  onRun: (item: Item, index: number, draft?: string) => void;
  onDismiss: (item: Item, dismissed: boolean) => void;
  /** An item whose command confirmation starts open, as `itemId:index`, for a story. */
  confirming?: string;
}

/** What a failed action left, in one line, or null when it did not fail. */
export function failureLine(record: ItemRecord | undefined): string | null {
  const result = record?.result;
  if (!result) return null;
  if (result.error !== undefined) return result.error;
  if (result.exitCode === undefined || result.exitCode === 0) return null;
  return (result.output ?? "").split("\n").find((line) => line.trim() !== "")?.trim() || `exit ${result.exitCode}`;
}

/**
 * The rows in the order the list shows them: items still to decide (skipped
 * ones included, so they can be undone), then items just done, then the plain
 * rows, each in the order published.
 */
export function listRows(stored: StoredView): { deciding: Item[]; listed: Item[] } {
  const items = stored.view.sections.flatMap((section) => section.items);
  const state = (item: Item) => stored.items[item.id]?.state ?? "open";
  const quiet = (item: Item) => isQuiet(stored.view, item);
  return {
    deciding: items.filter((item) => !quiet(item) && state(item) !== "done"),
    listed: [...items.filter((item) => !quiet(item) && state(item) === "done"), ...items.filter(quiet)],
  };
}

/** What a done item's row says: the button's `doneLabel`, or its label. */
export function doneTag(item: Item, record: ItemRecord | undefined): string {
  const label = record?.result?.label;
  const action = item.actions.find((candidate) => candidate.label === label);
  return action?.doneLabel ?? label ?? "Done";
}

function Title({ item, className }: { item: Item; className?: string }) {
  return item.url === undefined ? (
    <span className={cn("truncate", className)}>{item.title}</span>
  ) : (
    <UrlLink href={item.url} className={cn("truncate hover:underline", className)} title={item.url}>
      {item.title}
    </UrlLink>
  );
}

function Badges({ item }: { item: Item }) {
  return (
    <>
      {item.badges.slice(0, 2).map((badge) => (
        <span key={badge.label} className={cn("shrink-0 rounded border px-1 text-[10px]", TONE_CLASS[badge.tone])}>
          {badge.label}
        </span>
      ))}
    </>
  );
}

function DecidingRow({
  item,
  record,
  dismissLabel,
  busy,
  initiallyConfirming,
  onRun,
  onDismiss,
}: {
  item: Item;
  record: ItemRecord | undefined;
  dismissLabel: string;
  busy: boolean;
  initiallyConfirming: number | null;
  onRun: (index: number, draft?: string) => void;
  onDismiss: (dismissed: boolean) => void;
}) {
  const [confirming, setConfirming] = useState<number | null>(initiallyConfirming);
  // Starts from the last edit sent, so a failed Add keeps what the user typed.
  const [draft, setDraft] = useState(record?.result?.draft ?? item.draft);
  const edited = draft.trim() !== item.draft.trim();
  const empty = item.draft !== "" && draft.trim() === "";
  const run = (index: number) => {
    const action = item.actions[index]!;
    onRun(index, usesDraft(action) && edited && !empty ? draft.trim() : undefined);
  };
  const click = (index: number) => (needsConfirm(item.actions[index]!) ? setConfirming(index) : run(index));
  const primary = item.actions.findIndex((action) => action.primary && action.type !== "link");
  const dismissed = record?.state === "dismissed";
  const failure = failureLine(record);
  const pending = confirming === null ? undefined : item.actions[confirming];
  const summary = firstLine(item.summary);
  return (
    <li
      className={cn(
        "rounded-md border border-dashed px-2.5 py-1.5",
        failure !== null ? "border-destructive/50" : "border-border",
        dismissed && "opacity-50",
      )}
    >
      {/* Top-aligned, so the + and the buttons sit beside the name, not between it and the summary. */}
      <div className={cn("flex gap-2.5", item.draft === "" && !summary ? "items-center" : "items-start")}>
        <Icon name="Plus" className={cn("size-3.5 shrink-0 text-muted-foreground", (item.draft !== "" || summary) && "mt-[7px]")} aria-hidden />
        <span className={cn("min-w-0 flex-1", item.draft === "" && summary && "pt-1")}>
          {item.draft === "" ? (
            <>
              <span className="flex min-w-0 items-baseline gap-2 text-sm text-foreground">
                <Title item={item} className={cn(dismissed && "line-through")} />
                <Badges item={item} />
              </span>
              {summary ? <span className="mt-0.5 block break-words text-xs text-muted-foreground">{summary}</span> : null}
            </>
          ) : (
            <>
              <span className="flex min-w-0 items-center gap-2">
                <Input
                  aria-label={`${item.title}: ${item.draftLabel}`}
                  value={draft}
                  disabled={dismissed || busy}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && primary !== -1 && !empty) click(primary);
                  }}
                  className={cn("h-7 min-w-0 flex-1 bg-background px-2 text-sm text-foreground", dismissed && "line-through")}
                />
                <Badges item={item} />
              </span>
              {summary ? <span className="mt-0.5 block break-words text-xs text-muted-foreground">{summary}</span> : null}
            </>
          )}
          {failure === null ? null : (
            <span className="block truncate text-xs text-destructive" title={record?.result?.output ?? failure}>
              {record?.result?.label} failed: {failure}
            </span>
          )}
        </span>
        {busy ? (
          <span className="shrink-0 text-xs text-muted-foreground">Working…</span>
        ) : dismissed ? (
          <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2 text-xs" onClick={() => onDismiss(false)}>
            Undo
          </Button>
        ) : (
          <span className="flex shrink-0 items-center gap-1">
            {item.actions.map((action, index) =>
              action.type === "link" ? (
                <Button key={action.label} size="sm" variant={action.primary ? "default" : "outline"} className="h-7 px-2.5 text-xs" asChild>
                  <UrlLink href={action.url}>{action.label}</UrlLink>
                </Button>
              ) : (
                <Button
                  key={action.label}
                  size="sm"
                  variant={action.primary ? "default" : "outline"}
                  className="h-7 px-2.5 text-xs"
                  disabled={empty && usesDraft(action)}
                  onClick={() => click(index)}
                >
                  {action.label}
                </Button>
              ),
            )}
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => onDismiss(true)}>
              {dismissLabel}
            </Button>
          </span>
        )}
      </div>
      {pending?.type === "command" && !busy && !dismissed ? (
        <div className="mt-1.5 border-t border-dashed border-border pt-1.5">
          <div className="text-xs text-muted-foreground">Run this command{pending.cwd ? ` in ${pending.cwd}` : ""}?</div>
          <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-xs text-foreground">
            {(fillDraft(pending, item.draft, edited && !empty ? draft.trim() : undefined).action as typeof pending).command}
          </pre>
          <div className="mt-1.5 flex gap-1.5">
            <Button
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => {
                run(confirming!);
                setConfirming(null);
              }}
            >
              Run
            </Button>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function ListPanel({ stored, busyItem, onRun, onDismiss, confirming }: ListPanelProps) {
  const { deciding, listed } = listRows(stored);
  const [confirmItem, confirmIndex] = confirming?.split(":") ?? [];
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="px-4 pb-2 pt-4">
        <div className="text-sm font-medium text-foreground">{stored.view.title}</div>
        {stored.view.summary ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            <Markdown content={stored.view.summary} />
          </div>
        ) : null}
      </div>
      {deciding.length === 0 ? null : (
        <ul className="flex flex-col gap-1 px-3 pb-2">
          {deciding.map((item) => (
            <DecidingRow
              key={item.id}
              item={item}
              record={stored.items[item.id]}
              dismissLabel={dismissLabelOf(stored.view, item)}
              busy={busyItem === item.id}
              initiallyConfirming={confirmItem === item.id ? Number(confirmIndex) : null}
              onRun={(index, draft) => onRun(item, index, draft)}
              onDismiss={(dismissed) => onDismiss(item, dismissed)}
            />
          ))}
        </ul>
      )}
      <ul className="border-t border-border">
        {listed.map((item) => {
          const record = stored.items[item.id];
          const done = record?.state === "done";
          return (
            <li key={item.id} className="flex items-center gap-2.5 border-b border-border px-4 py-2 text-sm last:border-0">
              <Icon name="Circle" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              {done && record?.result?.draft !== undefined ? (
                <span className="min-w-0 truncate text-foreground">{record.result.draft}</span>
              ) : (
                <Title item={item} className="min-w-0 text-foreground" />
              )}
              {done ? (
                <span className="shrink-0 rounded border border-success/40 px-1 text-[10px] text-success">{doneTag(item, record)}</span>
              ) : (
                <Badges item={item} />
              )}
              {!done && firstLine(item.summary) ? (
                <span className="min-w-0 truncate text-xs text-muted-foreground">{firstLine(item.summary)}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
