import { Fragment, type ComponentType, type MouseEvent, type ReactNode } from "react";

import { Icon } from "./icons";
import { StackChip } from "./stack-chip";
import { cn } from "./lib/cn";
import { NoteBox, NoteField } from "./note";
import { Track } from "./track";
import type { Flag, RunTone, Stage, SweepItem, Tier } from "./types";

export interface SweepLinkProps {
  href: string;
  className?: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  // Optional, as it is on the SDK's UrlLink, or UrlLink would not fit here.
  children?: ReactNode;
}

/**
 * The link the title and parent chip are drawn with. Plugins pass the SDK's
 * `UrlLink`, which opens through bb's navigation and so follows the user's
 * browser choice. This plain anchor stands in for it in tests and stories.
 */
export function PlainLink({ href, className, onClick, children }: SweepLinkProps) {
  return (
    <a href={href} className={className} onClick={onClick}>
      {children}
    </a>
  );
}

/** The blue of "N new", here and in the comments drawer. */
export const BLUE_TEXT = "text-[#0b57d0] dark:text-[#a8c7fa]";
const BLUE_DOT = "bg-[#0b57d0] dark:bg-[#a8c7fa]";

/** Rows with a flag are tinted the way Now tints them: red for stale, slate for blocked. */
/**
 * A left edge and a faint wash: red for a stale row, slate for a blocked one,
 * and orange for one whose run is under way, in the same orange as its square.
 */
function tint(item: SweepItem, tone?: RunTone): string | false {
  if (item.flags.some((flag) => flag.kind === "stale"))
    return "-mx-4 border-l-2 border-l-destructive bg-destructive/[0.04] pl-[14px] pr-4";
  if (item.flags.some((flag) => flag.kind === "blocked"))
    return "-mx-4 border-l-2 border-l-slate-400 bg-slate-500/[0.05] pl-[14px] pr-4";
  if (tone === "underway")
    return "-mx-4 border-l-2 border-l-[#ea7a0c] bg-[#ea7a0c]/[0.05] pl-[14px] pr-4 dark:border-l-[#f08a24] dark:bg-[#f08a24]/[0.06]";
  return false;
}

function FlagText({ flag }: { flag: Flag }) {
  if (flag.kind === "blocked") {
    return (
      <span className="inline-flex items-center gap-1 font-medium text-slate-600 dark:text-slate-300">
        <Icon name="Lock" className="size-3" />
        {flag.text}
      </span>
    );
  }
  return <span className="font-medium text-destructive-text">{flag.text}</span>;
}

function ParentChip({ parent, Link }: { parent: NonNullable<SweepItem["parent"]>; Link: ComponentType<SweepLinkProps> }) {
  return (
    <Link
      href={parent.url}
      className="inline-flex min-w-0 max-w-[14rem] items-center gap-1 rounded border border-border px-1 text-[11px] leading-4 text-muted-foreground hover:text-foreground"
    >
      <Icon name="Layers" className="size-3 shrink-0" />
      <span className="truncate" title={`#${parent.number} ${parent.title}`}>
        {parent.title}
      </span>
    </Link>
  );
}

function Progress({ done, total }: { done: number; total: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums">
      <span className="relative h-1.5 w-16 overflow-hidden rounded-full bg-muted-foreground/15">
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-emerald-500"
          style={{ width: `${total === 0 ? 0 : (done / total) * 100}%` }}
        />
      </span>
      <span className="font-medium text-emerald-700 dark:text-emerald-400">
        {done}/{total}
      </span>
    </span>
  );
}

/** `#123`, the flags, the facts, and "N new", joined by dots. */
function NumberLine({ item, Link }: { item: SweepItem; Link: ComponentType<SweepLinkProps> }) {
  const parts: ReactNode[] = [
    ...item.flags.map((flag) => <FlagText flag={flag} />),
    ...item.facts.map((fact) => <span>{fact}</span>),
  ];
  if (item.newComments > 0) {
    parts.push(<span className={cn("font-medium", BLUE_TEXT)}>{item.newComments} new</span>);
  }
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
      <span>#{item.number}</span>
      {parts.map((part, index) => (
        <Fragment key={index}>
          <span aria-hidden="true">·</span>
          {part}
        </Fragment>
      ))}
    </div>
  );
}

function commentsLabel(count: number): string {
  return `${count} ${count === 1 ? "comment" : "comments"}`;
}

