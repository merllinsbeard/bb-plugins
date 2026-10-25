## What you get

- A status bar along the bottom of a thread listing the checkout's dev services, each as a pill colored by whether it is running.
- A menu on each service to open the service's URL, or start, stop, or restart it.
- Buttons for the repository's own commands, such as Start all or Reset database, with an optional confirmation.
- The last lines a failed command printed, above the bar, with a button that starts a thread in the same checkout to fix it. A checkout missing its dependencies gets a Set up in a thread button.
- Services stopped when you archive the last thread working in their checkout, so they don't keep running after the work is done.

## How it works

A repository commits `.bb/dev-bar.json`, naming a status command that prints JSON and the commands for each action. Without one, a checkout can keep the same file uncommitted at `.bb/dev-bar.local.json`, or you can save one for a whole bb project. The plugin runs them in the thread's checkout through your login shell, and runs status every few seconds while the thread is on screen. Nothing leaves your machine until you start a thread.

## For agents

The `dev-bar` skill describes the manifest and status format, so an agent can add the bar to a repository. `bb dev-bar manifest set`, `show`, and `clear` manage a project's saved manifest.

## Requirements

A checkout on the machine bb runs on, and a manifest, committed or saved.
