import { describe, expect, it } from "vitest";
import { boardForRow, boardPlacement, shouldAutoApply, stagesOnBoard } from "./board.js";

describe("boardPlacement", () => {
  it("reads the status from the named board, ignoring the others", () => {
    const placement = boardPlacement(
      [
        { title: "Someone's untitled project", status: { name: "Backlog" } },
        { title: "Acme Board", status: { name: "In Review" } },
      ],
      "Acme Board",
    );
    expect(placement).toEqual({ onBoard: true, status: "In Review", board: "Acme Board" });
  });

  it("separates being on the board from having a status there", () => {
    expect(boardPlacement([{ title: "Acme Board", status: { name: "" } }], "Acme Board")).toEqual({
      onBoard: true,
      status: null,
      board: "Acme Board",
    });
  });

  it("reports an issue on a different board as off this one", () => {
    expect(boardPlacement([{ title: "Other", status: { name: "Ready" } }], "Acme Board")).toEqual({
      onBoard: false,
      status: null,
      board: null,
    });
  });

  it("reads the first listed board the issue is on", () => {
    const items = [
      { title: "Octocat's Board", status: { name: "Todo" } },
      { title: "Acme Board", status: { name: "In Review" } },
    ];
    expect(boardPlacement(items, "Acme Board, Octocat's Board")).toEqual({
      onBoard: true,
      status: "In Review",
      board: "Acme Board",
    });
    expect(boardPlacement(items, "Octocat's Board, Acme Board").board).toBe("Octocat's Board");
  });

  it("falls through to a later listed board when the issue is not on the first", () => {
    expect(
      boardPlacement([{ title: "Octocat's Board", status: { name: "Todo" } }], "Acme Board, octocat's board"),
    ).toEqual({ onBoard: true, status: "Todo", board: "Octocat's Board" });
  });

  it("keeps the first listed board even when the issue has no status there", () => {
    // The list order is the whole rule, so a later board's status does not leak in.
    const items = [
      { title: "Acme Board", status: null },
      { title: "Octocat's Board", status: { name: "Todo" } },
    ];
    expect(boardPlacement(items, "Acme Board, Octocat's Board")).toEqual({
      onBoard: true,
      status: null,
      board: "Acme Board",
    });
  });

  it("reads any board when none is listed", () => {
    const items = [
      { title: "Acme Board", status: null },
      { title: "Octocat's Board", status: { name: "Todo" } },
    ];
    expect(boardPlacement(items, "")).toEqual({ onBoard: true, status: "Todo", board: "Octocat's Board" });
    expect(boardPlacement([], " ")).toEqual({ onBoard: false, status: null, board: null });
  });
});

describe("boardForRow", () => {
  const acme = { title: "Acme Board" };
  const gadgets = { title: "Gadgets Board" };

  it("moves a row on the board it is on", () => {
    expect(boardForRow({ onBoard: true, board: "gadgets board" }, [acme, gadgets])).toBe(gadgets);
  });

  it("adds a row on no listed board to the owner's first listed board", () => {
    expect(boardForRow({ onBoard: false, board: null }, [acme, gadgets])).toBe(acme);
  });

  it("refuses a row on a listed board its owner does not have", () => {
    // Adding it to the owner's board instead would put it on two.
    expect(boardForRow({ onBoard: true, board: "Octocat's Board" }, [acme])).toBeNull();
  });

  it("has nothing when the owner has none of the listed boards", () => {
    expect(boardForRow({ onBoard: false, board: null }, [])).toBeNull();
  });
});

describe("stagesOnBoard", () => {
  it("keeps the stages the board has, in the stages' order", () => {
    expect(
      stagesOnBoard(["Backlog", "Todo", "Ready", "In Progress", "In Review"], ["Done", "in progress", "Todo"]),
    ).toEqual(["Todo", "In Progress"]);
  });

  it("keeps every stage when the board could not be read", () => {
    expect(stagesOnBoard(["Ready", "In Progress"], [])).toEqual(["Ready", "In Progress"]);
  });
});

describe("shouldAutoApply", () => {
  it("moves a card that is somewhere else", () => {
    expect(shouldAutoApply("Backlog", null, "In Progress")).toBe(true);
  });

  it("moves a card that is on no column yet", () => {
    expect(shouldAutoApply(null, null, "In Progress")).toBe(true);
  });

  it("leaves a card that is already there", () => {
    // The write would change nothing and the sweep runs every few minutes.
    expect(shouldAutoApply("In Progress", null, "In Progress")).toBe(false);
    expect(shouldAutoApply("in progress", null, "In Progress")).toBe(false);
    expect(shouldAutoApply(" In Progress ", null, "In Progress")).toBe(false);
  });

  it("refuses to make the same move twice", () => {
    // This is the one that matters. A closing pull request stays open for
    // days, so without it every sweep would drag the card back to In Review
    // and a move made by hand would never survive.
    expect(shouldAutoApply("Backlog", "In Review", "In Review")).toBe(false);
  });

  it("still makes a different move it has not made before", () => {
    // Having moved a card to In Progress must not block the later promotion.
    expect(shouldAutoApply("In Progress", "In Progress", "In Review")).toBe(true);
  });

  it("does nothing when the target is blank, which is how the move is turned off", () => {
    expect(shouldAutoApply("Backlog", null, "")).toBe(false);
    expect(shouldAutoApply("Backlog", null, "   ")).toBe(false);
  });
});
