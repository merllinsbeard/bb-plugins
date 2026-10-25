# bb-plugin-issue-sweep

A bb sidebar panel listing every open GitHub issue assigned to you, across all
repositories, in two columns: what needs you, and everything else grouped by
board status.

The sweep is deterministic: it runs `gh`, parses the result with pure functions,
and spends no model tokens. No agent is involved at any point.

## Install on a new machine

```bash
cd ~/.dotfiles/bb/plugins/bb-plugin-issue-sweep
npm install
bb plugin install . --yes
```

## Requirements

- `gh` on PATH and authenticated as you (`gh auth login`). The plugin reports a
  missing or unauthenticated `gh` as a configuration state, not an error.
- The [gh-context](../bb-plugin-gh-context) plugin, which keeps the record of
  which threads belong to which issues. Without it the panel still lists
  issues, but none offers to start a thread, since a row cannot tell whether it
  already has one; after a few sweeps without it the plugin reports that it
  needs configuring.

## What it lists

One `gh search issues --assignee=@me --state=open` call covers every repository
you can see, so there is no per-repo fan-out and no allowlist to maintain. Two
kinds of hit are dropped: pull requests, which GitHub returns because it models
them as issues, and anything without a parseable `owner/name` or timestamp.

Search caps at 100 hits. Past that the panel says the list may be incomplete
rather than quietly showing a subset.

## How the list is ordered

Every issue is in one run. The runs that need you fill the left column, and
the rest go in the right one. Each column has summary squares at its top, one
square per issue: the left column's grouped by run ("2 new comments"), the
right column's by status group ("4 backlog"), coloured as the status dots are.
Pressing a group shows only its issues in that column; pressing it again shows
them all.

| Column | Runs, in order | Rows |
| --- | --- | --- |
| Needs you | new comments, stale, working, in progress, to start, on hold | Open: title, number line, note, actions, and why the issue is there. On hold rows are one line, with the note at the right, opening to the rest |
| Everything else | waiting on review, later, blocked | One line each, grouped by board status, opening to the same actions |

- **New comments**: comments others posted since you last opened the issue,
  its thread, or its comments drawer from the panel, started one, or commented
  yourself. A comment of
  yours is never new, and neither is anything before it, since you read the
  thread to reply. The first sweep to see an issue records its count, so
  nothing is new on the first sync.
- **Stale**: in one of the "Statuses that are on you", not blocked, not
  a parent, and not updated for "Stale after (days)". Flagged in red. A parent
  is never stale, because its sub-issues are the work. A board move does not
  change the issue's updated time on GitHub, so the plugin counts the moves it
  makes itself, from the picker or its own automatic moves, as activity. A
  move made on the board in GitHub is not seen, and the issue can still read
  as stale after one.
- **Working**: has a thread. Its rows have an orange left edge.
- **In progress**: in a counted status further along the "Board stages, in
  order" than the first counted one (In Progress, with the defaults), and not
  blocked. A parent counts, since its sub-issues are not done. Its squares are
  sky blue.
- **To start**: on the board in a counted status, not blocked, and without
  sub-issues.
- **On hold**: ticked On hold in its note editor, and would otherwise be in
  stale, working, in progress, or to start. Its board status does not change.
  A held issue is never stale, and it still moves up to new comments when
  someone comments. An issue already in review, blocked, or later stays there.
- **Waiting on review**: in the "Board status when a closing pull request
  opens" status.
- **Later**: everything else that is not blocked, including issues with
  sub-issues that are not in progress.
- **Blocked**: blocked by an open issue, through GitHub's issue dependencies.

An issue that fits more than one run takes the first in the order above. So
an issue with a thread and new comments is in "new comments", a blocked issue
in the review status is in "waiting on review", and a blocked parent is in
"blocked". Within a run, the most
recently updated issue comes first, tie-broken by repository then number:
issues bulk-edited in one action share a timestamp to the second, and without
the tiebreak those rows would reshuffle between sweeps.

The right column groups its issues under headings: the "Board stages, in
order" from the furthest along back, then Blocked, then statuses the board has
that are not stages (a "Stalled" column, say), alphabetically, then No status,
then Not on board. Within a group, the order is the run order above.

A chevron opens or closes a row in the right column. The row whose Harvest
timer is running stays open, so the timer stays in view. A one-line row with a
stale or blocked flag shows the flag in place of its age.

## Each row

The number line shows the issue number, any stale or blocked flag, how long ago
it was updated, and "N new" in blue when there are new comments. The comment
count and the sub-issue or task progress bar are at the end of the action
line instead, the bar first. A sub-issue shows its parent as a chip at the end of its title. The
repository joins the line only when more than one is in play.

An open row has a button for each of the "Board stages, in order" that its
board has, with the current stage filled. Pressing a stage moves the issue to
it on the board, adding the issue to the board first if it is not on it. The
last segment opens a menu of every status the board has, and names the status when it is not a
stage: "Stalled", say, "No status", or "Not on board". In the left column the
buttons sit beside the title, with no label saying why the issue needs you:
the squares above the column name each run. In the narrower right column the
buttons have a line of their own under the number line.

A row with a thread has a line under its actions saying what the thread is
doing, as bb's sidebar does (**Working**, **Needs you**, **Done, unread**,
**Failed, unread**, or **Idle**), with the thread's title. Clicking the line
opens the thread. The status comes from bb's sidebar, so it makes no request.

An open row's actions are Start thread or Open thread, Copy link, and Add note
or Edit note, then the progress bar, with its count in green, and the comment count. The Harvest clock, when the Harvest plugin is installed, sits at
the right end of that line. The page asks the Harvest plugin for the clock's state after it draws the rows, which costs two Harvest requests each time the page opens, a sweep lands, or a timer starts. Start
thread reads "No project here" and is disabled when no bb project is checked
out for the repository.

