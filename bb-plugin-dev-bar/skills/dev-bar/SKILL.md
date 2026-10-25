---
name: dev-bar
description: Use when adding the Dev Bar to a repository, writing or fixing its `.bb/dev-bar.json` manifest or the status command the manifest names, or when the bar along the bottom of a thread shows a failure.
---

# Dev Bar

The Dev Bar plugin draws a status bar along the bottom of a thread listing the
checkout's dev services, with buttons to start and stop them. It knows nothing
about any app. A repository opts in by committing `.bb/dev-bar.json`, and
the plugin runs the commands that file names.

## Where the manifest lives

The bar uses the first of these it finds, and says which on hover over its count:

1. `.bb/dev-bar.json`, committed in the repository. Prefer this when the
   repository is yours to change.
2. `.bb/dev-bar.local.json` in the checkout, for one checkout only. Keep it out
   of git, such as with `echo .bb/dev-bar.local.json >> .git/info/exclude`.
3. A manifest saved for the thread's bb project, shared by every worktree and
   branch of it, for a repository that commits none:

   ```sh
   bb dev-bar manifest set path/to/manifest.json   # validates it, then saves it
   bb dev-bar manifest show
   bb dev-bar manifest clear
   ```

   Each takes `--project <id>`; from a thread it defaults to that thread's project.

## The manifest format

```json
{
  "status": "pnpm status --json",
  "start": "pnpm launch start {id}",
  "stop": "pnpm launch stop {id}",
  "restart": "pnpm launch restart {id}",
  "actions": [
    { "label": "Start all", "command": "pnpm launch" },
    { "label": "Stop all", "command": "pnpm stop" },
    { "label": "Reset database", "command": "pnpm reset", "confirm": "Replace this checkout's database with seeded data?" }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `status` | yes | Prints the status JSON below and exits 0. |
| `start`, `stop` | no | Start or stop one service. `{id}` is replaced with the service's id. Without one, services have no Start or Stop. |
| `restart` | no | Restart one service. Without it, Restart runs `stop` and then `start`. |
| `actions` | no | Up to 8 buttons at the right end of the bar, in order. `label` is at most 40 characters. With `confirm`, the first click shows the label with a question mark and a second click runs it. |

## The status JSON

Printed to stdout. Text before the first line that starts with `{`, such as
the banner `pnpm run` prints, is skipped. Anything on stderr is ignored.

```json
{
  "services": [
    { "id": "web", "label": "Web", "state": "running", "url": "http://localhost:5174" },
    { "id": "db", "label": "Database", "state": "running", "actions": ["start"], "message": "Shared by every checkout" },
    { "id": "desktop", "label": "Desktop app", "state": "stopped" }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Letters, digits, `.`, `_`, `-`. It is put into the `start`, `stop`, and `restart` commands. |
| `label` | no | The service's name in the bar. Defaults to `id`. |
| `state` | yes | `running`, `starting`, `stopped`, or `failed`. |
| `url` | no | An absolute URL. The service's menu opens it while the service is running. |
| `message` | no | One line shown in the service's menu and on hover, such as why it failed. |
| `actions` | no | Limits the service's menu to these of `start`, `stop`, `restart`. Use `[]` or `["start"]` for a service this checkout should not stop, such as a database shared across checkouts. |

Services appear in the order listed. Unknown fields are ignored.

## What the commands must do

- Run from the checkout root, through the user's login shell, so `pnpm` and
  other tools on their PATH resolve.
- Return quickly. A service must be started detached, with its output going
  to a log file rather than the command's stdout. The bar shows a spinner
  until the command exits, and stops a command after 5 minutes, or a status
  command after 20 seconds.
- Exit non-zero on failure, with the reason in the last few lines of output.
  The bar shows the last 6 lines.
- Stop a service without asking, for `stop`. When the last thread in a
  checkout is archived, the bar stops every service that is `running` or
  `starting` and can be stopped, with no one watching.
- Be safe to run every 5 seconds, for `status`. It runs that often while the
  thread is on screen, and every second for 15 seconds after a button.

## Give each checkout its own ports

bb runs threads in separate worktrees of one repository, and each thread's
bar starts that worktree's services. When the repository's dev server,
Storybook, docs site, or API listens on a fixed port, the second worktree's
start fails because the port is taken. Or a tool that picks the next free
port starts on one the status command doesn't know about, and the bar opens
the first worktree's server instead.

So before writing the manifest, find every port the repository's services
listen on: its `package.json` scripts, `vite.config.*`, `.storybook/`,
`docker-compose.yml`, `Procfile`, `.env` files. When any is fixed, suggest
to the user that each checkout run on its own ports, and say which files
that changes. Make the change once they agree. Then:

- Choose the ports the first time the checkout starts, and save them in a
  file kept out of git, such as `.bb/ports.json`, so they stay the same
  across restarts and the status command can read them. Deriving a starting
  point from the checkout's path keeps two checkouts apart, and checking that
  each port is free before saving it covers the rare overlap:

  ```sh
  base=$(( 20000 + $(printf '%s' "$PWD" | cksum | cut -d' ' -f1) % 1000 * 10 ))
  # web on $base, Storybook on $((base + 1)), API on $((base + 2))
  ```

- Pass each port to its tool, and make the tool fail instead of moving to
  another port: `vite --port N --strictPort`, `storybook dev -p N --exact-port`,
  `ladle serve --port N`, `next dev -p N`, or `PORT=N` for a server that reads
  it. A service that also calls another, such as a web app calling the API,
  needs the other's port too.
- Put the saved port in each service's `url` in the status JSON.
- Tell whether a service is running from the process this checkout started,
  such as a pid file in the checkout, not from whether something answers on
  the port. Another checkout's server on a shared port would otherwise read
  as running here.

A service every checkout shares on purpose, such as a local database, keeps
its fixed port. List it with `"actions": ["start"]` and a `message` saying
it is shared, so archiving one thread doesn't stop it for the others.

## Checking a manifest

Run the status command in the checkout and confirm it prints the JSON above.
The plugin's RPC returns what the bar would draw, including any parse error:

```sh
BASE=$(node -p "require(process.env.HOME+'/.bb/bb-app-runtime.json').serverUrl")
curl -s -X POST -H "content-type: application/json" -H "origin: $BASE" \
  -d "{\"threadId\":\"$BB_THREAD_ID\"}" "$BASE/api/v1/plugins/dev-bar/rpc/strip"
```
