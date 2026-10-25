---
name: impromptu-ui
description: Use when `bb impromptu-ui` is available and the user would otherwise read your output and type a reply to act on it, such as choosing between options, approving a plan before you start ("Shall I go ahead?"), approving or editing a draft, comparing versions or UI designs (screenshots, original first), or working through several items like findings, issues, or PRs. Builds a small interface above the thread's composer, shaped to the task, instead of writing it in chat.
---

# Impromptu UI

## Overview

`bb impromptu-ui publish` shows a view right above this thread's composer: one row per item with its number, title, first two badges, and the first line of its summary. By default nothing runs from the list: clicking a row opens the item in the side panel, with its full summary, details, and every button. A view with `"layout": "list"` shows whole in the side panel instead (see "A list in the side panel" below). The user acts from the list instead of typing replies. Use it when there are several items with a decision on each. When a turn ends on one question with a few answers, such as "Should I go ahead?", publish it with `"layout": "inline"` instead (see "Ask a question inline" below).

## Is it available?

```bash
bb impromptu-ui help >/dev/null 2>&1 && echo available
```

If it is not available, present the results in chat as you would have.

## Publish

Write the view to a file and publish it from this thread:

```bash
bb impromptu-ui publish --file /tmp/<name>/view.json [--key <name>]
```

The list appears above the composer by itself, and the side panel opens on the first open item, so put the item that most needs a decision first. Publishing again with the same key (default `default`) replaces the view and keeps what the user already did to each item, matched by item `id`. Keep an item in the file after the user has acted on it: its done state and result banner show only while the item is still in the view, and dropping it makes a handled item vanish instead of reading as done. Use a different key for a second, separate view in the same thread; both show above the composer, newest first. A validation error names the field to fix.

After publishing, say in chat how many items there are and that they are above the composer. Do not repeat the list in chat.

## The view file

The examples in this skill show common shapes, not the limit. `bb impromptu-ui schema` prints the JSON Schema `publish` validates against, generated from the code, so it lists every field a view, item, and button can have, including ones added after this skill was written. Read it when the task calls for something the examples do not show.

```json
{
  "title": "Triage: acme/widgets milestone 4.2",
  "summary": "Markdown shown above the cards.",
  "sections": [
    {
      "title": "Ready to close",
      "items": [
        {
          "id": "issue-101",
          "title": "#101 Export widgets as CSV",
          "url": "https://github.com/acme/widgets/issues/101",
          "badges": [{ "label": "Done", "tone": "success" }],
          "summary": "Markdown, always shown.",
          "details": "Markdown, shown under the summary and changes.",
          "draft": "This is done. #140 added Export.",
          "draftLabel": "Comment to post",
          "actions": [
            { "type": "message", "label": "Post and close", "text": "Post this comment on #101, then close it:\n\n{draft}", "primary": true },
            { "type": "message", "label": "Post", "text": "Post this comment on #101 and leave it open:\n\n{draft}" },
            { "type": "command", "label": "Close only", "command": "gh issue close 101 --repo acme/widgets" },
            { "type": "thread", "label": "Fix in a new thread", "project": "widgets", "title": "Fix #101", "prompt": "..." },
            { "type": "link", "label": "Open #101", "url": "https://github.com/acme/widgets/issues/101" }
          ]
        }
      ]
    }
  ]
}
```

