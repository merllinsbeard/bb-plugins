# bb-plugin-pr-sweep

A bb sidebar panel listing every open pull request you authored, across all
repositories, in one list, newest first, with the ones being worked on pinned
at the top and the ones waiting on someone else closed to one line at the
bottom.

The sweep is deterministic: it runs `gh`, classifies the result with pure
functions, and spends no model tokens. An agent is only involved when you click
"Start thread" on a row.

## Install on a new machine

```bash
cd ~/.dotfiles/bb/plugins/bb-plugin-pr-sweep
npm install
bb plugin install . --yes
```

## Requirements

- The [gh-context](../bb-plugin-gh-context) plugin, which keeps the record of
  which threads belong to which pull requests. Without it the panel still lists
  pull requests, but none offers to start a thread, since a row cannot tell
  whether it already has one; after a few sweeps without it the plugin reports
  that it needs configuring.
- `gh` on PATH and authenticated as you (`gh auth login`). The plugin reports a
  missing or unauthenticated `gh` as a configuration state, not an error.
- A bb project is needed only for "Start thread", which matches a PR's
  repository against every git remote in the project's checkout, so a fork's
  upstream counts as well as its origin. PRs in repositories with no matching
  project are still listed; their action reads "No project here" and is
  disabled.

## How the list is ordered

Newest first, by when GitHub last saw activity on the pull request. The pull
requests waiting on someone else, which close to one line, are grouped at the
bottom. Two kinds are pinned to the top of their group:

1. **Being worked on**: has a thread. Its rows have an orange left edge.
   Pinned above the other open rows.
2. **Overdue**: awaiting review and not updated for "Stale after (days)".
   Tinted red, with "Waiting N days" on its icon line. Pinned above the other
   closed rows.

Each pinned kind is newest first too. Pull requests with the same timestamp
are ordered by repository then number, so rows do not reshuffle between
sweeps.

Every pull request is also in one run, which the summary squares above the
list count, one square per pull request ("2 need you"). Pressing a run shows
only its pull requests, in the same order; pressing it again shows them all.

- **Needs you**: a flag or open comments that are yours to act on.
- **Ready to merge**: approved, green, and nobody else asked to review.
- **Working**: has a thread, whatever its flags say. Its squares are orange.
- **Drafts**: not offered for review yet, flagged or not.
- **Waiting**: only a CI run in flight, approved with another reviewer still
  asked, or awaiting review.

Every row is open, with its title line, banner, icons, note, and actions,
except the waiting ones. A waiting row is one line: its title, number, and
stack chip, with its reviewers, checks, and size at the right. The chevron at
its left opens it to the full row. A waiting row whose Harvest timer is
running stays open.

## Each row

The title line starts with the pull request's icon, green when it is open and
grey for a draft, then the title and number, a stack chip when it is in a
stack, a warning triangle when it conflicts with its base branch, "N new" in
blue when comments were posted since you last opened the pull request or its
thread from the panel, or started one, and how long ago it was updated on the
right. The first sweep to see a pull request records its comment count, so nothing is new on
the first sync. A sweep that finds your own comment newest records the count
again, so your reply never shows as new.

A pull request in a stack, built on another open pull request's branch or
with one built on its own, has a chip after its number: "3 of 5 · on #612",
with the number linking to the pull request below it, or "1 of 5 · base" at
the bottom. Two pull requests on one base share an index, and the count is
every open pull request in the stack, whoever opened it. Rows keep their place
in the list, so a stack's layers can sit apart. The stacks come from one more
GraphQL call per sweep, reading the open pull requests in each swept
repository; a failure there drops the chips, not the sweep.

Under the title, a banner says where the pull request stands.

- **Red, for what stops it**, the first that applies: "Merge conflict with
  main" (naming its base branch), "2 of 9 checks failing", "Approved, but
  GitHub won't merge it · a branch rule isn't met" (approved and passing, yet
  a rule the listing cannot name still blocks it; when the approval came with
  feedback, the feedback leads instead), "1 of 9 checks cancelled",
  "No checks ran on the latest push", or "No reviewer requested".
