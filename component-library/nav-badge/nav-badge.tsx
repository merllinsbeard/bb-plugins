/** The badge bb draws on a page's entry in the sidebar and the rail: `ExperimentalBadge` from the plugin SDK. */
export type NavBadge = { count: number; tone: "warning" | "critical"; label: string };

/**
 * A page's badge in bb's navigation: the rows that need you most as a red
 * count, or else the rows that need you soon as an amber one, or else
 * nothing. The total is left out, so a badge always means something to do.
 * Its label, which bb puts in the tooltip and the accessible name, names
 * both counts when both are above zero.
 */
export function needsYouBadge({
  urgent,
  urgentLabel,
  soon = 0,
  soonLabel = "",
}: {
  urgent: number;
  /** Such as "2 urgent". */
  urgentLabel: string;
  soon?: number;
  /** Such as "3 due today". */
  soonLabel?: string;
}): NavBadge | null {
  if (urgent > 0) {
    return { count: urgent, tone: "critical", label: soon > 0 ? `${urgentLabel}, ${soonLabel}` : urgentLabel };
  }
  if (soon > 0) return { count: soon, tone: "warning", label: soonLabel };
  return null;
}

/**
 * The same red as `SidebarCount`'s circle (Tailwind's red-600), for every
 * critical badge in bb's navigation. bb draws the badge in its own
 * destructive red and scopes a plugin's stylesheet to the plugin's own
 * elements, so this goes in a style element in the document's head. bb marks
 * the badge with `data-nav-badge-tone` on both the rail and the sidebar list,
 * but not which page it belongs to, so bb's own critical badges turn this red
 * too.
 */
export const NAV_BADGE_RED_CSS =
  '[data-nav-badge-tone="critical"] > span { background-color: oklch(57.7% 0.245 27.325); color: #fff; }';

/**
 * Adds the red while the plugin runs: pass it to `app.contentScripts.register`.
 * Each plugin that registers it adds its own copy of the same rule.
 */
export const navBadgeRedContentScript = {
  id: "nav-badge-red",
  mount({ signal }: { signal: AbortSignal }) {
    const style = document.createElement("style");
    style.dataset.navBadgeRed = "";
    style.textContent = NAV_BADGE_RED_CSS;
    document.head.appendChild(style);
    const remove = () => style.remove();
    signal.addEventListener("abort", remove, { once: true });
    return remove;
  },
};