- Rows above the composer are numbered in the order you publish them, so do not number titles yourself. Set `"numbered": false` on the view when the order means nothing.
- Sections are optional. A section's `title` shows as a heading over its rows above the composer, with open items first within it, so group by what the user decides in order, such as "Fix before merge" and "Worth considering". Leave every title empty for one plain list.
- `id` is unique in the view and stable across republishing: `issue-101`, `finding-3`.
- `url` is what the item is about on the web (the issue, the PR, the review comment's `html_url`). The opened item's title links to it, so set it whenever there is one; a separate `link` button for the same page is then unnecessary.
- `tone` is `neutral` (default), `info`, `success`, `warning`, or `danger`.
- At most 6 actions per item. `primary: true` makes a button stand out; use it for the likely choice. `detail` is one line on what the button does, shown when the pointer rests on it.
- `draft` is text the user can edit before it is sent: a comment to post, the task for a new thread. It is markdown: the opened item shows it once, rendered, under `draftLabel`, with a Raw toggle to edit the source. A `message` or `thread` button puts `{draft}` in its `text` or `prompt` where the draft goes, so several buttons ("Post and close" and "Post") share one draft, and each sends its own instruction with the draft as the user left it. A command can use `{draft}` only in a list view (see below). Do not repeat the draft in `summary` or `details`.
- On a card, for a short answer or a value of the user's own, set `"draftFormat": "text"`: the draft becomes a one-line field, with no preview or Raw toggle, instead of the markdown editor. Keep the markdown editor for anything longer than a line, like a comment to post or a thread's task. A list view's draft is already a one-line field, so this is for cards. A `text` draft on a card can start empty (`"draft": ""` or left out), may have a `draftPlaceholder`, and needs at least one `message` or `thread` button that uses `{draft}`. The field shows below the card's other buttons, with its `{draft}` buttons on its right. Enter presses one of those (the `primary` one, if any), never another button, so a card can mark a product button `primary` and still offer the field:

  ```json
  {
    "id": "apples",
    "title": "Apples",
    "summary": "Last three orders were Fuji ×8.",
    "draftFormat": "text",
    "draftLabel": "Something else",
    "draftPlaceholder": "Fuji ×12, or another product",
    "actions": [
      { "type": "message", "label": "Fuji ×8", "text": "Add Fuji ×8 for Apples", "primary": true },
      { "type": "message", "label": "Honeycrisp ×5", "text": "Add Honeycrisp ×5 for Apples" },
      { "type": "message", "label": "Use this", "text": "For Apples, add this instead: {draft}" }
    ]
  }
  ```
- The row above the composer shows only the title, two badges, and the first line of `summary`. Make the first line the gist, and mark the likely choice `primary` so it stands out in the opened item. Put evidence and drafts further down the summary or in `details`.

| Action | What the button does |
|---|---|
| `message` | Sends `text` to this thread as if the user typed it, or to the thread named by `threadId` (see "An item in its own thread"). Use it when the work needs your judgment or context: posting a drafted comment, revising something. Write `text` so it names the item, because you will read it later with no other context. |
| `thread` | Starts a new thread in `project` (a name from `bb project list`, or `personal`) with `prompt` and `title`. The prompt must stand alone. Add `baseBranch` when the work belongs on a branch other than the project's default (see below). |
| `command` | Runs `command` in the user's login shell, in `cwd` (absolute) or the directory `publish` ran in. The panel shows the command and asks before running, then shows the exit code and output. `"confirm": false` runs it as soon as the button is clicked; use that only for a small step the user already expects, such as adding a to-do. Use a command for one self-contained step: `gh issue close`, `gh pr merge`. |
| `link` | Opens `url`. |

An item with `variations` is a visual review instead: see below.

A `thread` button with `baseBranch` starts its thread in a new worktree cut from that ref, after fetching it, and diffs the thread against it from the first turn. Use it whenever the new thread will open a pull request whose base is not the default branch, such as a fix in a PR against the PR you are reviewing. Without it, the thread's diff compares against `main` and shows the parent PR's changes too. Give a remote branch, `origin/<PR head branch>`, not a local one, which may be behind:

```json
{
  "type": "thread",
  "label": "Fix in a PR against this PR",
  "project": "widgets",
  "title": "Fix #101's retry loop",
  "baseBranch": "origin/retry-on-timeout",
  "prompt": "acme/widgets#101 retries forever when the server times out. Make a branch off retry-on-timeout, fix it there, and open a PR whose base is retry-on-timeout."
}
```

Every card also has Dismiss, and Start thread, which opens a new thread seeded with the card so the user can dig into it; do not add a `thread` button that only does that. Once one of a card's buttons goes through, the card is done and its other buttons are disabled (links stay usable), so each card should be one decision: offer "Post and close" and "Post" as alternatives, not "Post comment" then "Close issue" as steps. Label each button with only what it does: "Post" already means the issue stays open, so leave off "and keep open", and leave off prefixes like "Instead:". A command that fails leaves the card open to try again. A button with `"repeat": true` leaves the card open after it goes through, for a step the user may take again, such as "Regenerate".

## Ask a question inline

When your turn ends on a question the user answers by picking, such as "Should I go ahead?" after a proposed fix, or "Commit and push as 2 commits?" after a report, ask it above the composer instead of in the last line of your reply. Give the view `"layout": "inline"`: each item is one question, and its buttons are the answers.

```json
{
  "title": "Fix the failing check",
  "layout": "inline",
  "sections": [{ "items": [{
    "id": "snapshot",
    "title": "How should I fix the snapshot check?",
    "actions": [
      { "type": "message", "label": "Update, commit, and push", "primary": true,
        "detail": "Update the 2 snapshots, re-run the suite, commit, and push",
        "text": "Go ahead: update the 2 snapshots, re-run the suite, then commit and push." },
      { "type": "message", "label": "Update but don't push", "detail": "The same, stopping after the commit",
        "text": "Update the 2 snapshots and commit, but don't push yet." }
    ]
  }]}]
}
```

- The question, its buttons, and a "Something else…" field show right above the composer, and the side panel never opens. Once the user answers, a green banner with the answer replaces the buttons.
- An answer typed into the field comes to you as the question, a blank line, and what they typed. `state` prints it as `(Something else: "<text>")`.
- Any reply typed there closes the question, even one that only asks for more, such as "What would the first option change?". Answer it, then, if the decision is still open, publish the question again under the same key with a new item `id` (such as `deploy-2`), updating the answers if what you found changes them. Never tell the user a question is still above the composer without checking `state`.
- 1 to 3 questions per view, each with 2 to 4 buttons: `message`, `thread`, or `link`, at least 2 of them answers rather than links. A `command` needs the "cards" layout, since it asks before it runs. So do drafts, notes, changes, evidence, variations, related notes, history, a status, a meter, a closing step, and `thread` on an item.
- Keep labels short and say what each does in `detail`, which shows when the pointer rests on the button. Mark the answer you recommend `primary`.
- End your reply with the proposal and say the question is above the composer. Do not repeat the question or the answers in chat.

## A closing step

When the items lead up to one last decision that depends on them, such as a code review's verdict after its findings, make that decision the closing step rather than the first card. Give it `"closing": true`:

```json
{
  "id": "verdict",
  "title": "Submit as Request changes",
  "closing": true,
  "summary": "Request changes for the paging bug; the other two are not blocking. So far: {tally}.",
  "actions": [
    { "type": "message", "label": "Submit as Request changes", "text": "Submit my pending review on acme/widgets#431 as Request changes. Findings: {tally}.", "primary": true },
    { "type": "message", "label": "Submit as Comment", "text": "Submit my pending review on acme/widgets#431 as a comment. Findings: {tally}." }
  ]
}
```

- It shows under the rows as a "Then" line instead of a row, and the header's count leaves it out. The side panel opens on it only once every other item is done or dismissed.
- Its buttons wait until then: opened early, it says how many items are still open. Put it in a section of its own at the end, so it reads last in the file too.
- `{tally}` in its summary or in a `message` or `thread` button's text becomes what was done with the other items, such as "2 Attach as draft comment, 1 dismissed". Recommend the verdict in the summary, and let the user change it once they have been through the items.
- A view has at most one closing step, and it needs the "cards" layout.

## Code review findings

When the items are a pull request review's findings, lay the view out so the user reads them before deciding the review:

- One item per finding, grouped into sections by how much it matters: "Fix before merge", then "Worth considering". Leave out a section with nothing in it.
- Open each finding's summary with what goes wrong for the user or the system ("Every archived widget comes back on the next sync"), then the code that causes it. Names of functions and variables after the consequence, not before.
- Give each finding the hunk it is about, from `gh pr diff`, as a change, with `"changesLabel": "In this PR"`. When the finding has a concrete fix, add it as a change with `"role": "proposed"`, never in the PR hunk's block or as prose. Quote code the PR does not change in `details`.
- Give each finding that calls for a code change a "Fix in a PR" `thread` button, beside the ones that put it in the review. Its `prompt` names the pull request, the finding, and the fix, or the possible fixes when there are several, and asks for a new pull request against the PR's head branch. Give it `"baseBranch": "origin/<PR head branch>"`, so the new thread's diff shows only its own fix.
- Make the verdict (approve, comment, or request changes) the closing step, in a section of its own at the end, with your recommendation in its summary and `{tally}` in its buttons' text. Offer the other verdicts as its other buttons.

## Show what changed

When an item is about a change, such as a pull request's files, a code review finding's hunk, or a section's new text against the document it goes into, give it `changes` rather than describing the diff in its summary. This holds when another skill lists the fields its view uses and does not name `changes`: a skill's list of fields is what that skill adds, not everything an item may have.

```json
{
  "id": "pr-418",
  "title": "#418 date-fns 4.1.0 → 4.2.0",
  "changesLabel": "Files changed",
  "changes": [{ "patchFile": "/tmp/pr-418.diff" }]
}
```

- A change is a `patch` (a unified diff of one file, with its path as `label`), a `patchFile` (a diff on disk, such as one `gh pr diff 418 > /tmp/pr-418.diff` wrote, split into one change per file when you publish), or `before` and `after` text with a `label` naming it.
- A patch shows in bb's own diff view. Text shows as prose: each line beside the one it replaced, with the changed words marked. Set `"format": "code"` on `before` and `after` to show them as code instead.
- A lockfile (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`) shows as the packages whose versions changed, with downgrades flagged and each package marked by whether the `package.json` diff beside it names it. Its raw diff is one click away. Include the manifest's diff so the marks can show.
- `"collapsed": true` starts a change folded to its header, for a file that matters less.
- `before` with no `after` compares against the item's `draft`. The changes block then has an Edit tab that edits the draft, the draft's own editor is left out, and `{draft}` buttons send it as edited. Use this for a section you propose: `before` is the text now in the document, `draft` the proposed text.
- `changesLabel` names the heading, such as "Files changed", "In this PR", or "Changes against the Doc"; it defaults to "Changes".
- A change you suggest on top of the one under review, such as a code review finding's fix, gets `"role": "proposed"`. It shows in its own tinted block under the item's other changes, headed by `proposedLabel` (default "Suggested fix"), so a fix never reads as the pull request's own code. Give a review finding its PR hunk as an ordinary change with `"changesLabel": "In this PR"`, and its fix, when it has one, as a proposed change. A proposed `patchFile` keeps the role on every file it splits into.

## Show the evidence behind proposed text

When an item proposes text whose claims come from sources, such as a grant section citing release notes, a resume line drawn from a list of accomplishments, or a review finding based on certain lines, give it `evidence`: one entry per claim, with the verbatim quotes that back it. Do not put sources or doubts about a claim in `details`.

```json
{
  "id": "need",
  "draft": "Two volunteers maintain acme/widgets in their evenings. Its release queue is four months behind.",
  "changes": [{ "label": "Need", "before": "acme/widgets is downloaded 90,000 times a week." }],
  "evidence": [
    { "id": "volunteers", "claim": "Two volunteers maintain acme/widgets in their evenings.", "support": "full",
      "sources": [{ "quote": "octocat and hubber review every pull request, both outside their day jobs.", "source": "maintainers.md › Who we are" }] },
    { "id": "release-queue", "claim": "Its release queue is four months behind", "support": "partial",
      "note": "The notes date the wait from June, three months ago, not four.",
      "sources": [{ "quote": "The 4.0 release has waited on two security reports since June.", "source": "release-notes.md › 4.0", "url": "https://github.com/acme/widgets/releases" }] }
  ]
}
```

- `claim` is copied exactly from the proposed text: the draft, a change's `after`, or a patch's added lines. `publish` refuses one it cannot find. Keep it to the words the sources back, within one line, and list claims in the order they appear.
- `support` is `full`, `partial`, or `none`. Be honest: a claim the sources only partly back is `partial`, and one with no source is `none`, with `sources` left empty.
- Each source is a verbatim `quote`, `source` naming where it is from (the file and heading, the page), and a `url` when it has one.
- `note` is a doubt about the claim, such as a source that disagrees or a fact that may be out of date. It shows beside the claim.
- The claims are underlined and numbered in the text, and the Evidence card under the changes lists each with its quotes. A claim the user edits away moves to the bottom of the card with its quotes; when you publish the next round, drop or rewrite the evidence to match the new text.
- `related` is for notes not in the text yet. Once you use a related note, move it to `evidence` on the claim it backs.

## Work in rounds

When each item is a piece of work that goes back and forth, such as sections of a document you draft, the user pushes back on, and you revise, give each item a `status` and a `history`:

```json
{
  "id": "need",
  "title": "Need",
  "status": { "label": "In progress", "tone": "warning" },
  "summary": "Round 2 leads with who maintains acme/widgets.",
  "history": [
    { "text": "Round 1: opened with the download counts.", "at": "2026-03-12T09:42:00Z" },
    { "who": "user", "text": "Lead with who maintains it, not downloads.", "at": "2026-03-12T09:48:00Z" },
    { "text": "Round 2: leads with the two volunteer maintainers.", "at": "2026-03-12T09:51:00Z" }
  ],
  "draft": "Two volunteers maintain acme/widgets in their evenings. ...",
  "draftLabel": "Proposed text",
  "actions": [
    { "type": "message", "label": "Accept", "text": "Accept Need as below:\n\n{draft}", "primary": true },
    { "type": "message", "label": "Revise", "text": "Revise Need. My edits are below:\n\n{draft}" }
  ]
}
```

- An item with a `status` is finished only when you say so: republish it with `"complete": true` inside its `status`, as in `"status": { "label": "Added", "tone": "success", "complete": true }`. Its buttons stay usable until then, so the user can revise it as many times as it takes. Mark it complete when the work is really done, such as once the text is written in and fits, not when Accept is pressed; if it does not fit yet, say why in the label, such as `"40 words over"`.
- `label` is what shows, `tone` colors it, and `complete` defaults to false. Once any item has a status, the header counts what is complete ("1 of 4 complete") instead of what is open.
- `history` is the back and forth, oldest first, shown under the summary. Add an entry for each round you propose and each push-back the user gives (`"who": "user"`). `at` is an ISO time, shown as a time of day, or a short label shown as written.
- For the user's push-back, give the item `"note": { "placeholder": "What to change for the next round" }` and put `{note}` in the Revise button's `text`. A one-line field shows beside the buttons; Enter presses the button that sends it. An empty note sends nothing where `{note}` is, and `state` reads a sent note back.
- Each round, publish the item again under the same `id` with the new `draft`: the card starts over with it, replacing any edit the user sent with the last round. The banner saying which button the user pressed stays only until you publish again.

### An item in its own thread

When you start a thread for each item to work on with the user, such as one per section of a document, give the item `"thread"` with that thread's id, and give the buttons that belong there, such as Revise, the same `threadId`:

```json
{
  "id": "need",
  "title": "Need",
  "thread": "thr_need01",
  "note": { "placeholder": "What to change for the next round" },
  "actions": [
    { "type": "message", "label": "Accept", "text": "Accept Need as below:\n\n{draft}", "primary": true },
    { "type": "message", "label": "Revise", "text": "Revise Need. {note}\n\n{draft}", "threadId": "thr_need01" }
  ]
}
```

- The item then shows above that thread's composer too, as the same card from your view, so both threads always agree. That thread sees only its own items. Buttons without `threadId`, like Accept here, still come to you.
- In your thread, the item's row opens its thread instead of the side panel, and the panel keeps the page map. Do not add a `command` button that runs `bb thread open`.
- `{note}` goes wherever the button that uses it goes.
- `publish` refuses an id that is not a bb thread. A button sending to a thread archived since fails on the card with a note to unarchive it.
- Sending wakes that thread if it is idle, as `bb thread tell --mode auto` does.
- Only you publish the view. The item's thread cannot, so when it finishes a round it must hand the new text back to you, such as with `bb thread tell <your thread id>`, and you publish the next round. Tell it so in its first prompt. From its own thread, `bb impromptu-ui state` reads the item back, with the note the user sent.

## Budgets, supporting notes, and a map

For work that has to fit, such as sections of a two-page document or a word-limited form, three more fields help:

```json
{
  "map": { "pages": [{ "label": "Page 1", "columns": [["summary", "need"]] }, { "label": "Page 2", "columns": [["approach", "team"]] }] },
  "sections": [{ "items": [{
    "id": "need",
    "meter": { "value": 180, "max": 200, "unit": "words" },
    "related": {
      "title": "From the release notes",
      "detail": "Ranked by the fund's criteria",
      "entries": [
        { "id": "security-queue", "text": "The 4.0 release has waited on two security reports since June.", "detail": "Matches: maintenance is at risk",
          "action": { "type": "message", "label": "Add", "doneLabel": "Added", "text": "Add to Need: the 4.0 release has waited on two security reports since June." } },
        { "id": "dependents", "text": "1,400 public projects depend on acme/widgets.", "badge": { "label": "Used", "tone": "success" } }
      ]
    }
  }] }]
}
```

- `meter` is how much of its budget an item uses. It shows as a bar with its numbers on the row and the opened item, red once `value` passes `max`. Keep it current each round, from the real count (the exported page, the form's word count), not an estimate.
- `related` is supporting material to act on one entry at a time, shown in its own card under the item: notes to draw from, ranked best first. Each entry has `text`, an optional `detail` line (what it matches, where it is from), an optional `badge` such as "Used", and at most one button: a `message`, `thread`, or `link`, without `{draft}` or `{note}`. Once pressed, the entry says so (its `doneLabel`, or "Sent") until you publish again; then mark it, such as with a "Used" badge in place of its button.
- `map` on the view lays the items out as the pages they fill, at the top of the side panel: each page is one to three columns of item ids, top to bottom. A block's height comes from its item's `meter.max`, its fill from `meter.value`, and its color from its state and status, with an item over budget in red. Clicking a block opens its item. Every id must be an item in the view, once. It needs the "cards" layout.
- `state` reads each related button pressed as `[related] <entry id>` under its item.

## A list in the side panel

When each item is a quick yes or no that needs no reading, such as suggestions to add to a list, give the view `"layout": "list"`. The whole view then shows in the side panel as one list. Above the composer, under the view's header, a single row previews it (the names still to decide, then what is on the list) with a Review button that opens the panel:

```json
{
  "title": "Grocery staples",
  "summary": "Due staples that are not on the Groceries list yet.",
  "layout": "list",
  "dismissLabel": "Skip",
  "sections": [
    {
      "items": [
        {
          "id": "oat-milk",
          "title": "Oat milk",
          "summary": "Last bought Mar 5",
          "draft": "Oat milk",
          "draftLabel": "Task to add",
          "actions": [
            { "type": "command", "label": "Add", "doneLabel": "Just added", "command": "td task add {draft} --project \"Groceries\"", "confirm": false, "primary": true }
          ]
        }
      ]
    },
    {
      "items": [
        { "id": "task-eggs", "title": "Eggs (dozen)", "url": "https://app.todoist.com/app/task/eggs-1001" },
        { "id": "task-bread", "title": "Sourdough bread", "url": "https://app.todoist.com/app/task/bread-1002" }
      ]
    }
  ]
}
```

- Items with actions are the decisions. They sit at the top as dashed rows showing the title, badges, and the first line of `summary`, with their buttons and Dismiss on the right.
- Items with no actions are the list as it stands: plain rows with the title (linked to `url`) and badges. They are left out of the open count, and `state` prints them as `[listed]`.
- An item with a `draft` shows it in place of its title, in a text field the user can edit before pressing a button; Enter presses the primary one. A `command` puts `{draft}` where the text goes, and the plugin passes it as one single-quoted shell word, so write `td task add {draft}`, not `td task add "{draft}"`. `draftLabel` names the field for screen readers. `state` shows an edited name as `edited to "<text>"`.
- Once a button goes through, its row moves into the list, under the name as it was sent, tagged with the button's `doneLabel` (such as "Just added"), or its `label` when there is no `doneLabel`. A dismissed row stays on top, struck through, with Undo. A failed command stays on top with its error and its buttons, so the user can retry.
- `dismissLabel` renames Dismiss (`"Skip"`, `"Not now"`). Set it on the view, a section, or an item; the nearest one wins. It also works in the default layout.
- A `command` with `"confirm": false` runs as soon as its button is clicked. Without it, the command shows under its row with Run and Cancel. `message` buttons work too, but each one starts a turn in this thread, so use a command when one does the job.
- Section titles are not shown, so group items only by whether they have actions. An item has at most 3 actions besides Dismiss, and a list view cannot hold a visual review.

## Visual review

When you would otherwise describe how a piece of UI could look, show it instead: two or more directions ("how might we improve this?"), or a single change you propose. An item that proposes a change to what the user sees, such as one of several suggested improvements, gets screenshots of the screen as it is and with the change, however small the change. Describing it in the summary alone leaves the user to imagine it. Give an item `variations` in place of `actions`, or alongside a link:

```json
{
  "id": "review-rows-1",
  "title": "Task rows: 2 directions",
  "summary": "What reads as wrong now, in a sentence.",
  "variations": [
    { "label": "Original", "description": "As it is now.", "image": "/tmp/review/original.png" },
    { "label": "A. Sections", "description": "Overdue / Today headings, grey icons.", "image": "/tmp/review/a.png" },
    { "label": "B. Dates right", "description": "Sections, plus a short date on the right.", "image": "/tmp/review/b.png" }
  ]
}
```

- The first variation is always the original, as it is now. Then 1 to 5 alternatives, labelled with a letter and a few words.
- Each variation is a different design, because the user picks one of them. To show one design in several states (another tab selected, a filter on, a menu open), put the states side by side in that design's one image, and say in its description what each shows. Never make the states separate variations: "C. Widgets tab", "C. Gadgets tab", and "C. Gadgets, filtered" ask the user to pick between screens of the same thing. A round with one direction left is the original and that direction, two variations.
- Take every image the same way: the same story or screen, the same data, width, and crop, so only the design differs. Build each alternative as a story or behind a flag and screenshot it; do not draw mockups by hand. PNG, JPEG, WebP, or GIF, up to 8 MB each.
- Capture the element itself (Playwright's `locator.screenshot()`) rather than cropping a full-page capture afterwards. If you must crop, use `magick in.png -crop <w>x<h>+0+0 +repage out.png`, not `sips`: `sips -c` crops around the centre, and its `--cropOffset` does not pin the crop to the top-left, so the left and top edges are lost. Read each image back before publishing to check nothing is cut off.
- `publish` copies the images, so moving or deleting the files afterwards is fine.
- A variation is the only way to show a picture. A markdown image or link to a file on disk in `summary` or `details`, or a `link` button with a `file://` URL, shows no picture.
- To show screenshots of work you have built, such as the screens of a feature for the user to look over, put each screen in its own item as a before and after with `"built": true`: the screen as it was (the earlier story, or the placeholder or empty state it replaces), then as it is now, with several states side by side in the one image. Its buttons read **Looks good** and **Send note**, and you receive `Decision: **looks good**` or the note.
- Two variations, the original and one alternative, show as **Before and After** instead of a film strip: one image at a time in the same place, flipped with tabs or the arrow keys, an optional note, and **Build it** or **Send note only**. You receive `Before and after feedback on "<title>":`, then `Decision: **build it**` or `Decision: not yet`, and the note. Use this for each suggestion in a list of proposed changes: one item per change, each with its own before and after, so the user decides on each.
- With more variations, the user picks one (or none), notes on any, and presses Send feedback. You receive one message: `Visual review feedback on "<title>":`, the pick, and each note. Build what it says, then publish the next round as a new item with a new `id` (`review-rows-2`) if another round is needed. A sent review cannot be sent again.

## Read back what the user did

```bash
bb impromptu-ui state [--key <name>]
```

Prints each item as `[open|done|dismissed] <id> <title>`, then its status as `{In progress}` if it has one, with the last action and its result (and `sent to <thread id>` when it went to another thread), or with the `dismissLabel` it was dismissed under, such as `(Skip)`. An item with no actions in a list view prints as `[listed]`. Check it before a follow-up that depends on the user's choices, like a summary at the end of a batch.

## Take a view down

```bash
bb impromptu-ui hide [--key <name>]
```

Hides the view from above this thread's composer, as the archive button on its header does. Run it when a view's items are settled or a later round replaces it under a different key, rather than asking the user to dismiss it. The view and what the user did to it stay readable with `state`, and the next `publish` under the same key shows it again.

## When it falls short

If the user says a view should have appeared and did not, or that one could not do what the work needed, use the `refine-impromptu-ui` skill. It works out what went wrong with the user and files an anonymized issue with the improvement.
