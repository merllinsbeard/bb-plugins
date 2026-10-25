import { viewSchema, type View } from "./schema.js";

/* Invented diffs for the Dependabot and code-review fixtures. */

const prettierManifest = `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -22,7 +22,7 @@
   "devDependencies": {
     "eslint": "^9.30.0",
-    "prettier": "3.6.1",
+    "prettier": "3.6.2",
     "typescript": "^5.8.3",
     "vitest": "^3.2.4"
`;

const prettierLockfile = `diff --git a/package-lock.json b/package-lock.json
--- a/package-lock.json
+++ b/package-lock.json
@@ -18,7 +18,7 @@
       "devDependencies": {
         "eslint": "^9.30.0",
-        "prettier": "3.6.1",
+        "prettier": "3.6.2",
         "typescript": "^5.8.3",
@@ -4410,9 +4410,9 @@
     "node_modules/prettier": {
-      "version": "3.6.1",
-      "resolved": "https://registry.npmjs.org/prettier/-/prettier-3.6.1.tgz",
-      "integrity": "sha512-5xGWRa90Sp2+x1dQtNpIpeOQpTDBs9cZDmA/qs2vDNN2i18PdapqY7CmBeyLlMuGqXJRIOPaCaVZTLNQRWUH/A==",
+      "version": "3.6.2",
+      "resolved": "https://registry.npmjs.org/prettier/-/prettier-3.6.2.tgz",
+      "integrity": "sha512-I7AIg5boAr5R0FFtJ6rCfD+LFsWHp81dolrFD8S79U9tb8Az2nGrJncnMSnys+bpQJfRUzqs9hnA81OAA3hCuQ==",
       "dev": true,
       "license": "MIT",
`;

const dateFnsManifest = `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -14,7 +14,7 @@
   "dependencies": {
     "clsx": "^2.1.1",
-    "date-fns": "^4.1.0",
+    "date-fns": "^4.2.0",
     "react": "^19.1.0",
     "react-dom": "^19.1.0",
     "zod": "^3.25.76"
`;

const dateFnsLockfile = `diff --git a/package-lock.json b/package-lock.json
--- a/package-lock.json
+++ b/package-lock.json
@@ -9,7 +9,7 @@
       "dependencies": {
         "clsx": "^2.1.1",
-        "date-fns": "^4.1.0",
+        "date-fns": "^4.2.0",
         "react": "^19.1.0",
         "react-dom": "^19.1.0",
         "zod": "^3.25.76"
@@ -2104,9 +2104,9 @@
     "node_modules/date-fns": {
-      "version": "4.1.0",
-      "resolved": "https://registry.npmjs.org/date-fns/-/date-fns-4.1.0.tgz",
-      "integrity": "sha512-Ukq0owbQXxa/U3EGtsdVBkR1w7KOQ5gIBqdH2hkvknzZPYvBxb/aa6E8L7tmjFtkwZBu3UXBbjIgPo/Ez4xaNg==",
+      "version": "4.2.0",
+      "resolved": "https://registry.npmjs.org/date-fns/-/date-fns-4.2.0.tgz",
+      "integrity": "sha512-E4KWKavANzeuusPi0jUjpuI22SURAznGkx7eZV+4i6x2A+IZxAMcajgkvuDAU1bg40+xuhW1zRdVIIM/4khuIg==",
       "license": "MIT",
       "funding": {
         "type": "github",
@@ -5871,9 +5871,9 @@
     "node_modules/zod": {
-      "version": "3.25.76",
-      "resolved": "https://registry.npmjs.org/zod/-/zod-3.25.76.tgz",
-      "integrity": "sha512-gzUt/qt81nXsFGKIFcC3YnfEAx5NkunCfnDlvuBSSFS02bcXu4Lmea0AFIUwbLWxWPx3d9p8S5QoaujKcNQxcQ==",
+      "version": "3.24.2",
+      "resolved": "https://registry.npmjs.org/zod/-/zod-3.24.2.tgz",
+      "integrity": "sha512-lY7CDW43ECgW9u1TcT3IoXHflywfVqDYze4waEz812jR/bZ8FHDsl7pFQoSZTz5N+2NqRXs8GBwnAwo3ZNxqdQ==",
       "license": "MIT",
       "funding": {
         "url": "https://github.com/sponsors/octocat"
`;

const syncHunk = `diff --git a/src/sync.ts b/src/sync.ts
--- a/src/sync.ts
+++ b/src/sync.ts
@@ -41,10 +41,10 @@ export async function syncGadgets(rows: GadgetRow[], pageSize = 50) {
   const pages = [];
-  for (let start = 0; start < rows.length; start += pageSize) {
-    pages.push(rows.slice(start, start + pageSize));
+  for (let start = 0; start + pageSize < rows.length; start += pageSize) {
+    pages.push(rows.slice(start, start + pageSize - 1));
   }
   for (const page of pages) {
     await client.upsert("gadgets", page);
   }
   return pages.length;
 }
`;

/** The fix a review suggests for `syncHunk`: the PR's loop put back. */
const syncFixHunk = `diff --git a/src/sync.ts b/src/sync.ts
--- a/src/sync.ts
+++ b/src/sync.ts
@@ -41,6 +41,6 @@ export async function syncGadgets(rows: GadgetRow[], pageSize = 50) {
   const pages = [];
-  for (let start = 0; start + pageSize < rows.length; start += pageSize) {
-    pages.push(rows.slice(start, start + pageSize - 1));
+  for (let start = 0; start < rows.length; start += pageSize) {
+    pages.push(rows.slice(start, start + pageSize));
   }
   for (const page of pages) {
`;

/** A triage-shaped view: invented repository, issues, and people. */
export const triageView: View = viewSchema.parse({
  title: "Triage: acme/widgets milestone 4.2",
  summary: "Three open issues. One is done and can close, one still needs work, one is a duplicate.",
  sections: [
    {
      title: "Ready to close",
      items: [
        {
          id: "issue-101",
          title: "#101 Export widgets as CSV",
          url: "https://github.com/acme/widgets/issues/101",
          badges: [
            { label: "Done", tone: "success" },
            { label: "enhancement", tone: "neutral" },
          ],
          summary: "Shipped in acme/widgets#140, which added the **Export** menu and its tests.",
          details: "- Ask 1, CSV export: done in #140\n- Ask 2, include archived widgets: done in #140 (`--archived` flag)",
          draft: "This is done. #140 added **Export** to the widget list, and its `--archived` flag covers archived widgets.",
          draftLabel: "Comment to post",
          actions: [
            { type: "message", label: "Post and close", text: "Post this comment on #101, then close it as completed:\n\n{draft}", primary: true },
            { type: "message", label: "Post", text: "Post this comment on #101 and leave it open:\n\n{draft}", primary: false },
            { type: "command", label: "Close only", command: "gh issue close 101 --repo acme/widgets --reason completed", primary: false },
            { type: "link", label: "Open #101", url: "https://github.com/acme/widgets/issues/101", primary: false },
          ],
        },
      ],
    },
    {
      title: "Keep open",
      items: [
        {
          id: "issue-117",
          title: "#117 Gadget sync drops the last row",
          url: "https://github.com/acme/widgets/issues/117",
          badges: [
            { label: "Still needed", tone: "warning" },
            { label: "bug", tone: "danger" },
          ],
          summary: "Still reproduces on main: `syncGadgets` stops one row early when the page size divides the total.",
          details: "",
          actions: [
            {
              type: "thread",
              label: "Fix in a new thread",
              project: "widgets",
              title: "Fix #117: gadget sync drops the last row",
              prompt: "Fix acme/widgets#117.",
              primary: true,
            },
          ],
        },
        {
          id: "issue-123",
          title: "#123 Dark mode for the dashboard",
          badges: [{ label: "Duplicate of #98", tone: "info" }],
          summary: "",
          details: "",
          actions: [],
        },
      ],
    },
  ],
});