- **Reviewers' feedback** follows a blocker in lighter text after a dot, and
  stands alone in red when nothing else is wrong. Who requested changes
  leads ("hubber requested changes"). Otherwise the banner names everyone
  waiting on you, most unanswered threads first: "octocat left review
  comments" (a review that neither approved nor requested changes), "hubber
  approved with notes", "Review notes from hubber", or "Comments from hubber
  and octocat" when it is a mix, including inline comments from someone who
  approved. The unresolved comment threads follow a reviewer's name, split
  into those still unanswered and those you replied to last ("6 unanswered
  comments, 1 replied"), since a reply often answers a thread nobody marks
  resolved. Unanswered threads are the banner on their own when no review
  explains them, and only they put a pull request in needs you. A comment
  review or a review note stops counting once you have replied after it, in
  a comment or a review thread, so a pull request whose every comment you
  answered carries no feedback banner. Requested changes count until the
  reviewer reviews again. The thread counts come from one GraphQL call per
  sweep for every hundred swept pull requests, which asks for those pull
  requests by id and costs about one rate-limit point each; a failure there
  drops the counts, not the sweep.
- **Green** "Ready to merge", followed by who approved, or by who has not
  reviewed yet when someone else was asked. Feedback left alongside the
  approval takes that place instead: "Ready to merge · hubber approved with
  notes, 3 unanswered comments".
- **Grey** for failing checks you dismissed: "validate failing · dismissed",
  with Undo. See below.
- **Blue** for a wait worth knowing about: "Waiting on hubber to re-review",
  or "GitHub is still checking for conflicts".
- **None** for a draft, a first review not yet given, or checks still
  running, which the icons already show.

Under the banner, a line of icons: each reviewer's avatar with a badge for
where their review stands (requested, changes requested, approved, or
commented), or "no reviewer"; the checks as a green check with how many passed
out of those that ran, a clock while some are running, or a red cross with how
many failed or were cancelled, skipped checks left out and nothing shown when
the pull request has no checks; and the lines
added and removed. The repository joins the line only when more than one is in
play. A pull request awaiting review that has not been updated for "Stale
after (days)" shows "Waiting N days" in red there too.

A row has no stage track on the right, unlike Issue Sweep's: the banner and
the icons say where a pull request stands.

An open row's actions are Start thread or Open thread, Archive thread on a row
whose thread has no flags left, a menu of earlier threads when there are any,
Copy link, and Add note or Edit note, then the comment count: general and
inline comments together, resolved threads included, so a pull request whose
threads were all answered still shows it was discussed. The Harvest clock, when the Harvest
plugin is installed, sits at the right end of that line. The page asks the Harvest plugin for the clock's state after it draws the rows, which costs two Harvest requests each time the page opens, a sweep lands, or a timer starts. Start thread's tooltip names the work, such as "Resolve
conflict". A row only waiting for a run to finish offers no Start thread.

A row with a thread has a line under its actions saying what the thread is
doing, as bb's sidebar does (**Working**, **Needs you**, **Done, unread**,
**Failed, unread**, or **Idle**), with the thread's title. Clicking the line
opens the thread. The status comes from bb's sidebar, so it makes no request.

Clicking the comment count opens everything on the pull request in a drawer
under the action line, in one list, oldest first: reviews with something to
say, inline comments, and top-level comments from the pull request's
conversation. Each inline comment sits in a small card headed by its file and
line, with whether it is unanswered or you replied. Your own comments carry a
"you" label and bots' a "bot" label, since the count includes both. Resolved
threads wait behind "N resolved" at the bottom. When there are more than 10
entries, the drawer shows the 10 newest, with "Show N earlier" at the top for
the rest. Each entry opens on GitHub, and its text is cut to three
lines. Opening the drawer makes one GitHub GraphQL request for that pull
request, and none is made until you click; once it has read the comments, the
row's "N new" clears. Clicking the count again closes it.

A red "checks failing" banner has Dismiss at its right end, for a failure you
cannot fix yourself, such as a check that waits on a label only the
repository's maintainers can add. Dismissing takes the failing-checks flag off
the row, so it leaves needs you unless something else keeps it there, and a
thread started from the row is not asked to fix the checks. The banner turns
grey and names the dismissed checks ("validate failing · dismissed") with Undo,
unless another problem leads the banner. The checks icon still counts the
failure. The dismissal is stored only on this machine, against the branch's
latest commit and the names of the failing checks, so a new push or a different
check failing brings the flag back. Dismissing makes no GitHub request; the
sweep reads the commit with the rest of the listing.

