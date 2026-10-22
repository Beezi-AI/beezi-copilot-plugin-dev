---
name: beezi-dev-settings
description: Show and change Beezi settings — where each repo or folder sends its analytics (rules), the New folders default, the default account and the Copilot plan, crash reports, and Beezi's status line.
argument-hint: "[show | <n> | rules [show | add | remove <n>] | new-folders [show] | account [show] | refresh | undo | telemetry [show | on | off | correlate | anonymous] | statusline [show | on | off | badge on | badge off]]"
allowed-tools: shell(node:*), ask_user
---

# Beezi: settings

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

Arguments: the text the user typed after the skill's slash command in the message that started this skill; none if they typed only the command.

If any script below prints a line starting with `✗`, show that line verbatim and stop.

## Preflight

Unless the arguments are exactly `show` or a section followed by `show`, run EXACTLY first:

`node "<plugin-root>/scripts/preflight.mjs" --for settings`

If its first line starts with `✗`, show it verbatim and STOP.

## Read the settings: one command

Everything this skill reads comes from ONE command, picked by the first word of the arguments. Run it
once, right after the preflight, and take everything below from its output: never run it again, nor
another command to read settings. The commands below only change settings or refresh the plan, except
the Picker's `places` listing, which reads the recent repos and folders to pick from.

| First word of the arguments | Run EXACTLY |
|---|---|
| `show` alone | `node "<plugin-root>/scripts/settings.mjs" all` |
| `rules` | `node "<plugin-root>/scripts/settings.mjs" rules` |
| `new-folders` | `node "<plugin-root>/scripts/settings.mjs" new-folders` |
| `account` | `node "<plugin-root>/scripts/settings.mjs" account` |
| `telemetry` or `statusline`, alone or + `show` | `node "<plugin-root>/scripts/settings.mjs" privacy` |
| `telemetry <mode>`, `statusline on`/`off` or `statusline badge on`/`off` | nothing: go to Crash reports & status line |
| `refresh` | nothing: go to Refresh my Copilot plan |
| `undo` | nothing: go to Undo my last change |
| a number, nothing, or anything else | `node "<plugin-root>/scripts/settings.mjs"` |

Its output is blocks, each from a `<name …>` line to its `</name>` line:

- `<show>` — always first. Write its lines (not the tag lines) verbatim as your reply's first text.
- `<keys>` — for you only: `menu=<label>|<label>…` (the sections that apply here); one
  `account=<key> default=<yes|no> multi=<yes|no> workspaces=<n> status=<…> email=<email>` line per
  linked account (no such line: nothing is linked; `multi=yes`: the account is in several workspaces;
  `workspaces=<n>`: its known workspace count, `0` when not known yet); and
  `crash=<correlate|on|anonymous|off> statusline=<on|off> badge=<on|off>` (`badge=on`: the status line
  ends with the Beezi badge; it counts only with `statusline=on`).
- `<labels>` — with the menu read only: one line per `menu=` label, in the same order, the label with
  its current state (like `Rules: here → Alpha`, `New folders: ask me`, `Account: 2 linked`). These are
  the menu's choices.
- `<rules account="<key>">` — with the menu read or `rules`, one per account whose workspaces are
  known: that account's rule lines, for you only; see Rules.
- `<here-card account="<key>">` — with the menu read or `rules`, one per such account when this folder
  is known: where you are and where its analytics go now. Shown only where Rules says so.
- `<new-folders account="<key>">` — with the menu read or `new-folders`, one per account in several
  workspaces: its New folders lines, for you only; see New folders.

Only `<show>` and, where Rules says so, a `<here-card>` are ever shown.

## Route

First, `show` prints the current settings and changes nothing: `show` alone, or a section followed by
`show` (`rules show`, `new-folders show`, `account show`, `telemetry show` or `statusline show`) → the
`<show>` lines are the whole reply; stop.

Otherwise, by the first word of the arguments: `rules` → Rules (with the rest of the arguments);
`new-folders` → New folders; `account` → Account; `refresh` → Refresh my Copilot plan; `undo` → Undo my last change;
`telemetry` or `statusline` → Crash reports & status line (with the rest of the arguments). A number
`<n>` (the answer to the menu below, typed after the command) → the section of the n-th `menu=`
label, without asking the menu again; a number with no such label → the menu.

