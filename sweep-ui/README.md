# sweep-ui

The list that Issue Sweep, PR Sweep, and Review Sweep draw each tab with. It
takes plain props and holds no data of its own: each plugin decides which run
and tier every row is in, stores its own notes and seen comment counts, and
passes the results in.

A tab is one bordered list. Now rows are open, with their note and a line of
actions. Next rows are closed to their title and number line. Later rows are
one dimmed line each, and fold into "N more" after five. A chevron in the left
column opens or closes a row. A row with `forceOpen` set stays open in any
tier and has no chevron to close it; the plugins set it on the row whose
Harvest timer is running. A one-line Later row shows, where its first fact
would be, its note when it is on hold, or else its flag. Above the list, one square per row, grouped by
run, narrows the list to one run when pressed: blue for new, red for late,
orange for work under way, and grey for the rest. A stale row has a red left
edge and a faint red wash, a blocked one a slate one, and a row in an
under-way run an orange one. `threadLine` draws under the action line,
before the note, for component-library's `ThreadLine`.

Every row carries a track on the right: a dot for each stage with the stage
names under it, the current stage's name in bold. A row with `blockedStage`
set draws that stage as a red disc with a white cross and names it in red.

A plugin that passes `renderBody` draws its own row body. The row keeps its
chevron, the title line (the item's `icon`, the title, the number, the
item's `stack` as a `StackChip`, a warning triangle when `conflicted` is set,
"N new", and the first fact on the right as
the age), and, when open, the note and the
action line; `renderBody` fills the space between the title line and the
note. On a one-line Later row it is drawn inline where the first fact would
be. `StatusBanner` is the red, green, blue, or grey line such a body can put under
the title.

PR Sweep and Review Sweep both draw pull requests, and take what they draw for
one from `sweep-ui/pull-request`, so a pull request looks the same on both
tabs. Each passes `ReviewerStack` a `Tooltip`, a small wrapper around its own
tooltip component, because a tooltip's portal belongs to the plugin and this
package cannot import it. Without one, each avatar gets a native `title`.

## Installing

A plugin depends on it as `"sweep-ui": "file:../sweep-ui"` and installs with
`npm install --install-links`, the same way it installs `bb-plugin-harvest`.
A plain `npm install` links the directory instead of copying it, and the link
resolves React from this package's own `node_modules`, which puts a second
React in the plugin. React, `react-dom`, the Hugeicons packages, `clsx`, and
`tailwind-merge` are peer dependencies here for the same reason: the copy uses
the plugin's.

The package uses relative imports only, since `@/` means the plugin's own
directory once it is installed there.

`bb.pluginTailwindContent` in its package.json lists its components for
Tailwind. `bb plugin build` generates only the classes it finds in the plugin
itself and in dependencies that list files this way, so without it the
squares, the track width, and the row tints are missing in bb even though
they show in Storybook. A `bb` block with no `name` does not make this a
plugin: `sync.sh` and `setup.sh` look for `bb.name`.

## Exports