/** A self-improve-shaped view: invented threads, projects, and findings. */
export const selfImproveView: View = viewSchema.parse({
  title: "Self-improve review",
  summary: "5 findings from 94 threads in the last 7 days, most important first.",
  sections: [
    {
      title: "Findings",
      items: [
        {
          id: "finding-1",
          title: "Link local files with absolute paths",
          badges: [
            { label: "correction overhead", tone: "warning" },
            { label: "18 threads", tone: "neutral" },
          ],
          summary:
            "A \"where is it?\" turn in most threads that wrote a draft.\n\n> Give me the full path to the PR description\n>\n> You, `Refine #412: move the export job`",
          details: "**Target:** global agent instructions\n\n**Found in:** `thr_aaa0001`, `thr_aaa0002`",
          draft:
            "In the global agent instructions, extend the drafting rule: whenever you point at a local file, write a Markdown link whose target is the absolute path, never `~/`.\n\nDone when the rule is in the file and nothing else in it contradicts it.",
          draftLabel: "Task for the new thread",
          actions: [
            { type: "thread", label: "Open thread", project: "widgets", title: "Improve: Link local files with absolute paths", prompt: "{draft}\n\nFound in: @thread:thr_aaa0001 @thread:thr_aaa0002", primary: true },
            { type: "message", label: "Discuss", text: "Before we fix finding 1, talk me through the evidence.", primary: false },
          ],
        },
        {
          id: "finding-2",
          title: "Delegate repository surveys to subagents",
          badges: [
            { label: "tokens", tone: "warning" },
            { label: "11 threads", tone: "neutral" },
          ],
          summary: "214M tokens in threads that never used a subagent.",
          details: "**Target:** global agent instructions",
          actions: [
            { type: "thread", label: "Open thread", project: "widgets", title: "Improve: Delegate repository surveys", prompt: "…", primary: true },
          ],
        },
        {
          id: "finding-3",
          title: "Stop nesting worktrees inside bb worktrees",
          badges: [
            { label: "breakage", tone: "danger" },
            { label: "4 threads", tone: "neutral" },
          ],
          summary: "Uncommitted work lost twice.",
          details: "**Target:** the resolve-merge-conflicts skill",
          actions: [
            { type: "thread", label: "Open thread", project: "gadgets", title: "Improve: Stop nesting worktrees", prompt: "…", primary: true },
          ],
        },
        {
          id: "finding-4",
          title: "One-click post, approve, merge for dependency bumps",
          badges: [
            { label: "non-chat UX", tone: "info" },
            { label: "19 threads", tone: "neutral" },
          ],
          summary: "The same three words typed once per bump.",
          details: "",
          actions: [
            { type: "thread", label: "Open thread", project: "widgets", title: "Improve: One-click dependency merges", prompt: "…", primary: true },
          ],
        },
        {
          id: "finding-5",
          title: "Say which suites the root test command skips",
          badges: [
            { label: "excess steps", tone: "info" },
            { label: "3 threads", tone: "neutral" },
          ],
          summary: "Rediscovered on every merge.",
          details: "",
          actions: [
            { type: "thread", label: "Open thread", project: "widgets", title: "Improve: Name the skipped suites", prompt: "…", primary: true },
          ],
        },
      ],
    },
  ],
});

/** A Dependabot-review-shaped view: one invented pull request, safe to merge. */
export const dependabotView: View = viewSchema.parse({
  title: "Dependabot #412: prettier",
  summary: "",
  sections: [
    {
      title: "",
      items: [
        {
          id: "pr-412",
          title: "#412 prettier 3.6.1 → 3.6.2",
          url: "https://github.com/acme/widgets/pull/412",
          badges: [
            { label: "Safe to merge", tone: "success" },
            { label: "dev-only", tone: "neutral" },
            { label: "patch", tone: "neutral" },
          ],
          summary:
            "Safe to merge: dev-only patch bump, one formatter fix for a syntax we don't use, CI green.\n\n- **Changed:** a fix for decorators in class expressions\n- **Blast radius:** `npm run format` and the lint job only\n- **CI:** 12 of 12 passing",
          details: "The diff touches `package.json` and `package-lock.json` only.",
          changesLabel: "Files changed",
          changes: [
            { label: "package.json", patch: prettierManifest },
            { label: "package-lock.json", patch: prettierLockfile },
          ],
          draft:
            "Safe to merge. Prettier is a dev dependency here, used only by `npm run format` and the lint job.\n\n- 3.6.2 fixes formatting of decorators in class expressions, which acme/widgets doesn't use\n- No output changes on this repository: `npm run format -- --check` is clean on the branch\n- CI is green, 12 of 12",
          draftLabel: "Assessment to post",
          actions: [
            {
              type: "message",
              label: "Post, approve, and merge",
              text: "Post this assessment on #412, approve the PR, and turn on auto-merge (squash):\n\n{draft}",
              primary: true,
            },
            { type: "message", label: "Post only", text: "Post this assessment on #412 and stop there:\n\n{draft}" },
            { type: "link", label: "Open #412", url: "https://github.com/acme/widgets/pull/412" },
          ],
        },
      ],
    },
  ],
});

/** The same review for a conflicted runtime bump: the rebase is the likely next step. */
export const dependabotConflictView: View = viewSchema.parse({
  title: "Dependabot #418: date-fns",
  summary: "",
  sections: [
    {
      title: "",
      items: [
        {
          id: "pr-418",
          title: "#418 date-fns 4.1.0 → 4.2.0",
          url: "https://github.com/acme/widgets/pull/418",
          badges: [
            { label: "Needs a look", tone: "warning" },
            { label: "runtime", tone: "neutral" },
            { label: "minor", tone: "neutral" },
          ],
          summary:
            "Needs a rebase first: the lockfile conflicts with main, and the diff shows an unrelated downgrade from the stale base.\n\n- **Changed:** new `formatISODuration` options, no breaking changes\n- **Blast radius:** 14 files import it, all through `lib/dates.ts`\n- **CI:** not run since the conflict",
          details: "The downgrade of `zod` in the diff comes from the stale base, not from this bump.",
          changesLabel: "Files changed",
          changes: [
            { label: "package.json", patch: dateFnsManifest },
            { label: "package-lock.json", patch: dateFnsLockfile },
          ],
          draft:
            "Safe once rebased. The bump adds options and changes nothing this repository calls.\n\n- Every import goes through `lib/dates.ts`, which uses `format` and `parseISO` only\n- The `zod` downgrade in the diff is a stale-base artifact",
          draftLabel: "Assessment to post",
          actions: [
            {
              type: "command",
              label: "Ask Dependabot to rebase",
              command: 'gh pr comment 418 --repo acme/widgets --body "@dependabot rebase"',
              primary: true,
            },
            { type: "message", label: "Post only", text: "Post this assessment on #418 and stop there:\n\n{draft}" },
            { type: "link", label: "Open #418", url: "https://github.com/acme/widgets/pull/418" },
          ],
        },
      ],
    },
  ],
});

/** A visual-review-shaped view: three invented directions for a task list's rows. */
export const reviewView: View = viewSchema.parse({
  title: "Visual review: task rows",
  summary: "",
  sections: [
    {
      title: "",
      items: [
        {
          id: "review-rows",
          title: "Task rows: 2 directions",
          badges: [{ label: "Visual review", tone: "info" }],
          summary: "The rows read as messy: a bright icon on every row, and red dates that wrap.",
          variations: [
            { label: "Original", description: "As it is now.", image: "shots/original.png" },
            { label: "A. Sections", description: "Overdue / Today headings, grey outline icons.", image: "shots/a.png" },
            { label: "B. Dates right", description: "Sections, plus one short date on the right of each title.", image: "shots/b.png" },
          ],
          actions: [{ type: "link", label: "Open the story", url: "http://localhost:61000/?story=acme--rows" }],
        },
      ],
    },
  ],
});

