import { createContext, useContext, useEffect, useState, type ButtonHTMLAttributes, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";

import { SidebarCount } from "../sidebar-count/sidebar-count";

/**
 * The desktop app's title bar, the row along the top of the window that holds
 * the traffic lights, back and forward, the sidebar toggle, and the
 * right-panel toggle. bb has no plugin slot in it, so `TopBarSlot` finds it by
 * its test id and puts its children just after the sidebar toggle. In a
 * browser, or when bb changes the id, the slot falls back to the start of the
 * page header's row, then the right-panel toggle, then the header's actions,
 * and failing those draws nothing.
 */
export const TITLE_BAR = '[data-testid="app-window-title-bar"]';

/** bb's sidebar toggle. */
export const SIDEBAR_TOGGLE = '[data-sidebar="trigger"]';

/** The row inside bb's page header that holds the page's title and buttons. */
export const HEADER_ROW = '[data-testid="app-page-header-content-row"]';

/** bb's right-panel toggle, which most pages draw at the right end of their top bar. */
export const RIGHT_PANEL_TOGGLE = 'button[aria-label^="Show right panel"], button[aria-label^="Hide right panel"]';

/** The row of buttons at the right of a page's header, for a page with no right panel, such as a plugin's. */
export const HEADER_ACTIONS = "[data-app-page-header-actions]";

/** The spacer as wide as bb's sidebar column: the rail and, while it is open, the panel. */
export const SIDEBAR_GAP = '[data-sidebar="gap"]';

/** The space `alignEnd` keeps between the slot and the sidebar column's right edge, in pixels. */
const END_INSET = 8;

/**
 * The left margin that puts a slot's right edge `END_INSET` short of the
 * sidebar column's right edge, from where the slot sits now. Zero when the
 * slot would not fit, as on the rail alone, so it stays beside the toggle.
 */
export function endMargin({ columnRight, slotRight, margin }: { columnRight: number; slotRight: number; margin: number }): number {
  return Math.max(0, columnRight - END_INSET - (slotRight - margin));
}

/**
 * The width a slot has from where it starts beside the toggle to
 * `END_INSET` short of the sidebar column's right edge. It does not depend
 * on the slot's own width, so a slot can draw less when it is short of room
 * without that changing the answer. Negative when the sidebar is closed.
 */
export function roomToEnd({ columnRight, slotLeft, margin }: { columnRight: number; slotLeft: number; margin: number }): number {
  return columnRight - END_INSET - (slotLeft - margin);
}

/** Every plugin's slot element, so slots can line up beside each other. */
const SLOT = "[data-top-bar-slot]";

/**
 * Where the slots go: just after the sidebar toggle in the desktop app's
 * title bar. Without one, at the start of the first header row, which is the
 * leftmost pane's when a thread is split. Without that, before the last
 * right-panel toggle, or else before the first of the last header's own
 * buttons. `before` is null when the slots go last in `parent`.
 */
export function findTopBarAnchor(root: ParentNode): { parent: HTMLElement; before: Element | null } | null {
  const titleBar = root.querySelector<HTMLElement>(TITLE_BAR);
  const children = titleBar ? Array.from(titleBar.children) : [];
  const toggleAt = children.findIndex((child) => child.matches(SIDEBAR_TOGGLE) || child.querySelector(SIDEBAR_TOGGLE));
  if (titleBar && toggleAt !== -1) {
    return { parent: titleBar, before: children.slice(toggleAt + 1).find((child) => !child.matches(SLOT)) ?? null };
  }
  const header = root.querySelector<HTMLElement>(HEADER_ROW);
  if (header) return { parent: header, before: Array.from(header.children).find((child) => !child.matches(SLOT)) ?? null };
  const toggles = root.querySelectorAll<HTMLElement>(RIGHT_PANEL_TOGGLE);
  const toggle = toggles[toggles.length - 1];
  if (toggle?.parentElement) return { parent: toggle.parentElement, before: toggle };
  const rows = root.querySelectorAll<HTMLElement>(HEADER_ACTIONS);
  const row = rows[rows.length - 1];
  return row ? { parent: row, before: Array.from(row.children).find((child) => !child.matches(SLOT)) ?? null } : null;
}

function slotOrder(node: Element): [number, string] {
  const { topBarOrder = "0", topBarSlot = "" } = (node as HTMLElement).dataset;
  return [Number(topBarOrder), topBarSlot];
}

/**
 * The sibling `el` belongs just before: the first slot in the run already
 * beside the anchor that sorts after it, by `order` and then plugin id, or
 * else the anchor. Every slot works this out the same way, so several
 * plugins' slots settle into one order rather than moving past each other.
 */
export function slotNextSibling(parent: Element, before: Element | null, el: Element): Element | null {
  const run: Element[] = [];
  for (let node = before ? before.previousElementSibling : parent.lastElementChild; node?.matches(SLOT); node = node.previousElementSibling) {
    if (node !== el) run.unshift(node);
  }
  const [order, id] = slotOrder(el);
  return run.find((other) => {
    const [otherOrder, otherId] = slotOrder(other);
    return order < otherOrder || (order === otherOrder && id < otherId);
  }) ?? before;
}

/** Whether `pathname` is one of `prefixes` or a page under one. */
export function onPath(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** Whether the open page is one the slot's button opens, so the button can show as current. */
const ActiveContext = createContext(false);

/** The slot's `roomToEnd`, for a slot with `alignEnd` in the desktop title bar; null anywhere else. */
const RoomContext = createContext<number | null>(null);

/**
 * How many pixels a slot with `alignEnd` has before the sidebar column's
 * right edge, so it can draw a narrower form when the sidebar is too narrow
 * for the full one. Null outside the desktop title bar, where the slot has
 * no edge to keep to.
 */
export function useTopBarRoom(): number | null {
  return useContext(RoomContext);
}

/**
 * Puts `children` at the top left of bb's window, just after the sidebar
 * toggle in the desktop app's title bar, or before the page's title in a
 * browser, beside any other plugin's slot in `order`. Mount it from an
 * `experimental_appOverlay` component. It follows bb from page to page by
 * watching the document, and draws nothing on a page with neither. Under a
 * path in `activeOn`, the `TopBarCount` inside shows as the current page.
 */
export function TopBarSlot({ pluginId, order = 0, activeOn = [], alignEnd = false, children }: {
  /**
   * The plugin's id. bb scopes a plugin's stylesheet to elements under
   * `data-bb-plugin="<id>"`, and the slot sits in bb's own header, outside the
   * plugin's root, so it carries the attribute itself.
   */
  pluginId: string;
  /** Where this slot sits among other plugins' slots, lowest leftmost; plugin id breaks a tie. */
  order?: number;
  /** Path prefixes of the page the button opens, such as `/plugins/now/now`. */
  activeOn?: readonly string[];
  /**
   * In the desktop title bar, push the slot to the right edge of the sidebar
   * column while the sidebar is open, rather than beside the toggle.
   */
  alignEnd?: boolean;
  children: ReactNode;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [active, setActive] = useState(false);
  const [room, setRoom] = useState<number | null>(null);

  useEffect(() => {
    const el = document.createElement("span");
    el.dataset.bbPlugin = pluginId;
    el.dataset.topBarSlot = pluginId;
    el.dataset.topBarOrder = String(order);
    // The top bar is a window-drag region in bb's desktop app; this keeps the chip clickable.
    el.style.setProperty("-webkit-app-region", "no-drag");
    el.style.setProperty("app-region", "no-drag");
    // bb's title bar takes no pointer events, and turns them back on only around its own buttons.
    el.style.pointerEvents = "auto";
    el.style.display = "inline-flex";
    el.style.alignItems = "center";
    el.style.verticalAlign = "top";

    // The gap's width follows the sidebar as it opens, closes, or is dragged wider. A
    // ResizeObserver reads the layout after it has settled, and the margin it sets
    // changes neither the gap's size nor the slot's.
    let gap: Element | null = null;
    const align = () => {
      const column = gap?.getBoundingClientRect();
      const margin = parseFloat(el.style.marginLeft) || 0;
      if (!column || !el.parentElement?.matches(TITLE_BAR)) {
        if (margin !== 0) el.style.marginLeft = "";
        setRoom(null);
        return;
      }
      const slot = el.getBoundingClientRect();
      const next = endMargin({ columnRight: column.right, slotRight: slot.right, margin });
      if (next !== margin) el.style.marginLeft = next === 0 ? "" : `${next}px`;
      setRoom(Math.round(roomToEnd({ columnRight: column.right, slotLeft: slot.left, margin })));
    };
    const resize = alignEnd && typeof ResizeObserver !== "undefined" ? new ResizeObserver(align) : null;
    const watchGap = () => {
      const found = document.querySelector(SIDEBAR_GAP);
      if (found === gap) return;
      if (gap) resize?.unobserve(gap);
      gap = found;
      if (gap) resize?.observe(gap);
    };

    let frame = 0;
    const place = () => {
      frame = 0;
      setActive(onPath(window.location.pathname, activeOn));
      const anchor = findTopBarAnchor(document);
      if (anchor === null) {
        el.remove();
        setHost(null);
        return;
      }
      const { parent, before } = anchor;
      const next = slotNextSibling(parent, before, el);
      if (el.parentElement !== parent || el.nextElementSibling !== next) {
        parent.insertBefore(el, next);
        // Keep a gap before what follows: a flex row's own gap does it, but the lone toggle on the new-thread page has none.
        const style = getComputedStyle(parent);
        const gap = style.display.includes("flex") ? parseFloat(style.columnGap) || 0 : 0;
        el.style.marginRight = `${Math.max(0, 6 - gap)}px`;
      }
      // bb nudges the title bar's buttons down onto the traffic lights' line, on the toggle or a wrapper around it; match that offset.
      let transform = "none";
      for (let node = parent.matches(TITLE_BAR) ? parent.querySelector(SIDEBAR_TOGGLE) : null; node && node !== parent; node = node.parentElement) {
        transform = getComputedStyle(node).transform;
        if (transform !== "none" && transform !== "") break;
      }
      el.style.transform = transform === "none" ? "" : transform;
      if (resize) {
        watchGap();
        // Moving into the title bar resizes nothing, so the observer would not fire.
        align();
      }
      setHost(el);
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(place);
    };

    place();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("popstate", schedule);
    resize?.observe(el);
    return () => {
      resize?.disconnect();
      observer.disconnect();
      window.removeEventListener("popstate", schedule);
      if (frame !== 0) cancelAnimationFrame(frame);
      el.remove();
    };
  }, [pluginId, order, alignEnd, activeOn.join("\n")]);

  return host === null
    ? null
    : createPortal(
        <ActiveContext.Provider value={active}>
          <RoomContext.Provider value={room}>{children}</RoomContext.Provider>
        </ActiveContext.Provider>,
        host,
      );
}

const CHIP =
  "inline-flex h-7 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md bg-transparent pl-2 pr-1 text-muted-foreground transition-colors duration-150 hover:bg-state-hover hover:text-foreground hover:duration-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring aria-[current=page]:bg-state-active aria-[current=page]:text-foreground [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0";

/**
 * A button in bb's top bar, drawn as the other plugins' buttons are, around
 * whatever it shows. On the page it opens it shows as current, as
 * `TopBarCount` does.
 */
export function TopBarButton({
  label,
  onClick,
  active,
  className = "",
  children,
  ref,
  ...rest
}: {
  /** The button's name, such as "Open Tokenomics". */
  label: string;
  onClick: () => void;
  /** Whether its page is open. Inside a `TopBarSlot`, the slot works this out from `activeOn`. */
  active?: boolean;
  className?: string;
  children: ReactNode;
  /** For a popover or tooltip trigger wrapped around it. */
  ref?: Ref<HTMLButtonElement>;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "children" | "className">) {
  const current = useContext(ActiveContext);
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-current={active ?? current ? "page" : undefined}
      {...rest}
      className={`${CHIP} ${className}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * A page's counts in bb's top bar, as a button that opens the page: its
 * icon, then the same counts `SidebarCount` draws beside its name in the
 * sidebar. At a total of zero only the icon shows. On the page it opens it
 * shows as current, the way bb marks the open page in its own navigation.
 */
export function TopBarCount({
  icon,
  label,
  onClick,
  active,
  ...counts
}: {
  icon: ReactNode;
  /** The button's name, such as "Open Now". */
  label: string;
  onClick: () => void;
  /** Whether its page is open. Inside a `TopBarSlot`, the slot works this out from `activeOn`. */
  active?: boolean;
  urgent: number;
  total: number;
  urgentLabel: string;
  totalLabel: string;
  soon?: number;
  soonLabel?: string;
}) {
  return (
    <TopBarButton label={label} title={label} onClick={onClick} active={active} className={counts.total === 0 ? "pr-2" : ""}>
      {icon}
      <SidebarCount {...counts} />
    </TopBarButton>
  );
}