| Path | What it holds |
| --- | --- |
| `sweep-ui/list` | `SweepList`, the whole tab: summary, rows, fold, and the run filter. `order="given"` draws the rows as passed, unfolded, in place of Now, Next, then Later |
| `sweep-ui/row` | `SweepRow`, one row, used by `SweepList`. `trackPlacement` draws the track down the right-hand side, beside the title only so the action line runs full width, or on its own line |
| `sweep-ui/track` | `Track`, with its stage names and blocked stage, and `TRACK_WIDTH` |
| `sweep-ui/summary` | `SummarySquares`, one square per row grouped by run, coloured by the run's `tone` or its own `color`, with a `label` for a page that draws more than one |
| `sweep-ui/note` | `NoteBox` and `NoteField` |
| `sweep-ui/banner` | `StatusBanner`, a one-line status under a row's title: `tone="blocked"` in red with an alert icon, `tone="ready"` in green with a check, `tone="info"` in blue with an info icon, `tone="muted"` in grey for a problem set aside, an optional lighter `detail` after a dot, and an optional `action` at the right end |
| `sweep-ui/pull-request` | What a pull request row draws: `PullRequestIcon` (green when open, muted for a draft), `ReviewerStack` (avatars with a badge per review state, and an optional `Tooltip`), `Avatar`, `ChecksBadge` (a tick, clock, or cross with a count, and every count on hover), and `DiffCount` ("+128 −12"). Also the `Reviewer`, `ReviewState`, and `ChecksSummary` types, and the pure `githubAvatar`, `checksGlyph`, and `checksLabel` |
| `sweep-ui/stack-chip` | `StackChip`, a pull request's place in a stack of pull requests built on each other's branches: "3 of 4 · on #612", with the number linking to the one below, or "1 of 4 · base" |
| `sweep-ui/actions` | `LINE_ACTION`, the class a row action is drawn with, and `CopyLinkAction`, which copies through the writer the plugin passes as `write` |
| `sweep-ui/feedback` | `FeedbackDrawer`, which reads a pull request's comments when it mounts and draws them, a spinner while it reads, or the error; `FeedbackList`, the entries oldest first, each inline comment in a card headed by its file and line, "you" and "bot" labels on the name, each body drawn as Markdown with the `Markdown` component you pass (bb's, from `@get-bb/plugin-sdk/app`) and cut at three lines with Show more under it, resolved threads behind "N resolved", all but the 10 newest behind "Show N earlier", the last `newCount` marked new, and "Open all N on GitHub" when `total` says there are more than it read; and the `FeedbackEntry` type that `fetchFeedback` in `@danielb/gh-shared/gh` returns. Pass one from `renderComments` |
| `sweep-ui/types` | `Tier`, `RunTone`, `Flag`, `Run`, `SweepItem`, and `Stage` |

## SweepList's props

| Prop | What it does |
| --- | --- |
| `stages` | The track's stages, in order, each with its Tailwind color class |
| `runs` | Every run in list order. Each row's tier comes from its run. The summary names a run with `label` ("3 new comments"), or `labelOne` when it holds one row ("1 new comment") |
| `items` | The rows, already sorted by the plugin |
| `renderActions` | The plugin's own actions for an open row, drawn before "Add note" or "Edit note" |
| `onMove` | Optional. Makes the track's dots buttons that move a row to that stage |
| `onNoteSave` | Saves a note. An empty string deletes it. Resolves true once saved, which closes the field |
| `onOpenLink` | Optional. Called when the title is clicked, before the link opens |
| `Link` | Optional. Draws the title and parent chip. Pass `UrlLink` from `@get-bb/plugin-sdk/app`, so links open through bb's navigation and follow the user's browser choice. Defaults to a plain anchor, for tests and stories |
| `laterShown` | Later rows shown before "N more". Defaults to 5 |
| `busyKeys` | Keys of rows to dim while a request for them runs |
| `renderBody` | Optional. `(item, open, line)` draws the row's body in place of its number line. `line` is true on a one-line Later row, where it is drawn inline in place of the first fact |
| `renderTrack` | Optional. `(item, line)` draws the right-hand column in place of the stage track. Returning null leaves the column out, so the row takes the full width |
| `collapsible` | Optional, default true. False keeps every row open, whatever its tier, with no chevron and no column for one. `"later"` keeps Now and Next rows open that way and draws Later rows as one closed line each, with a chevron to open them; PR Sweep uses it for its waiting rows |
| `renderTrailing` | Optional. `(item)` draws at the right end of an open row's action line, after the note button. The sweeps put the Harvest timer there |
| `renderStartThread` | Optional. `(item)` draws under the row's action line, above its thread line. PR Sweep and Review Sweep return component-library's `StartThreadInline` for the row whose Start thread button opened it, and null for the rest |
| `renderComments` | Optional. `(item)` draws the drawer the comment count opens under the action line, and turns the count into a toggle. Drawn only while open, so a drawer that loads its comments loads them on the click. Issue Sweep, PR Sweep, and Review Sweep pass a `FeedbackDrawer` |
| `summaryAction` | Optional. Drawn on the summary squares' line, at its right end. Review Sweep puts its Batch button there |

## Working on it

```sh
npm install
npx tsc --noEmit -p tsconfig.json
npm test
```

`sweep.stories.tsx` draws the list with issue-shaped fixtures, and once with
a custom body; run
`npm run storybook` at the repository root to see it.
