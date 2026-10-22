---
name: beezi-dev-login
description: Link a Beezi account to this machine with a browser sign-in, record which Copilot plan pays for it, and upload past Copilot sessions. Use when the user wants to log in, sign in or connect to Beezi, add another Beezi account, or when a Beezi tool says this machine is not linked. Run it again to add accounts or resume an interrupted upload.
argument-hint: "[pasted sign-in address | <n>]"
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
with the next step, except Step 1w's "Where should analytics from this machine go?", which Step 1w
lists as a numbered list before it stops. Never stop the login for any other question. Step 1p's
request for the pasted address is plain text, not an `ask_user` question, so it still happens in
`mode=argument-only`.

Step 0 — preflight, before anything else. Run EXACTLY:

`node "<plugin-root>/scripts/preflight.mjs" --for login`

If its first line starts with `✗`, show that line verbatim and STOP: run no other command. A login
that stops halfway leaves this machine half-linked. If the command itself is refused or cannot run,
STOP as well, do not retry it another way, and tell the user this session's mode is blocking Beezi's
scripts. If it starts with `✓`, continue.

Arguments. When the arguments are `--no-browser` or ask to sign in without a browser, go to Step 1p.
When they are one whole number, they answer Step 1w's question from an earlier run of this skill in
this conversation: go to Step 1w's "Answer by number". Any other non-empty arguments are the address
pasted back from a paste-back sign-in started earlier (Step 1p): skip Step 1 and the first command of
Step 1p, and run Step 1p's `--complete` command with the arguments as the reply (trimmed and escaped
the same way).

## How the steps run

Steps 1 to 5a come from ONE script, which runs them in order and stops at the first one that needs a
question:

`node "<plugin-root>/scripts/login-flow.mjs"`

Each step's output is a block: a `<name …>` line, the output, then a `</name>` line (the tag lines are
never shown). Its LAST line says what to do now: `next=<step> account=<key>`, or just `next=stop` when
the sign-in linked nothing (never shown either). `<key>` is the account just linked: remember it;
every later command passes it as `--account <key>`.

| `next=` | Go to | Then carry on with `--from` |
|---|---|---|
| `stop` | Step 1, the sign-in did not link an account | (nothing) |
| `setup` | Step 1w, where analytics from this machine go | `here` |
| `here` | Step 1w, this session's own folder | `plan` |
| `plan` | Step 3 and Step 3v | `default` |
| `default` | Step 4 | `joined` |
| `joined` | Step 5a, new workspaces | `routes` |
| `routes` | Step 5a, repos and folders with no rule | (Step 5b next) |
| `backfill` | Step 5b | (nothing) |

After a question's answer (or its dismissal, or a question skipped in `mode=argument-only`) and the
commands it calls for, carry on with EXACTLY this, `<step>` from the table's last column:

`node "<plugin-root>/scripts/login-flow.mjs" --account <key> --from <step>`

