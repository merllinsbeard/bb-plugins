/**
 * One entry in an issue's `projectItems`, narrowed to what placement needs.
 *
 * An issue can sit on several projects at once, and most of these sit on two —
 * a team board and someone's personal one. Reading "the first project item"
 * would pick whichever GitHub returned first, so the boards are named and the
 * rest ignored.
 *
 * The board names are a plugin setting rather than a constant: they identify
 * private projects, and this repository is public.
 */
export interface ProjectItem {
  title?: string;
  status?: { name?: string } | null;
}

/**
 * Whether an issue sits on one of the configured boards, which one, and what
 * its Status column says there.
 *
 * Being on a board and having a status there are two questions, not one. An
 * issue added to a board without a status is on it, in the board's own "No
 * Status" column, and reporting that as "not on a board" would offer to add an
 * issue that is already there.
 */
export interface BoardPlacement {
  onBoard: boolean;
  status: string | null;
  /** The board's title as GitHub gives it, or null when the issue is on none. */
  board: string | null;
}

/**
 * The "Project boards" setting as a list of names, in the order given. Blank
 * is an empty list, which reads any board.
 */
export function parseBoardNames(raw: string): string[] {
  return parseStatusOrder(raw);
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The issue's placement on the first listed board it is on. An issue on two
 * listed boards reads the one listed first, even when that one has it in No
 * Status, so the list order is the whole rule. With no boards listed, the
 * first board that gives it a status wins, then any board at all.
 */
export function boardPlacement(
  items: ProjectItem[] | null | undefined,
  boards: string,
): BoardPlacement {
  const listed = parseBoardNames(boards);
  const all = (items ?? []).map((item) => ({
    title: (item.title ?? "").trim(),
    status: (item.status?.name ?? "").trim() || null,
  }));

  if (listed.length === 0) {
    const placed = all.find((item) => item.status !== null) ?? all[0];
    return placed
      ? { onBoard: true, status: placed.status, board: placed.title || null }
      : { onBoard: false, status: null, board: null };
  }

  for (const name of listed) {
    const matches = all.filter((item) => sameName(item.title, name));
    if (matches.length === 0) continue;
    const placed = matches.find((item) => item.status !== null) ?? matches[0]!;
    return { onBoard: true, status: placed.status, board: placed.title };
  }
  return { onBoard: false, status: null, board: null };
}

/**
 * The board a row's moves go to, among the listed boards its repository's
 * owner has, in list order.
 *
 * A row already on a board moves there. A row on no listed board is added to
 * the first one the owner has. A row on a listed board the owner does not
 * have, such as an org's issue on someone's personal board, gets null: the
 * board's owner cannot be read from the listing, and adding the issue to the
 * owner's board instead would put it on two.
 */
export function boardForRow<T extends { title: string }>(
  row: { onBoard: boolean; board?: string | null },
  ownerBoards: readonly T[],
): T | null {
  if (row.onBoard && row.board) {
    return ownerBoards.find((candidate) => sameName(candidate.title, row.board!)) ?? null;
  }
  // On a board but with no name recorded: a row stored before the name was.
  // The first board is the one a single-board setting would have read.
  return ownerBoards[0] ?? null;
}

/**
 * The stages a row's board has, in the stages' order. A board missing a stage
 * would refuse the move, so its button is left out rather than drawn and
 * failed. No options means the board could not be read; every stage stays,
 * since the row then shows its status as text instead of buttons.
 */
export function stagesOnBoard(stages: readonly string[], options: readonly string[]): string[] {
  if (options.length === 0) return [...stages];
  return stages.filter((stage) => options.some((option) => sameName(option, stage)));
}

/** The status alone, for callers that do not care about membership. */
export function boardStatus(
  items: ProjectItem[] | null | undefined,
  board: string,
): string | null {
  return boardPlacement(items, board).status;
}

/**
 * A comma-separated list of status names from a setting, such as the board
 * stages or the statuses that are on you.
 */
export function parseStatusOrder(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * Whether this plugin should move an issue's card to `target` on its own.
 *
 * Three ways the answer is no, and each one exists because of a specific way
 * the sweep could otherwise misbehave:
 *
 * - No target configured. The move is a convenience, and blank turns it off.
 * - The card is already there. A write that changes nothing still costs a
 *   round trip, and the sweep runs every few minutes.
 * - This plugin already moved it to that same status once. This is the one
 *   that matters: a pull request stays open for days, so without it every
 *   sweep would drag a card back to "In Review" for as long as the pull
 *   request lived, quietly undoing any move made by hand. Moving it once and
 *   then leaving it alone is the difference between a helpful default and a
 *   fight with the board.
 */
export function shouldAutoApply(
  current: string | null,
  alreadyApplied: string | null,
  target: string,
): boolean {
  const wanted = target.trim().toLowerCase();
  if (wanted === "") return false;
  if ((current ?? "").trim().toLowerCase() === wanted) return false;
  if ((alreadyApplied ?? "").trim().toLowerCase() === wanted) return false;
  return true;
}
