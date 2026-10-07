---
name: beezi-staging-logout
description: Log one Beezi account, or every one, out of this machine. Use only when the user asks to log out of Beezi, unlink this machine, or remove a linked Beezi account.
disable-model-invocation: true
allowed-tools: shell(node:*), ask_user
---

# Beezi: logout

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

Switching is not logging out. If the user only wants analytics to come from another linked account,
that is /beezi-staging-settings account; to sign in as someone else, /beezi-staging-login adds that account next to
this one. Ask before running anything unless the user clearly asked to log out, unlink or remove an
account.

Step 0 — preflight. Run EXACTLY `node "<plugin-root>/scripts/preflight.mjs" --for logout`. If its
first line starts with `✗`, show it verbatim and STOP.

Step 1 — run EXACTLY `node "<plugin-root>/scripts/logout.mjs" --list` and show the accounts. None
linked → say so and stop. One → use it. Several → ask "Which Beezi account should be logged out of this
machine?" with one choice per account (its name and workspace as the label; the bracketed key is only
for the command) and a last choice "All accounts".

Step 2 — when the account being removed is the default and others remain, ask "Which remaining account
should /beezi-staging-analytics read from?" with one choice per remaining account; when only one remains, use
it without asking. Pass it as `--next-default`.

Run exactly one of:

- `node "<plugin-root>/scripts/logout.mjs" --account <key>`
- `node "<plugin-root>/scripts/logout.mjs" --account <key> --next-default <remaining-key>`
- `node "<plugin-root>/scripts/logout.mjs" --all`

Relay every line it prints verbatim, including an unconfirmed server unlink, and add nothing of your
own. A dismissed question logs nothing out. Never retry in a loop and never delete a credentials file
by hand. Afterwards the Beezi tools may still be listed in this session; calls to them fail until
/beezi-staging-login links an account again.
