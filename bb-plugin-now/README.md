# bb-plugin-now

A [bb](https://getbb.app) plugin that puts what needs doing now on one
page, gathered from your sources: [Todoist](https://todoist.com) tasks and your
Gmail inbox.

## What it adds

A **Now** page in the left sidebar, whose icon carries a badge: the Urgent
run described below as a red count, or, when nothing is urgent, the Today
run (tasks due today whose time has not passed) as an amber one. Its tooltip
names both. With neither, there is no badge. It reads the stored list the
page reads, so it adds no calls to Todoist, Gmail, Calendar, or GitHub. The
red is the same as the counts on the page; bb draws its own badges in a
darker red, so the plugin adds a style rule that recolors every red badge in
bb's navigation. It loads every
configured source at once and merges their items into one list. The header
has the sections on the left (**Now**, **Anytime**) and the sources
on the right (**Gmail**, **Todoist**; hover one for its query), each with its
count of every row. One of them is chosen at a time: a section shows that
section from both sources, and a source shows every row from it, soonest first
for tasks and newest first for mail. Pressing the chosen one again stacks both
sections, each under its heading. Each row goes in one section:

- **Now**: every Gmail row, every task in Todoist's Inbox project, and any
  other task with a date, by its due date or its deadline, whichever is
  sooner.
- **Anytime**: every other task, which has no date.

Now is split into seven runs, in this order:

- **Urgent**: tasks dated before today, or due earlier today at a time that
  has passed, and every task in Todoist's Inbox, whatever its date, since it
  has not been filed yet.
- **Unread**: email with an unread message, unless it belongs in Archive.
  Once it is read, it moves to Me, Requests, or Minor.
- **Today**: the other tasks due today.
- **Me**: GitHub notifications about your own pull requests and issues, and
  email with your address in its To field.
- **Requests**: what asks something of you: a review requested of you or
  your team, a mention, an assignment, a document comment that mentions you,
  an invitation you have not answered, a new time a guest proposed for your
  event, and any other email.
- **Archive**: what has nothing left to do: a pull request or issue that has
  merged or closed, a review you have given, a review someone else was asked
  for, an invitation you have answered or that was canceled, a guest
  accepting your event, and a proposed time your event has been moved to.
- **Minor**: what you only follow, such as a subscription or a comment on
  someone else's item or document, and tasks dated after today.

Within a run, mail comes first, unread and then newest first, then dated
tasks, oldest first, then undated Inbox tasks, newest added first.

Under the header, while the Now section is showing, a line of small squares
gives one square to each of its rows, in the list's order, colored by run: red
for Urgent, violet for Unread, yellow for Today, green for Me, blue for Requests, and gray for
Archive and Minor. Each run is labelled with its count, such as "4 urgent",
and hovering a square shows its row's title. The squares shrink, down to 4px,
to keep the runs on one line; on a page too narrow even for that, each label
keeps only its count, with the name on hover. Pressing a run shows only its
rows and fades the others; pressing it again shows the whole section. When
the last row of the chosen run leaves the page, the whole section shows
again.

The page opens on the Now section. Tasks in Anytime go soonest first, then
most urgent. Each row starts
with its source's icon, drawn like bb's own outline icons (GitHub, Mail, and a
Todoist mark in the same style), then the item's title (linking to it in its
source) with its date at the right in one short form ("Sep 21", or the time
for today), its description, and a details line with the row's actions, tags,
and where it came from (a Todoist project, or an email's sender). A Todoist
task's description is rendered as Markdown, so its lists, links, and bold text
look as they do in Todoist, and its open subtasks are listed under it as
bullets. A task's
P1–P3 tag sits under its Todoist icon. An overdue row (a task dated before
today or due today at a time that has passed, or mail, read or unread, whose
latest message is more than 24 hours old) is tinted red with a red bar down its
left edge, and says how late it is in place of its date: "3 days late" for a
task, "2 hours late" or "20 minutes late" for one due earlier today, "4 days
old" for mail. Mail that old stays in its run rather than joining
Urgent, which holds only tasks. A task in the Today run is tinted yellow
with a yellow bar the same way. A deadline that is today is red too;
nothing else is colored for its date. A recurring item
has a repeat icon.

The list is stored in the plugin's database, so the page opens with the last
sync's items at once instead of waiting on Todoist and Gmail. The page also
keeps the last list it read, in memory and in the app's `localStorage`, and
draws that while it reads the database again, so it opens without a Loading
step except on its first open. It syncs in the
background every 15 minutes, and opening the page syncs a list older than a
minute. The page's title bar says when it last synced and has a Refresh
button that syncs now. Syncs that overlap share one run. A row completed,
archived, or restored with Undo while a sync is running stays that way when
the sync finishes, even though what the sync read predates it.

Above the list, each source that loaded shows its name, what it was asked for,
and how many items it returned. A source that is not set up shows what to
configure, and a source that failed shows its error. Either way the other
sources' items still appear, and a failed source keeps its items from the last
good sync, with a note saying how many.

## Priorities

A column to the right of the list shows the week's priorities: the bullets
under `Next:` in last week's journal entry, which
[Weekly Review](../bb-plugin-weekly-review) writes into Now after each of its
gathers and whenever you link a priority to a workstream. The bullets nested
under a priority show beneath it as a list that keeps the journal's levels,
each deeper level indented further.

The small icon after each priority starts a thread about it, in bb's own
composer under the priority, seeded with the priority and the bullets under
it, as Start thread does for a row. Once a thread has been started from a priority, the icon opens
that thread instead.

Check a priority off when it is finished. It is struck through and stays in
place. When Weekly Review writes the list again, a priority whose text has not
changed keeps its check, and one you reworded in the journal comes back
unchecked. Nothing is written back to the journal.

Under each priority are the hours its linked workstreams have had this week,
as of Weekly Review's last gather, which the column's heading names. A linked
priority with no hours yet says "No time yet" in amber. A priority not linked
to any workstream shows no hours, since nothing measures it; link it on Weekly
Review's page.

Drag the column's left edge to change its width, between 192 and 520 pixels.
The width is remembered across visits, and double-clicking the edge puts it
back to 256. With the edge focused, the left and right arrow keys widen and
narrow it. On a narrow page the column moves above the list. A week with no
priorities written shows no column.

Opening the page makes one read of Now's own database for the column, and no
request to Weekly Review or any outside service. The column reads it again when
Weekly Review writes a new list. Another plugin can write and read the list
through the `priorities_set` and `priorities_get` RPC methods.

## Row actions

- **Complete** (on a Todoist row, in its details line) completes the task in
  Todoist and takes the row off the page.
- **Edit** (on a Todoist row, after Complete) opens a strip under the row with
  the task's name, its description, and under them a due date box, a deadline
  box, a project picker, and the four priority flags. The name starts as
  Todoist holds it, Markdown included, so a link in it survives the save; Save
  waits while it is blank. The description is Markdown too, and grows as you
  type; Enter starts a new line, ⌘↩ saves, and emptying it clears the
  description in Todoist. The due date is when to do it: type it in words, as in Todoist
  ("fri", "next week", "every mon 9am", "no date"), and Todoist reads it when
  you save. The deadline is when it has to be done by. Todoist does not read
  a deadline's words, so the strip does, and shows the day it read at the
  right of the box: "today", "tomorrow", a weekday, "next fri", "next week",
  "in 3 days", "2 weeks", "sep 30", "9/30", or "2026-09-30", and "no deadline"
  to clear it. Anything else reads "Not a date" and Save waits. Either box
  left empty leaves its date as it is. A box whose task has a date shows an
  X, which types "no date" or "no deadline" into it, so Save clears that date. The
  project picker lists your projects nested as Todoist shows them, and typing
  narrows it. Nothing is sent until **Save**, which sends the name, description,
  date, priority, and project together, so a new project or date cannot move the row away
  halfway through. The row then shows what Todoist saved, and a sync follows,
  since the new date or project may move it to another section or off the
  page. A task in Todoist's Inbox shows the strip already open, since it is
  there to be sorted. Edit stays highlighted while the strip is open; Edit
  again, Escape, or **Cancel** closes it.
- **Postpone** (on a Todoist row, after Edit) opens a menu that moves the
  task to a later day. On a recurring task it moves only this occurrence, so
  the task keeps repeating and keeps its time of day. On a one-off task it
  appears once the due date is today or past, and moves that date, keeping its
  time; on a task whose due date is not due yet, or that has none, it appears
  once the deadline is today or past, and moves the deadline. It offers a day
  later, two days later, and a week later, counted from the date, or, when
  the date has passed, today, tomorrow, and a week from today, and a box that reads a typed day the way the
  deadline box does. It will not move a task to its own date or earlier, or to
  a day already past. One click saves, and a sync follows. Typing into the edit
  strip's boxes sets any other date.
- **Delete** (the bin in the edit strip) asks once more, then deletes the task
  in Todoist and takes the row off the page. Todoist cannot restore a deleted
  task, so there is no Undo.
- **Archive** (on an email row, in its details line) takes the row's threads
  out of the Gmail inbox, marks them read, and takes the row off the page. On a GitHub row whose pull
  request has merged or closed, or whose issue has closed, it is tinted purple
  and says so, to suggest it. It does the same, saying "you reviewed", on a
  pull request whose review you have given and nobody has asked for again,
  and saying "not your review" on one you are notified about only because
  someone else, or a team you are not on, was asked to review it.
- **Mark read** (on an unread email row, after Archive) marks the row's
  threads read in Gmail and leaves them in the inbox, so the row stays on the
  page and moves from Unread to the run it belongs in.
- **Open** (on an email row that is not a GitHub notification, a document
  comment, an invitation, or a proposed new time, after Archive) opens the email in full in the
  page's **Email** tab, in the side panel beside the list, and marks it read
  in Gmail. The row stays highlighted while its email is in the tab. The tab
  shows the subject and then each message in order: the latest open, laid out
  as its sender wrote it with its images loaded, and the earlier ones one line
  each, which open when clicked. Scripts in an email do not run, and its links
  open the way bb opens other links. **Archive**, **Start thread**, and
  **Close** stay at the top of the tab, with **Open in Gmail** beside them.
  **Start thread** opens bb's composer just under them.
  **Archive** archives the email and hides the side panel; **Close** hides the
  side panel and leaves the email in the inbox. The email is
  fetched from Gmail each time it is opened and is not stored.
- **Open and archive** (first in the details line of a Google Docs, Slides,
  or Sheets comment row that mentions or assigns you) opens the newest
  discussion and archives the row in the same click, since once it is read
  there is nothing to come back for.
- **Yes, No, Maybe** (under a calendar invitation's snippet, after "Going?")
  replies to the event in Google Calendar as you, the way the same links in
  the email do. Your current reply is the one marked, read from Calendar on
  each sync, so a reply made in Calendar or Gmail shows here too. The row
  stays where it is, and once you have replied its Archive is tinted and says
  "you replied". A canceled event says so instead, and suggests Archive.
- **Accept new time** (under a "Proposed new time" email's snippet, when a
  guest proposes another time for an event you organize) moves the event in
  Google Calendar to the proposed time and emails every guest the change, as
  accepting the proposal in Calendar does. Beside it the row says the time
  proposed and the time the event is at now: "Proposed Mon Sep 28, 3pm – 3:30pm,
  instead of 2pm – 2:30pm". Once the event is at the proposed time, however
  it got there, the line says "Moved to" that time and Archive is tinted and
  says "it's moved". To keep the current time, archive the row. There is no
  Undo, since the guests have already been emailed.

While one of these waits on Todoist, Gmail, or the plugin's server, its row
dims and its buttons are disabled, and the button says what it is doing
("Completing…", "Archiving…", "Merging…") beside a spinner. The row stays
that way until the refreshed list arrives, so it goes straight to gone rather
than flashing back first.

Each of these says what it did in a toast with **Undo**, which reopens the
task, puts the threads back in the inbox (unread again if they were), or
marks them unread again, and returns the
row to where it was. A recurring task is the exception: completing it moves
it to its next date, and Todoist cannot move it back, so its toast says so
instead of offering Undo. Undo is for the moment after the click; it does not
survive a reload of the plugin. Undo shows "Restoring…" in the toast until it
has finished.

Every row also starts its details line with **Start thread**, which opens bb's
new-thread composer under the row, and clicking it again closes it. The
composer opens with the row's facts already in the prompt
(its title, link, dates, description, and latest comment) and room for what
the thread should do. The composer's project defaults to the
`threadProjectId` setting when it is set. Starting it leaves you on the page,
with a toast whose **Go to thread** button opens the new thread. Once a thread is started, the row
offers **Open thread** instead, until that thread is archived or deleted, and
gets an orange left edge, unless it is overdue or due today. A line under its
actions says what the thread is doing, as bb's sidebar does (**Working**,
**Needs you**, **Done, unread**, **Failed, unread**, or **Idle**), with the
thread's title. Clicking the line opens the thread. The status comes from bb's
sidebar, so it makes no request.

A GitHub row also has **Reply** in its details line, which opens a box under
the row that comments on the pull request or issue through the GitHub API, as
you. ⌘↩ sends it. Above the details line, the row quotes the most recent thing
someone wrote, taken from its email's snippet. When some of its messages are
unread, it quotes each of those instead, oldest first, with what happened for
one that has no words ("approved", "requested review of acme/reviewers"), up
to five and then a count of the rest. Each quote shows two lines at most:
one that runs longer ends its second line with "…" and **Show more**. The
browser does the clamping, and each row checks once whether its text fits,
so a long list opens without measuring its text line by line. Gmail stops a snippet at about 200 characters, so a quote whose snippet
ends before GitHub's footer has Show more too, which reads that one
email's plain-text body and shows the whole comment in place, as Markdown,
without GitHub's opening line, the diff above a review comment on a line, or
the footer. A quote that is whole but runs past two lines has Show more too,
which only unclamps it. **Show less** folds it back.

A pull request you opened that GitHub would let you merge now has **Merge**
at the right of the card that ends the row: GitHub Context's split button, which merges
with the method it names (squash merge unless the repository does not allow
it) and whose menu picks another of the methods the repository allows. It
merges through `gh pr merge`, as you, and then reads the pull request back,
so a repository with a merge queue shows it still open and queued rather
than merged. The button shows only when the pull request is open and not a
draft, you can write to the repository, and GitHub's merge state is clean or
has only non-required checks failing. It does not show on someone else's
pull request, even where you could merge it, since that merge is theirs to
make. Once merged, the row suggests Archive.

Editing a Todoist task's description or labels still happens
in Todoist, and replying to an email that is not from GitHub still happens in Gmail.

## From a shell

`bb now` runs the Todoist actions from a shell, through the same functions the
page uses and with the plugin's own token, so an agent can check them against
real tasks: `bb now tasks` lists the Todoist rows with their rules, `bb now task
show <id>` reads one fresh from Todoist, `bb now task add <name> --due <words>`
adds one to the Inbox, `bb now postpone <id> <day>` postpones one as the menu
does, and `bb now task delete <id>` deletes one. `skills/now-cli` tells an
agent how to check Postpone with a throwaway task.

## Sources

### Todoist

The open tasks matching one
[Todoist filter query](https://todoist.com/help/articles/introduction-to-filters-V98wIH).
Copy your API token from Todoist under Settings → Integrations → Developer,
then save it:

```sh
bb plugin config now set todoistApiToken <token>
```

The filter defaults to `today | overdue`. To change it:

```sh
bb plugin config now set todoistFilter "#Work & (today | overdue | p1)"
```

In bb's settings the filter is a multi-line text box, so a long query can be
written across several lines. Line breaks are joined into single spaces before
the query is sent to Todoist.

Settings are read on every sync, so a change shows up on the next one; press
Refresh to see it at once. The token is a bb secret setting, stored
under `~/.bb` and never sent to the frontend.

A task matched only through its deadline (Todoist's `overdue` includes
missed deadlines) has no due date, and sorts by the deadline instead.

One sync makes three requests to the Todoist API v1, in parallel:
`GET /api/v1/tasks/filter` with the saved query, `GET /api/v1/projects` to
name each task's project and find the Inbox, and `GET /api/v1/tasks/filter`
with `subtask` for every open subtask. All three follow `next_cursor` 200
items at a time.
Saving the edit strip makes `POST /api/v1/tasks/{id}` for the name,
description, due date, deadline, and priority and `POST /api/v1/tasks/{id}/move` for the project, only for what
changed, then reads the task back with `GET /api/v1/tasks/{id}`. Postpone
on a due date is one `item_update` command to `POST /api/v1/sync`, carrying the
new date, with the rule's own words as the due string when the task repeats,
then the same read back. Postpone on a deadline is `POST /api/v1/tasks/{id}`
with the new `deadline_date`. Delete is
`DELETE /api/v1/tasks/{id}`. Opening the page reads the projects once, for the
picker.
Nothing runs in the background, and nothing is requested until a token is set.

### Gmail

The threads matching one Gmail search, read through the
[`gws`](https://github.com/googleworkspace/cli) CLI, so the plugin holds no
Google credentials of its own. Sign `gws` in once with `gws auth login`. Gmail
is on by default and reads `in:inbox`, the 25 most recent threads:

```sh
bb plugin config now set gmailQuery "in:inbox is:unread"
bb plugin config now set gmailMaxThreads 50
bb plugin config now set gmailEnabled false    # hide Gmail
bb plugin config now set gwsPath ~/tools/gws   # when gws is somewhere else
```

bb started from the Dock or at login has only the system's PATH, without
Homebrew's directories. So when `gws` or `gh` is not on bb's PATH, the plugin
also looks in `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, and
`~/bin` before reporting it missing.

Each thread is one row: the first message's subject, and the latest
message's sender, snippet, and time. The snippet shows two lines at most, as a
GitHub quote does, and since Gmail stops it at about 200 characters, **Show
more** at its end reads the latest message and shows its whole text in place,
from the plain-text part or else the HTML, without the earlier messages a
reply quotes beneath it. A snippet of under 150 characters that fits in two
lines is taken to be the whole message and has no Show more. A row with any unread message has a bold
title and a blue dot beside its mark, as in Gmail; that holds for the GitHub
rows below too. A row of several messages also says how many are new ("1
new") beside its date. Reading it in Gmail clears it on the next sync. The
link opens the thread in Gmail's web app, in the account `gws` is signed
into.

GitHub's notification emails are gathered into one row per pull request or
issue, however many threads they arrive in. The row is recognized from the
email's headers (`X-GitHub-Reason`, and the `owner/repo/pull/N` in
`In-Reply-To`), so a person's email that only links to GitHub stays an email.
Its title is the pull request's, its link goes to GitHub, and its description
summarizes the notifications from their fixed phrasings: "3 comments from
octocat, hubber · review requested by octocat · approved by hubber · merged".
A review asked of a team or of someone else says whose ("review requested of
acme/reviewers by octocat"), since GitHub notifies you of a request of your
team with the same reason as a request of you. Whose it is comes from
GitHub, which works out team membership itself: a request still waiting on
you, directly or through a team you are on (labelled **Team review
requested**), is yours to pick up; a review you have given makes it yours
and done, including a team's request that your review answered; anything
else is someone else's. GitHub counts an author's replies to review comments
as reviews, so your own pull request never counts as reviewed by you. When
`gh` cannot be asked, a team's request stays yours while the team is still
among the pending reviewers the emails named.

The row ends in GitHub Context's banner card, below its details line: the
pull request or issue's state icon, then for an open pull request with checks
on its latest commit the GitHub mark with bb's check-status dot (a check for
passing, a cross for failing, a dot for pending), then `acme/widgets#141` and
your review in GitHub Context's words ("Review requested", "Team review
requested", "Re-review requested", "You approved", "You requested changes",
"You commented"), or else what it is waiting on ("Approved", "Changes
requested"), or its state once it is not open ("Draft",
"Merged", "Closed", "Not planned"). The segment links to it on GitHub.
After it, a pull request's reviewers are drawn as GitHub Context draws them:
an avatar for each person or team asked or who reviewed, with a badge for
approved, changes requested, commented, dismissed, or pending, and **No
reviewers** when nobody has been asked.

That state comes from `gh`, asked about every pull request and issue in one
GraphQL query per sync, because an email only says what was true when it was
sent: a pull request merged without a "Merged" email would otherwise still
read as open. When `gh` is missing or fails, the row uses the
`X-GitHub-PullRequestStatus` of its latest email instead.

```sh
bb plugin config now set ghPath ~/tools/gh   # when gh is somewhere else
bb plugin config now set threadProjectId <project-id>  # where Start thread opens
```

Google's comment notifications, from `comments-noreply@docs.google.com`, are
gathered the same way into one row per Google Docs, Slides, or Sheets file.
Their headers say little, so these threads, and only these, are read again
with their bodies, whose HTML has a fixed layout: a headline, the document,
and each discussion's posts with the author and a "New" badge. The row's
title is the document's, its link opens the newest discussion, **Open in
Google Docs** (or Slides, or Sheets) in its details line opens the document
itself, and its description is the latest headline and what is new: "Octocat mentioned you in
a comment · 2 new comments from Octocat, Hubber · 1 resolved". Below that it
quotes each new comment, from the unread emails, or from the latest one once
they are all read, with an action in words ("resolved the comment"), and an
external-link icon after each that opens the document at that comment. A
**Mentioned** label shows when one of them mentioned you or assigned you
something.

Calendar's invitations carry an `X-Google-Calendar-Notification` header
(`eventCreated`, `timeOrRecurrenceUpdated`, `eventCancelled`, and so on;
someone else's reply, such as `rsvpAccepted`, asks nothing of you, and a
guest's plain acceptance goes to Archive saying "they accepted"). Outlook's
acceptance has no such header, so a thread whose subject starts "Accepted:"
has its `invite.ics` read, and goes to Archive when that says `METHOD:REPLY`
with `PARTSTAT=ACCEPTED`. The event is
named only in the body's links, whose `eid` decodes to the event's id and your
address, so those threads are read in full too. Each sync then asks Calendar
for every invitation's event (`gws calendar events get`) and reads your reply
from its guest list. Replying sends that guest list back with your entry
changed (`gws calendar events patch`), since Calendar replaces the whole list
on a patch.

A guest's proposal of a new time carries `rsvpProposeNewTime` among the
header's kinds, and its `invite.ics` (`METHOD:COUNTER`) holds the time
proposed. Gmail leaves that file out of the full thread as an attachment, so
each sync fetches it (`gws gmail users messages attachments get`) for each
proposal thread. The same `events get` gives the event's current time.
Accepting sends the new `start` and `end` with `sendUpdates: all`, keeping the
time zone the event is shown in.

One sync runs `gws gmail users threads list` with the search, then
`threads get` for each thread's headers, five at a time, and once more in full
for each thread of Google comment notifications or calendar invitations and proposals. The signed-in
address is asked for once per plugin load, for the links. If `gws` cannot be
found, a red alert above the list names where the plugin looked and how to set
`gwsPath`; if it fails (an expired sign-in, for example), the alert shows its
error instead. Either way the Todoist tasks still load.

### Sync interval

```sh
bb plugin config now set syncIntervalMinutes 30   # 5, 15 (the default), 30, or 60
```

### What a sync costs

Clicking the sync time in the title bar shows the past hour's calls: the
total, one bar per sync stacked by service (Todoist, Gmail, Calendar, and
GitHub), each service's total for the hour, the calls the page's buttons made
between syncs, such as Complete, Postpone, or Archive, and what the GitHub
account has left of its 5,000 points an hour. A typical sync makes about 15
calls: three or four to Todoist, one Gmail search and one read per email
thread, a Calendar read per invitation, and one GitHub query.

The count costs no calls of its own. `now/usage.ts` wraps the Todoist `fetch`
and the `gws` and `gh` runners, so every call is recorded with its service
and time, and a call made while a sync runs counts as the sync's. The GitHub
query asks for its own `rateLimit`, so its points are GitHub's figure. The
hour is kept in memory, so a reload starts it over.

## Adding a source

A source is a `Source` from `now/sources.ts`: an id, a name, the query it
reports, and a `load()` that returns its status and its items as `Item`s
(`now/types.ts`). Give it a directory of its own beside `todoist/`, add its
settings to `server.ts` with the source's name as a prefix, and add it to the
list `server.ts` passes to `loadSources`.

## Layout

| Path | What it holds |
| --- | --- |
| `now/types.ts` | The `Item` shape every source produces |
| `now/sources.ts` | The `Source` interface, loading every source into one list, and keeping a failed source's last items |
| `now/items.ts` | The order the merged list is in, and which email rows open in the Email tab |
| `now/due.ts` | How a due date reads ("Today 14:00", "Tuesday", "Jan 15, 2027") and its color, and how an email's time reads |
| `now/cli.ts` | `bb now`, the Todoist actions from a shell |
| `skills/now-cli/` | The skill that tells an agent how to use `bb now` |
| `now/contract.ts` | The RPC contract: reading the stored list, syncing, the row actions, an email in full, and the week's priorities |
| `now/store.ts` | The database tables: the stored list, the threads started from rows, and the week's priorities |
| `now/priorities.ts` | The priorities' shape, keeping a check across a rewrite, this week's Monday, the column's labels, and its width bounds |
| `now/priorities-store.ts` | Reading and writing a week's priorities and their checks |
| `now/priorities-column.tsx` | The Priorities column with its nested bullets, and the page layout that puts it beside or above the list, with the edge that resizes it |
| `now/item-row.tsx` | One row: its details, state chips, buttons, and reply box |
| `now/postpone-menu.tsx` | Postpone's menu on a Todoist row |
| `now/task-edit.tsx` | A Todoist row's edit strip: the name, the description, the due date and deadline boxes, project picker, priority flags, and Delete |
| `now/pull-request-bar.tsx` | A GitHub row's card, in GitHub Context's banner chrome: the pull request segment and room for Merge |
| `now/merge-button.tsx` | The Merge split button, from GitHub Context's banner |
| `now/reviewer-stack.tsx` | A pull request's reviewers, from GitHub Context's banner |
| `now/github-favicon-icon.tsx` | The GitHub mark with a check-status dot, vendored from bb by way of GitHub Context |
| `now/brand-icon.tsx` | The source icons: bb's GitHub, Mail, and file outlines, and a Todoist mark drawn to match |
| `now/sections.ts` | Which section a row goes in, which run of the Now section and why a row can be archived, the short date each row shows, and the sidebar's counts |
| `now/now-summary.tsx` | The squares under the header, one per row in Now, shrunk to fit one line, that filter the list to one run |
| `now/thread-prompt.ts` | What Start thread's composer opens with |
| `now/item-list.tsx` | The page's display component, which loads nothing itself |
| `now/find-command.ts` | Finding `gws` and `gh` in the usual install directories when bb's PATH does not include them |
| `now/email-text.ts` | A plain email's latest message as the text Show more puts in place of its snippet |
| `now/email-reader.tsx` | The Email tab's display: the thread's messages, each in a frame that runs no scripts |
| `now/side-panel.ts` | Archive's and Close's way of hiding the side panel, by pressing bb's own hide button |
| `todoist/api.ts` | The only module that calls Todoist: auth, pagination, and error messages |
| `todoist/normalize.ts` | Turning Todoist task payloads into items, and projects into the picker's tree |
| `todoist/edit.ts` | What one Save asks of Todoist: only the fields the strip changed |
| `todoist/postpone.ts` | What Postpone moves on a row, its days (the quick picks and which days are allowed), and the due date moved with its time kept |
| `todoist/deadline.ts` | Reading a deadline typed in words into a day, since Todoist reads only a due date's words |
| `todoist/source.ts` | Todoist as a `Source`, built from its settings |
| `gmail/gws.ts` | The only module that runs `gws`: spawning it, reading its JSON, and its errors |
| `gmail/normalize.ts` | Turning Gmail thread payloads into items: sender names, snippets, links |
| `gmail/source.ts` | Gmail as a `Source`: the thread search and each thread's headers |
| `gmail/body.ts` | Reading a whole email out of Gmail's full format: each message's sender, time, and HTML or text body, and the whole comment in a GitHub notification |
| `gmail/inbox.ts` | Turning a page of threads into rows, with GitHub notifications gathered per pull request or issue and Google comment notifications per document |
| `github/notifications.ts` | Reading a GitHub notification: which pull request or issue, what happened, what was written (from the snippet or the whole body), and the summary |
| `github/state.ts` | The GraphQL query for every reference's state, checks, and whether you can merge it, and reading its answer |
| `github/gh.ts` | The only module that runs `gh`: the state query, merging, and posting a comment |
| `calendar/invite.ts` | Which event an invitation is about, your reply to it, and the guest list that changes it |
| `calendar/proposal.ts` | The time a proposal's invite.ics names, whether the event is at it, and how the row writes both |
| `calendar/api.ts` | The only module that asks Google Calendar: each event's reply and time, replying, and moving an event to a proposed time |
| `gdocs/notifications.ts` | Reading a Google Docs, Slides, or Sheets comment email's HTML: the document, its discussions, who wrote what, and the summary |
| `now/usage.ts` | Counting every call to Todoist, Gmail, Calendar, and GitHub by service, split into syncs and the calls between them, for the sync status |
| `item-list.stories.tsx` | The page in every state, for `npm run storybook` at the root |
| `email-reader.stories.tsx` | The Email tab beside the list, for `npm run storybook` at the root |
| `priorities.stories.tsx` | The Priorities column and its wide, narrow, and empty layouts, for `npm run storybook` at the root |
| `server.ts` | The settings, the sync (shared between callers), the background service, and the RPC handlers |
| `app.tsx` | The sidebar page, its title-bar sync control, its Email tab, and its navigation badge, which read the stored list and sync on open |

## Working on it

```sh
npm install
npx tsc --noEmit -p tsconfig.json
npm test
bb plugin build . && bb plugin reload now
```

For visual changes, run `npm run storybook` at the repository root and open
**now / Item list**.
