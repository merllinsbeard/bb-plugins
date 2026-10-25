---
name: refine-impromptu-ui
description: Use when Impromptu UI fell short, or should have run and did not, such as "impromptu UI should have shown this", "why didn't that show above the composer", "the view can't do what I need", "file feedback on impromptu UI", or "refine impromptu UI"; and when the user asks to scan recent or active threads for moments where Impromptu UI could have run or a better view would have helped. Run in a thread doing other work, it starts a new thread for the refinement. Finds the missed moments, shows a view in threads still waiting on the user, and turns the rest into a change to the plugin, its guide, or the skill that should have published, filing an anonymized issue on danielbachhuber/bb-plugins where the plugin needs to change.
---

# Refine Impromptu UI

Impromptu UI falls short in three ways: a thread wrote its results into chat
when a view would have let the user act on them, a view went up but could not
do what the work needed, or a view went up when a different one would have
done the job better. This skill finds those moments, fixes the ones the user
is still waiting on, and turns the rest into a change that stops them
happening again.

There are three ways in:

- **In a thread doing other work.** The user says Impromptu UI should have
  run here, or that a view here fell short. Go to "Hand it off": the
  refinement runs in a new thread, so it stays out of this one.
- **One thread.** This thread was started to refine one thread, by a hand-off
  or by the user naming it. Go to "One thread".
- **A scan.** The user asks to look across recent or active threads. Go to
  "A scan". Run it in a thread of its own: the subagents' reports fill the
  context, and the scan skips the thread it runs in.

"One thread" and "A scan" end in "Choose the fix".

## Hand it off

Do two things here, then stop.

**Show the view, if the moment is still open.** If the user has not yet acted
on the output that should have been a view, build that view now, following
the `impromptu-ui` skill. That is this thread's own work, and the user's
decision is waiting on it. Skip this when the moment has passed or the
problem is a view that broke.

**Start the refinement thread.** Find the message the problem is about: the
reply that should have been a view, or the one that published the view that
fell short.

Usually it is your last reply before the user's complaint. List your recent
replies' sequence numbers, newest last, and check one with `--message`:

```bash
bb thread log --self --json --all | jq -r '[.[] | select(.type=="item/completed" and .data.item.type=="agentMessage")] | .[-5:][] | .seq'
bb thread log --self --message <seq>
bb thread show --self --json | jq '.thread | {providerId, projectId}'
```

Write the prompt to a file. It names this thread and the message, and says
in a sentence or two what the user said went wrong, in their words where you
can:

```
Use the refine-impromptu-ui skill to refine one thread: @thread:<this thread's id>#msg=<seq>.
What happened: <what the reply held, and what the user did or said about it>.
```

```bash
bb thread spawn --project <project> --provider <this thread's providerId> \
  --title "Refine Impromptu UI: <the kind of work, in a few words>" \
  --prompt-file /tmp/refine-impromptu-ui/handoff.md
```

For `--project`, use the project whose checkout holds this plugin if
`bb project list` has one, since a guide edit happens there; otherwise this
thread's project. Do not pass `--parent-self`: the refinement is not part of
this thread's work.

In chat, say in one line that the refinement is running in
`@thread:<new id>`, and go back to the work this thread was doing.

## One thread

### 1. Work out what went wrong

Read the thread and the message the prompt names, with the messages around
it:

```bash
bb thread log <id> --message <seq> --context 5
```

Read the whole thread with `--format minimal --all` if that is not enough to
see the task. Check whether it published a view, and what the user did with
it:

```bash
BB_THREAD_ID=<id> bb impromptu-ui list
BB_THREAD_ID=<id> bb impromptu-ui state --key <name>
```

Place the problem in one of these:

| What happened | Example |
|---|---|
| **Did not fire** | Results that the user acted on one by one went into chat as a numbered list, because the skill's description did not match the task. |
| **Could not express it** | A view went up, but the work needed something it has no field for: a button type, a layout, a way to group or sort items. |
| **Worked badly** | A view went up and did the job, but something about it got in the way: too much text on a row, the side panel opening at the wrong time, a button that did the wrong thing. |
| **Broke** | An error from `publish`, a view that did not render, a button that failed. |

