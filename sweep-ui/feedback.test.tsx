// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { FeedbackList, type FeedbackEntry } from "./feedback";
import { PlainLink } from "./row";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const url = "https://github.com/acme/widgets/pull/512";
const comment = (index: number): FeedbackEntry => ({
  kind: "comment",
  author: "hubber",
  avatarUrl: "",
  body: `Comment ${index}`,
  url,
  at: index,
});
const resolvedThread = (index: number): FeedbackEntry => ({
  kind: "thread",
  author: "octocat",
  avatarUrl: "",
  path: "export/csv.ts",
  line: index,
  status: "resolved",
  outdated: false,
  replies: 1,
  body: `Resolved ${index}`,
  url,
  at: index,
});

const Markdown = ({ content }: { content: string }) => <p>{content}</p>;

function draw(entries: FeedbackEntry[]) {
  render(<FeedbackList entries={entries} age={() => "1d ago"} url={url} Link={PlainLink} Markdown={Markdown} />);
}
const bodies = () => screen.queryAllByText(/^(Comment|Resolved) \d+$/).map((node) => node.textContent);

describe("FeedbackList", () => {
  it("shows every entry when there are 10 or fewer", () => {
    draw(Array.from({ length: 10 }, (_, index) => comment(index)));
    expect(bodies()).toHaveLength(10);
    expect(screen.queryByRole("button", { name: /earlier/ })).toBeNull();
  });

  it("shows the 10 newest of a longer list, and the rest on Show earlier", () => {
    draw(Array.from({ length: 50 }, (_, index) => comment(index)));
    expect(bodies()).toEqual(Array.from({ length: 10 }, (_, index) => `Comment ${40 + index}`));
    fireEvent.click(screen.getByRole("button", { name: "Show 40 earlier" }));
    expect(bodies()).toHaveLength(50);
    expect(bodies()[0]).toBe("Comment 0");
    expect(screen.queryByRole("button", { name: /earlier/ })).toBeNull();
  });

  it("leaves hidden resolved threads out of the count", () => {
    draw([...Array.from({ length: 5 }, (_, index) => resolvedThread(index)), ...Array.from({ length: 12 }, (_, index) => comment(10 + index))]);
    expect(screen.getByRole("button", { name: "Show 2 earlier" })).toBeInTheDocument();
    expect(bodies()).toHaveLength(10);
  });

  it("offers Show more only on a body cut at three lines, and opens it in place", () => {
    // jsdom lays out nothing, so report every body as taller than it is drawn, and fire the observer at once.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private callback: () => void) {}
        observe() {
          this.callback();
        }
        disconnect() {}
      },
    );
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 100 });
    try {
      draw([comment(1)]);
    } finally {
      delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    }
    const body = screen.getByText("Comment 1").parentElement!.parentElement!;
    expect(body).toHaveClass("line-clamp-3");
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(body).not.toHaveClass("line-clamp-3");
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(body).toHaveClass("line-clamp-3");
  });

  it("offers no Show more on a body that fits", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private callback: () => void) {}
        observe() {
          this.callback();
        }
        disconnect() {}
      },
    );
    draw([comment(1)]);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("marks the last newCount entries new", () => {
    render(
      <FeedbackList entries={[comment(1), comment(2), comment(3)]} newCount={2} age={() => "1d ago"} url={url} Link={PlainLink} Markdown={Markdown} />,
    );
    const isNew = (text: string) => within(screen.getByText(text).closest("li")!).queryByText("new") !== null;
    expect([isNew("Comment 1"), isNew("Comment 2"), isNew("Comment 3")]).toEqual([false, true, true]);
  });

  it("links to all of them when the conversation has more than it read", () => {
    render(<FeedbackList entries={[comment(1)]} total={80} age={() => "1d ago"} url={url} Link={PlainLink} Markdown={Markdown} />);
    expect(screen.getByRole("link", { name: /Open all 80 on GitHub/ })).toBeInTheDocument();
  });

  it("says there are no comments, or nothing open when every thread is resolved", () => {
    draw([]);
    expect(screen.getByText("No comments yet.")).toBeInTheDocument();
    cleanup();
    draw([resolvedThread(1)]);
    expect(screen.getByText("Nothing open.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open the conversation on GitHub/ })).toBeInTheDocument();
  });
});
