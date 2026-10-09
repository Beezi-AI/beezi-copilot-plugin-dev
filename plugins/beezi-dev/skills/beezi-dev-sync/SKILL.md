---
name: beezi-dev-sync
description: Upload past Copilot CLI and VS Code Agent Host sessions to Beezi analytics, skipping what Beezi already has. Safe to run any number of times. Use when the user asks to sync or re-upload their Copilot history to Beezi, or when their Beezi analytics miss older sessions.
argument-hint: "[account email]"
allowed-tools: shell(node:*), ask_user
---

# Beezi: sync

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
`ask_user` at all: list the choices as a numbered list, stop, and tell the user to run the skill again
with their choice typed after the command.
In this skill only, if the preflight printed `mode=argument-only`, skip Step 1's questions (a skipped
question runs nothing) and go to Step 2.

Arguments: the text the user typed after the skill's slash command in the message that started this
skill; none if they typed only the command. When it names an account (an email or key), `<key>` below
is that account's key from `node "<plugin-root>/scripts/accounts.mjs"` (for you only).

Step 0 — run EXACTLY `node "<plugin-root>/scripts/preflight.mjs" --for sync`. If its first line
starts with `✗`, show it verbatim and STOP.

Step 1 — new workspaces, then repos and folders with no rule. In `mode=argument-only`, this step's
questions are skipped (as for the rest of Step 1).

First, new workspaces. Run EXACTLY (for you only; add `--account <key>` when the user named an
account):

`node "<plugin-root>/scripts/workspace.mjs" joined`

Lines:
- `<email>: you joined <names> — <N> repos or folders to review account=<key> new=<ids>` starts the
  block;
- `W. <workspace> account=<key> tenant=<id> new=<yes|no> role=<role>` is one per workspace, and
  `new=yes` is one just joined;
- `J<i>. <short> (<label>), <k> sessions, now: <where> account=<key> kind=<repo|folder|outside> match=<…> now=<ids|none|pending>`
  is one repo or folder, where `<where>` is where it sends today: workspace names, `not tracked` or
  `no rule yet`. `J<i>. outside a project, …` is sessions in the home folder, `/` or a temp folder;
- `J<i>-command=<command>` comes right after its `J` line and ends in a literal `<tenants>`;
- `add-all-command=<command>`;
- `done-command=<command>`;
- `joined=<total>` is last.

`joined=0` → go to "Then, repos and folders with no rule".

Per account with `J` lines (with several accounts, end each question with " (<email>)"):

More than 4 `J` lines → first ask "You joined <names>. Where should analytics for these <N> repos and
folders go?" (`<N>` = that account's number of `J` lines) with:
- "Add <names> to all <N> — repos you don't track, and ones with no rule yet, stay as they are";
- "Choose per repo — one question per repo or folder";
- "Leave them as they are — nothing changes, and you're not asked about <names> again".

"Add … to all" → run the `add-all-command=` text EXACTLY ONCE. "Choose per repo" → the per-repo
questions. "Leave them as they are" → run the `done-command=` text EXACTLY ONCE. No answer → nothing;
the next /beezi-dev-sync asks again.

The per-repo question (per `J` line, numbered `(i of N)` across that account's `J` lines, `N` = their
number; several allowed). This question counter restarts for each account; the printed `J` numbers are
global across accounts. Preserve each printed `J` number to match its command; never use the question
counter to look up a `J<i>-command`. `<where>` is the text after `now: ` up to ` account=`.
- For `kind=repo`: "(i of N) Now: <where>. Where should analytics for <short> go?", ending with
  "Don't track this repo".
- For `kind=folder`: "(i of N) Now: <where>. Where should analytics for <label> (and everything inside
  it) go?", ending with "Don't track this folder".
- For `kind=outside`: "(i of N) Now: <where>. Where should analytics for sessions outside a project
  folder go?", ending with "Don't track these".

Choices: one per `W.` line (name — role, or "Beezi workspace"; add ", new" for `new=yes`), then that
last choice.

