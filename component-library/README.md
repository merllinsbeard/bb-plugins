# component-library

UI that several plugins draw the same way. A plugin imports it from here
rather than keeping its own copy in `components/ui/`, so a fix lands in every
plugin at once and the plugins cannot drift apart.

Something belongs here once two plugins draw it the same way. Each entry is a
directory holding the component, its tests, and a story for each of its
states, and has a section below saying what it is for, where it goes, and
what not to do with it.

| Entry | Import | What it is |
| --- | --- | --- |
| [Sync status](#sync-status) | `@danielbachhuber/bb-plugin-component-library/sync-status` | How long ago a page last synced, and a Refresh button, for the page's title bar, with what the past hour of syncs cost on GitHub behind the label |
| [Sidebar count](#sidebar-count) | `@danielbachhuber/bb-plugin-component-library/sidebar-count` | The counts beside a page's name in bb's sidebar: urgent rows in a red circle, optionally rows due soon in amber beside it as one pill, then the total; or rows past a warning in amber and past an error in red |
| [Nav badge](#nav-badge) | `@danielbachhuber/bb-plugin-component-library/nav-badge` | The badge on a page's icon in bb's navigation: urgent rows as a red count, or else rows due soon as an amber one, in the same red as Sidebar count |
| [Segmented](#segmented) | `@danielbachhuber/bb-plugin-component-library/segmented` | A row of choices, one always on, and a toggle form for a filter that can be off |
| [Calendar](#calendar) | `@danielbachhuber/bb-plugin-component-library/calendar` | A month grid, drawn the way bb draws one, for picking a day or a range |
| [Date range](#date-range) | `@danielbachhuber/bb-plugin-component-library/date-range` | A button that opens two months of calendar to pick a span of days |
| [Top bar](#top-bar) | `@danielbachhuber/bb-plugin-component-library/top-bar` | A page's counts as a button in bb's top bar on every page, and the slot that puts it there, at the top left just after the sidebar toggle |
| [Start thread](#start-thread) | `@danielbachhuber/bb-plugin-component-library/start-thread` | bb's new-thread composer under a row or in a dialog, with the plugin's suggested skills as chips, and the toast that links to the thread once it starts |
| [Thread status](#thread-status) | `@danielbachhuber/bb-plugin-component-library/thread-status` | A row whose item has a thread: an orange edge, Open thread, and a line under the actions with what the thread is doing, read live from bb's sidebar |
| [Last value](#last-value) | `@danielbachhuber/bb-plugin-component-library/last-value` | State that opens on the value the page last read from its server, kept in `localStorage`, so a page draws its list at once instead of a loading screen |

`sweep-ui`, the list the three sweeps draw, is a separate package because only
the sweeps use it.

## Installing

It is published to npm as `@danielbachhuber/bb-plugin-component-library`, and
a plugin depends on it as `"@danielbachhuber/bb-plugin-component-library":
"^1.0.0"`. In this checkout npm links the local `component-library/`
directory, since it is a workspace whose version fits that range, so an edit
here reaches every plugin without publishing.

The published copy is what a marketplace install gets. bb installs a plugin
from git with `npm install --prefix <plugin dir> --omit=dev` and builds it
from source, so nothing is installed beside a `file:../` sibling, and its
imports of Hugeicons fail to resolve. A copy npm installs from the registry
sits inside the plugin's own `node_modules`, where they resolve.

So a plugin release that needs a change made here needs that change published
first. To find out whether it does, run this at the root:

```sh
node scripts/check-component-library.mjs <plugin>   # or no id, for every plugin
```

It prints `STOP` for a plugin that imports an entry the published version
does not export, or one whose files here differ from the published tarball.
The `publish-plugin-update` skill runs it before bumping a plugin's version.
To publish:

```sh
cd component-library
npm version minor --no-git-tag-version   # patch, when no entry was added
npm publish
```

Raise the range in each plugin that needs the new version, run `npm install`
at the root, and commit. Then run
`node scripts/check-installable.mjs <plugin>` at the root, which installs the
plugin from the last commit the way bb does.

React, `react-dom`, the Hugeicons packages, `clsx`, and `tailwind-merge` are
peer dependencies, so the library uses the plugin's copy and React stays
single. bb provides React, `clsx`, and `tailwind-merge` at runtime; the plugin
lists the Hugeicons packages in its own dependencies.

`react-day-picker` is an optional peer, for the calendar. npm does not install
an optional peer, so a plugin that imports neither [Calendar](#calendar) nor
[Date range](#date-range) leaves it out of its lockfile. A plugin that imports
either one lists `react-day-picker` in its own dependencies.

`@get-bb/plugin-sdk` and `sonner` are optional peers too, for
[Start thread](#start-thread) and [Thread status](#thread-status). bb provides
both at runtime.

The package uses relative imports only, since `@/` means the plugin's own
directory once it is installed there. For the same reason it cannot use a
plugin's vendored `Button` or `Icon`, and `@get-bb/plugin-sdk/app` exports
neither, so an entry draws them itself with the same classes and Hugeicons
glyphs.

`bb.pluginTailwindContent` in `package.json` lists the components for
Tailwind. `bb plugin build` generates only the classes it finds in the plugin
and in dependencies that list files this way. A `bb` block with no `name` does
not make this a plugin: `sync.sh` and `setup.sh` look for `bb.name`.

An edit here does nothing in bb until every plugin that uses it is rebuilt.
`./sync.sh` at the repository root does that, since it counts this package as
part of the source of every plugin that depends on it.

## Sync status

```tsx
import { SyncStatus } from "@danielbachhuber/bb-plugin-component-library/sync-status";

<SyncStatus syncedAt={listing?.syncedAt ?? null} busy={busy} onRefresh={refresh} />
```

It answers "is this page current?", so it shows how long ago the last sync
landed ("synced 4m ago") rather than a clock time, which would leave the
reader to do the subtraction.

**Where it goes.** The right end of the page's title bar, through the
route's `headerContent` slot. Each plugin keeps a small `SyncHeader` in its
`app.tsx` that subscribes to its own listing, calls its own refresh RPC,
shows a failure with `toast.error`, and passes the result in. That wiring
stays in the plugin because the RPC and realtime channel differ per plugin.
Now, PR Sweep, Issue Sweep, Review Sweep, and Contributor Dashboard use it.

**What it draws.** A small muted label, then an outline Refresh button:

| State | Label | Button |
| --- | --- | --- |
| No sync has finished | not synced yet | Refresh |
| Under a minute | synced just now | Refresh |
| Under an hour | synced 4m ago | Refresh |
| Under a day | synced 3h ago | Refresh |
| A day or more | synced 2d ago | Refresh |
| A refresh is running | unchanged | Refreshing…, disabled |

The label is lowercase because it sits mid-header. It re-reads the clock
every 30 seconds, so it ages between syncs instead of sitting on "just now"
until the next one.

**What the syncs cost.** Given `usage`, the label becomes a button that opens
a summary under it, kept inside the window: the GitHub points the past hour of
syncs used, one bar per sync placed at the time it ran (hover one for its
points, calls, and time), and how many points the account has left before the
hour resets. A sync that could not be measured draws as a faint stub and is
left out of the total, which says how many it left out. A plugin calling
several services, as Now does, gives each sync its calls by service and lists
the calls made between syncs; the summary then counts calls rather than
points, stacks each bar by service with a legend of the hour's totals, and
keeps GitHub's points beside GitHub's calls. Without `usage`, the label stays
plain text. The shape is what `createSyncUsage` in `gh-shared` reports,
repeated here as `SyncUsage` because this package cannot depend on gh-shared.
PR Sweep, Issue Sweep, Review Sweep, and Now pass it.

**Props.** `syncedAt` is the last sync's time in milliseconds, or null.
`busy` disables the button. `onRefresh` starts a refresh. `usage` is the past
hour's syncs and the account's budget. `now` pins the clock, and
`defaultOpen` and `initialHovered` draw the summary open; all three are for
stories and tests only. `syncedAgo(syncedAt, now)` is exported too.

**Don't** show an absolute time, put the control in the page body, call the
button anything but Refresh, or write another formatter for the same label.

## Sidebar count

```tsx
import { SidebarCount } from "@danielbachhuber/bb-plugin-component-library/sidebar-count";

<SidebarCount urgent={2} total={5} urgentLabel="2 need you" totalLabel="5 to review" />
```

It answers "how much is on me here?" from the sidebar, without opening the
page. Pass it to the route as `experimental_sidebarAccessory`, in a small
component that reads the same listing as the page, so completing or archiving
a row lowers the count at once.

**What it draws.** The rows that need you most in a red circle, then every
row in muted text. The circle is left out at zero, and nothing is drawn at a
total of zero. Each number has a tooltip naming what it counts, such as
"2 need you" and "5 to review".

A page that also knows what needs you soon passes `soon` and `soonLabel`,
and that count goes in an amber circle before the total. When both counts
are above zero, the red and amber join into one pill, red then amber, so
they read as one group. Count a row in one of them only. Now passes the
tasks due today.

**Lining up.** bb centers a lone count in a box at least 20px wide, so the
total keeps that box. A row with a circle and a row without one then have
their totals in the same column. A page with nothing urgent still draws its
total through this component, with `urgent={0}`, for that reason.

bb 0.47 and later ignore `experimental_sidebarAccessory`, so in the sidebar
use a [Nav badge](#nav-badge). Tokenomics draws `SidebarLevels`.

## Nav badge

```tsx
import { navBadgeRedContentScript, needsYouBadge } from "@danielbachhuber/bb-plugin-component-library/nav-badge";

app.contentScripts.register(navBadgeRedContentScript);
app.slots.navPanel({
  // ...
  experimental_useBadge: () => needsYouBadge({ urgent, urgentLabel: `${urgent} urgent`, soon, soonLabel: `${soon} due today` }),
});
```

It answers "does this page need me?" from bb's navigation, on the icon in
the rail and beside the name in the sidebar list. bb draws the badge;
`experimental_useBadge` is a hook that returns what to draw, so it can read
the same listing as the page. That field needs `@get-bb/plugin-sdk` 0.6.53
or later, and a host that old, in `engines.bbPluginSdk`.

**What it draws.** `needsYouBadge` gives the urgent count in red, or, when
nothing is urgent, the due-soon count in amber, or nothing. The total is
left out, so a badge always means something to do. bb shows a count over 9
as "9+" on the rail and over 99 as "99+" in the list. The label, which bb puts in the
tooltip and the accessible name, names both counts when both are above zero.

**The red.** bb draws a critical badge in its own darker red.
`navBadgeRedContentScript` adds a style rule to the document's head that
draws it in Tailwind's red-600 instead, the red Sidebar count and the pages
use. bb marks the badge with `data-nav-badge-tone` but not with the page it
belongs to, so every red badge in bb's navigation changes, bb's own
included.

Now, PR Sweep, and Review Sweep use it.

**Don't** draw a bare number in a `<span>`, which drifts out of line with
the rows around it, or count rows the page would not show.

**Warnings and errors.** A page whose total means nothing, such as
Tokenomics, where every thread counts, draws `SidebarLevels` instead:

```tsx
import { SidebarLevels } from "@danielbachhuber/bb-plugin-component-library/sidebar-count";

<SidebarLevels warning={3} error={1} warningLabel="3 past the warning" errorLabel="1 past the limit" />
```

Rows past the warning go in an amber circle, then rows past the error in a
red one, the same red as `SidebarCount`'s urgent circle. A row counts in one
circle only, the higher. Each circle is left out at zero, and nothing is
drawn when both are. Tokenomics uses it.

## Segmented

```tsx
import { Segmented, SegmentedToggle } from "@danielbachhuber/bb-plugin-component-library/segmented";

<Segmented label="Period" options={periods} value={period} onChange={setPeriod} />
<SegmentedToggle label="Source" options={sources} value={source} onChange={setSource} />
```

A row of a few short choices in one bordered group, drawn like bb's own
segmented controls.

**Which one.** `Segmented` is for a choice that always has an answer, such as
the period a page charts. It is a `radiogroup`, and one option is always on.
`SegmentedToggle` is for a filter that can also be off: pressing an option
shows only it, and pressing it again passes `null` and shows everything. It is
a group of `aria-pressed` buttons.

**Options.** Each has an `id` and a `label`, an optional `count` drawn muted
after the label, and an optional `title` for a tooltip that says what the
option holds. `label` names the whole group for assistive technology.

Now, Tokenomics, and Contributor Dashboard use it.

**Don't** use it for more than about five options, or for options whose
labels need more than a word or two. A select fits those better.

## Calendar

```tsx
import { Calendar } from "@danielbachhuber/bb-plugin-component-library/calendar";

<Calendar mode="range" numberOfMonths={2} selected={range} onSelect={setRange} />
```

A month grid over `react-day-picker`, with bb's own class names so it looks
like the calendar in bb rather than like a plugin's own. bb's copy lives in
`packages/shared-ui` in the bb repository, which is private to it, and the
plugin SDK exports no calendar, so this is the nearest a plugin can get.

**Props** are react-day-picker's: `mode`, `selected`, `onSelect`,
`numberOfMonths`, `disabled`, `defaultMonth`. It takes the component's whole
API rather than wrapping a smaller one, because what a page needs from a
calendar varies more than a wrapper could guess.

**Don't** reach for it directly to pick a span of days: [Date
range](#date-range) already draws the button, the panel, and Apply around it.

## Date range

```tsx
import { DateRange, type DayRange } from "@danielbachhuber/bb-plugin-component-library/date-range";

<DateRange value={range} onChange={setRange} earliest={twoYearsAgo} latest={Date.now()} />
```

A button that reads `Sep 19 to Oct 9`, or a placeholder when nothing is
picked, opening two months of calendar with Cancel and Apply. It closes on
Escape, on a click outside, and on Apply. `earliest` and `latest` grey out the
days there is nothing to show for.

**Whole days.** `value` and `onChange` use `{ from, to }` in epoch
milliseconds, where `from` is midnight on the first day and `to` is midnight
on the day after the last. A caller can hand `to` straight to a range query
without adding a day to it, and the button still names the last day someone
actually chose. `dayRangeLabel` is exported for a caller that wants the same
wording elsewhere.

Contributor Dashboard uses it, beside the presets rather than instead of them.

**Don't** use it as the only way to choose a span. Picking two dates is slower
than pressing a button, so offer the spans people ask for most as presets and
keep this for the rest.

## Day menu

```tsx
import { DayMenu, describeDay } from "@danielbachhuber/bb-plugin-component-library/day-menu";

<PopoverContent align="start" className="w-72 p-1">
  <DayMenu
    heading="Snooze until"
    choices={[{ label: "Tomorrow", day: "2026-10-17" }]}
    describe={(day) => describeDay(day, now)}
    check={(day) => (day > today ? null : "Too early")}
    onPick={snoozeUntil}
    now={now}
    menuLabel="Snooze until"
    inputLabel="Snooze until a day"
  />
</PopoverContent>
```

What goes inside a "pick a later day" popover, as Now's Postpone first drew
it: a line saying what moves, a few quick days each with the day in words
beside it, a box for a day typed in words ("fri", "next mon", "oct 8", "in 3
days", "9/30", "2026-09-30") that says which day it read or why it cannot
use it, and an optional note under a rule. Enter in the box picks the typed
day. Days are `YYYY-MM-DD` strings throughout.

**The popover stays in the plugin.** bb's popover is vendored into each
plugin, so the plugin draws its own button and `PopoverContent` and puts
`DayMenu` inside. Radix unmounts the content when it closes, so the box is
empty each time it opens.

**The parser is separate.** `@danielbachhuber/bb-plugin-component-library/parse-day`
exports `parseDay`, `describeDay` ("Tomorrow", "Friday", "Oct 24"),
`localDay`, `addDaysTo`, and `nextMonday`, with no React, so a server or a
CLI can read a typed day the same way. `day-menu` re-exports them.

Now's Postpone and Review Sweep's Snooze use it.

## Top bar

```tsx
import { TopBarCount, TopBarSlot } from "@danielbachhuber/bb-plugin-component-library/top-bar";

<TopBarSlot pluginId="now" order={0} activeOn={["/plugins/now/now"]}>
  <TopBarCount icon={<Icon name="Target" />} label="Open Now" onClick={open}
    urgent={2} soon={3} total={9} urgentLabel="2 urgent" soonLabel="3 due today" totalLabel="9 in Now" />
</TopBarSlot>
```

It answers "how much is on me there?" from whatever page is open, and gets
you to that page in one click. Mount it from a component registered with
`experimental_appOverlay`, which reads the same listing as the page's
sidebar count. That slot needs `@get-bb/plugin-sdk` 0.5.9 or later.

**What it draws.** `TopBarCount` is a borderless button, like bb's other
header buttons, holding the page's icon and then exactly what [Sidebar
count](#sidebar-count) draws: urgent in red, due soon in amber, joined into
one pill when both show, then the total.
At a total of zero only the icon shows, so the way to the page stays. On
the page it opens, the button is shaded and marked `aria-current="page"`,
the way bb marks the open page in its own navigation.

**Where it goes.** bb has no plugin slot in its top bar, so `TopBarSlot`
finds a place in the page instead: in the desktop app's title bar
(`[data-testid="app-window-title-bar"]`), just after the sidebar toggle
(`[data-sidebar="trigger"]`). In a browser, which has no title bar, it goes
at the start of the page header's row
(`[data-testid="app-page-header-content-row"]`), before the page title; a
split thread has two header rows, and it takes the first, the leftmost
pane's. On a page with neither, such as the new-thread page in a browser, it
goes just before the right-panel toggle, found by its "Show right panel" or
"Hide right panel" label, or else at the start of the header's buttons
(`[data-app-page-header-actions]`). Several plugins' slots line up side by side, lowest `order` on the
left and plugin id breaking a tie; each works the order out the same way, so
they settle rather than moving past each other. It watches the document so
it follows bb from page to page, and tells the button it is current under a
path in `activeOn`. If a bb
update changes all four, it draws nothing rather than throwing.

`pluginId` matters beyond naming the element: bb scopes a plugin's
stylesheet to elements under `data-bb-plugin="<id>"`, and the slot sits in
bb's own header, outside the plugin's root. Without it the pill's colors are
missing.

**Aligning to the sidebar's edge.** With `alignEnd`, the slot moves to the
right edge of the sidebar column (`[data-sidebar="gap"]`), 8px in, while the
sidebar is open, and stays beside the toggle when the sidebar is closed and
only the rail is left. A ResizeObserver on the column and the slot keeps it
there as the sidebar is dragged wider, and the slot aligns again each time
it moves. Only the desktop title bar does this; in a browser the slot stays
where it goes.

Inside the slot, `useTopBarRoom()` gives the pixels from where the slot
starts beside the toggle to that edge, so a button can draw a narrower form
when the sidebar is too narrow for its full one. The number does not change
with the slot's own width, so drawing less does not flip it back. It is
negative with the sidebar closed, and null outside the desktop title bar.
Tokenomics drops its spark chart and keeps the rings below 120px.

bb's title bar takes no pointer events except around its own buttons, so
the slot turns them back on for itself.

Tokenomics uses the slot with `alignEnd`, with its own button through
`TopBarButton`.
No plugin uses `TopBarCount`. A page's counts go in a [Nav badge](#nav-badge)
instead, since several chips in the title bar run past the sidebar's edge and
over the page title.

**Don't** put more than one button in the slot, or anything wider than the
counts. The top bar holds a thread's own controls, and every plugin that
adds a chip takes room from them.

## Start thread

```tsx
import { useStartThreadBox } from "@danielbachhuber/bb-plugin-component-library/start-thread";

const box = useStartThreadBox({
  navigate,
  submit: async (draft, request) => {
    const { threadId, error } = await rpc.call("start", { id: draft.key, request });
    return { threadId, error };
  },
  announcement: (draft) => `Started a thread for ${draft.key}`,
});

// The row's Start thread button:
onClick={() => box.toggle({ key, seed })}
// Under the row's action line:
{box.boxFor(key)}
{box.isStarting(key) ? <StartingThreadLine title={title} /> : null}
```

It is how a plugin starts a thread about one row: a pull request, an issue, a
task, a plugin. It holds bb's own `experimental_NewThreadComposer`, so
@-mentions, attachments, and the provider, project, environment, branch and
permission pickers are bb's. The plugin supplies a seed and passes the
resolved `NewThreadRequest` on to `threads.spawn`.

**Where it opens.** `StartThreadInline` draws it in a box under the row, where
sweep-ui's Add note opens its editor, so the list stays in view. The row's
Start thread button opens it, stays pressed (`aria-expanded`) while it is
open, and closes it. sweep-ui's `SweepList` draws it from
`renderStartThread`. `StartThreadDialog` draws the same thing in a dialog,
under a card naming the row (`seed.preview`), for a page without rows to open
it under. `StartThreadForm` is the contents of either.

**Suggested skills.** `seed.skills` lists the skills the plugin suggests, each
with a `reason` shown on hover and an `instruction`, the line it puts in the
prompt. They are drawn as chips above the composer, and the ones marked
`selected` start picked. The prompt holds only the picked instructions, in the
order the plugin listed them. bb's composer cannot have text inserted once it
is open and will not submit an empty prompt, so a chip remounts it seeded with
the new instructions, and anything typed before is dropped. Without `skills`,
the composer is seeded with `seed.prompt`.

**The rest of the seed.** Whichever of `projectId`, `providerId`, `model`,
`permissionMode` and `environment` the plugin has an opinion on. With
`seed.workspace.branch`, a banner names the branch the thread runs on and the
composer's project, environment and branch pickers are hidden, which needs
`FIXED_ENVIRONMENT_CSS` on the page from a content script. The draft is saved
per row and per seeded prompt, so an edit survives reopening the same row
with the same chips and is dropped once the plugin seeds something different.

**While it starts.** `useStartThreadBox` holds which row's box is open and
which rows' threads are starting. Pressing Send hides the box at once, and
the row shows `OpenThreadAction disabled` and `StartingThreadLine` from
[Thread status](#thread-status) until `submit` resolves, so resolve it once
the row's own data lists the thread, such as after a reload. Where the data
arrives later, `startedThread(key)` has the id meanwhile. The box is hidden
rather than unmounted, so if no thread starts, it shows again with bb's
composer having put the prompt back, and the reason at the top
(`StartThreadError`).
Two surfaces that draw the same rows, such as Now's list and its Email tab,
pass the same `scope`, so a row started from either says Starting in both.
Each keeps its own box.

**After it starts.** The hook calls `announceStartedThread` rather than
`navigate.toThread`. Every plugin leaves you on the page you started the
thread from, with a toast whose **Go to thread** button opens it. Opening a
thread that already exists, from a row's Open thread, still navigates.

**The dialog parts.** The library cannot import a plugin's vendored
`components/ui/dialog.tsx`, since `@/` means the plugin's directory, so the
plugin passes its own in to `StartThreadDialog` as `dialog`.

The three sweeps, Now, and Contributor Dashboard open it under the row.
Impromptu UI and Plugin Shelf use the dialog. New issue, Presentations, and Weekly Review use only the
toast.

**Don't** put the row's identity in the editable prompt instead of the card.
Editing it could only break the link between the thread and its row.

## Thread status

How a row looks once its item has a thread, the same in Now, the three
sweeps, and Contributor Dashboard: an orange left edge, **Open thread** first
in the action line where **Start thread** was, and a line under the actions,
set off by an orange rule, saying what the thread is doing and its title.

```tsx
const threadStatus = useThreadStatus(); // once, on the page

<li className={cn("py-3", threadId && THREAD_EDGE)}>
  …
  <OpenThreadAction onOpen={() => navigate.toThread(threadId)} />
  …
  <ThreadLine status={threadStatus(threadId)} onOpen={() => navigate.toThread(threadId)} />
</li>
```

`useThreadStatus` reads bb's sidebar, which the page already holds, so it
makes no request. The line says **Working**, **Needs you**, **Done, unread**,
**Failed, unread**, or **Idle**, as the sidebar's glyph would, and only
**Needs you** and **Failed** are bold. `THREAD_EDGE` reaches into the list's
padding the way a stale row's red edge does; `THREAD_EDGE_INSET` is for a list
drawn inside its own border. A sweep passes the line to sweep-ui's row as
`threadLine`, which draws it between the action line and the note.

Hovering Open thread underlines its label, and hovering the line underlines
the thread's title.

While the thread is being started, draw `<OpenThreadAction disabled />` and
`<StartingThreadLine title={…} />` in the same places: a spinner, **Starting**,
and the title the row is known by, such as `Let widgets export to CSV (#487)`.
[Start thread](#start-thread)'s `useStartThreadBox` says when.

Call the hook in the page and pass the lookup down, so a story can pass
fixtures instead.

**Don't** let an overdue or due-today edge give way to the orange one. They
say more.

## Last value

A page that reads a stored list from its server can draw the list it read
last time while the new read runs, so it opens on its rows rather than on a
loading screen.

```tsx
import { useLastValue } from "@danielbachhuber/bb-plugin-component-library/last-value";

const [listing, setListing] = useLastValue<Listing>("bb-plugin-pr-sweep:listing");

useEffect(() => {
  void rpc.call("listRows", null).then(setListing);
}, [rpc, setListing]);
```

It works like `useState`, except it starts from the value kept under the key,
or null when there is none, and keeps each value it is given for the next
mount. Every plugin shares one `localStorage`, so name the key for the plugin.
A value kept by another build of the page is dropped, since bb serves each
build of a plugin's frontend at a new URL. `readLastValue` and
`writeLastValue` do the same outside React.

The three sweeps use it for their listing and their Harvest state.

**Don't** keep anything private to the server here, such as a token, or a
value the page cannot draw while it is stale for a moment.

## Working on it

```sh
npm install
npx tsc --noEmit -p tsconfig.json
npm test
```

Run `npm run storybook` at the repository root to see the stories.