Nothing or anything else → ask "What do you want to change?" with one choice per `<labels>` line, in
its order and with exactly its text, each followed by its description. The n-th `<labels>` line is the
n-th `menu=` label's section: the description and the section you go to follow that `menu=` label.
Descriptions: Rules — "where each repo or folder sends its analytics"; New folders — "where analytics
go for a repo or folder with no rule"; Account — "refresh your Copilot plan" (plus "or pick the
default account" when there are several `account=` lines); Crash reports & status line — "plugin
crash reports and Beezi's status line". In `mode=argument-only`, write the `<labels>` lines as a
numbered list instead, stop, and tell the user to run `/beezi-dev-settings <n>` with the number of their
choice. Go to the chosen section; a dismissal stops.

Every section below works from the blocks of this one read.

## Undo my last change

Every change's confirmation ends with " Undo: /beezi-dev-settings undo"; this is where that lands.
Run EXACTLY `node "<plugin-root>/scripts/workspace.mjs" undo`. Its output ends with `undone=1` (the
last change was undone) or `undone=0` (nothing was undone): either way, write its first line verbatim
and stop. Output with a `✗` line and no `undone=` line means nothing changed: write the `✗` line
verbatim and stop.

## Choosing the account (Rules and New folders)

Rules uses the `account=` lines with `multi=yes` or `workspaces=1`; New folders only those with
`multi=yes`. No `account=` line at all → say this machine is not linked and to run /beezi-dev-login; stop.
None qualify → for New folders, say this setting applies only to an account in several workspaces; stop.
For Rules, say the account's workspaces are not known yet and to start a new Copilot session, then try
again; stop. Exactly one → use it. Several → ask "Whose rules?" (Rules) or "Whose New
folders setting?" (New folders), one choice per line labelled with its `email=`. `<key>` below is the
chosen line's `account=` value.

## The workspace question

Asked about one repo, folder, or the sessions outside a project folder; several answers allowed.
`<short>` is the name the line gives, `<label>` the text in parentheses right after it.

About the `here:` line (the repo or folder you're in):

| `kind=` | Question | Last choice |
|---|---|---|
| `repo` | "Where should analytics for <short>, the repo you're in, go?" | "Don't track <short>" |
| `folder` | "Where should analytics for <label>, the folder you're in (and everything inside it), go?" | "Don't track <short>" |
| `outside` | "Where should analytics for sessions outside a project folder go?" | "Don't track these" |

About an `R<n>.` line, an `F<i>.` line (Picker, below) or a typed target:

| `kind=` | Question | Last choice |
|---|---|---|
| `repo` | "Where should analytics for <short> go?" | "Don't track this repo" |
| `folder` | "Where should analytics for <label> (and everything inside it) go?" | "Don't track this folder" |
| `outside` | "Where should analytics for sessions outside a project folder go?" | "Don't track these" |

Choices: one per `W.` line — the workspace name (text after `W. ` up to ` account=`) — its `role=`
value, or "Beezi workspace" when empty; then the last choice — "Not tracked: nothing from <short> is sent"
("Not tracked: nothing from sessions outside a project folder is sent" for `outside`). When it changes an
existing rule, add ", current" after the workspaces in that rule's `tenants=` (or after the last
choice when `tenants=none`). `<ids>` = the chosen workspaces' `tenant=` values joined by commas, or
`none` when the last choice is the whole answer.
The last choice stands alone: when an answer has it together with a workspace, run nothing and ask the
same question once more, starting with `"Don't track" can't be combined with a workspace — pick one or the other.`
A second mixed answer is a dismissal. Nothing chosen → run nothing.

## Rules

Choose the account. Its lines are the `<rules account="<key>">` block, for you only, and its card is
the `<here-card account="<key>">` block (none when this folder is not known, or when live tracking is
off for a one-workspace account).

For an account in several workspaces, its lines: `W. <workspace> account=<key> tenant=<id> role=<role>`;
`R<n>. <short> (<label>) → <workspaces | not tracked> account=<key> rule=<n> kind=<…> tenants=<ids|none> match=<…>`;
`here: <short> (<label>) → <R<n> | no rule> now=<ids|pending|none> [path=<path>] account=<key> rule=<n|none> kind=<…> match=<…>`
(`path=` only for a repo or folder). For
a one-workspace account (`workspaces=1`) there are no `W.` lines: the first line reads
`<account>: <n> rule(s) account=<key> workspaces=1`, and each `R<n>.` line reads
`→ <not tracked | tracked>` in place of naming workspaces. A `kind=outside` line has no ` (<label>)`. `<here>` = the `here:` line's `<short>`, or "sessions outside a
project" for `kind=outside`. The `here:` rule is "its own" when that `R<n>.` line has the same `kind=`
and `match=`; otherwise it is a wider rule that covers this folder.

