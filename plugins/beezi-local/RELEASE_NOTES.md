# Beezi plugin release notes

## 0.2.0 (2026-10-22) — Anonymized workspaces and past sessions on your say-so

### New
- **Choose what each workspace hides** — a Beezi workspace can hide repos, branches, session names, your computer name and your GitHub account, each on its own. Hidden details arrive as made-up values, and hiding session names also leaves out the agent name and error messages.
- **Past sessions only after you say yes** — Beezi shows how many past sessions it found, from when and where, and what uploading them sends, then uploads them only after you choose "Upload". You can be asked at sign-in, during setup, when a new session starts or from `/beezi-local-sync`, and `/beezi-local-sync` always asks.
- **Privacy notice** — the first session start in an anonymized workspace says that its sessions are anonymized, once per account and workspace.
- **Appears as** — `/beezi-local-settings account` shows the name this machine appears as in an anonymized workspace.

### Improved
- **Rule changes no longer upload history** — adding or changing a folder rule never uploads past sessions. At most, Beezi asks again about that folder's past sessions.
- **"Not now" is remembered** — Beezi doesn't ask that workspace again until its owner changes the past-sessions setting. Run `/beezi-local-sync` any time to upload them.
- **Hidden details stay hidden** — a detail the question said was hidden is hidden in that upload even if the setting changes before it runs.
- **Declined sessions** — sessions you said Not now to are not asked about again until the workspace's choice changes; `/beezi-local-sync` still shows them.
- **GitHub sign-in in hidden workspaces** — when GitHub logins are hidden, Beezi also sends whether the account is on github.com.

## 0.1.93 (2026-10-21) — Clearer settings, a status-line badge and one-question sign-in

### New
- **Status-line badge** — the Copilot CLI status line can end with a Beezi badge that shows where this folder's analytics go. Off by default; turn it on in `/beezi-local-settings`.
- **Undo** — a rule or New folders change in `/beezi-local-settings` ends with "Undo: /beezi-local-settings undo", and running it puts your last change back.
- **Folder picker** — stop tracking another folder by picking it from your most-used ones instead of typing a path.
- **`/beezi-local-release-notes`** — what changed in each version, right in Copilot.

### Improved
- **You're here** — `/beezi-local-settings` shows where this folder's analytics go, with a Default row, a "← you're here" marker, each rule's path or remote and its sessions over the last 30 days.
- **Clearer settings menu** — each option shows its current state, each view opens in one step, and the Rules menu ends with Close.
- **Status names your folder and version** — `/beezi-local-status` says where this folder's analytics go, and how to update when a newer version is out.
- **Clearer session-start question** — a new repo or folder is named plainly when Beezi asks where its analytics go, and session start makes one fewer server call.
- **One-question sign-in** — `/beezi-local-login` and the terminal setup ask one question, "Where should analytics from this machine go?", with how many past sessions go there.
- **Fewer steps** — `/beezi-local-sync` and `/beezi-local-logout` finish in fewer steps when there is nothing to ask.

## 0.1.92 (2026-10-20) — Set up from one terminal command

### New
- **Terminal setup** — the one-line installer runs a short setup in the same terminal: sign-in, where analytics go, your Copilot plan, uploading past sessions, crash reports and the status line.
- **Sign in without a browser** — over SSH, in a Codespace or dev container, or when the browser times out, paste the sign-in address back into the terminal instead.

## 0.1.91 (2026-10-15) — Pick repos for each workspace you join

### New
- **Repos per workspace** — after joining workspaces, choose which repos and folders go to each one, or add them to all.

### Improved
- **Faster uploads** — uploading past sessions is faster, and joining several workspaces looks through your repos once, so the upload starts sooner.
