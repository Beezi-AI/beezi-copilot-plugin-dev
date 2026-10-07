---
name: beezi-local-settings
description: Show and change Beezi settings — where each repo or folder sends its analytics (rules), the New folders default, the default account and the Copilot plan, crash reports, and Beezi's status line.
argument-hint: "[show | rules [show | add | remove <n>] | new-folders [show] | account [show] | refresh | telemetry [show | on | off | correlate | anonymous] | statusline [show | on | off]]"
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

## Show

Only when the arguments are empty (or name no section below), run EXACTLY
`node "<plugin-root>/scripts/settings.mjs"` and write its output verbatim as your reply text, before
anything else. Always run EXACTLY (for you only; do not show it):

`node "<plugin-root>/scripts/settings.mjs" keys`

It prints `menu=<label>|<label>…` (the sections that apply here); one
`account=<key> default=<yes|no> multi=<yes|no> workspaces=<n> status=<…> email=<email>` line per linked
account (no such line: nothing is linked; `multi=yes`: the account is in several workspaces;
`workspaces=<n>`: its known workspace count, `0` when not known yet); and
`crash=<correlate|on|anonymous|off> statusline=<on|off>`.

## Route

- `show` alone → run EXACTLY `node "<plugin-root>/scripts/settings.mjs" all`, write its output
  verbatim, and stop.
- `rules show`, `new-folders show`, `account show`, `telemetry show` or `statusline show` → run EXACTLY
  `node "<plugin-root>/scripts/settings.mjs" <section>` with `<section>` = `rules`, `new-folders`,
  `account`, or `privacy` (for telemetry and statusline), write its output verbatim, and stop.

Otherwise, by the first word of the arguments: `rules` → Rules (with the rest of the arguments);
`new-folders` → New folders; `account` → Account; `refresh` → Refresh my Copilot plan; `telemetry` or
`statusline` → Crash reports & status line (with the rest of the arguments). Nothing or anything else
→ ask "What do you want to change?" with one choice per `menu=` label, in its order and with exactly
its text, each followed by its description: Rules — "where each repo or folder sends its analytics";
New folders — "where analytics go for a repo or folder with no rule"; Account — "refresh your Copilot
plan" (plus "or pick the default account" when there are several `account=` lines); Crash reports &
status line — "plugin crash reports and Beezi's status line". Go to the chosen section; a dismissal
stops.

## Choosing the account (Rules and New folders)

Rules uses the `account=` lines with `multi=yes` or `workspaces=1`; New folders only those with
`multi=yes`. No `account=` line at all → say this machine is not linked and to run /beezi-local-login; stop.
None qualify → for New folders, say this setting applies only to an account in several workspaces; stop.
For Rules, say the account's workspaces are not known yet and to start a new Copilot session, then try
again; stop. Exactly one → use it. Several → ask "Whose rules?" (Rules) or "Whose New
folders setting?" (New folders), one choice per line labelled with its `email=`. `<key>` below is the
chosen line's `account=` value.

## The workspace question

Asked about one repo, folder, or the sessions outside a project folder; several answers allowed.
`<short>` is the name the line gives, `<label>` the text in parentheses right after it.

| `kind=` | Question | Last choice |
|---|---|---|
| `repo` | "Where should analytics for <short> go?" | "Don't track this repo" |
| `folder` | "Where should analytics for <label> (and everything inside it) go?" | "Don't track this folder" |
| `outside` | "Where should analytics for sessions outside a project folder go?" | "Don't track these" |

Choices: one per `W.` line — the workspace name (text after `W. ` up to ` account=`) — its `role=`
value, or "Beezi workspace" when empty; then the last choice — "Nothing from <short> is uploaded"
("Nothing from sessions outside a project folder is uploaded" for `outside`). When it changes an
existing rule, add ", current" after the workspaces in that rule's `tenants=` (or after the last
choice when `tenants=none`). `<ids>` = the chosen workspaces' `tenant=` values joined by commas, or
`none` when the last choice is picked (it wins over the others). Nothing chosen → run nothing.