In `mode=argument-only`, Rules only shows, for both kinds of account, and this wins over the
numbered-list rule at the top: without asking "Whose rules?", show each qualifying account's card (its
lines verbatim, when there is one) after the rules table, which is the `<show>` block the `rules` read
already printed (after the menu read, say instead that `/beezi-dev-settings rules show` prints the rules
table). Then stop. Ask nothing and list no choices: no rules question, no workspace question, no
Picker or typed target, and no Remove confirmation, with or without a rule number; run no
`workspace.mjs` command. Say plainly that changing a rule needs an
attended session, one where Beezi can ask you questions: run `/beezi-dev-settings rules` there.

For a one-workspace account, use One-workspace rules, below, instead of the rest of this section.

By the rest of the arguments: `add` → Add; `remove <n>` → Remove rule `<n>` (drop a leading `R`);
`remove` → Remove; anything else → show the card first (its lines verbatim, when there is one), then
ask "What do you want to do with rules?" offering only what
applies, in this order: "Add a rule for <here>" (`rule=none`); "Change where <here> goes" (its own
rule; description = that `R<n>.` line up to ` account=`); "Change where <rule short> goes (covers
<here>)" and "Add a rule just for <here> — only <here> changes; R<n> keeps the rest" (a wider rule);
"Add a rule for another folder or repo… — pick a different repo or folder" (only when the `here:`
line does not name a wider rule, so `rule=none` or its own rule); "Change a rule" and "Remove a rule"
(any `R<n>.` line); "Close". "Close" or a dismissal stops.

- Add, or "Add a rule just for <here>" → the workspace question about the `here:` line, then run
  EXACTLY `node "<plugin-root>/scripts/workspace.mjs" rule add --current '<ids>' --account <key>`
- "Change where … goes" → the workspace question about the `R<n>.` line the `here:` line names, then
  run EXACTLY `node "<plugin-root>/scripts/workspace.mjs" rule set <n> '<ids>' --account <key>`
- "Change a rule" → pick a rule ("Which rule do you want to change?"), the workspace question about
  it, then the `rule set` command with its number.
- "Add a rule for another folder or repo…" → Picker, below.
- Remove → no `R<n>.` line: say the account has no rules; stop. A number that no line has: say there
  is no rule R<n>; stop. With a number, ask "Remove R<n> (<short>)?" with
  "Yes — delete the rule. New sessions there follow the default" (for `workspaces=1`:
  "Yes — delete the rule. It's tracked again unless another rule covers it") and "No — keep it"; only
  Yes goes on. Without one, pick a rule
  ("Which rule do you want to remove?"). Run EXACTLY
  `node "<plugin-root>/scripts/workspace.mjs" rule remove <n> --account <key>`

