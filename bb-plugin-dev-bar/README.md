# Dev Bar

A status bar under a thread that starts, stops, and restarts its checkout's dev services, and stops them when its last thread is archived.

![A thin bar along the bottom of a thread, under the composer, in a wide and a narrow pane: a small ring with one green, amber, or grey slice per service, then each service as a green, amber, or grey pill, and Start all, Start with sync, Stop all, and Reset database buttons on the right, shown as icons in the narrow pane](https://raw.githubusercontent.com/danielbachhuber/bb-plugins-screenshots/main/dev-bar/strip--running.png)

## Use

- Open a thread whose checkout has a `.bb/dev-bar.json`. The bar appears along the bottom of the thread, under the composer, with each service as a pill tinted by its state: green is running, amber is starting, grey is stopped, red has failed. The ring at the left end has one slice per service in the same colors; hover it for the count.
- Click a service to **Open** the service's URL, or to **Start**, **Stop**, or **Restart** it.
- Click a button at the right end of the bar, such as **Start all**, to run a command the repository declares. When nothing is running, the first button that starts things is filled. A button with a question asks it first; click again to confirm.
- A failed command's last lines show above the bar. Click **Start thread** to have an agent fix it in the same checkout, or **Set up in a thread** when the checkout is missing a program the command needs, such as before its dependencies are installed. When the bar couldn't read the services, **Retry** runs the status command again.
- Archive the last thread working in a checkout, and the plugin stops that checkout's running and starting services with the manifest's `stop` command. While another thread still uses the checkout, its services keep running.

![The bar with Web in red, and above it a note reading "Start web failed" with the command and the error it printed](https://raw.githubusercontent.com/danielbachhuber/bb-plugins-screenshots/main/dev-bar/strip--action-failed.png)

## Add it to a repository

The plugin knows nothing about any app. A repository opts in by committing `.bb/dev-bar.json`, which names the commands to run in the checkout:

```json
{
  "status": "pnpm status --json",
  "start": "pnpm launch start {id}",
  "stop": "pnpm launch stop {id}",
  "actions": [
    { "label": "Start all", "command": "pnpm launch" },
    { "label": "Stop all", "command": "pnpm stop" },
    { "label": "Reset database", "command": "pnpm reset", "confirm": "Replace this checkout's database with seeded data?" }
  ]
}
```

The status command prints JSON listing each service:

```json
{
  "services": [
    { "id": "web", "label": "Web", "state": "running", "url": "http://localhost:5174" },
    { "id": "db", "label": "Database", "state": "running", "actions": ["start"] },
    { "id": "desktop", "label": "Desktop app", "state": "stopped" }
  ]
}
```

Each worktree of a repository runs its own services, so a dev server or Storybook on a fixed port collides with the same server in another worktree. When the skill sets up the bar, it suggests running each checkout's services on ports of their own, saved in the checkout, and leaving a service every checkout shares, such as a database, on its fixed port.

For a repository that commits no manifest, put the same file at `.bb/dev-bar.local.json` in one checkout and keep it out of git, or save it for every checkout of a bb project with `bb dev-bar manifest set <file>`. The bar uses the first it finds, in that order, and says which on hover over the count.

The `dev-bar` skill in [`skills/dev-bar/SKILL.md`](skills/dev-bar/SKILL.md) is the full contract: every field, and what the commands must do.

## For agents

The `dev-bar` skill tells agents how to write a manifest and status command for a repository.

```sh
bb dev-bar manifest set <file> [--project <id>]   # save a manifest for a bb project
bb dev-bar manifest show [--project <id>]         # print the saved manifest
bb dev-bar manifest clear [--project <id>]        # remove it
```

## Settings

- **Provider for threads that fix a failure**: the provider for threads the failure buttons start. Defaults to `claude-code`, since the thread follows the `dev-bar` skill.

## Requirements

A checkout on the machine bb runs on. Commands run in the checkout through your login shell. While a thread is on screen, the plugin runs the status command every 5 seconds, and every second for 15 seconds after you click a button. When a thread is archived, it lists the checkout's other live threads once, and if none are left, runs the status command once and `stop` once per running service.

## Related plugins

- **Worktree Ports** (`worktree-ports`): lists the ports each worktree is listening on and can stop the process holding one. It finds services on its own, while Dev Bar shows the services a repository declares and can start them.
- **GitHub Context** (`gh-context`): the banner above the composer from this repository. Dev Bar sits along the bottom of the thread, under the composer, so the two can run together.

## Develop

```sh
npm install
npx tsc --noEmit
npm test
node ../scripts/link-workspace-deps.mjs && bb plugin build . && bb plugin reload dev-bar
```