## Rules

Choose the account, then run EXACTLY and write its output verbatim as your reply text:

`node "<plugin-root>/scripts/workspace.mjs" rules --table --account <key>`

Then run EXACTLY (for you only): `node "<plugin-root>/scripts/workspace.mjs" rules --account <key>`.
For an account in several workspaces, its lines: `W. <workspace> account=<key> tenant=<id> role=<role>`;
`R<n>. <short> (<label>) → <workspaces | not tracked> account=<key> rule=<n> kind=<…> tenants=<ids|none> match=<…>`;
`here: <short> (<label>) → <R<n> | no rule> account=<key> rule=<n|none> kind=<…> match=<…>`. For
a one-workspace account (`workspaces=1`) there are no `W.` lines: the first line reads
`<account>: <n> rule(s) account=<key> workspaces=1`, and each `R<n>.` line reads
`→ <not tracked | tracked>` in place of naming workspaces. A `kind=outside` line has no ` (<label>)`. `<here>` = the `here:` line's `<short>`, or "sessions outside a
project" for `kind=outside`. The `here:` rule is "its own" when that `R<n>.` line has the same `kind=`
and `match=`; otherwise it is a wider rule that covers this folder.

For a one-workspace account, use One-workspace rules, below, instead of the rest of this section.

By the rest of the arguments: `add` → Add; `remove <n>` → Remove rule `<n>` (drop a leading `R`);
`remove` → Remove; anything else → ask "What do you want to do with rules?" offering only what
applies, in this order: "Add a rule for <here>" (`rule=none`); "Change where <here> goes" (its own
rule; description = that `R<n>.` line up to ` account=`); "Change where <rule short> goes (covers
<here>)" and "Add a rule just for <here> — only <here> changes; R<n> keeps the rest" (a wider rule);
"Add a rule for another folder or repo…" — "pick a different repo or folder" (only when the `here:`
line does not name a wider rule, so `rule=none` or its own rule); "Change a rule" and "Remove a rule"
(any `R<n>.` line); "Done". "Done" or a dismissal stops.

- Add, or "Add a rule just for <here>" → the workspace question about the `here:` line, then run
  EXACTLY `node "<plugin-root>/scripts/workspace.mjs" rule add --current '<ids>' --account <key>`
- "Change where … goes" → the workspace question about the `R<n>.` line the `here:` line names, then
  run EXACTLY `node "<plugin-root>/scripts/workspace.mjs" rule set <n> '<ids>' --account <key>`
- "Change a rule" → pick a rule ("Which rule do you want to change?"), the workspace question about
  it, then the `rule set` command with its number.
- "Add a rule for another folder or repo…" → Typed target, below, then run EXACTLY, with the flag it
  picked and the `<ids>` from the workspace question it asks:
  `node "<plugin-root>/scripts/workspace.mjs" rule add --folder '<value>' '<ids>' --account <key>` or
  `node "<plugin-root>/scripts/workspace.mjs" rule add --repo '<value>' '<ids>' --account <key>`
- Remove → no `R<n>.` line: say the account has no rules; stop. A number that no line has: say there
  is no rule R<n>; stop. With a number, ask "Remove R<n> (<short>)?" with "Yes — delete the rule; new
  sessions there follow New folders" (for `workspaces=1`: "Yes — delete the rule; Beezi tracks it again
  unless another rule covers it") and "No — keep it"; only Yes goes on. Without one, pick a rule
  ("Which rule do you want to remove?"). Run EXACTLY
  `node "<plugin-root>/scripts/workspace.mjs" rule remove <n> --account <key>`

Picking a rule: one choice per `R<n>.` line, "R<n>. <short> — <text after `→ ` up to ` account=`>";
with only one line add "Cancel — change nothing". "Cancel" or a dismissal runs nothing. After
`rule add`, `rule set` or `rule remove`, write its first line verbatim.