If what the user said leaves more than one of these possible, ask one
question to settle it, and offer your best guess as the first answer. Do not
ask about what you can see in the thread.

Then write down three answers, in plain words, before looking for a fix.
They open the view you show the user (see "Choose the fix"):

- **What you expected:** what the user would have seen if Impromptu UI had
  worked, such as "the commit question above the composer with Yes and No
  buttons, as it was the last two times".
- **What happened instead:** what they saw, with the reply's words quoted,
  such as "the reply ended on \"Should I commit them and push the Doc?\" in
  chat, with nothing above the composer".
- **Why:** the cause, in terms of what the agent knew and did, such as "the
  instructions already tell it to ask this question above the composer, and
  it had them, but it skipped the check on a quick follow-up edit". If you
  cannot tell why, say so rather than guessing.

Leave out commit hashes, event and field names, and words like "steer" from
these answers. They are for someone who saw the thread, not the code.

### 2. Look for a way that already works

If the moment is still open in that thread and no view went up for it,
offer the scan's **Show it there** button (see "A scan") as a card of its
own.

Read `skills/impromptu-ui/SKILL.md` (bb gives it to this thread as the
`impromptu-ui` skill) for the part that covers the problem. Some problems can
already be solved today, with a field you did not use, a different layout,
or a way of arranging the cards, such as one card that acts on a whole group.
Offer to republish that way. If the guide does not mention the workaround,
that is a change to the guide, and it goes on to "Choose the fix".

## A scan

### 1. Pick the threads

The user may name the range: "active threads", "the last 3 days". Without
one, take the threads updated in the last 2 days.

```bash
bb thread list --json
```

Keep the threads whose `updatedAt` falls in the range, or whose `status` is
`active` or `idle` for "active threads". Leave out this thread
(`$BB_THREAD_ID`). `bb thread list` already leaves out hidden and archived
threads. If more than 40 remain, say how many and ask whether to read them
all or only the 40 most recent, with the 40 as the first answer.

### 2. Read them in parallel

Split the threads into batches of about 8. In one message, dispatch one
subagent per batch with the prompt in `references/scan-prompt.md`, filling in
the thread ids with each one's title and status. Keep the transcripts out of
your own context. Each subagent returns a list of moments in JSON.

### 3. Sort the moments

Each moment is one of:

- **Open**: the thread is idle, its last reply is the missed moment, and the
  user has not answered it. The subagent marks these `"open": true`.
- **Passed**: the user has already answered, so the moment is evidence for a
  fix.

Group the passed moments by cause: the same skill that never publishes, the
same field the view did not have, the same layout chosen when another fit
better. A cause seen in several threads outranks one seen once. Drop a moment
whose only problem has nothing to do with Impromptu UI.

Group by root cause, not by symptom. Two causes are one when they describe
the same failure from two sides, such as a question left in chat at the end
of a turn and a question left in chat beside a view, or when their fixes
would edit the same paragraph. Merge them into one card with one edit per
file. Two cards that change the same file conflict when both are applied.

Read `skills/impromptu-ui/SKILL.md` and `bb impromptu-ui schema` before
deciding a cause is a missing feature. A view that left out a field the
schema has is a guide problem, not a plugin one.

Check whether a cause is already fixed. Find the file its fix would change
(see "Choose the fix") and its last commits:

```bash
git -C <checkout> log --since="<days> days ago" --format='%h %cI %s' -- <file>
```

Split the cause's moments into those before and after a commit that already
addresses it. A cause whose moments all came before the fix is not a card;
mention it in one line of the chat reply. Otherwise count only the moments
after it, and say so on the card.

Moments after such a commit mean agents read the rule and did not follow it.
More wording in the same place rarely changes that. Say so on the card:
"The instructions already say this; 4 threads since 5a70459 did it anyway."
Then propose a fix that does not rely on the agent remembering the rule:

