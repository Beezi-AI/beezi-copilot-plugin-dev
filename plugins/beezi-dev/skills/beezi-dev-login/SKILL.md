---
name: beezi-dev-login
description: Link a Beezi account to this machine with a browser sign-in, then choose which repos and folders Beezi tracks. Use when the user wants to log in, sign in or connect to Beezi, add another Beezi account, or when a Beezi tool says this machine is not linked. Run it again to add accounts.
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
description, write it as "<label> — <description>". The user may type their own answer instead. Never
answer a question yourself and never assume an answer. When a question allows several answers, number
its choices and end the question with " You can pick more than one: type their numbers separated by
commas." If the preflight printed `mode=argument-only`, do not call `ask_user` at all: Step 3 lists
its choices as a numbered list and stops instead. Step 1p's request for the pasted address is plain
text, not an `ask_user` question, so it still happens in `mode=argument-only`.

Step 0 — preflight, before anything else. Run EXACTLY:

`node "<plugin-root>/scripts/preflight.mjs" --for login`

If its first line starts with `✗`, show that line verbatim and STOP: run no other command. A login
that stops halfway leaves this machine half-linked. If the command itself is refused or cannot run,
STOP as well, do not retry it another way, and tell the user this session's mode is blocking Beezi's
scripts. If it starts with `✓`, continue.

Arguments. When the arguments are `--no-browser` or ask to sign in without a browser, go to Step 1p.
When they are one whole number, they answer Step 3's question from an earlier run of this skill in
this conversation: go to Step 3's "Answer by number". Any other non-empty arguments are the address
pasted back from a paste-back sign-in started earlier (Step 1p): skip Step 1 and the first command of
Step 1p, and run Step 1p's `--complete` command with the arguments as the reply (trimmed and escaped
the same way).

## How the steps run

Every step comes from ONE script, which runs them in order and stops at most once, for the tracking
question:

`node "<plugin-root>/scripts/login-flow.mjs"`

Each step's output is a block: a `<name …>` line, the output, then a `</name>` line (the tag lines are
never shown). Its LAST line says what to do now: `next=<step> account=<key>`, or just `next=stop` when
the sign-in linked nothing (never shown either). `<key>` is the account just linked: remember it.

| `next=` | Go to |
|---|---|
| `stop` | Step 1, the sign-in did not link an account |
| `track` | Step 3, the tracking question |
| `done` | Step 4 |