/** Work already built, against the placeholder it replaced: Before and After, asking whether it looks good. */
export const builtBeforeAfterView: View = viewSchema.parse({
  title: "Task rows: built",
  summary: "",
  sections: [
    {
      title: "",
      items: [
        {
          id: "rows-built",
          title: "Rows grouped under Overdue and Today",
          summary: "Built in the story, with sample tasks.",
          built: true,
          variations: [
            { label: "Before", description: "The rows as they were.", image: "shots/original.png" },
            { label: "Now", description: "Overdue and Today headings, with grey outline icons.", image: "shots/a.png" },
          ],
        },
      ],
    },
  ],
});

/** One proposed change and the screen as it is: shown as Before and After, with a choice to build it. */
export const beforeAfterView: View = viewSchema.parse({
  title: "Suggestions: task rows",
  summary: "",
  sections: [
    {
      title: "",
      items: [
        {
          id: "rows-sections",
          title: "Group the rows under Overdue and Today",
          badges: [{ label: "Small", tone: "success" }],
          summary: "Every row has a bright icon and a red date, so nothing stands out. Headings would carry the urgency instead.",
          variations: [
            { label: "Original", description: "A bright icon and a red date on every row.", image: "shots/original.png" },
            { label: "A. Sections", description: "Overdue and Today headings, with grey outline icons.", image: "shots/a.png" },
          ],
        },
      ],
    },
  ],
});

export const nowRoundView: View = viewSchema.parse({
  title: "Visual review: a summary above the Now list",
  summary: "",
  sections: [
    {
      title: "",
      items: [
        {
          id: "now-summary",
          title: "Now summary: 4 directions",
          badges: [{ label: "Visual review", tone: "info" }],
          summary: "The list has no overview: you can't see how much is urgent until you scroll.",
          variations: [
            { label: "Original", description: "As it is now: the toggles, then the rows.", image: "shots/now-0.png" },
            { label: "A. Stacked bar", description: "One thin bar split by group, with counts beneath.", image: "shots/now-1.png" },
            { label: "B. Stat tiles", description: "One tile per group: the count and a line of detail.", image: "shots/now-2.png" },
            { label: "C. By day", description: "Columns from last week through next week.", image: "shots/now-3.png" },
            { label: "D. One square per row", description: "Each row is a square, colored by group. It shrinks as you clear rows.", image: "shots/now-4.png" },
          ],
          actions: [],
        },
      ],
    },
  ],
});

type MockRow = { title: string; detail: string; date: string; overdue: boolean };

const MOCK_ROWS: MockRow[] = [
  { title: "Renew the widget license", detail: "Acme Board · octocat", date: "Sep 9", overdue: true },
  { title: "Reply to hubber about gadgets", detail: "Inbox", date: "Today 09:30", overdue: true },
  { title: "Review acme/widgets#412", detail: "acme/widgets", date: "Sep 21", overdue: false },
  { title: "Plan the gadget launch", detail: "Acme Board", date: "Sep 28", overdue: false },
];

