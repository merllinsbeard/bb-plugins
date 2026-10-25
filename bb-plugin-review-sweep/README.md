# bb-plugin-review-sweep

A bb sidebar panel listing every open pull request waiting on a review from you,
across all repositories, in one list ordered by what needs you: Now, then Next,
then Later, and oldest request first within each run.

The sweep is deterministic: it runs one `gh` query, classifies the result with
pure functions, and spends no model tokens. An agent is only involved when you
click "Start review" on a row, or start several reviews at once from Batch.

## Install on a new machine

```bash
cd ~/.dotfiles/bb/plugins/bb-plugin-review-sweep
npm install
bb plugin install . --yes
```

## Requirements

- The [gh-context](../bb-plugin-gh-context) plugin, which keeps the record of
  which threads belong to which pull requests. Without it the panel still lists
  review requests, but none offers to start a thread, since a row cannot tell
  whether it already has one; after a few sweeps without it the plugin reports
  that it needs configuring.
- `gh` on PATH and authenticated as you (`gh auth login`). The plugin reports a
  missing or unauthenticated `gh` as a configuration state, not an error.
- A bb project is needed only for the row action, which matches a PR's
  repository against every git remote in the project's checkout, so a fork's
  upstream counts as well as its origin. PRs in repositories with no matching
  project are still listed; their action reads "No project here" and is
  disabled.

## What lands in the list

One GraphQL query, `is:pr is:open review-requested:@me archived:false`.

`review-requested:` rather than `user-review-requested:` on purpose. The two are
not synonyms: the former also matches a request that reached you through a team
you belong to, which is how most requests arrive in an org, and the narrower
qualifier drops them silently.

Nothing else is filtered. A conflicting PR, a red-CI PR and a bot's dependency
bump are all still review requests, so they are all still listed.

## Why GraphQL rather than `gh pr list`

pr-sweep discovers repositories with `gh search prs` and then fans out one
`gh pr list` per repository, because it needs every check run by name. This
plugin does not: the only checks it shows are the head commit's counts, and
those and `mergeable` both come back in the search query.

What it does need is **when the review was requested of you**, and `gh pr list`
has no field for it at any verbosity. The only honest sources are the
`ReviewRequestedEvent` timeline, or a guess from the PR's own timestamps —
and `updatedAt` bumps on every unrelated comment, so a PR that has sat with you
for three weeks would read as "20 minutes". A review queue whose age column is a
guess is not worth having.

So: one `gh api graphql` call, with an exact `requestedAt` per row. The same
call reads `comments { totalCount }`, the count behind each row's "N new", each
review's own `comments { totalCount }`, which together are its inline
comments, and the head commit's `statusCheckRollup` counts by state, behind each row's checks.
The reviewers come from the `reviews` and `reviewRequests` it already reads for
the request time. It also
means there is no per-repository partial-failure state to carry; the sweep
either returns the whole queue or fails and keeps the last known rows.

A second call reads the open pull requests in the rows' repositories, for the
stack chips: a stack's other layers are rarely asking you to review, so the
search cannot see them.

`requestedAt` resolves in three steps, so a thin timeline degrades rather than
throwing:

1. The newest request naming your login. Exact.
2. The newest request of any kind. A request reaching you through a team names
   the team and never your login, and the search already guarantees you are a
   requested reviewer.
3. The pull request's own `createdAt`, if the timeline window did not reach the
   event.

## How the list is ordered

Every review request is in one run, and every run is in one tier. The summary
squares above the list show one square per request, grouped by run and counted
("2 to review"). Pressing a run shows only its requests; pressing it again
shows them all. Batch sits at the right end of the same line.

| Tier | Runs, in order |
| --- | --- |
| Now | re-review, waiting too long, reviewing |
| Next | to review, drafts |
| Later | snoozed, folded after five |

- **Re-review**: you reviewed it, the author pushed, and it came back. The
  author is blocked on you, and it is usually the quickest row to clear, so it
  comes first, even with a thread running. A draft re-review goes to drafts
  instead.
- **Waiting too long**: requested of you at least "Stale after (days)" ago,
  counted in whole days.
- **Reviewing**: a review thread has been started, whether or not the request
  is a draft.
- **To review**: every other request.
- **Drafts**: a draft was assigned to you: a real request, but not offered for
  review yet.
- **Snoozed**: you snoozed it until a day. It stays here until that day,
  whatever else is true of it, or until your review is requested again, if
  that comes first. The snooze is stored on this machine only: you stay a
  requested reviewer on GitHub.

Within a run, the oldest request comes first, tie-broken by repository then
number, so rows do not reshuffle between sweeps. Every row is open, with its
title line, banner, icons, note, and actions, since each request is one for
you to do, except a snoozed one. That is one line, with its icons and the
day it comes back ("Until Monday") at the right, and the chevron at its left
opens it to the full row.

The Reviews icon in bb's navigation carries a red badge counting the
requests waiting too long that have no thread and are not drafts or snoozed,
as Now counts its urgent rows. With none, there is no badge. It reads the
stored list the page reads, so it adds no GitHub calls.

