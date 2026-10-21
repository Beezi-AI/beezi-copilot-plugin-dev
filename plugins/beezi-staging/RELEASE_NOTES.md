# Beezi plugin release notes

## 0.1.93 (2026-10-21) — Clearer settings, a status-line badge and one-question sign-in

### New
- **Status-line badge** — the Copilot CLI status line can end with a Beezi badge that shows where this folder's analytics go. Off by default; turn it on in `/beezi-staging-settings`.
- **Undo** — a rule or New folders change in `/beezi-staging-settings` ends with "Undo: /beezi-staging-settings undo", and running it puts your last change back.
- **Folder picker** — stop tracking another folder by picking it from your most-used ones instead of typing a path.
- **`/beezi-staging-release-notes`** — what changed in each version, right in Copilot.

### Improved
- **You're here** — `/beezi-staging-settings` shows where this folder's analytics go, with a Default row, a "← you're here" marker, each rule's path or remote and its sessions over the last 30 days.
- **Clearer settings menu** — each option shows its current state, each view opens in one step, and the Rules menu ends with Close.
- **Status names your folder and version** — `/beezi-staging-status` says where this folder's analytics go, and how to update when a newer version is out.
- **Clearer session-start question** — a new repo or folder is named plainly when Beezi asks where its analytics go, and session start makes one fewer server call.
- **One-question sign-in** — `/beezi-staging-login` and the terminal setup ask one question, "Where should analytics from this machine go?", with how many past sessions go there.
- **Fewer steps** — `/beezi-staging-sync` and `/beezi-staging-logout` finish in fewer steps when there is nothing to ask.

## 0.1.92 (2026-10-20) — Set up from one terminal command

### New
- **Terminal setup** — the one-line installer runs a short setup in the same terminal: sign-in, where analytics go, your Copilot plan, uploading past sessions, crash reports and the status line.
- **Sign in without a browser** — over SSH, in a Codespace or dev container, or when the browser times out, paste the sign-in address back into the terminal instead.

## 0.1.91 (2026-10-15) — Pick repos for each workspace you join

### New
- **Repos per workspace** — after joining workspaces, choose which repos and folders go to each one, or add them to all.

### Improved
- **Faster uploads** — uploading past sessions is faster, and joining several workspaces looks through your repos once, so the upload starts sooner.
