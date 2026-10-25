// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { NAV_BADGE_RED_CSS, navBadgeRedContentScript, needsYouBadge } from "./nav-badge";

describe("needsYouBadge", () => {
  it("counts the urgent rows in red, naming both counts", () => {
    expect(needsYouBadge({ urgent: 15, urgentLabel: "15 urgent", soon: 24, soonLabel: "24 due today" })).toEqual({
      count: 15,
      tone: "critical",
      label: "15 urgent, 24 due today",
    });
  });

  it("counts the rows due soon in amber when none are urgent", () => {
    expect(needsYouBadge({ urgent: 0, urgentLabel: "0 urgent", soon: 2, soonLabel: "2 due today" })).toEqual({
      count: 2,
      tone: "warning",
      label: "2 due today",
    });
  });

  it("draws nothing when nothing needs you", () => {
    expect(needsYouBadge({ urgent: 0, urgentLabel: "0 urgent" })).toBeNull();
  });
});

describe("navBadgeRedContentScript", () => {
  it("adds the red to the document's head until the plugin stops", () => {
    const controller = new AbortController();
    navBadgeRedContentScript.mount({ signal: controller.signal });
    expect(document.head.querySelector("style[data-nav-badge-red]")?.textContent).toBe(NAV_BADGE_RED_CSS);
    controller.abort();
    expect(document.head.querySelector("style[data-nav-badge-red]")).toBeNull();
  });
});