Output that ends without any `next=` line means the script itself failed or refused to run: show what
it printed verbatim and stop (running /beezi-dev-login again resumes safely). Never run the commands
behind the blocks yourself (`login.mjs`, `billing-capture.mjs`, `workspace.mjs setup` and the
finish step's upload and defaults): the blocks hold their output. Before doing what `next=` says, write
out what each block printed this time calls for, in order, as its step below says.

Step 1 — sign in (opens the browser and waits until the user approves there). Go to Step 1p instead
when the user asks to sign in without a browser or on another device, or when this session runs where
no browser can open on this machine (an SSH session, a container, a Codespace, a VS Code Remote window).
Otherwise run `login-flow.mjs` with no arguments (above). Its `<sign-in>` block holds the sign-in's
output.

Show the `<sign-in>` block except the machine line `account=<key>` (never shown). If it says the
machine is already linked as that account, say so: the script still went on, so a changed plan is
refreshed. On `next=stop`, show the block and STOP, except in the
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
STOP. With one, run EXACTLY this, which runs every step after the sign-in:

`node "<plugin-root>/scripts/login-flow.mjs" --account <key>`

Step 2 — the plan: the `<plan>` block. Write its lines verbatim. It asks nothing.

Step 3 — the tracking question (`next=track`): the `<track account="<key>">` block. Its lines:

- `<checklist>` … `</checklist>`: what past sessions send; absent when there are none;
- `W. <workspace> account=<key> tenant=<id> role=<role>`: one per workspace. `<name>` is the text
  after `W. ` up to ` account=`;
- `T<i>. <short> (<label>), <k> sessions account=<key> kind=<…> now=<ids|none|default> match=<…>`:
  one repo or folder (a `T` line). `<short>` is the text after `T<i>. ` up to ` (` or `,`; `now=` is
  where it goes today: workspace ids, `none` (not tracked) or `default` (no rule);
- `T<i>-command=<command>`: right after its `T` line, ending in a literal `<tenants>`;
- `everything-command=<command>` (ending in a literal `<tenants>`) and `chosen-command=<command>`;
- `<n> other past sessions have no recorded folder and are not sent.` (or the one-session form);
- `same-list=yes`: only when the workspaces are the same as in the list shown before and not answered;
- `setup=<M> sessions=<N> workspaces=<W> chosen=no`: always last. `<M>` is the number of `T` lines.

First write the lines between `<checklist>` and `</checklist>` verbatim inside one plain fenced code
block (```, no language), keeping every leading space and line break, then the no-recorded-folder
line verbatim when there is one. Write nothing else from the block. Then ask ONE question, by the
number of `W.` lines:

| Workspaces | Question | Choices |
|---|---|---|
| 1 | "What should it track?" | "Everything" — "all <M>, and new ones as you open them", "Let me choose" — "tick the repos and folders" |
| 2 | "Where should they go?" | "Everything to <A>", "Everything to <B>", "Everything to both", "Let me choose" — "tick repos for each workspace" |
| 3 or more | "Where should they go?" | "Everything to <A>", "Everything to <B>", "Several workspaces…" — "Pick two or more; everything goes to each of them", "Let me choose" — "tick repos for each workspace" |

`<A>` and `<B>` are the first two `W.` lines' names. With no `T` lines (the script stops only for
several workspaces then) the question is "Where should this machine's analytics go?" and the last
choice is "Ask me for each repo" — "Beezi asks the first time you work in one" instead of "Let me
choose".

In `mode=argument-only`, write the question and its Everything choices as a numbered list instead:
"Everything" for one workspace; otherwise one "Everything to <name>" per `W.` line, then "Everything
to both" (two workspaces) or "Everything to all <W>" (more), then "Ask me for each repo" when there
are no `T` lines. "Let me choose" needs questions this session cannot ask: leave it out and say
/beezi-dev-settings sets repos and folders one by one. Stop, and tell the user to run `/beezi-dev-login <n>`
with the number of their choice.

Answer by number (the arguments were one whole number `<n>`): after Step 0, take `<key>` from the
`<track account="<key>">` block an earlier run printed in this conversation; when there is none, say
the number answers nothing here and start at Step 1 instead. Run
`node "<plugin-root>/scripts/login-flow.mjs" --account <key>` and write its `<plan>` block as Step 2
says. When it ends with `next=track` and its `<track>` block has the line `same-list=yes`, the answer
is the `<n>`-th choice of that same numbered list, built from this new block; a number past the list
is a dismissal. When it ends with `next=track` without that line, the workspaces changed since the
list was shown: the number answers nothing, so run no command, say the list changed, and do Step 3
with this new block from the start (in `mode=argument-only`, the numbered list again, then stop).
Otherwise follow its `next=` line.

Run no command until every question of this step is answered. A dismissed question, or a typed answer
that matches none of the choices: run nothing, tell the user nothing was set up and to run
/beezi-dev-login again to choose what to track, and STOP (no `--from finish`).

- "Several workspaces…" → ask "Which workspaces should get analytics from this machine?" (several
  allowed, one choice per `W.` line: the workspace name — its `role=` value, or "Beezi workspace" when
  empty). Nothing chosen is a dismissal. Otherwise → the Everything bullet with those workspaces.
- An Everything choice → run the `everything-command=` text EXACTLY ONCE, changing nothing except the
  final `<tenants>`: the chosen workspaces' `tenant=` values joined by commas inside one pair of single
  quotes, like `'<id>,<id>'` (the quotes keep PowerShell from splitting them). With one workspace, drop
  the literal ` <tenants>` instead.
- "Ask me for each repo" → run the `chosen-command=` text EXACTLY ONCE.
- "Let me choose" → the place questions below.

Place questions. With one workspace, a `T` line with `now=none` is not offered: say `<short>` is not
tracked today and that /beezi-dev-settings changes it. The places to offer are the other `T` lines.

- 4 or fewer places → one question per workspace, in `W.` order: "Which repos and folders should
  Beezi track?" (one workspace) or "Which repos and folders go to <name>?" (several). Several allowed:
  one choice per place, "<short> — <k> sessions", and no other choice. An answer with no place picked
  means nothing goes there; it is not a dismissal.
- More than 4 places → write the places once as a numbered list, `<n>. <short> — <k> sessions`,
  inside one plain fenced code block. Then one question per workspace, worded as above, with the
  choices "All of them — every place in the list" and "None of them — nothing in the list". A typed
  answer is the numbers to include, separated by commas; a number not in the list makes it a
  dismissal.
- No place to offer → ask nothing.

A place is chosen for a workspace when that workspace's answer includes it. Then, for each place whose
chosen workspaces differ from its `now=` value as a set (`default` always differs), run its
`T<i>-command=` text EXACTLY ONCE, changing nothing except the final `<tenants>`: the chosen
workspaces' `tenant=` values joined by commas inside one pair of single quotes, like `'<id>,<id>'`, or
`none` when it is chosen nowhere. With one workspace run it only for places left out, with `none`.
After those, run the `chosen-command=` text EXACTLY ONCE. Never rebuild a command or re-quote its path.

Of every command's output write only a `✗` line, verbatim. When a command prints a `✗` line, write
that line verbatim, run no other command (no later `T<i>-command`, no `chosen-command`, no
`--from finish`), tell the user nothing more was set up and to run /beezi-dev-login again, and STOP.
Otherwise carry on with EXACTLY this:

`node "<plugin-root>/scripts/login-flow.mjs" --account <key> --from finish`

Step 4 — the finish (`next=done`): the `<finish>` block. Write its lines verbatim, blank lines
included, and add nothing of your own. Never echo any token.

If the Beezi tools are still missing afterwards, they appear within about 15 seconds; if not, run
/restart.