### One-workspace rules

For an account with `workspaces=1` there is no workspace question anywhere. `<here>` and "its own
rule" are as defined above. By the rest of the arguments: `remove <n>` → Remove (above) with rule `<n>`;
`remove` → Remove; anything else, `add` included → ask "What do you want to do with rules?", offering
only the choices that apply, in this order:

- "Don't track <here>" — the `here:` line has `rule=none`, or names a rule shown `→ tracked`. Run
  EXACTLY `node "<plugin-root>/scripts/workspace.mjs" rule add --current none --account <key>`
- "Track <here> again" — `<here>`'s own rule is `not tracked`. Run EXACTLY, with that rule's number
  and without the Yes/No confirmation Remove uses:
  `node "<plugin-root>/scripts/workspace.mjs" rule remove <n> --account <key>`
- "Don't track another folder or repo…" — Typed target, below, then run EXACTLY, with the flag it
  picked: `node "<plugin-root>/scripts/workspace.mjs" rule add --folder '<value>' none --account <key>`
  or `node "<plugin-root>/scripts/workspace.mjs" rule add --repo '<value>' none --account <key>`.
  Offer it only when the `here:` line does not name a wider rule.
- "Remove a rule" — there is an `R<n>.` line; use Remove, above.
- "Done" — nothing else changes.

After any command, write its first line verbatim (a `✗` line too).

### Typed target

Ask in plain text, not with `ask_user`: "Which folder or repo? Reply with a folder path (like
~/work/client) or a repo URL." Then end your reply and wait for the answer. An empty reply or "cancel"
stops. A reply is a repo (`--repo`) only when it contains `://`, starts with `git@`, or does not start with
`/`, `~` or `.`, contains at least one `/`, and its first `/`-separated segment contains a dot (like
`github.com/org/repo`); everything else, `client.app` and a relative path like `work/client`
included, is a folder (`--folder`). `<value>` is the
reply trimmed; the templates already single-quote it, so first escape each `'` in the reply for the
shell you run the command in: in bash or sh replace it with `'\''`, in PowerShell replace it with `''`
(two single quotes) and also double each `‘`, `’`, `‚` and `‛` (PowerShell reads them as single quotes). For a one-workspace account that is all: run the calling step's command with `none`. For an
account in several workspaces, first ask the workspace question about it (`kind=` `folder` or `repo`
by the reply, `<label>` the typed folder, `<short>` its last path segment), then run the command with
the resulting `<ids>`. The script validates the value; show its first line verbatim, errors included.

## New folders

Run EXACTLY and write its output verbatim as your reply text:
`node "<plugin-root>/scripts/settings.mjs" new-folders`. Choose the account, then run EXACTLY (for you
only): `node "<plugin-root>/scripts/workspace.mjs" new-folders --account <key>` — a summary line,
`W.` lines, and last `new-folders=<ask|send|none> set=<yes|no> multi=yes account=<key>`.

Ask "For a repo or folder with no rule, where should analytics go?" with "Ask me — Beezi asks once per
repo or folder, when a session starts there", "Send to… — pick the workspaces that get them", "Don't
send — nothing from a repo or folder with no rule is uploaded"; add " (current)" to the one matching
`new-folders=`.
- "Ask me" → run EXACTLY `node "<plugin-root>/scripts/workspace.mjs" new-folders ask --account <key>`
- "Don't send" → run EXACTLY `node "<plugin-root>/scripts/workspace.mjs" new-folders none --account <key>`
- "Send to…" → ask "Which workspaces should get analytics for repos and folders with no rule?"
  (several allowed; choices as in the workspace question, without the last one), then run EXACTLY
  `node "<plugin-root>/scripts/workspace.mjs" new-folders send '<ids>' --account <key>`

Write the command's first line verbatim.

## Account