A note is a one-line next step, stored only on this machine and never sent to
GitHub. It shows in a grey drawer under the action line, and Add note or Edit
note opens its editor in the same place. The button stays put, pressed, while
the editor is open; pressing it again
closes the editor. Save or Enter saves the note, Cancel or Escape cancels, and
saving an empty note deletes it.

## Threads

A thread started from a row is linked to its pull request in gh-context, and
the row then opens that thread rather than starting another. gh-context's
banner above the composer shows the pull request on every thread, so this
plugin adds nothing to the thread itself.

A row's Start thread opens bb's composer under the row, where Add note opens
its editor, and clicking it again closes it. Above the composer, each skill the
sweep suggests for the pull request is a chip, such as
`resolve-merge-conflicts` for a conflict and `address-code-review` for new
comments. The ones its findings name are picked, worst first, and `pr-sweep`
is offered unpicked for anything else. Each picked chip puts one line in the
prompt naming its skill and what it is for, and clicking a chip adds or
removes its line. Changing the chips starts the prompt over, so pick them
before typing anything of your own. Starting it leaves you on the page, with a
toast whose **Go to thread** button opens the new thread. The thread runs in a
worktree on the pull request's own branch, beside the checkout as
`<checkout>-pr-<number>`, so its commits land on the pull request and bb shows
the pull request's checks and merge state on the thread. bb's own worktrees
always start a new branch, so the box hides the composer's project,
environment, and branch pickers and names the branch instead. When another
worktree already has the branch checked out, usually the thread that opened
the pull request, the box says so and keeps the pickers, and the thread starts
on a new branch and is told to make its own worktree on the pull request's
branch inside that one.

Before the thread starts, the plugin fetches the pull request's base branch and
head, so a branch pushed to or rebased on GitHub is not stale here. A local
copy of the branch moves to the head when that loses no commits, and a worktree
made earlier fast-forwards. The thread's diff compares against
`origin/<base>`, the branch the pull request merges into, so a pull request
stacked on another one shows only its own changes, as GitHub does. When the
thread starts on a new branch instead, its new worktree starts from
`origin/<base>`. That is two git fetches per thread and no GitHub API calls
beyond the one that reads the branch.

bb does not delete a worktree it did not create, so this plugin removes one
when its thread is archived or deleted and no other thread uses it. `git
worktree remove` keeps a worktree with uncommitted or untracked changes, and
the branch and its commits stay either way. The same applies to worktrees made
by **Open pull request**.

A thread started from the composer whose first prompt names exactly one pull
request, and nothing else, is adopted on the next sweep when that pull request
is in the list: linked to the row and given this plugin's title, unless
another thread already has that title. gh-context reads the prompt; this
plugin decides which of those threads are its own. Archiving a thread releases
it, and unarchiving one gets it adopted again on the next sweep, as long as its
first prompt names that pull request and nothing else.

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
- **Only sweep repositories checked out here** — on by default. A repository is
  swept only when a bb project on this machine has it as one of its checkout's
  git remotes, upstream as readily as origin. bb's project
  list is per-installation, so this is what separates the computer a repository
  is checked out on from every other one: the work laptop's repositories stop
  filling the personal one's panel. The skipped repositories are named under
  the list, so an empty panel never reads as "no open pull requests".
- **Repositories that do not need a reviewer** — comma or newline separated
  `owner/name`. Where nobody is ever assigned, an unassigned pull request is
  the normal state rather than something to chase, so the no-reviewer flag is
  skipped for these repositories. Only that flag: a conflict or a red check in
  one of them still reads the same. The row loses the flag as it is classified,
  so with nothing else outstanding it waits rather than sitting under needs you
  with a problem you have decided to ignore.
- **Also sweep these repositories** — comma or newline separated `owner/name`,
  for a repository worth watching without a checkout here. Ignored when the
  filter is off.
- **Stale after (days)** — how long a pull request awaiting review can go
  without an update before it is flagged. Default 3; anything but a positive
  whole number is read as 3.