- a check that runs without the agent, such as the plugin noticing a turn
  that ends on a question with no view published, which is a plugin change
  and gets an issue;
- a skill whose steps make the view the step itself, not a reminder at the
  end;
- a rule moved to where the agent is when it goes wrong, such as the step
  that writes the reply, rather than a general section read at the start.

Offer a wording change only as a second button, and say why it might work
where the last one did not.

Pick the place for each cause yourself, then draft the exact edit: the
current text of the paragraph or step it changes, and the text you propose.
For an issue, the edit is the change to the view file or panel in a sentence
or an example view. A card the user cannot judge without opening the file is
not finished.

### 4. Show the results

Publish one view under the key `refine-impromptu-ui-scan`, with two sections.

**Waiting on you**: one card per open moment, titled with the thread's title.
Before writing it, check the moment is still live: look in `bb thread list`
for a later thread on the same subject, and in the git log of the thread's
checkout for a commit that did what the reply asked about. Then fill in:

- **Badges**: how long it has waited, from the thread's `updatedAt`, such as
  "2 days". Add `{ "label": "Maybe settled", "tone": "warning" }` when a later
  thread or commit looks like it answered the reply.
- **Summary**: `@thread:<id>`, then what the reply holds, such as "6 pull
  requests, each needing approve or skip", then **The view it would
  publish**: the subagent's `betterView` in a sentence, such as "one card per
  PR with Approve and Skip". When it may be settled, say by what, linking the
  thread or naming the commit.
- **Details**: the reply's last sentence, verbatim, from `agentWrote`.

Give it a command button:

```json
{ "type": "command", "label": "Show it there", "primary": true, "doneLabel": "Asked",
  "command": "bb thread tell <thread id> 'Your last reply ended on <what it holds>, and the user has not answered yet. Publish it as an Impromptu UI view (the impromptu-ui skill covers how), then stop.'" }
```

Fill in `<what it holds>` in plain words, with no quote from the reply and no
apostrophe, since the message is in single quotes.
Nothing is sent until the user presses the button. Pressing it is what allows
this thread to message the other one.

**Ways to fix it**: one card per cause, most threads first. Show at most 5;
put the rest in a third section, **Smaller**, in the same shape. Each card
answers what goes wrong, how often, and what will change, so the user can
decide without opening a thread:

```json
{
  "id": "pick-lists",
  "title": "Show a list to pick from as cards, even when no question is asked",
  "badges": [{ "label": "Guide", "tone": "info" }, { "label": "5 threads" }],
  "summary": "**What happens now:** The agent ends on a list of suggestions with no question, so the instructions do not read it as a decision. The user quotes an item back to act on it.\n\n> Agent: a list of 5 suggested doc changes. User typed: \"Draft those suggested changes\"\n\n**Seen in:** 5 threads in the last 2 days.\n\n**The fix:** Say in the instructions every thread gets that a list the user will pick from is a view, question or not.",
  "changesLabel": "The edit",
  "proposedLabel": "Proposed wording",
  "changes": [{ "label": "view/instructions.ts", "before": "<the paragraph now>", "after": "<the paragraph with the edit>", "role": "proposed" }],
  "details": "**Threads**\n\n- @thread:<id>: <the kind of work>; <what the user typed>.",
  "actions": [
    { "type": "message", "label": "Make this edit", "primary": true, "text": "Make the edit for \"<card title>\" as shown in its card." },
    { "type": "message", "label": "File an issue instead", "text": "File an issue for \"<card title>\" instead of editing." }
  ]
}
```

- **Title**: the change, in plain words, not the problem.
- **What happens now**: the problem in two or three plain sentences, with no
  file names.
- **The example**: one real moment, from the `agentWrote` and `userTyped` the
  subagents returned. Never write an example yourself. If no moment has a
  clear one, describe the moment instead, and do not set it out as a quote.
- **Seen in**: the thread count, and how many came before a fix that already
  landed.