Run EXACTLY and write its output verbatim as your reply text:
`node "<plugin-root>/scripts/settings.mjs" account`. Then: no `account=` line → say this machine is
not linked and to run /beezi-local-login; stop. One → Refresh my Copilot plan. Several → ask "What do you
want to do?" with "Refresh my Copilot plan — re-read which Copilot plan pays for this machine" and
"Default account — pick which account /beezi-local-analytics reads from". A dismissal stops.

### Default account

Selectable accounts are the `account=` lines whose `status=` is not `revoked`. None → say every linked
account's authorization was revoked and to run /beezi-local-login; stop. One → use it without asking.
Several → ask "Which account should /beezi-local-analytics read from?", one choice per selectable line
labelled with its `email=` — "current default" when `default=yes`, else "linked account". Run EXACTLY
`node "<plugin-root>/scripts/accounts.mjs" use <key>` and write its output verbatim. Then say that
every linked account still receives this machine's analytics, and that /restart (or a new session)
makes the Beezi tools follow the new default.

### Refresh my Copilot plan

Use the default account unless the user named another; for another, add `--account <key>` to both
commands. Run EXACTLY `node "<plugin-root>/scripts/billing-capture.mjs" --from-copilot --via refresh`
and write its first line and any change notices verbatim; the `key=value` machine lines after them
(`source=`, `plan=`, `plan-source=`, `identity=`) are for you only and never shown. Unless the machine
line is `plan-source=none`, stop. Otherwise ask "Which
GitHub Copilot plan pays for your Copilot use on this machine?" with "Copilot Free", "Copilot Student",
"Copilot Pro", "Copilot Pro+", "Copilot Max", "Copilot Business — a seat from your organization",
"Copilot Enterprise — a seat from your enterprise", "I don't know". The value is `copilot_free`,
`copilot_student`, `copilot_pro`, `copilot_pro_plus`, `copilot_max`, `copilot_business` or
`copilot_enterprise` respectively. Run EXACTLY ONCE
`node "<plugin-root>/scripts/billing-capture.mjs" --plan <value> --via refresh-user` and write its
first line and any change notices verbatim (never the machine lines). "I don't know", a dismissal or
any other answer runs nothing; say the plan stays unknown.

## Crash reports & status line

Run EXACTLY and write its output verbatim as your reply text:
`node "<plugin-root>/scripts/settings.mjs" privacy`.

With a mode in the arguments, run it without asking, write its output verbatim, and stop:
- `telemetry on|off|correlate|anonymous` → `node "<plugin-root>/scripts/telemetry.mjs" <mode>`
- `statusline on` → `node "<plugin-root>/scripts/statusline-install.mjs"`
- `statusline off` → `node "<plugin-root>/scripts/statusline-install.mjs" --uninstall`

Otherwise ask these two questions, one after the other:
1. "How should Beezi crash reports work?" — "Correlate (recommended) — crash reports with an
   installation ID, so support can find yours", "On — crash reports without an installation ID",
   "Off — no crash reports; pending ones are deleted", "Anonymous — stay on, and delete the
   installation ID and the reports that carry it".
2. "Should Beezi's status line record the model, context use and allow-all state of your Copilot
   sessions?" — "On — your existing status line still looks the same", "Off".

When `keys` printed `statusline=unsupported`, ask only question 1, and for `statusline on|off` in the
arguments just show the `privacy` output. Add ", current setting" to the choice matching `crash=`
(`correlate`, `on`, `off`, `anonymous`) and the one matching `statusline=` (`on`, `off`). Then run only what changed: a different crash-report
answer → `node "<plugin-root>/scripts/telemetry.mjs" <correlate|on|off|anonymous>`; a different
status-line answer → `node "<plugin-root>/scripts/statusline-install.mjs"` for On, or with
`--uninstall` for Off. Write each output verbatim; when nothing changed, say the settings are
unchanged.

If the user asks what crash reports collect: plugin and Copilot versions, OS, and which plugin file
failed — never their code, prompts, file paths or repository names. Correlate is the recommended way
to turn them on; never talk the user out of On or Off.