## Each row

Each row is drawn the way PR Sweep draws a pull request. The title line has
the pull request icon (green when open, muted for a draft), the title, the
number, a stack chip when it is in a stack, a warning triangle when it
conflicts with its base branch, "N new" in blue when comments were posted
since you last opened the pull request or its thread from the panel, and how
long ago the review was requested of you on the right. The first sweep to see
a request records its comment count, so nothing is new on the first sync.

A pull request in a stack, built on another open pull request's branch or
with one built on its own, has a chip after its number: "3 of 5 · on #612",
with the number linking to the pull request below it, or "1 of 5 · base" at
the bottom. Two pull requests on one base share an index, and the count is
every open pull request in the stack, whoever opened it. Rows keep their place
in the list, so a stack's layers can sit apart. The stacks come from one more
GraphQL call per sweep, reading the open pull requests in each swept
repository; a failure there drops the chips, not the sweep.

Under the title, a banner appears for two kinds of request:

- **Waiting on you for N days**, in red, for a request in the waiting too long
  run. The row keeps its red tint and bar.
- **Asked to review again**, in blue, for a re-review.

A row in the reviewing run has an orange left edge and a faint orange wash, in
the same orange as its squares. A line under its actions says what the review
thread is doing, as bb's sidebar does (**Working**, **Needs you**, **Done,
unread**, **Failed, unread**, or **Idle**), with the thread's title. Clicking
the line opens the thread. The status comes from bb's sidebar, so it makes no
request.

Then a line of icons:

- the author's picture and login
- the reviewers' pictures, yours first, each with a badge for where their
  review stands: pending while a request is outstanding, otherwise their
  latest approval, change request, or dismissal, or a comment if that is all
  they left. A team shows its organization's picture. You are in it when you
  were asked by name or have reviewed; a request only to your team shows the
  team.
- the head commit's checks as a count, such as a green tick with "13/13", an
  amber clock while any run, or a red cross with "2/15 failing". Hovering it
  names every count. Left out when the pull request has no checks.
- the size in lines added and removed ("+18 −4")
- the repository, only when more than one is in play

The age is how long ago the review was requested of you, read from the
`ReviewRequestedEvent` timeline described above, not from the pull request's
own timestamps.

A row has no stage track on the right, unlike Issue Sweep's: the banner and
the icons say where a review stands.

An open row's actions are Start review or Open thread; Archive thread on a row
with a thread; Snooze, or Unsnooze on a snoozed row; Copy link; and Add note or Edit note, then the comment count:
general and inline comments together, resolved threads included. Inline
comments are counted through the reviews that posted them, since each reply to
a thread is a review of its own, leaving out your pending review. Only general
comments count toward "N new". The Harvest clock, when the Harvest plugin is
installed, sits at the right end of that line. The page asks the Harvest plugin for the clock's state after it draws the rows, which costs two Harvest requests each time the page opens, a sweep lands, or a timer starts.

Snooze opens the same day menu as Now's Postpone, from component-library:
Tomorrow, Next week (the coming Monday), and In two weeks, each with the day
beside it, and a box for any later day typed in words ("fri", "oct 8").

Clicking the comment count opens what is on the pull request in a drawer under
the action line, drawn the same way as PR Sweep's: one list, oldest first, of
reviews, inline comments, and top-level comments, with each inline comment in
a small card headed by its file and line. Your own reviews, threads, and
comments carry a "you" label and bots' a "bot" label. Resolved threads wait
behind "N resolved" at the bottom. When there are more than 10 entries, the
drawer shows the 10 newest, with "Show N earlier" at the top for the rest. A thread is "unanswered" when someone else
spoke last, including the author answering one of yours; "waiting on a reply"
when you started it and nobody has answered; and "you replied" when you spoke
last. Each entry opens on GitHub, and its text is cut to
three lines. Opening the drawer makes one GitHub GraphQL request for that pull
request, and none is made until you click; once it has read the comments, the
row's "N new" clears. Clicking the count again closes it.

A note is a one-line next step, stored only on this machine and never sent to
GitHub. It shows in a grey drawer under the action line, and Add note or Edit
note opens its editor in the same place. The button stays put, pressed, while
the editor is open; pressing it again
closes the editor. Save or Enter saves the note, Cancel or Escape cancels, and
saving an empty note deletes it.

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
starts it over.

## Settings

- **Sync interval** — how often the background sweep runs. Default 5 minutes.
- **Path to the gh CLI** — override when `gh` is not on the server's PATH.
- **Only show repositories checked out here** — on by default. A review request
  is shown only when a bb project on this machine has that repository as one of
  its checkout's git remotes, upstream as readily as origin. bb's project
  list is per-installation, so this is what separates the computer a repository
  is checked out on from every other one: the work laptop's repositories stop
  filling the personal one's panel. The skipped repositories are named under
  the list, so an empty panel never reads as a cleared queue.