- **The fix**: one sentence.
- **The edit**: the current and proposed text, as a proposed change labeled
  with the file. For an issue, put the invented example view or a sentence
  here instead.
- **Details**: each thread as `@thread:<id>` with the kind of work and what
  the user typed.
- **Buttons**: one main button for the place you picked: "Make this edit" for
  a guide or skill change, "File an issue" for a plugin change. Add "File an
  issue instead" to an edit only when the edit lands somewhere the user does
  not own.

In chat, say only how many threads were read, how many moments are waiting,
how many fixes there are, and any cause left out because a fix already
landed, and point to the view. Do not repeat the cards. When a button sends
you work, do it, then publish the view again under the same key with every
card still in it, marking each finished card `"complete": true` with a badge
naming the commit or issue.

## Choose the fix

Each problem changes one of four places. Name the place before drafting
anything.

| Place | When | What to do |
|---|---|---|
| **Another skill** | The thread ran a skill whose own steps end in a list or a question in chat, so the agent followed the skill instead of publishing. | Edit that skill: see "Editing another skill". |
| **The guide** | No skill was involved, or the agent published but chose the wrong layout or missed a field the schema has. Includes the guide's description not matching the task. | Edit `skills/impromptu-ui/SKILL.md` in this repository, or the section every thread's instructions get, in `view/instructions.ts`, when the problem is that a thread never thought of a view; test that one with the evals (see "Testing a change to the thread instructions"). If you cannot write to the plugin's checkout, file it as an issue. |
| **The view file** | The work needed a field, button type, or layout the schema does not have. | File an issue. |
| **The panel or the list** | Something already supported looks or behaves wrong, or broke. | File an issue. |

For a problem from "One thread", come up with two to four alternatives
first, each specific enough to build, drawn from different places rather
than one idea three ways. Do this even when the prompt names a likely fix:
that fix is one card, not the decision. Edit nothing until the user presses
**Do this one**. For each, say what it would change for the task at
hand, and what it costs: another field every agent has to learn, a layout
that suits only this kind of work, a change in behavior that existing views
rely on. Show them as a view under the key `refine-impromptu-ui`, so it does
not replace the view the user is still working in, in one section titled
**Ways to change it**, with `"dismissLabel": "Not this"`. Give each card one
button, `{ "type": "message", "label": "Do this one", "text": "Do the
Impromptu UI change \"<card title>\"" }`, and put your recommendation first.
Set the view's `summary` to the three answers from "Work out what went
wrong", each as its own bolded line (**What you expected**, **What happened
instead**, **Why**), so the user knows what is being fixed before reading
any option. Write each card the same way: what the user would see change,
then what it costs, without naming events, fields, or files outside the
card's `changes`.
If Impromptu UI is not available or is what broke, list them in chat instead
and ask which to do. The user may pick more than one; each filed issue links
the others among its alternatives.

After an edit, to another skill or the guide, publish the
`refine-impromptu-ui` view again with the diff in the picked card's
`changes`, and mark it `"complete": true`. If the repository's rules let you
commit when asked, ask whether to commit and push as an inline question under
its own key, `refine-impromptu-ui-commit`, not as a button on the card: the
card's buttons stay disabled once **Do this one** went through. End the turn
there. Do not ask about committing in chat.

### Testing a change to the thread instructions

A change to `view/instructions.ts` goes through the plugin's evals, in
`evals/`, before and after the edit. They need the plugin's checkout and the
`claude` CLI. Without either, say so on the card and skip this.

1. Add the missed moment to `evals/cases.ts`: the request, the reply's
   ending, the view it should have published, and the options that view
   must offer. Prefer a task case, a small repository the agent works in,
   to a draft case. This repository is public, so write the case from
   scratch around the ending, with no names or text from the thread.
2. If the thread ran on Claude Code, find its transcript with
   `grep -rl "<a phrase from the reply>" ~/.claude/projects`, and replay it
   with `node evals/replay.ts --session <file> --cut-before "<phrase>"`.
   The transcript stays on this machine. A fresh case often passes when the
   real thread missed, so the replay is what shows whether a fix works.
