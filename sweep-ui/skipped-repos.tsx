// The mark pinned to the bottom of a sweep panel that counts the repositories
// the project filter held back. It is a standing fact about this machine, not
// news, so it shows only an icon and a number, and hovering it names them and
// says how to bring them back.
import { Icon } from "./icons";

export interface SkippedReposFooterProps {
  repos: string[];
  /** What happened to them: "Not swept", "Not shown". */
  label?: string;
  /** How to bring them back: the setting that lists them. */
  hint?: string;
}

export function SkippedReposFooter({ repos, label = "Not swept", hint }: SkippedReposFooterProps) {
  if (!repos.length) return null;
  const sentence = `${label}: ${repos.join(", ")}. No project checked out here.${hint ? ` ${hint}` : ""}`;
  return (
    <div className="shrink-0 px-4 pb-2 md:px-5">
      <span
        role="note"
        aria-label={sentence}
        title={sentence}
        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/70"
      >
        <Icon name="Info" className="size-3" />
        {repos.length}
      </span>
    </div>
  );
}
