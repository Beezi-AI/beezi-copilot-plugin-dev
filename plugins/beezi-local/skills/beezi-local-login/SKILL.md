---
name: beezi-local-login
description: Link a Beezi account to this machine with a browser sign-in, record which Copilot plan pays for it, and upload past Copilot sessions. Use when the user wants to log in, sign in or connect to Beezi, add another Beezi account, or when a Beezi tool says this machine is not linked. Run it again to add accounts or resume an interrupted upload.
argument-hint: ""
allowed-tools: shell(node:*), ask_user
---

# Beezi: login

Every script below is at `<plugin-root>/scripts/…`, where `<plugin-root>` is the folder that contains this skill's `skills/` folder (this file is `<plugin-root>/skills/<name>/SKILL.md`). If you do not know that path, call the `beezi_status` tool from the Beezi MCP server and use its `Plugin root:` line. Always use the absolute path, in double quotes.

Do not read, open or inspect any files yourself; run only the commands given, exactly as written.
Output you are told to show is copied exactly into your reply text — never summarized, paraphrased or
replaced by a sentence of your own. Machine lines (`key=value` lines, and any output you are told not
to show) are never shown. Never echo a token or anything from a credentials file.

Questions, everywhere below: ask with the `ask_user` tool, one question per call, and wait for the
answer before doing anything else. Offer the choices exactly as written; where a choice has a
description, write it as "<label> — <description>". The user may type their own answer instead; an
answer that matches none of the choices, an empty answer or a dismissed question runs nothing. Never
answer a question yourself and never assume an answer. When a question allows several answers, number
its choices and end the question with " You can pick more than one: type their numbers separated by
commas." When a step says "show … first", write that output verbatim in your reply before asking —
the user reads it while answering. If the preflight printed `mode=argument-only`, do not call
`ask_user` at all: in this skill, skip every question (a skipped question runs nothing) and keep going
with the next step. Never stop the login for this reason.

Step 0 — preflight, before anything else. Run EXACTLY:

`node "<plugin-root>/scripts/preflight.mjs" --for login`

If its first line starts with `✗`, show that line verbatim and STOP: run no other command. A login
that stops halfway leaves this machine half-linked. If the command itself is refused or cannot run,
STOP as well, do not retry it another way, and tell the user this session's mode is blocking Beezi's
scripts. If it starts with `✓`, continue.

Step 1 — sign in (opens the browser and waits until the user approves there). Run EXACTLY:

`node "<plugin-root>/scripts/login.mjs"`

Show its output except its LAST line, the machine line `account=<key>` (never shown): remember that
key; every later step passes it as `--account <key>`. If it says the machine is already linked as that
account, say so and still continue with Step 1w, so a changed plan is refreshed and an interrupted
upload resumes. If it prints no
`account=` line, show the output and STOP. If the sign-in fails with a network or connection error, do
not retry and do not continue: tell the user the sign-in could not reach Beezi, and that a sandboxed
session may block the network. A failed sign-in never removes an earlier authorization; if the output
says so, relay it verbatim and never tell the user they were logged out.

Step 1w — new folders. Run EXACTLY (for you only; do not show it):

`node "<plugin-root>/scripts/workspace.mjs" new-folders --account <key>`

Its last line is `new-folders=<ask|send|none> set=<yes|no> multi=yes account=<key>` for an account in
several workspaces, or `new-folders=n/a multi=no account=<key>`. Lines before it include
`W. <workspace> account=<key> tenant=<id> role=<role>`, one per workspace.

Only when the last line contains `set=no`, ask "Where should analytics go for repos and folders with
no rule yet?" with the choices "Ask me (recommended) — Beezi asks once per repo or folder, when a
session starts there", "Send to… — pick the workspaces that get them", "Don't send — nothing from a
repo or folder with no rule is uploaded".
- "Ask me" → run EXACTLY `node "<plugin-root>/scripts/workspace.mjs" new-folders ask --account <key>`
- "Don't send" → run EXACTLY `node "<plugin-root>/scripts/workspace.mjs" new-folders none --account <key>`
- "Send to…" → ask "Which workspaces should get analytics for repos and folders with no rule?" (several
  allowed), one choice per `W.` line: the workspace name (text after `W. ` up to ` account=`) — its
  `role=` value, or "Beezi workspace" when empty. Then run EXACTLY, with the chosen lines' `tenant=`
  values joined by commas (the template already single-quotes them, so PowerShell keeps them one argument):
  `node "<plugin-root>/scripts/workspace.mjs" new-folders send '<ids>' --account <key>`

Write the command's first line verbatim.

Then this session's own folder, only when the setting is now "Ask me" (the last line said
`new-folders=ask` and no `send`/`none` command just succeeded). Run EXACTLY (for you only):

`node "<plugin-root>/scripts/workspace.mjs" rules --account <key>`

Its `here:` line is `here: <short> (<label>) → <R<n> | no rule> account=<key> rule=<n|none> kind=<repo|folder|outside> match=<…>`.
Only when it has `rule=none`, ask the workspace question for it (see Step 5a) and run EXACTLY, with
`<ids>` = the chosen `tenant=` values joined by commas, or `none` when the last choice was picked:

`node "<plugin-root>/scripts/workspace.mjs" rule add --current --account <key> '<ids>'`

and write its first line verbatim. Steps 2–4 pick their workspaces themselves; pass no `--tenant`.

Step 2 — the Copilot plan. Run EXACTLY:

`node "<plugin-root>/scripts/billing-capture.mjs" --from-copilot --via login --account <key>`

It reads only non-secret account information from Copilot on this machine. Its first line is for the
user, followed by any change notices: write those verbatim. The `key=value` lines after them
(`source=`, `plan=`, `plan-source=`, `identity=`) are machine lines for you only — never show them.
Ask nothing and go to Step 4 unless the machine line is `plan-source=none`.

Step 3 — ask the plan, only when Step 2 printed the machine line `plan-source=none`. Ask "Which GitHub Copilot
plan pays for your Copilot use on this machine?" with the choices "Copilot Free", "Copilot Student",
"Copilot Pro", "Copilot Pro+", "Copilot Max", "Copilot Business — a seat from your organization",
"Copilot Enterprise — a seat from your enterprise", "I don't know". Map the answer:

| Answer | value |
|---|---|
| Copilot Free | `copilot_free` |
| Copilot Student | `copilot_student` |
| Copilot Pro | `copilot_pro` |
| Copilot Pro+ | `copilot_pro_plus` |
| Copilot Max | `copilot_max` |
| Copilot Business | `copilot_business` |
| Copilot Enterprise | `copilot_enterprise` |

Run EXACTLY ONCE: `node "<plugin-root>/scripts/billing-capture.mjs" --plan <value> --via login-user --account <key>`
and write its first line and any change notices verbatim (never its `key=value` machine lines). "I
don't know", a dismissal or any other answer runs nothing: say
the link succeeded, the plan stays unknown, and `/beezi-local-settings refresh` sets it later.

Step 4 — default account, only when Step 1's output contained `/beezi-local-analytics still reads from …`.
Ask "Make <the account from Step 1> the account /beezi-local-analytics reads from?" with "Yes" and "No".
Yes → run EXACTLY `node "<plugin-root>/scripts/accounts.mjs" use <key>` and write its output verbatim.
No → say the default is unchanged and `/beezi-local-settings account` switches it. Session tracking goes to
every linked account either way.

Step 5a — repos and folders with no rule. Run EXACTLY (for you only, except the line named below):

`node "<plugin-root>/scripts/workspace.mjs" routes --account <key>`

Lines: `W.` lines as above; `P<i>. <short> (<label>), <k> sessions account=<key> kind=<repo|folder|outside> match=<…>`
(one repo or folder; `P<i>. outside a project, …` is every past session in the home folder, `/` or a
temp folder); `P<i>-command=<command>` right after its `P` line, ending in a literal `<tenants>`;
`all-command=<command>`; `<n> other past sessions have no recorded folder and are not sent.` (for one
session: `1 other past session has no recorded folder and is not sent.`) — write that line verbatim,
once; `routes=<total>` last. `routes=0` → go to Step 5b.

More than 4 `P` lines → first ask "Where should analytics for these <N> repos and folders go?" with
"Send all <N> to the same workspaces… — pick the workspaces once for all of them", "Choose per repo —
one question per repo or folder", "Skip — nothing from them is sent this time; you're asked again next
time". "Send all" → ask "Which workspaces should get analytics for these <N> repos and folders?"
(several allowed, one choice per `W.` line) and run the `all-command=` text EXACTLY ONCE with the final
`<tenants>` replaced by the chosen `tenant=` values joined by commas inside one pair of single quotes, like `'<id>,<id>'`. "Choose per repo" → the per-repo
questions. "Skip" → Step 5b.

The workspace question (per `P` line, numbered `(i of N)`; several allowed): for `kind=repo` "(i of N)
Where should analytics for <short> go?" ending with "Don't track this repo"; for `kind=folder` "(i of N)
Where should analytics for <label> (and everything inside it) go?" ending with "Don't track this
folder"; for `kind=outside` "(i of N) Where should analytics for sessions outside a project folder
go?" ending with "Don't track these". Choices: one per `W.` line (name — role, or "Beezi workspace"),
then that last choice. For each answered `P` line run its `P<i>-command=` text EXACTLY ONCE, changing
only the final `<tenants>`: the chosen `tenant=` values joined by commas inside one pair of single quotes, like `'<id>,<id>'`, or `none` when the last
choice was picked (it wins). Never rebuild a command or re-quote its path. Write each command's first
line verbatim.

Step 5b — upload past sessions. This is always the last step. Run EXACTLY, with no other flags:

`node "<plugin-root>/scripts/backfill.mjs" --account <key> --via login`

It uploads this machine's Copilot CLI and VS Code Agent Host history once and can take minutes. Relay
its output verbatim. Nothing new to upload means the history is up to date. If some sessions were not
delivered, running /beezi-local-login again resumes. If it says the one-time import was already used, that is
final: do not retry, do not look for a way around it, and never add or suggest `--force`, `--since` or
`--dry-run`. Only when it reports the import finalized, tell the user to run /beezi-local-login on their other
machines before those finalize too.

If the Beezi tools are still missing afterwards, they appear within about 15 seconds; if not, run
/restart.