3. Run the replay with the current text and with the edit
   (`--instructions-at <commit>` runs an older version), then `npm run eval`
   with the edit to catch a case it breaks. Put both on the card, such as
   "Replay: 0/6 before, 4/6 after. All 11 cases pass."
4. Offer the edit only if it does better on the replay and breaks no case.
   If no wording does, say so on the card: that points to a fix that does
   not depend on the agent remembering a rule, such as the plugin checking
   how a turn ended.

### Editing another skill

Find where the skill comes from. A skill in `~/.claude/skills/<name>`,
`~/.agents/skills/<name>`, or a repository's `.claude/skills/` is a file you
can edit. A skill under `~/.bb/runtime/` is bb's copy of a plugin's skill:
find the plugin in `bb plugin list` and edit its source checkout, or file the
change on the plugin's repository if there is none.

The change is usually a step near the end that publishes a view, with the
view's shape: one card per item, the buttons each item needs, the key. Keep
it short and point to the `impromptu-ui` skill for the rest. Then show the
diff on its card, as above, and follow that repository's own rules for
committing. If the skill's repository is public, the anonymizing rules below
apply to the edit too.

## File an issue

### 1. Check for an existing issue

```bash
gh issue list -R danielbachhuber/bb-plugins --state all --search "<keywords>" --limit 10
```

Try two or three phrasings of the change itself, such as "select several
cards" and "bulk action", with and without "impromptu". If an open issue asks
for the same change, offer to add this use case to it as a comment instead of
filing a new one. If a closed one does, read why it was closed before going
on.

### 2. Draft it, anonymized

Write the draft to a markdown file and show it to the user. Nothing is posted
until they confirm.

**Anonymize everything.** The issue is public, and it should read the same
whoever filed it:

- No repository, organization, project, board, team, or person names. Use
  `acme/widgets`, `acme/gadgets`, `octocat`, `hubber`, or `Acme Board`.
- No thread ids, file paths under a home directory, internal URLs, or email
  addresses.
- No text copied from a thread, the user's files, or their issues and pull
  requests. Describe the work in general terms: "a skill that triages the
  open issues in a milestone", not the issues themselves. A count or a kind
  of thing, such as "six patch-level bumps" or "seen in 4 threads", is fine;
  a title, number, or quote is not.
- An example view file is useful, but write its titles, summaries, and
  numbers from scratch. Swapping the names in a real one and lightly
  rewording it still identifies it.

**Shape.** No headings. A title that states the change, such as "Let a
`command` button take the draft in a card view". Then:

1. A paragraph on the kind of work and what Impromptu UI did with it. From a
   scan, say how many threads showed it.
2. A paragraph on what would have helped, followed by an invented example
   view file or a sketch of the screen if it makes the change clearer.
3. The other alternatives considered, a line each, then why this one. If you
   recommended a different one, say which and why.
4. One line: `Versions: bb <x>, impromptu-ui <y>`, from `bb --version` and
   `bb plugin list | grep impromptu-ui`.
5. A `**Done is:**` list of two to four checks someone could run to see the
   change is finished.

Before showing the draft, read it once more against the anonymizing rules,
looking for anything that came from a thread rather than from you.

### 3. File it

Once the user confirms:

```bash
gh issue create -R danielbachhuber/bb-plugins \
  --title "<title>" --body-file <draft.md> --label <enhancement|bug>
```

Use `bug` for something that broke, `enhancement` for the rest. Reply with
the issue's title and a link to it, then delete the draft file. Mark the card
done by publishing the view again, and take down the alternatives view once
every pick is handled:

```bash
bb impromptu-ui hide --key refine-impromptu-ui
```

If `gh` is not installed or not signed in, give the user a link that opens
the form already filled in instead:

```
https://github.com/danielbachhuber/bb-plugins/issues/new?title=<url-encoded title>&body=<url-encoded body>&labels=<label>
```