function svgUrl(body: string, height: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="${height}" viewBox="0 0 640 ${height}" font-family="Inter, system-ui, sans-serif"><rect width="640" height="${height}" fill="#ffffff"/>${body}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function heading(y: number, text: string, red: boolean): string {
  return `<text x="24" y="${y}" font-size="11" font-weight="600" letter-spacing="1" fill="${red ? "#dc2626" : "#737373"}">${text}</text>`;
}

/** Invented screenshots for `reviewView`, drawn as SVG so no image file enters the repository. */
export const reviewImages: string[] = [
  // Original: bright filled icons, red two-line dates on the left.
  svgUrl(
    MOCK_ROWS.map((row, i) => {
      const y = 20 + i * 64;
      const colors = ["#e44332", "#ea4335", "#24292f", "#e44332"];
      const [day, time] = row.date.split(" ");
      return `<rect x="20" y="${y + 6}" width="22" height="22" rx="5" fill="${colors[i]}"/>
        <text x="54" y="${y + 16}" font-size="12" fill="${row.overdue ? "#dc2626" : "#525252"}">${day}</text>
        ${time ? `<text x="54" y="${y + 32}" font-size="12" fill="#dc2626">${time}</text>` : ""}
        <text x="128" y="${y + 18}" font-size="14" fill="#171717">${row.title}</text>
        <text x="128" y="${y + 38}" font-size="12" fill="#737373">${row.detail}</text>
        <line x1="20" y1="${y + 56}" x2="620" y2="${y + 56}" stroke="#e5e5e5"/>`;
    }).join(""),
    276,
  ),
  // A: section headings, grey outline icons, dates still on the left.
  svgUrl(
    [heading(26, "OVERDUE · 2", true), heading(174, "UPCOMING · 2", false)].join("") +
      MOCK_ROWS.map((row, i) => {
        const y = (i < 2 ? 40 : 188) + (i % 2) * 60;
        return `<rect x="24" y="${y + 6}" width="18" height="18" rx="4" fill="none" stroke="#737373" stroke-width="1.5"/>
          <text x="56" y="${y + 19}" font-size="12" fill="#525252">${row.date}</text>
          <text x="140" y="${y + 18}" font-size="14" fill="#171717">${row.title}</text>
          <text x="140" y="${y + 38}" font-size="12" fill="#737373">${row.detail}</text>`;
      }).join(""),
    316,
  ),
  // B: sections, grey icons, one short date on the right.
  svgUrl(
    [heading(26, "OVERDUE · 2", true), heading(174, "UPCOMING · 2", false)].join("") +
      MOCK_ROWS.map((row, i) => {
        const y = (i < 2 ? 40 : 188) + (i % 2) * 60;
        const short = row.date.startsWith("Today") ? "09:30" : row.date;
        return `<rect x="24" y="${y + 6}" width="18" height="18" rx="4" fill="none" stroke="#737373" stroke-width="1.5"/>
          <text x="56" y="${y + 18}" font-size="14" fill="#171717">${row.title}</text>
          <text x="56" y="${y + 38}" font-size="12" fill="#737373">${row.detail}</text>
          <text x="616" y="${y + 18}" font-size="12" text-anchor="end" fill="${row.overdue && i === 1 ? "#dc2626" : "#737373"}">${short}</text>`;
      }).join(""),
    316,
  ),
];

function staple(id: string, name: string, lastBought: string) {
  return {
    id,
    title: name,
    summary: `Last bought ${lastBought}`,
    draft: name,
    draftLabel: "Task to add",
    actions: [
      {
        type: "command",
        label: "Add",
        doneLabel: "Just added",
        command: 'td task add {draft} --project "Groceries"',
        confirm: false,
        primary: true,
      },
    ],
  };
}

/**
 * A grocery-staples-shaped view in the "list" layout: the staples to add on
 * top, each renamed if need be and added or skipped from its row, and the list
 * as it stands below.
 * Invented items and task links.
 */
export const staplesView: View = viewSchema.parse({
  title: "Grocery staples",
  summary: "Due staples that are not on the Groceries list yet.",
  layout: "list",
  dismissLabel: "Skip",
  sections: [
    {
      title: "Suggested",
      items: [
        staple("oat-milk", "Oat milk", "Mar 5"),
        staple("bananas", "Bananas", "Mar 5"),
        staple("coffee-beans", "Coffee beans", "Feb 26"),
        staple("rice", "Brown rice", "Feb 20"),
      ],
    },
    {
      title: "On Groceries",
      items: [
        { id: "task-eggs", title: "Eggs (dozen)", url: "https://app.todoist.com/app/task/eggs-1001" },
        { id: "task-bread", title: "Sourdough bread", url: "https://app.todoist.com/app/task/bread-1002" },
        { id: "task-candles", title: "Birthday candles", url: "https://app.todoist.com/app/task/candles-1003" },
      ],
    },
  ],
});

/**
 * A "list" view whose rows have no draft and a description much longer than
 * the name, with two buttons beside each. Invented vendors.
 */
export const vendorsView: View = viewSchema.parse({
  title: "Sort the vendors",
  summary: "Vendors on recent invoices that are not on either list yet.",
  layout: "list",
  dismissLabel: "Skip",
  sections: [
    {
      title: "To sort",
      items: [
        ["acme-anvils", "Acme Anvils", "Drop-forged anvils and other heavy goods, shipped by freight. Ordered from twice last quarter by octocat."],
        ["gadget-works", "Gadget Works", "Small electronics and spare parts for the widget line, with a minimum order of 50 units. hubber is the contact."],
        ["widget-wholesale", "Widget Wholesale Supply Co.", "Bulk widgets at a discount for orders over 1,000, invoiced monthly."],
      ].map(([id, title, summary]) => ({
        id,
        title,
        summary,
        actions: [
          { type: "message", label: "Keep", text: `Keep ${title}` },
          { type: "message", label: "Drop", text: `Drop ${title}` },
        ],
      })),
    },
  ],
});

/**
 * A grocery-cart-shaped view: each card offers products as buttons and a
 * one-line field for a value of the user's own. Invented store and products.
 */
export const groceryView: View = viewSchema.parse({
  title: "Acme Market cart: this week",
  summary: "Pick a product for each item on the list.",
  sections: [
    {
      title: "Confirm",
      items: [
        {
          id: "apples",
          title: "Apples",
          badges: [{ label: "Bought 6 times", tone: "info" }],
          summary: "Last three orders were **Fuji ×8**.",
          draftFormat: "text",
          draftLabel: "Something else",
          draftPlaceholder: "Fuji ×12, or another product",
          actions: [
            { type: "command", label: "Fuji ×8", command: "true", primary: true },
            { type: "command", label: "Fuji ×5", command: "true" },
            { type: "command", label: "Honeycrisp ×5", command: "true" },
            { type: "command", label: "Gala ×6", command: "true" },
            { type: "command", label: "Pink Lady ×4", command: "true" },
            { type: "message", label: "Use this", text: "For Apples, put this in the cart instead: {draft}" },
          ],
        },
      ],
    },
    {
      title: "Questions",
      items: [
        {
          id: "chew-toy",
          title: "Chew toy",
          summary: "Searching Acme Market found nothing that fits. What is it?",
          draftFormat: "text",
          draftLabel: "Answer",
          draftPlaceholder: "What it is, and a size if it matters",
          actions: [
            { type: "message", label: "Send answer", text: "About Chew toy on the list: {draft}", primary: true },
            { type: "command", label: "Rope toy ×1", command: "true" },
          ],
        },
      ],
    },
  ],
});

const grantActions = (section: string) => [
  { type: "message", label: "Accept", text: `Accept ${section} as below, write it into the application, and check the word count:\n\n{draft}`, primary: true },
  { type: "message", label: "Revise", text: `Revise ${section}. What to change: {note}\n\nThe text as I left it:\n\n{draft}` },
];

/**
 * A piece of work in rounds: a grant application written section by section.
 * The agent sets each section's status, so a section is complete only once
 * its text is written in and fits the word limit, whatever the user pressed.
 */
export const grantView: View = viewSchema.parse({
  title: "Grant: Acme Foundation Open Tools Fund",
  summary: "",
  map: {
    pages: [
      { label: "Page 1", columns: [["summary", "need"]] },
      { label: "Page 2", columns: [["approach", "team"]] },
    ],
  },
  sections: [
    {
      title: "",
      items: [
        {
          id: "need",
          title: "Need",
          status: { label: "In progress", tone: "warning" },
          meter: { value: 180, max: 200, unit: "words" },
          related: {
            title: "From the release notes",
            detail: "Ranked by the fund's criteria",
            entries: [
              {
                id: "security-queue",
                text: "The 4.0 release has waited on two security reports since June.",
                detail: "Matches: maintenance is at risk",
                action: { type: "message", label: "Add", doneLabel: "Added", text: "Add to Need: the 4.0 release has waited on two security reports since June." },
              },
              {
                id: "maintainer-hours",
                text: "Both maintainers log about four hours a week, all outside work.",
                detail: "Matches: the project depends on volunteers",
                action: { type: "message", label: "Add", doneLabel: "Added", text: "Add to Need: both maintainers log about four hours a week, all outside work." },
              },
              {
                id: "dependents",
                text: "1,400 public projects depend on acme/widgets.",
                detail: "Matches: reach",
                badge: { label: "Used", tone: "success" },
              },
            ],
          },
          summary: "Round 2 leads with who maintains acme/widgets, then what breaks without them.",
          history: [
            { text: "Round 1: opened with the download counts.", at: "2026-03-12T09:42:00Z" },
            { who: "user", text: "Lead with who maintains it, not downloads.", at: "2026-03-12T09:48:00Z" },
            { text: "Round 2: leads with the two volunteer maintainers.", at: "2026-03-12T09:51:00Z" },
          ],
          changesLabel: "Changes against the application",
          changes: [
            {
              label: "Need",
              before:
                "acme/widgets is downloaded 90,000 times a week. It is a dependency of 1,400 public projects, and its release queue is behind.\n\n- 212 open issues\n- Downloads grew 40% this year",
            },
          ],
          draft:
            "Two volunteers maintain acme/widgets in their evenings. It is a dependency of 1,400 public projects, and its release queue is four months behind.\n\n- 212 open issues, 38 of them security reports waiting on triage\n- No maintainer is paid for the work",
          draftLabel: "Proposed text",
          note: { placeholder: "What to change for the next round" },
          actions: grantActions("Need"),
        },
        {
          id: "approach",
          title: "Approach",
          status: { label: "40 words over", tone: "danger" },
          meter: { value: 240, max: 200, unit: "words" },
          summary: "Accepted and written in, but the form counts 240 of 200 words.",
          history: [{ text: "Round 1: a three-phase plan: triage, release, handover.", at: "2026-03-12T09:30:00Z" }],
          draft:
            "Fund one maintainer for twelve months at half time. Months one to three clear the security queue; four to nine ship the overdue 4.0 release; ten to twelve write the handover guide.",
          draftLabel: "Proposed text",
          note: { placeholder: "What to change for the next round" },
          actions: grantActions("Approach"),
        },
        {
          id: "summary",
          title: "Summary",
          status: { label: "Complete", tone: "success", complete: true },
          meter: { value: 48, max: 50, unit: "words" },
          summary: "Written into the application and under the limit.",
          draft: "Half-time funding for one acme/widgets maintainer, for a year, to clear its security backlog and ship 4.0.",
          draftLabel: "Proposed text",
          note: { placeholder: "What to change for the next round" },
          actions: grantActions("Summary"),
        },
        {
          id: "team",
          title: "Team",
          status: { label: "Not started" },
          meter: { value: 0, max: 150, unit: "words" },
          summary: "Who maintains it, and who reviews their work.",
          actions: [{ type: "message", label: "Start", text: "Draft the Team section of the grant application.", primary: true }],
        },
      ],
    },
  ],
});

/** A code review's findings, each with the hunk it is about and a comment to post. */
export const codeReviewView: View = viewSchema.parse({
  title: "Review: acme/widgets#431",
  summary: "",
  sections: [
    {
      title: "",
      items: [
        {
          id: "finding-1",
          title: "Paging drops the last rows of every sync",
          url: "https://github.com/acme/widgets/pull/431#discussion_r1001",
          badges: [
            { label: "Bug", tone: "danger" },
            { label: "src/sync.ts", tone: "neutral" },
          ],
          summary:
            "The new loop stops one page early and slices one row short, so 120 rows sync as 49. Found by running the existing `sync.test.ts` fixture through the changed loop.",
          changesLabel: "In this PR",
          changes: [
            { label: "src/sync.ts", patch: syncHunk },
            { label: "src/sync.ts", patch: syncFixHunk, role: "proposed" },
          ],
          draft:
            "This drops rows: with 120 rows and a page size of 50, the loop stops after the first page, and `pageSize - 1` leaves off each page's last row. The original `start < rows.length` and `start + pageSize` were right.",
          draftLabel: "Comment to post",
          actions: [
            { type: "message", label: "Post comment", text: "Post this review comment on acme/widgets#431, on src/sync.ts line 43:\n\n{draft}", primary: true },
            { type: "message", label: "Fix it", text: "Fix the paging bug in src/sync.ts on acme/widgets#431 and push the fix." },
          ],
        },
      ],
    },
  ],
});

const attach = (line: number) => ({
  type: "message",
  label: "Attach as draft comment",
  text: `Add this to my pending review on acme/widgets#431, line ${line}:\n\n{draft}`,
  primary: true,
});

/** A code review with its verdict as the closing step: three findings to decide on, then submitting the review. */
export const reviewWithVerdictView: View = viewSchema.parse({
  title: "Review: acme/widgets#431 Page the gadget sync",
  summary: "",
  sections: [
    {
      title: "Fix before merge",
      items: [
        {
          id: "finding-paging",
          title: "Paging drops the last rows of every sync",
          badges: [{ label: "Bug", tone: "danger" }],
          summary: "120 rows sync as 49: the loop stops one page early and slices each page one row short.",
          changesLabel: "In this PR",
          changes: [
            { label: "src/sync.ts", patch: syncHunk },
            { label: "src/sync.ts", patch: syncFixHunk, role: "proposed" },
          ],
          draft: "This drops rows: with 120 rows and a page size of 50, the loop stops after the first page. The original `start < rows.length` and `start + pageSize` were right.",
          draftLabel: "Comment to post",
          actions: [attach(43)],
        },
      ],
    },
    {
      title: "Worth considering",
      items: [
        {
          id: "finding-retry",
          title: "A failed page is retried forever",
          badges: [{ label: "Reliability", tone: "warning" }],
          summary: "One bad row keeps the whole sync looping, since the retry has no limit.",
          draft: "Could the retry stop after a few tries and report the page it gave up on?",
          draftLabel: "Comment to post",
          actions: [attach(52)],
        },
        {
          id: "finding-name",
          title: "`pages` holds rows, not page numbers",
          badges: [{ label: "Naming", tone: "neutral" }],
          summary: "Reading `pages.length` as a page count is right, but `pages[0]` reads as a number.",
          draft: "Nit: `batches` might read better than `pages` here.",
          draftLabel: "Comment to post",
          actions: [attach(42)],
        },
      ],
    },
    {
      title: "",
      items: [
        {
          id: "verdict",
          title: "Submit as Request changes",
          closing: true,
          summary: "Request changes for the paging bug; the other two are not blocking. So far: {tally}.",
          actions: [
            { type: "message", label: "Submit as Request changes", text: "Submit my pending review on acme/widgets#431 as Request changes. Findings: {tally}.", primary: true },
            { type: "message", label: "Submit as Comment", text: "Submit my pending review on acme/widgets#431 as a comment. Findings: {tally}." },
          ],
        },
      ],
    },
  ],
});

const evidenceNeed = {
  id: "need",
  title: "Need",
  status: { label: "In progress", tone: "warning" },
  meter: { value: 46, max: 200, unit: "words" },
  summary: "Lead with who maintains acme/widgets, then what is waiting on them.",
  changesLabel: "Changes against the application",
  changes: [
    {
      label: "Need",
      before:
        "acme/widgets is downloaded 90,000 times a week. It is a dependency of 1,400 public projects, and its release queue is behind.\n\n- 212 open issues\n- Downloads grew 40% this year",
    },
  ],
  draft:
    "Two volunteers maintain acme/widgets in their evenings. It is a dependency of 1,400 public projects, and its release queue is four months behind.\n\n- 212 open issues, 38 of them security reports waiting on triage\n- No maintainer is paid for the work",
  draftLabel: "Proposed text",
  note: { placeholder: "What to change for the next round" },
  actions: grantActions("Need"),
  related: {
    title: "Not used yet",
    detail: "From the release notes",
    entries: [
      {
        id: "lts-backports",
        text: "The 3.x branch still gets backports for two long-term-support platforms.",
        detail: "release-notes.md › 3.9.2",
        action: { type: "message", label: "Add", doneLabel: "Added", text: "Add to Need: the 3.x branch still gets backports for two long-term-support platforms." },
      },
    ],
  },
};

const evidence = [
  {
    id: "volunteers",
    claim: "Two volunteers maintain acme/widgets in their evenings.",
    support: "full",
    sources: [
      { quote: "octocat and hubber review every pull request, both outside their day jobs.", source: "maintainers.md › Who we are" },
      { quote: "Both maintainers log about four hours a week, all outside work.", source: "release-notes.md › 3.9.0" },
    ],
  },
  {
    id: "dependents",
    claim: "a dependency of 1,400 public projects",
    support: "full",
    sources: [{ quote: "1,400 public projects depend on acme/widgets.", source: "GitHub › Dependents", url: "https://github.com/acme/widgets/network/dependents" }],
  },
  {
    id: "release-queue",
    claim: "its release queue is four months behind",
    support: "partial",
    note: "The notes date the wait from June, three months ago, not four.",
    sources: [{ quote: "The 4.0 release has waited on two security reports since June.", source: "release-notes.md › 4.0 (unreleased)" }],
  },
  {
    id: "open-issues",
    claim: "212 open issues",
    support: "full",
    sources: [{ quote: "212 Open · 1,893 Closed", source: "GitHub › Issues", url: "https://github.com/acme/widgets/issues" }],
  },
  {
    id: "security-reports",
    claim: "38 of them security reports waiting on triage",
    support: "none",
    note: "No source counts the security reports. The tracker's security label shows 31 open.",
  },
  {
    id: "unpaid",
    claim: "No maintainer is paid for the work",
    support: "full",
    sources: [{ quote: "Neither maintainer receives a salary or sponsorship for acme/widgets.", source: "funding.md › Sponsors" }],
  },
];

/** A grant section whose proposed text cites where each claim comes from. */
export const grantEvidenceView: View = viewSchema.parse({
  title: "Grant: Acme Foundation Open Tools Fund",
  summary: "",
  sections: [{ title: "", items: [{ ...evidenceNeed, evidence }] }],
});


/**
 * The grant with each section drafted in a thread of its own, which shows the
 * section's card too: Revise and its note go to the section's thread, while
 * Accept stays with the thread that published the view and writes the
 * application.
 */
export const grantSectionThreadsView: View = {
  ...grantView,
  sections: grantView.sections.map((section) => ({
    ...section,
    items: section.items.map((item) => ({
      ...item,
      thread: `thr_${item.id}01`,
      actions: item.actions.map((action) =>
        action.type === "message" && action.label === "Revise" ? { ...action, threadId: `thr_${item.id}01` } : action,
      ),
    })),
  })),
};

/** What the panel shows for each section's thread. */
export const grantSectionThreads = {
  thr_summary01: { title: "Grant: Summary", archived: false },
  thr_need01: { title: "Grant: Need", archived: false },
  thr_approach01: { title: "Grant: Approach", archived: false },
  thr_team01: { title: "Grant: Team", archived: false },
};

/**
 * A one-question view the grant thread publishes under a key of its own, so
 * it shows above the composer beside the grant view rather than replacing it.
 */
export const grantQuestionView: View = viewSchema.parse({
  title: "Application question: Why Acme Foundation?",
  summary: "",
  sections: [
    {
      title: "",
      items: [
        {
          id: "why-acme",
          title: "Why Acme Foundation?",
          summary: "A suggested answer that ties acme/widgets to the fund's focus on maintainer time.",
          details: "The Open Tools Fund pays for maintainer hours rather than features. Two volunteers keep acme/widgets running, and the fund would let them spend Fridays on the backlog.",
          draft: "The Open Tools Fund pays for maintainer hours rather than features, which is what acme/widgets needs most.",
          actions: [{ type: "message", label: "Use this answer", text: "Use this answer for Why Acme Foundation:\n\n{draft}", primary: true }],
        },
      ],
    },
  ],
});

/* A documentation audit: findings checked against the code, each a doc edit to apply. */

const auditDoc = "the Widgets Configuration Audit doc";

function applyToDoc(row: string) {
  return [{ type: "message", label: "Apply to doc", primary: true, text: `In ${auditDoc}, update the "${row}" row as below:\n\n{draft}` }];
}

export const configAuditView: View = viewSchema.parse({
  title: "Configuration audit: suggested updates",
  summary: "Checked the Widgets Configuration Audit doc against `main`. **Apply to doc** asks me to make that edit in the doc.",
  sections: [
    {
      title: "Must fix",
      items: [
        {
          id: "gadget-previews",
          title: 'Remove the "Gadget previews" row',
          badges: [{ label: "Obsolete", tone: "danger" }],
          summary: "The feature was deleted in Remove gadget previews (#412). `client/modules/gadget-preview/` no longer exists.",
          draft: 'Delete the "Gadget previews" row from Modules, and change the header count from (9) to (8).',
          draftLabel: "Edit",
          actions: [{ type: "message", label: "Apply to doc", primary: true, text: `In ${auditDoc}:\n\n{draft}` }],
        },
        {
          id: "widget-home",
          title: "Add Widget Home as a feature",
          badges: [{ label: "Missing", tone: "warning" }],
          summary: "A public landing page listing a team's open and closed widgets, added in Add Widget Home (#388). Off by default.",
          draft: "Widget Home: a public landing page for a team, listing its open and closed widgets. Turned on by the `widgetHomeEnabled` team setting, which defaults to off. Code: `client/screens/widget-home.tsx`.",
          draftLabel: "New row",
          actions: [{ type: "message", label: "Apply to doc", primary: true, text: `In ${auditDoc}, add this row to Features:\n\n{draft}` }],
        },
        {
          id: "reports-capability",
          title: "REPORTS_CAPABILITY was split into VIEW and MANAGE",
          badges: [{ label: "Stale", tone: "warning" }],
          summary: "Split in Separate viewing reports from changing them (#401). Two rows name the old constant.",
          changesLabel: "Change against the doc",
          changes: [
            {
              label: "Admin page, Reports page",
              before: "Admin page: ...gated on REPORTS_CAPABILITY.\nReports page: ...gates the screen on REPORTS_CAPABILITY.",
            },
          ],
          draft: "Admin page: ...gated on REPORTS_VIEW_CAPABILITY.\nReports page: ...gates the screen on REPORTS_VIEW_CAPABILITY, and changes to reports on REPORTS_MANAGE_CAPABILITY.",
          actions: applyToDoc("Admin page, Reports page"),
        },
        {
          id: "settings-defaults",
          title: "Setting defaults moved to server/settings.ts",
          badges: [{ label: "Stale", tone: "warning" }],
          summary: "Moved in Serve settings from the database layer (#395). The values are unchanged; eight rows point at the old file.",
          changesLabel: "Change against the doc",
          changes: [{ label: "Settings", before: "settings-map.ts stores colorScheme, defaulting to light." }],
          draft: "server/settings.ts defaults colorScheme to light.",
          actions: applyToDoc("Settings"),
        },
        {
          id: "env-config-file",
          title: "Environment: remove 3 rows and add WIDGETS_CONFIG_FILE",
          badges: [{ label: "Stale", tone: "warning" }],
          summary: "Three variables are no longer declared, and Load settings from a file (#379) added one.",
          draft: "Remove LOCAL_DEV, EMULATOR_HOST and CLOUD_PROJECT. Add WIDGETS_CONFIG_FILE: names a JSON settings file; environment variables override it.",
          draftLabel: "Edit",
          actions: [{ type: "message", label: "Apply to doc", primary: true, text: `In ${auditDoc}:\n\n{draft}` }],
        },
      ],
    },
    {
      title: "Should fix",
      items: [
        {
          id: "sorter-key",
          title: "sorterKey is stored but nothing reads it",
          badges: [{ label: "Open question", tone: "info" }],
          summary: 'The row says it picks "which sorter a team uses", but sorting uses a hardcoded `ACTIVE_SORTER = "newest"`.',
          draft: "sorterKey is stored and defaulted, but nothing reads it: sorting uses a hardcoded ACTIVE_SORTER. Open question: wire sorterKey up, or remove the setting?",
          draftLabel: "Note for the sorterKey row",
          actions: [
            { type: "message", label: "Add as open question", primary: true, text: `In ${auditDoc}, add this to the "sorterKey" row:\n\n{draft}` },
            { type: "message", label: "Create issue", text: "Draft an acme/widgets issue about this:\n\n{draft}" },
          ],
        },
        {
          id: "dashboard-tabs",
          title: "Dashboard: correct the tab list",
          badges: [{ label: "Inaccurate", tone: "warning" }],
          summary: "The tabs are Widgets, Gadgets, Reports and Settings. The per-user page is a subscreen, not a tab.",
          changesLabel: "Change against the doc",
          changes: [{ label: "Dashboard", before: "Tabs: Widgets, Gadgets, Users and Settings." }],
          draft: "Tabs: Widgets, Gadgets, Reports and Settings. Each user's page opens from the Widgets tab.",
          actions: applyToDoc("Dashboard"),
        },
        {
          id: "env-duplicate-defaults",
          title: "Environment: defaults stated twice",
          badges: [{ label: "Typo", tone: "neutral" }],
          summary: "`MAIL_PROVIDER` and `MAIL_PORT` each state their default twice.",
          changesLabel: "Change against the doc",
          changes: [{ label: "MAIL_PORT", before: "Port for outgoing mail. Defaults to 587. Default: 587." }],
          draft: "Port for outgoing mail. Defaults to 587.",
          actions: applyToDoc("MAIL_PORT"),
        },
      ],
    },
    {
      title: "Worth adding",
      items: [
        {
          id: "repo-docs",
          title: "Fix the stale environment docs in the repo",
          badges: [{ label: "Repo", tone: "neutral" }],
          summary: "`docs/configuration.md` lists a variable that no longer exists.",
          draft: "Remove MAIL_SENDER_ID from docs/configuration.md, and describe WIDGETS_CONFIG_FILE.",
          draftLabel: "What the PR changes",
          actions: [{ type: "thread", label: "Fix in a PR", primary: true, project: "widgets", title: "Fix the stale environment docs", prompt: "In acme/widgets, open a pull request that does this:\n\n{draft}" }],
        },
      ],
    },
  ],
});

/* A whole milestone triaged at once: thirteen issues, each with a status comment to post. */

type TriageRow = [number, string, string, string, string];

function triageItem([number, title, badge, summary, draft]: TriageRow, close: string | null, tone: "success" | "warning" | "info" | "neutral") {
  const post = { type: "message", label: "Post", text: `Post this triage comment on #${number}:\n\n{draft}` };
  return {
    id: `issue-${number}`,
    title: `#${number} ${title}`,
    url: `https://github.com/acme/widgets/issues/${number}`,
    badges: [{ label: badge, tone }],
    summary,
    draft,
    draftLabel: "Comment to post",
    actions:
      close === null
        ? [{ ...post, primary: true }]
        : [{ type: "message", label: close, text: `Post this triage comment on #${number}, then close it:\n\n{draft}`, primary: true }, post],
  };
}

const closeRows: TriageRow[] = [
  [313, "Translate gadget titles in the embed", "Close: completed", "Fixed when the embed moved to the v2 gadget read (#518), which returns each title's translations.", "This is fixed. The embed no longer reads the old metadata endpoint, and the v2 gadget read (#518) returns the title's translations, which the embed picks from by the reader's locale.\n\n- Seeded and real gadget titles translate: done in #518\n- The old endpoint returning translations: no longer needed, since nothing calls it"],
  [429, "Share one stylesheet between the embed and the app", "Close: completed", "Both now take their colors and spacing from the shared theme tokens added in #540.", "This is done. #540 moved the embed and the app onto the same theme tokens, so a color change in the theme now reaches both.\n\n- Shared colors: done in #540\n- Shared spacing: done in #540\n- The embed's own copy of the palette: deleted in #540"],
  [310, "Decide which embed styles we support", "Close: duplicate of #320", "The same decision is being made in #320, which has the design discussion.", "Closing as a duplicate of #320, where the design discussion on which embed styles to keep is happening. The list of styles from this issue is copied there."],
  [311, "Decide how partner colors are managed", "Close: duplicate of #619", "#619 covers partner colors as part of the theme work.", "Closing as a duplicate of #619, which handles partner colors as part of the theme work."],
];
const questionRows: TriageRow[] = [
  [308, "Serve the new embed at the existing /embed URL", "Keep open: question", "Still the last step. The approach was left to decide at the end of the project.", "Status: still open, and it's the last step before partners switch. In May we said we'd choose between a redirect and serving the new embed directly at the end of the project. Which do we want?"],
  [320, "Design the default embed", "Keep open: question", "Waiting on a design direction for the default style.", "Status: the embed ships one style today. Before we build more, we need a direction for the default. Is the current single style the default, or does design want a new one?"],
  [434, "Embed shows the system font instead of the brand font", "Keep open: question", "Still happens in Chrome: the font import inside the embed's shadow root is ignored.", "Status: still a bug in Chrome. The font `@import` sits inside the embed's shadow root, where Chrome ignores it, so the embed falls back to the system font. Stories don't show it because they load the stylesheet into the main page. Should we load the font from the host page instead?"],
  [375, "Stop the page jumping when the embed loads", "Keep open: question", "No fix yet. Reserving a fixed height is the simplest option.", "Status: no change yet. The simplest fix is to reserve a fixed height before the embed loads. Is a fixed height acceptable for partners whose questions run long?"],
];
const statusRows: TriageRow[] = [
  [442, "Accessibility audit of the embed", "Keep open: status", "Keyboard navigation and screen reader labels are still missing.", "Status: still needed. The embed can't be reached by keyboard, and its buttons have no screen reader labels. Partners have asked about this."],
  [307, "Move the embed out of the client directory", "Keep open: status", "Half done: the build moved in #532, the source has not.", "Status: half done. #532 moved the build, but the source still lives under `client/`."],
  [361, "Build every embed URL the same way", "Keep open: status", "Two of five places still join strings by hand.", "Status: three of the five places now use `new URL(path, base)`. The other two still join strings by hand."],
  [373, "Use the app's translation system in the embed", "Keep open: status", "The embed still has its own string table.", "Status: still open. The embed keeps its own table of 40 strings instead of the app's translation system."],
];
const moveRows: TriageRow[] = [
  [344, "Cache the embed's data endpoint", "Keep open: move milestone", "Belongs with the database work. The endpoint now does more per view, so caching matters more.", "Status: still needed, and more than when this was filed: the endpoint now loads every comment on each request. Moving it to the Database Support milestone, where the caching work is planned."],
];

export const milestoneTriageView: View = viewSchema.parse({
  title: "Triage: Gadget Embed milestone",
  summary: "13 open issues checked against `main`. Nothing has been posted yet.",
  sections: [
    { title: "Close", items: closeRows.map((row) => triageItem(row, "Post and close", "success")) },
    { title: "Keep open, with a question", items: questionRows.map((row) => triageItem(row, null, "warning")) },
    { title: "Keep open, with a status comment", items: statusRows.map((row) => triageItem(row, null, "info")) },
    { title: "Move milestone", items: moveRows.map((row) => triageItem(row, "Post and move", "neutral")) },
  ],
});

/* Three pull requests from one review comment, each in its own worktree. */

const permissionsDocPatch = `diff --git a/docs/guides/permissions.md b/docs/guides/permissions.md
--- a/docs/guides/permissions.md
+++ b/docs/guides/permissions.md
@@ -1,7 +1,7 @@
 # Permissions
 
 Widgets uses roles to control who can change gadgets, review reports, and manage a team. Each member can hold one or more roles, and each role grants a set of permissions. Members without a role can view gadgets and nothing else.
 
-Roles are assigned from the **Team Settings** screen, available to Owners and Maintainers.
+Roles are assigned from the **Team Settings** screen, available to Owners.
 
 Assign one of these three roles:
@@ -42,7 +42,7 @@
 Reading the member list (**List members**) is granted to every role: several screens use it, so no narrower permission fits.
 
-Changing a member's display name is separate from deciding their role. **Edit member profiles** covers the Members screen, so a Reviewer can fix a colleague's name without being able to invite or remove anyone. **Assign roles** stays with Owners and Maintainers. On the Members screen a Reviewer therefore sees the Invite button and the Remove action disabled.
+Changing a member's display name is separate from deciding their role. **Edit member profiles** covers the Members screen, so a Reviewer can fix a colleague's name without being able to invite or remove anyone. **Assign roles** stays with Owners. On the Members screen a Reviewer therefore sees the Invite button and the Remove action disabled.
 
 | Permission | Owner | Reviewer | Viewer | Maintainer |
 |---|:-:|:-:|:-:|:-:|
 | Edit gadgets | x | x |   | x |
@@ -61,16 +61,7 @@
 | Export reports | x | x | x | x |
 
-## Permission groups
-
-Some retired roles include the permissions of others:
-
-- **Maintainer** includes everything a Reviewer can do.
-- **Owner** has every permission, whatever roles they hold.
-
-Holding Maintainer, for example, already includes everything a Reviewer can do.
-
 ## Assigning roles
 
-Roles are assigned on the **Team Settings** screen. Only Owners and Maintainers can open it. From there, an Owner or Maintainer can add a member by email and pick which roles to grant. A member can hold several roles, and their permissions combine.
+Roles are assigned on the **Team Settings** screen. Owners can open it. From there, an Owner can add a member by email and pick which roles to grant. A member can hold several roles, and their permissions combine.
 
 To remove a member's access entirely, take away all of their roles.
`;

function splitCommentPr(id: string, title: string, summary: string, branch: string, patch: string) {
  return {
    id,
    title,
    summary: `${summary}\n\nDraft: [pull-request-${branch}.md](/tmp/drafts/pull-request-${branch}.md) · worktree \`/tmp/worktrees/widgets-${branch}\``,
    changesLabel: "Files changed",
    changes: [{ label: patch.match(/^\+\+\+ b\/(.+)$/m)![1]!, patch }],
    actions: [
      { type: "message", label: "Commit, push, and open PR", primary: true, text: `Commit, push, and open the pull request for "${title}" from \`${branch}\`.` },
      { type: "message", label: "Revise", text: `Let's revise "${title}" before it goes up.` },
    ],
  };
}

const seedPatch = `diff --git a/server/seed/demo-accounts.ts b/server/seed/demo-accounts.ts
--- a/server/seed/demo-accounts.ts
+++ b/server/seed/demo-accounts.ts
@@ -8,9 +8,6 @@ export const DEMO_ACCOUNTS: DemoAccount[] = [
   { name: "Octocat Owner", email: "owner@example.com", roles: ["owner"] },
   { name: "Hubber Reviewer", email: "reviewer@example.com", roles: ["reviewer"] },
   { name: "Vera Viewer", email: "viewer@example.com", roles: ["viewer"] },
-  { name: "Max Maintainer", email: "maintainer@example.com", roles: ["maintainer"] },
-  { name: "Gail Gatekeeper", email: "gatekeeper@example.com", roles: ["gatekeeper"] },
-  { name: "Tess Triager", email: "triager@example.com", roles: ["triager"] },
 ];
`;

const invitePatch = `diff --git a/client/screens/members/invite.tsx b/client/screens/members/invite.tsx
--- a/client/screens/members/invite.tsx
+++ b/client/screens/members/invite.tsx
@@ -27,7 +27,7 @@ export function InviteMember({ team }: { team: Team }) {
   const [email, setEmail] = useState("");
-  const role = team.defaultRole ?? "maintainer";
+  const role = team.defaultRole ?? "viewer";
   return (
     <Form onSubmit={() => invite(team.id, email, role)}>
`;

export const threePrsView: View = viewSchema.parse({
  title: "Three PRs from the #2318 comment",
  summary: "Each fix is uncommitted in its own worktree, with its pull request description drafted. Nothing has been pushed.",
  sections: [
    {
      items: [
        splitCommentPr(
          "invite-viewer",
          "fix(teams): invite new members as Viewer",
          "New members invited without a role were made Maintainers, a role we are retiring. They now start as Viewers.",
          "invite-as-viewer",
          invitePatch,
        ),
        splitCommentPr(
          "demo-accounts",
          "fix(seed): drop demo accounts that hold retired roles",
          "Removes Max Maintainer, Gail Gatekeeper, and Tess Triager from the demo accounts, so signing in on a preview server no longer offers roles the app is retiring.",
          "seed-retired-roles",
          seedPatch,
        ),
        splitCommentPr(
          "permissions-doc",
          "docs(permissions): remove permission groups and fix who opens Team Settings",
          "Removes the Permission groups section, which describes inheritance the code doesn't have, and describes Team Settings as open to Owners, leaving out the retiring Maintainer role.",
          "docs-permissions-accuracy",
          permissionsDocPatch,
        ),
      ],
    },
  ],
});

/** An inline question after a short proposal: three answers, the likely one primary. */
export const inlineView: View = viewSchema.parse({
  title: "Fix the failing check",
  layout: "inline",
  sections: [
    {
      items: [
        {
          id: "snapshot",
          title: "How should I fix the snapshot check?",
          actions: [
            {
              type: "message",
              label: "Update, commit, and push",
              primary: true,
              detail: "Update the 2 snapshots, re-run the suite, commit, and push",
              text: "Go ahead: update the 2 snapshots, re-run the suite, then commit and push.",
            },
            {
              type: "message",
              label: "Update but don't push",
              detail: "The same, stopping after the commit",
              text: "Update the 2 snapshots and commit, but don't push yet.",
            },
            {
              type: "message",
              label: "Show me the diff first",
              detail: "Update the snapshots and show the diff before committing",
              text: "Update the snapshots, then show me the diff before committing.",
            },
          ],
        },
      ],
    },
  ],
});

/** An inline question after a long report: four longer answers, and a second question after it. */
export const inlineTwoView: View = viewSchema.parse({
  title: "Faster widget list",
  layout: "inline",
  sections: [
    {
      items: [
        {
          id: "commit",
          title: "Commit and push as 2 commits, then capture screenshots?",
          actions: [
            {
              type: "message",
              label: "2 commits, push, and capture",
              primary: true,
              detail: "The shared hook, then the 3 pages; push; run the screenshot capture",
              text: "Commit the hook, then the 3 pages, as 2 commits. Push, then run the screenshot capture.",
            },
            { type: "message", label: "Just commit and push", detail: "The same 2 commits, without the screenshot capture", text: "Commit and push as 2 commits. Skip the screenshot capture." },
            { type: "message", label: "1 commit instead", detail: "Hook and pages together, then push and capture", text: "Commit everything as 1 commit, push, then run the screenshot capture." },
            { type: "message", label: "Not yet", detail: "Leave everything uncommitted", text: "Don't commit yet." },
          ],
        },
        {
          id: "publish",
          title: "Publish the component library first?",
          actions: [
            { type: "message", label: "Publish it", primary: true, text: "Publish the component library with the new hook." },
            { type: "message", label: "Later", text: "Don't publish the component library yet." },
          ],
        },
      ],
    },
  ],
});

/** A refine-impromptu-ui scan: invented threads, moments, and fixes. */
export const refineScanView: View = viewSchema.parse({
  title: "Refine Impromptu UI",
  summary: "14 threads from the last 2 days: 1 moment waiting on you, and 3 ways to stop the rest.",
  sections: [
    {
      title: "Waiting on you",
      items: [
        {
          id: "bumps",
          title: "Dependency bumps for acme/widgets",
          badges: [{ label: "2 days" }],
          summary:
            "6 pull requests, each needing approve or skip.\n\n**The view it would publish:** one card per pull request with Approve and Skip.",
          details: "> Which of these should I approve?",
          actions: [
            {
              type: "command",
              label: "Show it there",
              primary: true,
              doneLabel: "Asked",
              command:
                "bb thread tell thr_ref0001 'Your last reply ended on six dependency bumps to approve or skip, and the user has not answered yet. Publish it as an Impromptu UI view (the impromptu-ui skill covers how), then stop.'",
            },
          ],
        },
      ],
    },
    {
      title: "Ways to fix it",
      items: [
        {
          id: "pick-lists",
          title: "Show a list to pick from as cards, even when no question is asked",
          badges: [{ label: "Guide", tone: "info" }, { label: "5 threads" }],
          summary:
            "**What happens now:** The agent ends on a list of suggestions with no question, so the instructions do not read it as a decision. The user quotes an item back to act on it.\n\n> Agent: a list of 5 suggested changes to the setup guide. User typed: \"Do the second and fourth\"\n\n**Seen in:** 5 threads in the last 2 days.\n\n**The fix:** Say in the instructions every thread gets that a list the user will pick from is a view, question or not.",
          changesLabel: "The edit",
          proposedLabel: "Proposed wording",
          changes: [
            {
              label: "view/instructions.ts",
              role: "proposed",
              before:
                "Reach for it whenever the user would otherwise read your output and then type a reply to act on it: choosing between things, approving a plan or editing a draft, comparing versions, or working through several items.",
              after:
                "Reach for it whenever the user would otherwise read your output and then type a reply to act on it: choosing between things, approving a plan or editing a draft, comparing versions, or working through several items. A list the user will pick from, such as suggestions or follow-ups, is a view even when your reply asks no question.",
            },
          ],
          details:
            "**Threads**\n\n- Setup guide review; typed \"Do the second and fourth\".\n- Follow-ups after a release; typed \"Open issues for 1 and 3\".\n- Test cleanup ideas; typed \"Just the flaky one\".",
          actions: [
            { type: "message", label: "Make this edit", primary: true, text: "Make the edit for \"Show a list to pick from as cards, even when no question is asked\" as shown in its card." },
            { type: "message", label: "File an issue instead", text: "File an issue for \"Show a list to pick from as cards, even when no question is asked\" instead of editing." },
          ],
        },
        {
          id: "review-step",
          title: "End the code review skill on a view of its findings",
          badges: [{ label: "Another skill", tone: "info" }, { label: "3 threads" }],
          summary:
            "**What happens now:** The review skill's last step says to list the findings in chat, so the agent follows it and never publishes. The user answers each finding by number.\n\n**Seen in:** 3 threads in the last 2 days.\n\n**The fix:** Make publishing one card per finding the review skill's last step.",
          actions: [{ type: "message", label: "Make this edit", primary: true, text: "Make the edit for \"End the code review skill on a view of its findings\" as shown in its card." }],
        },
        {
          id: "bulk",
          title: "Let one button act on every card in a section",
          badges: [{ label: "Issue", tone: "warning" }, { label: "2 threads" }],
          summary:
            "**What happens now:** A view of 12 patch-level bumps had an Approve button on each card, and the user pressed it 12 times.\n\n**Seen in:** 2 threads in the last 2 days.\n\n**The fix:** A section-level button that runs one action for each open card.",
          actions: [{ type: "message", label: "File an issue", primary: true, text: "File an issue for \"Let one button act on every card in a section\"." }],
        },
      ],
    },
  ],
});