- **Also show these repositories** — comma or newline separated `owner/name`,
  for a repository you review in without a checkout here. Ignored when the
  filter is off.
- **Stale after (days)** — how many whole days a request can wait before it
  moves into Now as waiting too long, flagged "Waiting N days". Default 2.
- **Model for review threads** — blank takes the provider's default. There is
  only one action here, so this is a single value rather than pr-sweep's
  model-by-action JSON.
- **Provider for spawned threads** — defaults to `claude-code`, the provider
  whose `code-review` command the prompt names. Blank uses bb's default.
- **Permission mode for spawned threads** — defaults to `full`. Read the next
  section before changing it.

## What a spawned thread may do

**It reports findings in the thread. It posts nothing to GitHub without asking.**

When Impromptu UI is installed, the prompt asks for the findings as a view
above the composer, one card per finding with the verdict last, rather than
as a reply in chat.

Reviewing someone else's pull request is outward-facing in a way pushing to your
own branch is not: a wrong finding lands publicly on a colleague's PR and cannot
be quietly undone. So unlike pr-sweep, whose prompt authorizes its own commit
and push, this prompt withholds that authorization and says so explicitly.

Two things make that instruction load-bearing rather than decorative.

**The skill may try to post on its own.** Two commands answer to `code-review`
on this machine: the built-in one, which posts only when passed `--comment`, and
the claude-plugins-official one, whose final step runs `gh pr comment` with no
flag to suppress it. Which one a spawned thread resolves is not something this
plugin controls. The prompt therefore names the skill *and* states the
constraint, including the case where the skill's own last step posts a comment —
a direct user instruction outranks a skill's steps.

**The sandbox cannot enforce it.** `auto` keeps the workspace sandbox, which
blocks network egress, so a thread in that mode cannot reach GitHub to read the
diff it was started for. `full` is the only mode in which a review can happen at
all, and it has no way to express "may read GitHub, may not write to it". The
no-posting rule lives in the prompt, not in the permission mode. Worth knowing
before trusting it unattended.

## Threads

"Start review" opens bb's composer under the row, where Add note opens its
editor, and clicking it again closes it. Above the composer, the
`code-review` skill is a chip, already picked, and it puts what this review is
and how it should read in the prompt. Unpick it to write your own prompt
instead. Starting it leaves you on the page, with a toast whose **Go to
thread** button opens the new thread. A thread started from a row is linked to its pull request in gh-context, and
the row then opens that thread rather than starting another. A review thread
is not on the pull request's branch, so bb itself finds no pull request for it;
gh-context's banner above the composer shows the one this plugin linked.

In a new worktree, which is the composer's default here, the thread starts from
`origin/<base>`, the branch the pull request merges into, and bb diffs the
thread against it. A pull request stacked on another one then shows only its
own changes, as GitHub does. Before the thread starts, the plugin fetches that
base branch and the pull request's head into the project's checkout, and moves
a local copy of the head branch up to date when that loses no commits, so
`gh pr checkout` in the thread finds it current after a rebase on GitHub. That
is two git fetches per thread and no GitHub API calls. A thread started in the
project checkout or an existing worktree keeps that environment's diff base,
since other threads share it.

## Starting several reviews at once

Batch opens a dialog listing every request that Start review could start: no
thread yet, not snoozed, and a project here for its repository. Drafts come last, as in the
list. Tick the ones to review. The request ticked last is shaded, and its
prompt fills the column on the right, where you can edit it; clicking another
ticked title shows that one's prompt instead, and clicking an unticked title
ticks it. An edited prompt says "edited" in the list, with Reset beside the
prompt to go back to the one the panel wrote.

"Start N reviews" starts them all, with no composer. Each starts as Start
review would by default: in a new worktree in the matching project, with the
provider, model and permission mode from the settings, and the prompt the
column held. The line naming the pull request comes before that prompt and the
rule against posting to GitHub after it, so neither can be edited away, and a
prompt left empty cannot be started. The dialog closes once every review
started. One that could not start says why in a toast and stays ticked, with
the dialog still open to try again.

Starting is one call to this plugin's server per ticked review, all at once.
Each one spawns one thread; nothing asks GitHub for anything. A review that
already has a thread, such as one started from its row a moment earlier, gets
that thread back instead of a second one.

## Relationship to pr-sweep

`bb-plugin-pr-sweep` covers pull requests *you authored*; this one covers
requests *made of you*. They are deliberately separate plugins, which means
`review/spawn-target.ts`, `review/store.ts`, the `gh` runner and the vendored
`components/` are a second copy of pr-sweep's. What the two draw for a pull
request (the icon, the reviewer avatars, the checks badge, and the size) comes
from `sweep-ui/pull-request`, so a row looks the same on both tabs.

## Development

```bash
npm test          # vitest
npm run typecheck # tsc --noEmit
bb plugin dev     # rebuild and reload on save
```

**All test fixtures are synthetic.** This repository is public. Never paste real
pull request titles, reviewer logins, repository names, or URLs into a test.
