# Beezi plugin release notes

## 0.4.0 (2026-11-11) — One-question setup

### New
- **One question at setup** — after you sign in, the terminal setup and `/beezi-dev-login` ask one thing: what Beezi should track. "Everything" tracks every repo and folder, new ones included; "Let me choose" lets you tick the repos and folders, per workspace when you have several. With no past sessions and one workspace, nothing is asked.
- **Past sessions follow your answer** — the past sessions in the repos and folders you track start uploading in the background right after you answer, without a second question. Places you leave out are never uploaded, and a workspace whose owner chose never to upload past sessions is still skipped.

### Improved
- **Your plan is found, not asked** — setup and `/beezi-dev-login` read your Copilot plan silently and say which one they found. When they can't tell, they say so and `/beezi-dev-settings` sets it.
- **Crash reports and the status line on by default** — setup turns on crash reports unless you already chose, and installs the status line when it is off. Both stay changeable in `/beezi-dev-settings`.
- **Fewer questions at sign-in** — `/beezi-dev-login` no longer asks about this session's folder, the default account, workspaces you joined or repos with no rule. `/beezi-dev-settings` and `/beezi-dev-sync` still cover them.
- **Beezi's colours in the terminal** — the terminal setup shows the Beezi mark and violet highlights, and ends with a short closing block.

## 0.3.0 (2026-11-03) — Past sessions that upload without asking

### New
- **Uploads without asking** — a workspace owner can choose to upload past sessions without asking. Beezi still shows the summary, says that workspace uploads past sessions without asking, and uploads them in the background: at sign-in, during setup, when a new session starts and from `/beezi-dev-sync`.

### Improved
- **One summary for several workspaces** — when several of your workspaces have past sessions, Beezi shows one summary with each workspace, its number of sessions and what it hides, then asks one question for the workspaces that ask first: "Upload to both" (or "Upload to all 3", and so on), "Choose for each" or "Not now".

## 0.2.1 (2026-10-30) — A clearer past-sessions summary

### Improved
- **Past-sessions summary as a checklist** — the summary now lists what is sent, what your workspace hides and what is never sent, each on its own short line. The question offers "Upload now" or "Not now", and the terminal setup asks it as an arrow-key menu.

## 0.2.0 (2026-10-30) — Anonymized workspaces and past sessions on your say-so

### New
- **Choose what each workspace hides** — a Beezi workspace can hide repos, branches, session names, your computer name and your GitHub account, each on its own. Hidden details arrive as made-up values, and hiding session names also leaves out the agent name and error messages.
- **Past sessions after you say yes** — Beezi shows how many past sessions it found, from when and where, and what uploading them sends, then uploads them after you choose "Upload". You can be asked at sign-in, during setup, when a new session starts or from `/beezi-dev-sync`. Since 0.3.0 a workspace can also upload them without asking.
- **Privacy notice** — the first session start in an anonymized workspace says that its sessions are anonymized, once per account and workspace.
- **Appears as** — `/beezi-dev-settings account` shows the name this machine appears as in an anonymized workspace.

### Improved
- **Rule changes upload nothing by themselves** — adding or changing a folder rule uploads no past sessions by itself. Beezi asks again about that folder's past sessions; a workspace whose owner chose upload without asking gets a notice and the upload instead.
- **"Not now" is remembered** — Beezi doesn't ask that workspace again until its owner changes the past-sessions setting. Run `/beezi-dev-sync` any time to upload them.
- **Hidden details stay hidden** — a detail the question said was hidden is hidden in that upload even if the setting changes before it runs.
- **Declined sessions** — sessions you said Not now to are not asked about again until the workspace's choice changes; `/beezi-dev-sync` still shows them.
- **GitHub sign-in in hidden workspaces** — when GitHub logins are hidden, Beezi also sends whether the account is on github.com.

## 0.1.96 (2026-10-29) — Large sessions keep tracking

### Fixed
- **Large sessions keep tracking** — Copilot CLI and VS Code sessions over 64 MB are tracked live and uploaded instead of being skipped.

## 0.1.95 (2026-10-26) — Terminal setup sees what your sessions see

### Fixed
- **Uploads reach Beezi again** — the plugin uses Beezi's new address, `https://api.beezi.ai`, and existing sign-ins keep working without a new `/beezi-dev-login`.
- **One GitHub account per machine** — a `COPILOT_GITHUB_TOKEN` or `GITHUB_TOKEN` set in your shell no longer reaches terminal setup, the same way Copilot hides them from plugins, so setup no longer records a different GitHub account than your sessions report. Setup prints a warning when Copilot uses such a token, and suggests `GH_TOKEN`, which Beezi can see.

## 0.1.94 (2026-10-22) — Pick several workspaces, and no silent drops

### Improved
- **Several workspaces for this machine** — "Where should analytics from this machine go?" in `/beezi-dev-login` and the terminal setup has a "Several workspaces…" choice that sends everything to each workspace you pick.
- **Several workspaces at session start** — the question about a new repo or folder says you can type several workspace names.

### Fixed
- **"Don't track" stands alone** — picking "Don't track" together with a workspace no longer saves "not tracked" and drops the workspace. The terminal setup clears the other ticks, and Copilot asks again.
- **"None of these" stands alone** — picking "None of these" together with repos for a workspace you joined no longer drops those repos and marks the join reviewed.

## 0.1.93 (2026-10-21) — Clearer settings, a status-line badge and one-question sign-in

### New
- **Status-line badge** — the Copilot CLI status line can end with a Beezi badge that shows where this folder's analytics go. Off by default; turn it on in `/beezi-dev-settings`.
- **Undo** — a rule or New folders change in `/beezi-dev-settings` ends with "Undo: /beezi-dev-settings undo", and running it puts your last change back.
- **Folder picker** — stop tracking another folder by picking it from your most-used ones instead of typing a path.
- **`/beezi-dev-release-notes`** — what changed in each version, right in Copilot.

### Improved
- **You're here** — `/beezi-dev-settings` shows where this folder's analytics go, with a Default row, a "← you're here" marker, each rule's path or remote and its sessions over the last 30 days.
- **Clearer settings menu** — each option shows its current state, each view opens in one step, and the Rules menu ends with Close.
- **Status names your folder and version** — `/beezi-dev-status` says where this folder's analytics go, and how to update when a newer version is out.
- **Clearer session-start question** — a new repo or folder is named plainly when Beezi asks where its analytics go, and session start makes one fewer server call.
- **One-question sign-in** — `/beezi-dev-login` and the terminal setup ask one question, "Where should analytics from this machine go?", with how many past sessions go there.
- **Fewer steps** — `/beezi-dev-sync` and `/beezi-dev-logout` finish in fewer steps when there is nothing to ask.

## 0.1.92 (2026-10-20) — Set up from one terminal command

### New
- **Terminal setup** — the one-line installer runs a short setup in the same terminal: sign-in, where analytics go, your Copilot plan, uploading past sessions, crash reports and the status line.
- **Sign in without a browser** — over SSH, in a Codespace or dev container, or when the browser times out, paste the sign-in address back into the terminal instead.

## 0.1.91 (2026-10-15) — Pick repos for each workspace you join

### New
- **Repos per workspace** — after joining workspaces, choose which repos and folders go to each one, or add them to all.

### Improved
- **Faster uploads** — uploading past sessions is faster, and joining several workspaces looks through your repos once, so the upload starts sooner.