Picking a rule: one choice per `R<n>.` line, "R<n>. <short> — <text after `→ ` up to ` account=`>";
with only one line add "Cancel — change nothing". "Cancel" or a dismissal runs nothing. After
`rule add`, `rule set` or `rule remove`, write its first line verbatim (it ends with " Undo:
/beezi-dev-settings undo" when there is a change to undo).

### One-workspace rules

For an account with `workspaces=1` there is no workspace question anywhere. `<here>` and "its own
rule" are as defined above. By the rest of the arguments: `remove <n>` → Remove (above) with rule `<n>`;
`remove` → Remove; anything else, `add` included → show the card first (its lines verbatim, when there
is one), then ask "What do you want to do with rules?", offering only the choices that apply, in this
order:

- "Don't track <here>" — the `here:` line has `rule=none`, or names a rule shown `→ tracked`. Run
  EXACTLY `node "<plugin-root>/scripts/workspace.mjs" rule add --current none --account <key>`
- "Track <here> again" — `<here>`'s own rule is `not tracked`. Run EXACTLY, with that rule's number
  and without the Yes/No confirmation Remove uses:
  `node "<plugin-root>/scripts/workspace.mjs" rule remove <n> --account <key>`
- "Stop tracking another folder" — "pick a repo or folder with recent sessions"; Picker, below. Offer
  it only when the `here:` line does not name a wider rule.
- "Remove a rule" — there is an `R<n>.` line; use Remove, above.
- "Close" — nothing else changes.

After any command, write its first line verbatim (a `✗` line too; it ends with " Undo:
/beezi-dev-settings undo" when there is a change to undo).

### Picker

For "Stop tracking another folder" (one workspace) and "Add a rule for another folder or repo…"
(several workspaces). Run EXACTLY (for you only):

`node "<plugin-root>/scripts/workspace.mjs" places --account <key>`

It prints a header line, then up to 3 places, each
`F<i>. <short> (<label>), <n> sessions account=<key> kind=<repo|folder|outside> match=<…>` (a
`kind=outside` line has no ` (<label>)`) followed by its own `F<i>-command=<command>` line, whose
command ends in a literal `<tenants>`; last `places=<n>`.

- `places=0` → Typed target, below.
- Otherwise ask "Which repo or folder should Beezi stop tracking?" (one workspace) or "Which repo or
  folder do you want a rule for?" (several), one choice per `F<i>.` line, "<short> — <label>, <n>
  sessions" (for `kind=outside`: "sessions outside a project — <n> sessions"), then "Another folder
  or repo… — type a folder path or a repo URL" and "Cancel — change nothing". "Another folder or
  repo…" → Typed target. "Cancel" or a dismissal runs nothing.
- A picked `F<i>.` line: for one workspace, run its `F<i>-command=` value with `<tenants>` replaced
  by `none`; for several, ask the workspace question about that `F<i>.` line, then run its
  `F<i>-command=` value with `<tenants>` replaced by `'<ids>'`. Never rebuild the command. Write its
  first line verbatim.

### Typed target

Ask in plain text, not with `ask_user`: "Which folder or repo? Reply with a folder path (like
~/work/client) or a repo URL." Then end your reply and wait for the answer. An empty reply or "cancel"
stops. A reply is a repo (`--repo`) only when it contains `://`, starts with `git@`, or does not start with
`/`, `~` or `.`, contains at least one `/`, and its first `/`-separated segment contains a dot (like
`github.com/org/repo`); everything else, `client.app` and a relative path like `work/client`
included, is a folder (`--folder`). `<value>` is the
reply trimmed; the templates already single-quote it, so first escape each `'` in the reply for the
shell you run the command in: in bash or sh replace it with `'\''`, in PowerShell replace it with `''`
(two single quotes) and also double each `‘`, `’`, `‚` and `‛` (PowerShell reads them as single quotes). For a one-workspace account that is all: run EXACTLY, with the flag it picked,
`node "<plugin-root>/scripts/workspace.mjs" rule add --folder '<value>' none --account <key>` or
`node "<plugin-root>/scripts/workspace.mjs" rule add --repo '<value>' none --account <key>`. For an
account in several workspaces, first ask the workspace question about it (`kind=` `folder` or `repo`
by the reply, `<label>` the typed folder, `<short>` its last path segment), then run EXACTLY
`node "<plugin-root>/scripts/workspace.mjs" rule add --folder '<value>' '<ids>' --account <key>` or
`node "<plugin-root>/scripts/workspace.mjs" rule add --repo '<value>' '<ids>' --account <key>`. The script validates the value; show its first line verbatim, errors included.

## New folders

Choose the account. Its lines are the `<new-folders account="<key>">` block, for you only: a summary
line, `W.` lines, and last `new-folders=<ask|send|none> set=<yes|no> multi=yes account=<key>`.

Ask "For a repo or folder with no rule, where should analytics go?" with "Ask me — Beezi asks once per
repo or folder, when a session starts there", "Send to… — pick the workspaces that get them", "Don't
send — nothing from a repo or folder with no rule is sent"; add " (current)" to the one matching
`new-folders=`.
- "Ask me" → run EXACTLY `node "<plugin-root>/scripts/workspace.mjs" new-folders ask --account <key>`
- "Don't send" → run EXACTLY `node "<plugin-root>/scripts/workspace.mjs" new-folders none --account <key>`
- "Send to…" → ask "Which workspaces should get analytics for repos and folders with no rule?"
  (several allowed; choices as in the workspace question, without the last one), then run EXACTLY
  `node "<plugin-root>/scripts/workspace.mjs" new-folders send '<ids>' --account <key>`

Write the command's first line verbatim.

## Account

No `account=` line → say this machine is
not linked and to run /beezi-dev-login; stop. One → Refresh my Copilot plan. Several → ask "What do you
want to do?" with "Refresh my Copilot plan — re-read which Copilot plan pays for this machine" and
"Default account — pick which account /beezi-dev-analytics reads from". A dismissal stops.

### Default account

Selectable accounts are the `account=` lines whose `status=` is not `revoked`. None → say every linked
account's authorization was revoked and to run /beezi-dev-login; stop. One → use it without asking.
Several → ask "Which account should /beezi-dev-analytics read from?", one choice per selectable line
labelled with its `email=` — "current default" when `default=yes`, else "linked account". Run EXACTLY
`node "<plugin-root>/scripts/accounts.mjs" use <key>` and write its output verbatim. Then say that
every linked account still receives this machine's analytics, and that /restart (or a new session)
makes the Beezi tools follow the new default.

### Refresh my Copilot plan

Use the default account unless the user named another; for another, add `--account <key>` to both
commands. Run EXACTLY `node "<plugin-root>/scripts/billing-capture.mjs" --from-copilot --via refresh`
and write its first lines (a second `✓ Beezi billing for VS Code …` line appears when VS Code is signed
in to another GitHub account) and any change notices verbatim; the `key=value` machine lines after them
(`source=`, `plan=`, `plan-source=`, `identity=`, and any `vscode-…=` lines) are for you only and never
shown. Unless a machine line is `plan-source=none` or `vscode-plan-source=none`, stop.

Only when `plan-source=none`: ask "Which
GitHub Copilot plan pays for your Copilot use on this machine?" with "Copilot Free", "Copilot Student",
"Copilot Pro", "Copilot Pro+", "Copilot Max", "Copilot Business — a seat from your organization",
"Copilot Enterprise — a seat from your enterprise", "I don't know". The value is `copilot_free`,
`copilot_student`, `copilot_pro`, `copilot_pro_plus`, `copilot_max`, `copilot_business` or
`copilot_enterprise` respectively. Run EXACTLY ONCE
`node "<plugin-root>/scripts/billing-capture.mjs" --plan <value> --via refresh-user` and write its
first line and any change notices verbatim (never the machine lines). "I don't know", a dismissal or
any other answer runs nothing; say the plan stays unknown.

Then, only when `vscode-plan-source=none`: ask "VS Code's Copilot is signed in as <vscode-login>, a
different GitHub account. Which Copilot plan does <vscode-login> have?", where `<vscode-login>` is the
value of the `vscode-login=` machine line, with the same choices and values. Run EXACTLY ONCE, with
`<vscode-identity>` the value of the `vscode-identity=` machine line,
`node "<plugin-root>/scripts/billing-capture.mjs" --plan <value> --github <vscode-identity> --via refresh-user`
and write its first line verbatim. "I don't know", a dismissal or any other answer runs nothing; say
that account's plan stays unknown.

## Crash reports & status line

With a mode in the arguments, run it without asking (no read ran first), write its output verbatim,
and stop:
- `telemetry on|off|correlate|anonymous` → `node "<plugin-root>/scripts/telemetry.mjs" <mode>`
- `statusline on` → `node "<plugin-root>/scripts/statusline-install.mjs"`
- `statusline off` → `node "<plugin-root>/scripts/statusline-install.mjs" --uninstall`
- `statusline badge on` or `statusline badge off` → `node "<plugin-root>/scripts/settings.mjs" set badge=<on|off>`

Otherwise ask these two questions, one after the other:
1. "How should Beezi crash reports work?" — "Correlate (recommended) — crash reports with an
   installation ID, so support can find yours", "On — crash reports without an installation ID",
   "Off — no crash reports; pending ones are deleted", "Anonymous — stay on, and delete the
   installation ID and the reports that carry it".
2. "Should Beezi's status line record the model, context use and allow-all state of your Copilot
   sessions?" — "On — your existing status line still looks the same", then, only when
   `statusline=on`, "On, with a Beezi badge — also shows where this folder's analytics go, like
   Beezi → Acme, at the end of your status line", then "Off".

Add ", current setting" to the choice matching `crash=`
(`correlate`, `on`, `off`, `anonymous`) and the one matching `statusline=` and `badge=`
(`statusline=on badge=off` → "On", `statusline=on badge=on` → "On, with a Beezi badge",
`statusline=off` → "Off"). Then run only what changed: a different crash-report
answer → `node "<plugin-root>/scripts/telemetry.mjs" <correlate|on|off|anonymous>`; for the status
line, "Off" from either On → `node "<plugin-root>/scripts/statusline-install.mjs" --uninstall`; "On" from
Off → `node "<plugin-root>/scripts/statusline-install.mjs"`; "On, with a Beezi badge" from "On" →
`node "<plugin-root>/scripts/settings.mjs" set badge=on`; "On" from "On, with a Beezi badge" →
`node "<plugin-root>/scripts/settings.mjs" set badge=off`. Write each output verbatim; when nothing
changed, say the settings are unchanged.

If the user asks what crash reports collect: plugin and Copilot versions, OS, and which plugin file
failed — never their code, prompts, file paths or repository names. Correlate is the recommended way
to turn them on; never talk the user out of On or Off.