For each answered `J` line, run its `J<i>-command=` text EXACTLY ONCE, changing only the final
`<tenants>`: the chosen `tenant=` values joined by commas inside one pair of single quotes, like
`'<id>,<id>'`, or `none` when the last choice was picked (it wins). After the last `J` question has
been answered (not skipped or dismissed), run the `done-command=` text EXACTLY ONCE; otherwise run no
`done-command`, and the next login or sync asks again. Never rebuild a command or re-quote its path.
Write each command's first line verbatim.

Then, repos and folders with no rule. Run EXACTLY (add `--account <key>` when the user named an
account): `node "<plugin-root>/scripts/workspace.mjs" routes`. Its output is for you only, except the
one line named below. For each account in several workspaces set to "Ask me", it prints a block:
`<email>: <N repos or folders have | 1 repo or folder has> past sessions with no rule (<M> sessions) account=<key>`; `W.`
lines (one per workspace: `W. <workspace> account=<key> tenant=<id> role=<role>`); `P<i>. <short>
(<label>), <k> sessions account=<key> kind=<repo|folder|outside> match=<…>` lines, each followed by
`P<i>-command=<command>` ending in a literal `<tenants>`; one `all-command=<command>`. Then
`<n> other past sessions have no recorded folder and are not sent.` (for one session: `1 other past
session has no recorded folder and is not sent.`) — write it verbatim, once — and last
`routes=<total>`. Not linked or `routes=0` → Step 2.

For each account with `P` lines (with several accounts, end every question with " (<email>)"):
- More than 4 `P` lines → ask "Where should analytics for these <N> repos and folders go?" with "Send
  all <N> to the same workspaces… — pick the workspaces once for all of them", "Choose per repo — one
  question per repo or folder", "Skip — nothing from them is sent this time; you're asked again next
  time". "Send all" → ask "Which workspaces should get analytics for these <N> repos and folders?"
  (several allowed, one choice per `W.` line of that account: name — role, or "Beezi workspace"), then
  run that account's `all-command=` text EXACTLY ONCE, changing only the final `<tenants>` to the chosen
  `tenant=` values joined by commas inside one pair of single quotes, like `'<id>,<id>'`. "Choose per repo" → the per-repo questions. "Skip" → next account.
- 4 or fewer → the per-repo questions: one per `P` line (several allowed), numbered "(i of N)":
  `kind=repo` "(i of N) Where should analytics for <short> go?" ending with "Don't track this repo";
  `kind=folder` "(i of N) Where should analytics for <label> (and everything inside it) go?" ending
  with "Don't track this folder"; `kind=outside` "(i of N) Where should analytics for sessions outside
  a project folder go?" ending with "Don't track these". Choices: one per `W.` line of that account,
  then that last choice.

For each answered `P` line run its `P<i>-command=` text EXACTLY ONCE, changing only the final
`<tenants>`: the chosen `tenant=` values joined by commas inside one pair of single quotes, like `'<id>,<id>'`, or `none` when the last choice was picked
(it wins). Never rebuild a command or re-quote its path. Write each command's first line verbatim.

Step 2 — sync. Run EXACTLY `node "<plugin-root>/scripts/sync.mjs"` with no flags. Add `--account <key>`
only when the user named an account, and `--account <key> --tenant '<id>[,<id>…]'` only when the user
asks to sync to specific workspaces — an override that sends every past session there, ignoring
rules. Never add or suggest any other flag (`--force`, `--since`, `--dry-run` are not offered). Write
its output verbatim as your reply text.

It resumes each session from what Beezi already has, so repeating it is safe. Output saying
"everything is already uploaded" is success: do not re-run it or look for flags to force it. "this
machine is not linked" → /beezi-dev-login. "does not support /beezi-dev-sync yet" → the Beezi server needs an
update; the history is not lost. A `Beezi (<account>): …` line says where that account's past
sessions go; "not sent this time" is expected after a skipped question — the next /beezi-dev-sync asks
again, and /beezi-dev-settings rules adds a rule from inside that repo or folder.