Clicking the comment count opens the issue's latest comments in a drawer under
the action line, oldest first, with the ones that are new marked in blue, and
yours and bots' labelled "you" and "bot". Each comment is drawn as the Markdown
it was written in, cut at three lines with Show more under it, and its author
line opens it on GitHub. The drawer reads the latest 50 and shows the newest
10, with the rest behind "Show N earlier", and when the issue has more than 50,
the link at the bottom says how many there are in all. Opening the drawer makes one GitHub GraphQL request for that
issue, and none is made until you click; once it has read the comments, the
row's "N new" clears. Clicking the count again closes it.

A note is a one-line next step, stored only on this machine and never sent to
GitHub. It shows in a grey drawer under the action line, and Add note or Edit
note opens its editor in the same place. The editor's On hold box puts the
issue on hold, with or without text: it moves to the bottom of Needs you as
one line, with the note at its right end (or "On hold" when there is no text),
and its chevron opens it to the full row, whose drawer starts with "On hold". The hold is stored with the note, on this
machine only, and clearing the box takes the issue off hold. The X at the
right end of the drawer deletes the note and the hold together. The button stays put, pressed, while
the editor is open; pressing it again
closes the editor. Save or Enter saves the note, Cancel or Escape cancels, and
saving an empty note with the box clear deletes it.

## What a sweep costs on GitHub

GitHub limits GraphQL to 5,000 points an hour per account, shared by every
plugin and every `gh` command an agent runs, and charges each query by how
many nodes it could return rather than how many calls it takes. Clicking the
sync time in the title bar shows the past hour of sweeps: the total, one bar per sweep with its
points, calls and time, and how many points the account has left before the
hour resets.

Each sweep is measured by reading the account's budget twice before it and up
to three times after, through `createSyncUsage` in `gh-shared`. The readings
are `gh api graphql` calls for `rateLimit`, which cost no points; the extra
readings are there because GitHub answers from two counters with different
windows and only two readings from the same one can be subtracted. A sweep
whose readings never match shows as unmeasured. The difference counts
everything the account spent during the sweep, so a sweep that ran while an
agent was using `gh` reads high. The hour is kept in memory, so a reload
starts it over. The measured span runs through the comment-author reads, the board lookups and the automatic status moves, so their points count; only the listing and comment-author calls are in the call count.

## Settings

- **Sync interval** — how often the background sweep runs. Default 5 minutes.
- **Path to the gh CLI** — override when `gh` is not on the server's PATH.
- **Only sweep repositories checked out here** — on by default. A repository is
  swept only when a bb project on this machine has it as one of its checkout's
  git remotes, upstream as readily as origin. bb's project
  list is per-installation, so this is what separates the computer a repository
  is checked out on from every other one: the work laptop's repositories stop
  filling the personal one's panel. The skipped repositories are named under
  the list, so an empty panel never reads as "nothing is assigned to you".
- **Also sweep these repositories** — comma or newline separated `owner/name`,
  for a repository worth watching without a checkout here. Ignored when the
  filter is off.
- **Project boards** — the boards each issue's status is read from, separated
  by commas, such as `Team Board, Personal`. An issue on more than one reads
  the first one listed, even when it has no status there. A row on none of
  them is added to the first board listed that its repository's owner has. A
  row on a listed board its owner does not have, such as an org's issue on a
  personal board, shows its status but cannot be moved from here. Blank reads
  the status from any board and offers no moves. Resolving the boards costs
  one `gh project list` per repository owner and one `gh project field-list`
  per board found, once per reload or change to this setting.
- **Board stages, in order** — the stage buttons on each open row, and the
  order of the status groups in the right column, drawn furthest along first. Default
  `Backlog,Ready,In Progress,In Review`. With boards whose columns differ,
  list them all, such as `Backlog,Todo,Ready,In Progress,In Review`, and each
  row shows only the ones its own board has.
- **Statuses that are on you** — the statuses "to start" and stale are made
  of. Default `In Progress,Ready`.
- **Stale after (days)** — how long a counted issue can go without an update
  before it is flagged stale. Default 7; anything but a positive whole number
  is read as 7.
- **Board status when a closing pull request opens** — the board move made when
  a pull request that closes the issue opens, and the status the list reads as
  waiting on review. Default `In Review`.

## When a sweep fails

The last good rows stay in the store and stay on screen, with the error in a
banner above them. A stale list beats an empty one, and the background service
keeps running, so the panel heals on its own once `gh` works again.

## Development

```bash
npm test          # vitest
npm run typecheck # tsc --noEmit
bb plugin dev     # rebuild and reload on save
```

**All test fixtures are synthetic.** This repository is public. Never paste real
issue titles, repository names, or URLs into a test.

## Threads

Start thread opens bb's composer under the row, where Add note opens its
editor, so you can read and edit the prompt first. Clicking it again closes
it. Starting it leaves you on the page, with a toast whose **Go to
thread** button opens the new thread.

A thread started from a row is linked to its issue in gh-context, and the row
then opens that thread rather than starting another.

A thread started from the composer whose first prompt links exactly one issue
is adopted on the next successful sweep when that issue is in the list: linked
to the row, moved on the board as a thread started here would be, and given
this plugin's title unless another thread already has it. gh-context reads the
prompt; this plugin decides which of those threads are its own. A handoff
thread that only names the issue on its first line (`issue #N`) is left alone:
gh-context's banner shows the issue, but the thread keeps the title it was
handed off with.