It prints the blocks of the steps from there on and a new `next=` line. A listing that fails shows a
`✗` line inside its block and the script goes on: write that line verbatim. Output that ends without
any `next=` line means the script itself failed or refused to run: show what it printed verbatim and
stop (running /beezi-dev-login again resumes safely). Never run the commands behind the blocks yourself
(`login.mjs`, `billing-capture.mjs --from-copilot`, the `workspace.mjs` `rules`, `joined` and `routes`
listings): the blocks hold their output. Before doing what `next=` says, write out what each block
printed this time calls for, in order, as its step below says (Step 1's sign-in output, Step 2's
capture lines, Step 5a's no-folder line).

Step 1 — sign in (opens the browser and waits until the user approves there). Go to Step 1p instead
when the user asks to sign in without a browser or on another device, or when this session runs where
no browser can open on this machine (an SSH session, a container, a Codespace, a VS Code Remote window).
Otherwise run `login-flow.mjs` with no arguments (above). Its `<sign-in>` block holds the sign-in's
output.

Show the `<sign-in>` block except the machine line `account=<key>` (never shown). If it says the
machine is already linked as that account, say so: the script still went on, so a changed plan is
refreshed and an interrupted upload resumes. On `next=stop`, show the block and STOP, except in the
case Step 1p covers. If the sign-in fails with a network or connection error, do not retry and do not
continue: tell the user the sign-in could not reach Beezi, and that a sandboxed session may block the
network. A failed sign-in never removes an earlier authorization; if the output says so, relay it
verbatim and never tell the user they were logged out.

Step 1p — paste-back sign-in. When Step 1 sends you here, when the user says the browser did not open,
or when Step 1 failed because the sign-in timed out or was never approved in the browser. This is the
one exception to "do not retry". Run EXACTLY:

`node "<plugin-root>/scripts/login.mjs" --no-browser`

Show its output except its last line, the machine line `login=pending` (never shown); that line is the
expected end here, not a failure. Then ask in plain text, not with `ask_user`: "Paste the full address
from your browser's address bar after signing in." End your reply and wait for the answer. An empty
reply or "cancel" stops here; the user can finish later with /beezi-dev-login followed by the address. Any
other reply is the pasted address: trim it and, because the template already single-quotes it, escape
each `'` in it for the shell you run the command in: in bash or sh replace it with `'\''`, in PowerShell
replace it with `''` (two single quotes) and also double each `‘`, `’`, `‚` and `‛`. Run EXACTLY ONCE,
with the escaped address in place of `<pasted>`:

`node "<plugin-root>/scripts/login.mjs" --complete '<pasted>'`

Show its output except its last line, `account=<key>` (never shown); without one, show the output and
STOP. With one, carry on with `--from setup`, which runs everything after the sign-in.

Step 1w — where analytics from this machine go. The script stops with `next=setup` only for an account
in several workspaces that has never set where repos and folders with no rule go. Without a `<setup>`
block, say nothing about it.

The `<setup account="<key>">` block is for you only: one `W. <workspace> account=<key> tenant=<id>
role=<role>` line per workspace, then `sessions=<N> places=<M>` (the past sessions the history upload
would send, and the repos and folders they ran in) or a `✗` line when they could not be counted (write
it verbatim), then the choices as `O<i>. <label> — <description>` lines. `O<i>` for `i` up to the
number of `W.` lines is the `i`-th `W.` line's workspace; the next `O` line is "Several workspaces…" and
the last `O` line is "Let me choose per repo".

Ask "Where should analytics from this machine go?" with one choice per `O` line, in order: its text
after `O<i>. `, exactly. In `mode=argument-only`, write that question and the same choices as a
numbered list instead, leaving out the "Several workspaces…" line: numbered 1, 2, … in order, so the
last number is "Let me choose per repo". Stop, and tell the user to run `/beezi-dev-login <n>` with the
number of their choice.

Answer by number (the arguments were one whole number `<n>`): after Step 0, take `<key>` from the
`<setup account="<key>">` block an earlier run printed in this conversation; when there is none, say
the number answers nothing here and start at Step 1 instead. Run
`node "<plugin-root>/scripts/login-flow.mjs" --account <key> --from setup`. When it ends with
`next=setup`, the answer is the `<n>`-th choice of that same list (the `O` lines without "Several
workspaces…"); a number past the list is a dismissal: ask nothing and go on below. Otherwise the
setting was made meanwhile: follow its `next=` line.

Then, by the answer:
- a workspace → run EXACTLY, with that `W.` line's `tenant=` value (the template already single-quotes
  it, so PowerShell keeps it one argument):
  `node "<plugin-root>/scripts/workspace.mjs" new-folders send '<id>' --account <key> --defer-upload`
- "Several workspaces…" → ask "Which workspaces should get analytics from this machine?" (several
  allowed, one choice per `W.` line: the workspace name — its `role=` value, or "Beezi workspace" when
  empty). End the question with " You can pick more than one: type their numbers separated by
  commas." Run EXACTLY, with the chosen `tenant=` values joined by commas (one chosen workspace is fine):
  `node "<plugin-root>/scripts/workspace.mjs" new-folders send '<id>,<id>' --account <key> --defer-upload`
  An empty, unmatched or dismissed answer runs nothing, and the next login asks again.
- "Let me choose per repo" → run EXACTLY `node "<plugin-root>/scripts/workspace.mjs" new-folders ask --account <key> --defer-upload`
- a dismissal, or a question skipped → run nothing; the next login asks again.

Write the command's first line verbatim, then carry on with `--from here`.

Then this session's own folder. The script checks it by itself whenever the setting is "Ask me", and
stops with `next=here` only when this folder has no rule. Then the `<rules account="<key>">` block
holds the `workspace.mjs rules` listing, for you only. Its `here:` line is
`here: <short> (<label>) → no rule now=<ids|pending|none> [path=<path>] account=<key> rule=none kind=<repo|folder|outside> match=<…>`.
`<short>` is the name the line gives, `<label>` the text in parentheses right after it. Ask (several
allowed), by its `kind=`:

| `kind=` | Question | Last choice |
|---|---|---|
| `repo` | "Where should analytics for <short>, the repo you're in, go?" | "Don't track <short>" |
| `folder` | "Where should analytics for <label>, the folder you're in (and everything inside it), go?" | "Don't track <short>" |
| `outside` | "Where should analytics for sessions outside a project folder go?" | "Don't track these" |

Choices: one per `W.` line of the block (name — role, or "Beezi workspace"), then the last choice —
"Not tracked: nothing from <short> is sent" ("Not tracked: nothing from sessions outside a project
folder is sent" for `outside`). Run EXACTLY, with `<ids>` = the chosen `tenant=` values joined by
commas, or `none` when the last choice is the whole answer:

`node "<plugin-root>/scripts/workspace.mjs" rule add --current --account <key> --defer-upload '<ids>'`

and write its first line verbatim. The last choice stands alone: when an answer has it together with a workspace, run nothing and ask the
same question once more, starting with `"Don't track" can't be combined with a workspace — pick one or the other.`
A second mixed answer is a dismissal. Nothing chosen or a skipped question runs nothing. Then carry on
with `--from plan`. Steps 2–4 pick their workspaces themselves; pass no `--tenant`.

Step 2 — the Copilot plan. The `<capture>` block is
`node "<plugin-root>/scripts/billing-capture.mjs" --from-copilot --via login --account <key>`'s output;
the script runs it on every login, including when the machine was already linked.

It reads only non-secret account information from Copilot on this machine. Its first lines are for the
user (a second `✓ Beezi billing for VS Code …` line appears when VS Code is signed in to another GitHub
account), followed by any change notices: write those verbatim. The `key=value` lines after them
(`source=`, `plan=`, `plan-source=`, `identity=`, and any `vscode-…=` lines) are machine lines for you
only — never show them. The script stops with `next=plan` only when a machine line is
`plan-source=none` or `vscode-plan-source=none`; otherwise it went on to Step 4.

Step 3 — ask the plan, only when the `<capture>` block has the machine line `plan-source=none`. Ask
"Which GitHub Copilot plan pays for your Copilot use on this machine?" with the choices "Copilot Free",
"Copilot Student", "Copilot Pro", "Copilot Pro+", "Copilot Max", "Copilot Business — a seat from your
organization", "Copilot Enterprise — a seat from your enterprise", "I don't know". Map the answer:

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
the link succeeded, the plan stays unknown, and `/beezi-dev-settings refresh` sets it later.

Step 3v — VS Code's account, only when the `<capture>` block has the machine line
`vscode-plan-source=none`. Ask
"VS Code's Copilot is signed in as <vscode-login>, a different GitHub account. Which Copilot plan does
<vscode-login> have?", where `<vscode-login>` is the value of the `vscode-login=` machine line, with the
same choices as Step 3, and map the answer the same way. Run EXACTLY ONCE, with `<vscode-identity>` the
value of the `vscode-identity=` machine line:
`node "<plugin-root>/scripts/billing-capture.mjs" --plan <value> --github <vscode-identity> --via login-user --account <key>`
and write its first line verbatim. "I don't know", a dismissal or any other answer runs nothing: say
that account's plan stays unknown and `/beezi-dev-settings refresh` sets it later.

Then carry on with `--from default`.

Step 4 — default account. The script stops with `next=default` only when another account stays the
one /beezi-dev-analytics reads from (Step 1's output said `/beezi-dev-analytics still reads from …`).
Ask "Make <the account from Step 1> the account /beezi-dev-analytics reads from?" with "Yes" and "No".
Yes → run EXACTLY `node "<plugin-root>/scripts/accounts.mjs" use <key>` and write its output verbatim.
No → say the default is unchanged and `/beezi-dev-settings account` switches it. Session tracking goes to
every linked account either way. Then carry on with `--from joined`.

Step 5a — new workspaces, then repos and folders with no rule. In `mode=argument-only`, skip the
new-workspace questions and run nothing for them.

First, new workspaces. The script stops with `next=joined` when the `<joined account="<key>">` block
(for you only) has something to review; it is
`node "<plugin-root>/scripts/workspace.mjs" joined --account <key> --defer-upload`'s output.

Lines:
- `<email>: you joined <names> — <N> repos or folders to review account=<key> new=<ids>` starts the
  block;
- `W. <workspace> account=<key> tenant=<id> new=<yes|no> role=<role>` is one per workspace, and
  `new=yes` is one just joined;
- `J<i>. <short> (<label>), <k> sessions, now: <where> account=<key> kind=<repo|folder|outside> match=<…> now=<ids|none|pending>`
  is one repo or folder, where `<where>` is where it sends today: workspace names, `not tracked` or
  `no rule yet`. `J<i>. outside a project, …` is sessions in the home folder, `/`, a temp folder or a Copilot app chat folder;
- `J<i>-command=<command>` comes right after its `J` line: the command that adds one new workspace to
  it, ending in a literal `<tenant>`;
- `add-all-command=<command>`;
- `done-command=<command>` records that the new workspaces were reviewed, and keeps unpicked repos and
  folders sending where they send now;
- `joined=<total>` is last.

More than 4 `J` lines → first ask "You joined <names>. Where should analytics for these <N> repos and
folders go? Their past sessions will be sent there too." with:
- "Add <names> to all <N> — repos you don't track, and ones with no rule yet, stay as they are";
- "Choose repos — pick which repos and folders go to each new workspace";
- "Leave them as they are — nothing changes, and you're not asked about <names> again".

"Add … to all" → run the `add-all-command=` text EXACTLY ONCE. "Choose repos" → the per-workspace
questions. "Leave them as they are" → run the `done-command=` text EXACTLY ONCE. No answer → nothing;
the next login or /beezi-dev-sync asks again.

4 or fewer `J` lines → the per-workspace questions.

Per-workspace questions: one `ask_user` question per `W.` line with `new=yes`, in order, where
`<name>` is that line's text after `W. ` up to ` account=`. Ask "Which repos and folders should also
send analytics to <name>? Their past sessions will be sent there too." Several allowed: number the
choices and end the question with " You can pick more than one: type their numbers separated by
commas." Choices: one per `J` line, in order, "<short> — Now: <where>" (or "<short> — No rule yet"
when `<where>` is `no rule yet`), where `<short>` is the `J` line's text after `J<i>. ` up to ` (` or
`,`, and `<where>` the text after `now: ` up to ` account=`; then last "None of these — nothing from
these goes to <name>". Preserve each printed `J` number to match its command; never use a choice
number to look up a `J<i>-command`.

For each picked `J` line, run its `J<i>-command=` text EXACTLY ONCE, changing only the final
`<tenant>`: that workspace's `tenant=` value inside single quotes, like `'<id>'`. "None of these"
stands alone: as the whole answer it runs no `J<i>-command` and still counts as an answer. An answer
with "None of these" together with a repo runs nothing and is not an answer: ask the same question
once more, starting with `"None of these" can't be combined with repos — pick one or the other.` A
second mixed answer is a dismissal. An empty or unmatched answer, or a dismissed question, is no answer and runs nothing.
After every new workspace's question has been answered, run the `done-command=` text EXACTLY ONCE;
otherwise run no `done-command`, and the next login or sync asks again. Never rebuild a command or re-quote its path. Write each command's first
line verbatim. Then carry on with `--from routes`.

Then, repos and folders with no rule. The `<routes account="<key>">` block (for you only, except the
line named below) is `node "<plugin-root>/scripts/workspace.mjs" routes --account <key> --defer-upload`'s
output; the script stops with `next=routes` when it lists any.

Lines: `W.` lines as in Step 1w; `P<i>. <short> (<label>), <k> sessions account=<key> kind=<repo|folder|outside> match=<…>`
(one repo or folder; `P<i>. outside a project, …` is every past session in the home folder, `/`, a
temp folder or a Copilot app chat folder); `P<i>-command=<command>` right after its `P` line, ending in a literal `<tenants>`;
`all-command=<command>`; `<n> other past sessions have no recorded folder and are not sent.` (for one
session: `1 other past session has no recorded folder and is not sent.`) — write that line verbatim,
once, whatever `next=` says; `routes=<total>` last.

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
then that last choice — "Not tracked: nothing from <short> is sent" ("Not tracked: nothing from
sessions outside a project folder is sent" for `outside`). For each answered `P` line run its `P<i>-command=` text EXACTLY ONCE, changing
only the final `<tenants>`: the chosen `tenant=` values joined by commas inside one pair of single quotes, like `'<id>,<id>'`, or `none` when the last
choice is the whole answer. The last choice stands alone: when an answer has it together with a workspace, run nothing and ask the same
question once more, starting with `"Don't track" can't be combined with a workspace — pick one or the other.`
A second mixed answer is a dismissal. Never rebuild a command or re-quote its path. Write each
command's first line verbatim. Then go to Step 5b.

Step 5b — upload past sessions. This is always the last step. Run EXACTLY, with no other flags:

`node "<plugin-root>/scripts/backfill.mjs" --account <key> --via login`

It uploads this machine's Copilot CLI and VS Code Agent Host history once and can take minutes. Relay
its output verbatim. Nothing new to upload means the history is up to date. If some sessions were not
delivered, running /beezi-dev-login again resumes. If it says the one-time import was already used, that is
final: do not retry, do not look for a way around it, and never add or suggest `--force`, `--since` or
`--dry-run`. Only when it reports the import finalized, tell the user to run /beezi-dev-login on their other
machines before those finalize too.

- `… to this workspace you joined` / `this workspace already has this machine's history` / `Some history
  did not reach this workspace this time…` — the upload for a workspace joined after this machine was
  linked; it resumes from what that workspace already has, like /beezi-dev-sync. Relay it; when history
  did not arrive, offer /beezi-dev-sync.

If the Beezi tools are still missing afterwards, they appear within about 15 seconds; if not, run
/restart.