function Chevron({ open, small, onToggle }: { open: boolean; small: boolean; onToggle?: () => void }) {
  // A row held open has nothing to toggle, so the chevron is drawn but is not a button.
  if (!onToggle) {
    return (
      <span className="-m-1 inline-flex shrink-0 items-center justify-center p-1 text-muted-foreground/50">
        <Icon name="ChevronDown" className={small ? "size-3" : "size-3.5"} />
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={open ? "Collapse" : "Expand"}
      onClick={onToggle}
      className="-m-1 inline-flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <Icon name={open ? "ChevronDown" : "ChevronRight"} className={small ? "size-3" : "size-3.5"} />
    </button>
  );
}

export interface SweepRowProps {
  item: SweepItem;
  tier: Tier;
  open: boolean;
  /** Left out for a row that cannot be closed, which then has no chevron button. */
  onToggle?: () => void;
  /** False leaves out the chevron column, for a list whose rows never close. */
  chevron?: boolean;
  /** The row's run's tone. An under-way row gets an orange edge. */
  tone?: RunTone;
  stages: Stage[];
  onMove?: (stage: number) => void;
  onOpenLink?: () => void;
  /** Draws the title and parent chip. Defaults to a plain anchor. */
  Link?: ComponentType<SweepLinkProps>;
  /** The plugin's own actions, drawn before the note button. */
  actions: ReactNode;
  /** Drawn at the right end of the action line. */
  trailing?: ReactNode;
  /**
   * Drawn directly under the action line, before the note: the row's thread,
   * as component-library's ThreadLine.
   */
  threadLine?: ReactNode;
  /**
   * Drawn directly under the action line, before the thread line, while the
   * row's Start thread button has it open: component-library's
   * StartThreadInline.
   */
  startThread?: ReactNode;
  /**
   * Turns the comment count into a toggle for a drawer under the action line.
   * Left out, the count is only a number.
   */
  onToggleComments?: () => void;
  commentsOpen?: boolean;
  /** What the drawer holds while open. */
  commentsDrawer?: ReactNode;
  editing: boolean;
  onEditNote: () => void;
  /** `onHold` is the editor's On hold box, which is drawn only when `holdable` is set. */
  onNoteSave: (body: string, onHold: boolean) => Promise<boolean>;
  onNoteCancel: () => void;
  /** Gives the note editor an On hold checkbox, and the note an X that clears it and the hold. */
  holdable?: boolean;
  /** Dimmed while a request for this row runs. */
  busy?: boolean;
  /**
   * The plugin's own body, drawn under the title line in place of the number
   * line. `line` is true for a one-line Later row, where it is drawn inline.
   */
  renderBody?: (item: SweepItem, open: boolean, line: boolean) => ReactNode;
  /** Draws the right-hand column in place of the track; null leaves it out. */
  renderTrack?: (item: SweepItem, line: boolean) => ReactNode;
  /**
   * Where an open or closed row draws its track. "column", the default, is a
   * column down the row's right-hand side. "header" puts it beside the title
   * and number line only, so the action line below runs the row's full width
   * and its trailing item sits at the far right. "below" gives it its own line
   * under the number line, for a column too narrow for it beside the title.
   * A one-line row always draws it in the column.
   */
  trackPlacement?: "column" | "header" | "below";
}

export function SweepRow({
  item,
  tier,
  open,
  onToggle,
  chevron = true,
  tone,
  stages,
  onMove,
  onOpenLink,
  Link = PlainLink,
  actions,
  trailing,
  onToggleComments,
  commentsOpen = false,
  commentsDrawer,
  threadLine,
  startThread,
  editing,
  onEditNote,
  onNoteSave,
  onNoteCancel,
  holdable = false,
  busy = false,
  renderBody,
  renderTrack,
  trackPlacement = "column",
}: SweepRowProps) {
  const line = tier === "later" && !open;
  const unread = item.newComments > 0;
  const track = renderTrack ? (
    renderTrack(item, line)
  ) : (
    <Track stages={stages} stage={item.stage} offTrack={item.offTrack} onMove={onMove} blocked={item.blockedStage} />
  );
  const icon = item.icon ? <span className="flex shrink-0 items-center">{item.icon}</span> : null;
  const iconColumn = !chevron ? null : (
    <div className={cn("flex w-5 shrink-0 flex-col items-center gap-1.5", !line && "pt-0.5")}>
      <Chevron open={open} small={line} onToggle={onToggle} />
      {unread ? <span className={cn("size-1.5 rounded-full", BLUE_DOT)} aria-label="New" /> : null}
    </div>
  );
  const title = (
    <Link
      href={item.url}
      onClick={onOpenLink}
      className={cn("truncate hover:underline", line ? "text-muted-foreground" : "text-foreground", unread && "font-semibold")}
    >
      {item.title}
    </Link>
  );
  const conflict = item.conflicted ? (
    <span className="flex shrink-0" title="Merge conflict">
      <Icon name="AlertTriangle" label="Merge conflict" className="size-4 text-muted-foreground" />
    </span>
  ) : null;

  if (line) {
    return (
      <li className={cn("flex items-center gap-3 py-2 text-sm", tint(item, tone), busy && "opacity-50")}>
        {iconColumn}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            {icon}
            {title}
            <span className="shrink-0 text-xs text-muted-foreground">#{item.number}</span>
            {item.stack ? <StackChip stack={item.stack} Link={Link} /> : null}
            {conflict}
          </span>
          {/* One slot on the right: a held row's note, then a flag, then the first fact, or the flag would never show on a line. */}
          {renderBody ? (
            <span className="ml-auto flex shrink-0 items-center">{renderBody(item, false, true)}</span>
          ) : item.onHold ? (
            // Up to 60% of the line, so the title is what gives way.
            <span className="ml-auto flex min-w-0 shrink-0 items-center gap-1 text-xs text-muted-foreground" style={{ maxWidth: "60%" }}>
              <Icon name="Pause" className="size-3 shrink-0" />
              <span className="truncate">{item.note ?? "On hold"}</span>
            </span>
          ) : item.flags[0] ? (
            <span className="ml-auto shrink-0 text-xs">
              <FlagText flag={item.flags[0]} />
            </span>
          ) : item.facts[0] ? (
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">{item.facts[0]}</span>
          ) : null}
        </div>
        {track}
      </li>
    );
  }
  const head = renderBody ? (
    <>
      <div className="flex min-w-0 items-center gap-2">
        {icon}
        <span className="flex min-w-0 items-center gap-1.5">
          {title}
          <span className="shrink-0 text-muted-foreground">#{item.number}</span>
        </span>
        {item.stack ? <StackChip stack={item.stack} Link={Link} /> : null}
        {conflict}
        {unread ? (
          <span className={cn("shrink-0 text-xs font-medium", BLUE_TEXT)}>{item.newComments} new</span>
        ) : null}
        {item.facts[0] ? (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">{item.facts[0]}</span>
        ) : null}
      </div>
      {renderBody(item, open, false)}
    </>
  ) : (
    <>
      <span className="flex min-w-0 items-center gap-1.5">
        {icon}
        {title}
        {/* At the end of the title, so a sub-issue's number line keeps to one line. */}
        {item.parent ? <ParentChip parent={item.parent} Link={Link} /> : null}
        {conflict}
      </span>
      <NumberLine item={item} Link={Link} />
    </>
  );
  return (
    <li className={cn("flex gap-3 text-sm", open ? "py-3" : "py-2.5", tint(item, tone), busy && "opacity-50")}>
      {iconColumn}
      <div className="min-w-0 flex-1">
        {trackPlacement === "header" ? (
          <div className="flex gap-3">
            <div className="min-w-0 flex-1">{head}</div>
            {track}
          </div>
        ) : (
          head
        )}
        {trackPlacement === "below" && track ? <div className="mt-2">{track}</div> : null}
        {open ? (
          <>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {actions}
              {/* Stays put while the drawer is open, pressed, and closes it again. */}
              <button
                type="button"
                aria-expanded={editing}
                onClick={editing ? onNoteCancel : onEditNote}
                className={cn(
                  "-mx-1 inline-flex items-center gap-1 rounded px-1 hover:bg-accent hover:text-foreground",
                  editing && "bg-accent text-foreground",
                )}
              >
                <Icon name="Edit" className="size-3" />
                {item.note === null && !item.onHold ? "Add note" : "Edit note"}
              </button>
              {item.progress ? <Progress {...item.progress} /> : null}
              {item.comments && onToggleComments ? (
                <button
                  type="button"
                  aria-expanded={commentsOpen}
                  aria-label={`${commentsOpen ? "Hide" : "Show"} ${commentsLabel(item.comments)}`}
                  title={`${commentsOpen ? "Hide" : "Show"} ${commentsLabel(item.comments)}`}
                  onClick={onToggleComments}
                  className={cn(
                    "-mx-1 inline-flex items-center gap-1 rounded px-1 tabular-nums hover:bg-accent hover:text-foreground",
                    commentsOpen && "bg-accent text-foreground",
                  )}
                >
                  <Icon name="Comment" className="size-3" />
                  {item.comments}
                </button>
              ) : item.comments ? (
                <span className="inline-flex items-center gap-1 tabular-nums" title={commentsLabel(item.comments)}>
                  <Icon name="Comment" className="size-3" />
                  {item.comments}
                </span>
              ) : null}
              {trailing ? <span className="ml-auto flex items-center">{trailing}</span> : null}
            </div>
            {startThread}
            {threadLine}
            {/* The note and its editor share one place under the action line, the editor replacing the note while open. */}
            {editing ? (
              <NoteField
                initial={item.note ?? ""}
                onSave={onNoteSave}
                onCancel={onNoteCancel}
                initialOnHold={holdable ? item.onHold === true : undefined}
              />
            ) : (
              <NoteBox
                note={item.note}
                onHold={item.onHold === true}
                onClear={holdable ? () => void onNoteSave("", false) : undefined}
              />
            )}
            {commentsOpen && commentsDrawer ? <div className="mt-2">{commentsDrawer}</div> : null}
          </>
        ) : null}
      </div>
      {trackPlacement === "column" ? track : null}
    </li>
  );
}
