---
name: beezi-staging-sync
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
In this skill only, if the preflight printed `mode=argument-only`, skip Step 1 (run nothing from it)
and go to Step 2.

Arguments: the text the user typed after the skill's slash command in the message that started this
skill; none if they typed only the command. When it names an account (an email or key), `<key>` below
is that account's key from `node "<plugin-root>/scripts/accounts.mjs"` (for you only).

Step 0 — run EXACTLY `node "<plugin-root>/scripts/preflight.mjs" --for sync`. If its first line
starts with `✗`, show it verbatim and STOP.

Step 1 — new workspaces, then repos and folders with no rule, then the sync. In
`mode=argument-only`, skip this step and go to Step 2.

Run EXACTLY this one command (add `--account <key>` when the user named an account, and Step 2's
`--tenant` override when the user asked for it):

`node "<plugin-root>/scripts/sync.mjs" --review`

It prints a `<joined>` block (new workspaces, below) and stops there when that block's last line is
not `joined=0`. Otherwise it prints a `<routes>` block (repos and folders with no rule, below) and
stops there when its last line is not `routes=0`. Its last listing line, `review=<n>`, is for you
only: the number of `J` or `P` lines waiting for an answer. On `review=0` it goes straight on
to the sync: everything after that line is Step 2's output, and no other command runs. A listing that
fails shows a `✗` line inside its block instead and counts as nothing to ask: write that line
verbatim.

First, new workspaces: the `<joined>` block is what `workspace.mjs joined --defer-upload` prints, for
you only.

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

`joined=0` → go to "Then, repos and folders with no rule".

Run the printed commands unchanged; whatever they route gets its history uploaded.

Per account with `J` lines (with several accounts, add " (<email>)" right after each question's "go?",
or after "<name>?" in the per-workspace questions):

More than 4 `J` lines → first ask "You joined <names>. Where should analytics for these <N> repos and
folders go? Their past sessions will be sent there too." (`<N>` = that account's number of `J` lines) with:
- "Add <names> to all <N> — repos you don't track, and ones with no rule yet, stay as they are";
- "Choose repos — pick which repos and folders go to each new workspace";
- "Leave them as they are — nothing changes, and you're not asked about <names> again".

"Add … to all" → run the `add-all-command=` text EXACTLY ONCE. "Choose repos" → the per-workspace
questions. "Leave them as they are" → run the `done-command=` text EXACTLY ONCE. No answer → nothing;
the next /beezi-staging-sync asks again.

4 or fewer `J` lines → the per-workspace questions.

Per-workspace questions: one `ask_user` question per `W.` line with `new=yes` of that account, in
order, where `<name>` is that line's text after `W. ` up to ` account=`. Ask "Which repos and folders
should also send analytics to <name>? Their past sessions will be sent there too." Several allowed:
number the choices and end the question with " You can pick more than one: type their numbers
separated by commas." Choices: one per `J` line of that account, in order, "<short> — Now: <where>"
(or "<short> — No rule yet" when `<where>` is `no rule yet`), where `<short>` is the `J` line's text
after `J<i>. ` up to ` (` or `,`, and `<where>` the text after `now: ` up to ` account=`; then last
"None of these — nothing from these goes to <name>". The printed `J` numbers are global across
accounts and the choice numbers are not: preserve each printed `J` number to match its command; never
use a choice number to look up a `J<i>-command`.

For each picked `J` line, run its `J<i>-command=` text EXACTLY ONCE, changing only the final
`<tenant>`: that workspace's `tenant=` value inside single quotes, like `'<id>'`. "None of these"
stands alone: as the whole answer it runs no `J<i>-command` and still counts as an answer. An answer
with "None of these" together with a repo runs nothing and is not an answer: ask the same question
once more, starting with `"None of these" can't be combined with repos — pick one or the other.` A
second mixed answer is a dismissal. An empty or unmatched answer, or a dismissed question, is no answer and runs nothing.
After every new workspace's question has been answered, run the `done-command=` text EXACTLY ONCE;
otherwise run no `done-command`, and the next login or sync asks again. Never rebuild a command or re-quote its path. Write each command's first
line verbatim.

Then, repos and folders with no rule. Run nothing for them after `joined=0`: the Step 1 command
already printed the `<routes>` block. After the `J` questions (answered or not) and their commands,
run EXACTLY, with the same `--account` and `--tenant` as the Step 1 command:
`node "<plugin-root>/scripts/sync.mjs" --review-routes`. It prints the `<routes>` block and
`review=<n>`, and on `review=0` goes straight on to the sync as the Step 1 command does. The
`<routes>` block is what `workspace.mjs routes --defer-upload` prints. It is for you only, except the
one line named below. For each account in several workspaces set to "Ask me", it prints a block:
`<email>: <N repos or folders have | 1 repo or folder has> past sessions with no rule (<M> sessions) account=<key>`; `W.`
lines (one per workspace: `W. <workspace> account=<key> tenant=<id> role=<role>`); `P<i>. <short>
(<label>), <k> sessions account=<key> kind=<repo|folder|outside> match=<…>` lines, each followed by
`P<i>-command=<command>` ending in a literal `<tenants>`; one `all-command=<command>`. Then
`<n> other past sessions have no recorded folder and are not sent.` (for one session: `1 other past
session has no recorded folder and is not sent.`) — write it verbatim, once — and last
`routes=<total>`. Not linked or `routes=0` → nothing to ask: the sync already ran in the same call; go
to Step 2 for its output.

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
  then that last choice — "Not tracked: nothing from <short> is sent" ("Not tracked: nothing from
  sessions outside a project folder is sent" for `outside`).

For each answered `P` line run its `P<i>-command=` text EXACTLY ONCE, changing only the final
`<tenants>`: the chosen `tenant=` values joined by commas inside one pair of single quotes, like `'<id>,<id>'`, or `none` when the last choice is the whole answer.
The last choice stands alone: when an answer has it together with a workspace, run nothing and ask
the same question once more, starting with `"Don't track" can't be combined with a workspace — pick one or the other.` A second
mixed answer is a dismissal. Never rebuild a command or re-quote its path. Write each command's first
line verbatim.

Step 2 — sync. When the last listing printed `review=0`, the sync already ran: its output is
everything after that `review=0` line, so write it verbatim as your reply text and run nothing more.
Otherwise — after the `P` questions (answered or not) and their commands, or in `mode=argument-only`
— run EXACTLY `node "<plugin-root>/scripts/sync.mjs"` with no flags. Add `--account <key>`
only when the user named an account, and `--account <key> --tenant '<id>[,<id>…]'` only when the user
asks to sync to specific workspaces — an override that sends every past session there, ignoring
rules. Never add or suggest any other flag than Step 1's `--review` and `--review-routes` (`--force`,
`--since`, `--dry-run` are not offered). Write its output verbatim as your reply text.

It resumes each session from what Beezi already has, so repeating it is safe. Output saying
"everything is already uploaded" is success: do not re-run it or look for flags to force it. "this
machine is not linked" → /beezi-staging-login. "does not support /beezi-staging-sync yet" → the Beezi server needs an
update; the history is not lost. A `Beezi (<account>): …` line says where that account's past
sessions go; "not sent this time" is expected after a skipped question — the next /beezi-staging-sync asks
again, and /beezi-staging-settings rules adds a rule from inside that repo or folder.