- **Provider for spawned threads** — defaults to `claude-code`, which is the
  provider the routed skills belong to. Blank uses bb's default.
- **Permission mode for spawned threads** — defaults to `full`. `accept-edits` stops
  at the first shell command; `auto` keeps the workspace sandbox, which blocks
  network egress, so a conflict resolution commits but cannot push. Only `full`
  carries the work through to the PR unattended, and it grants unsandboxed
  command execution in the worktree.
- **Model by action** — a JSON object keyed by flag, picking the model for that
  action's thread. Blank by default, so every action takes the provider's
  default model. An unlisted flag takes the provider's default too, and a
  malformed value is logged and ignored rather than blocking a spawn.

  ```json
  { "conflict": "claude-sonnet-5" }
  ```

  Worth knowing before tuning this down: `resolve-merge-conflicts` is explicit
  that the conflict markers are the easy part and the real work is the semantic
  collisions git could not mark. Watch the first few conflict threads before
  trusting a cheaper model with them.

## Flags

| Flag | Meaning |
| --- | --- |
| merge conflict | Conflicts with its base branch. |
| CI failing | A red check. |
| reviewer feedback | A `CHANGES_REQUESTED` review, or a `COMMENTED` one you have not replied to since. |
| merge blocked | Approved and green, but a required review or ruleset is unsatisfied. |
| mergeability unknown | GitHub had not computed it, twice. |
| CI cancelled | A run was cancelled; usually needs a re-run. |
| no CI | Zero checks ran. Not the same as green. |
| no reviewer | Non-draft with nobody requested and no reviews. Never raised in a repository named by **Repositories that do not need a reviewer**. |
| CI running | Still in flight. |
| ready to merge | Approved, green, no conflict, not a draft. |

A pull request with a thread attached moves to **working**, whatever its flags
say, so needs you only ever holds work that is actually waiting on you. The
Pull requests icon in bb's navigation follows the same rule: a red badge
counts the rows in needs you, and with none there is no badge. It reads the
stored list the page reads, so it adds no GitHub calls.

A PR that is answered and awaiting re-review carries no flag: the ball is in the
reviewer's court.

## Where an action sends the work

The row's worst flag picks both the work Start thread names and the skill the
spawned thread is told to use:

| Worst flag | Skill |
| --- | --- |
| merge conflict | `resolve-merge-conflicts` |
| reviewer feedback | `address-code-review` |
| anything else | `pr-sweep` |

Those first two skills specify their own flow, including worktree setup on the
PR's own branch, so the prompt names the skill and states the findings without
restating any method. A thread already on the branch is told to skip that
setup step.

**A pull request with several flags gets one thread that works them in order**,
worst first, finishing each before starting the next. They are sequential
rather than independent: resolving a conflict changes the code review feedback
refers to, and fixing CI changes what is left to answer. One thread also keeps
two agents off the same branch. A step routed to `pr-sweep` adds that skill's
triage guardrails, since it is a playbook rather than a fixed workflow.

Two things follow from that routing:

**Threads spawn on Claude Code.** All three skills are `provider-user` skills
scoped to `claude-code`, so a thread on any other provider cannot see them and
will improvise the workflow instead. The **Provider for spawned threads**
setting pins this; blank falls back to bb's default provider. If you point it
at a provider without these skills, the prompts will name skills that provider
does not have.

**A skill-routed prompt authorizes its own commit and push.** Standing user
instructions forbid committing without an explicit ask and outrank a skill, so
without that paragraph the thread does the work and stops at a staged merge.
Clicking the row's action is the ask. Force-pushing, rewriting a pushed commit,
merging the PR, and posting review replies still require confirmation.

## Development

```bash
npm test          # vitest
npm run typecheck # tsc --noEmit
bb plugin dev     # rebuild and reload on save
```

The check rules are a port of the `pr-sweep` Claude skill at
`~/.dotfiles/claude/skills/pr-sweep/`, which documents why each rule is shaped
the way it is, including the GitHub API traps each one avoids. Read it before
changing `sweep/classify.ts`.

**All test fixtures are synthetic.** This repository is public. Never paste real
pull request titles, reviewer logins, repository names, or URLs into a test.
