---
name: beezi-local-status
description: Show whether this machine is linked to Beezi and whether Copilot sessions are being captured — accounts, sign-in health, Beezi API, Copilot plan, which hooks fire, the session watcher, status line, crash reports and plugin updates. Use when the user asks whether they are linked to Beezi, which Beezi account is used, or why their Beezi analytics look empty.
allowed-tools: shell(node:*)
---

# Beezi: status

Every script below is at `<plugin-root>/scripts/…`, where `<plugin-root>` is the folder that contains this skill's `skills/` folder (this file is `<plugin-root>/skills/<name>/SKILL.md`). If you do not know that path, call the `beezi_status` tool from the Beezi MCP server and use its `Plugin root:` line. Always use the absolute path, in double quotes.

Do not read, open or inspect any files yourself; run only the commands given, exactly as written.
Output you are told to show is copied exactly into your reply text — never summarized, paraphrased or
replaced by a sentence of your own. Machine lines (`key=value` lines, and any output you are told not
to show) are never shown. Never echo a token or anything from a credentials file.

Run EXACTLY `node "<plugin-root>/scripts/settings.mjs" status` and write its output verbatim as your
reply. If that command cannot run, or its output says the saved login could not be read, call the
`beezi_status` tool from the Beezi MCP server instead and write its text verbatim — it runs in the
process that holds the stored login. When both ran and name different Beezi APIs, say so rather than
picking one.

Answer follow-up questions from those lines only:
- `not linked` → /beezi-local-login.
- A sign-in line saying the authorization must be renewed or was revoked → /beezi-local-login as that
  account; no logout needed.
- "could not be checked just now" says nothing about the link; queued reports are retried by
  themselves.
- `Tracking` in audit mode or off is a Beezi workspace setting, not something to fix here.
- `Hooks … not seen` together with a running watcher is fine: the watcher captures the sessions
  (normal on VS Code Agent Host). Hooks not seen and no watcher means sessions are not being
  captured: suggest /restart; if hooks stay silent, `disableAllHooks` or an organization policy that
  allows managed hooks only is the likely cause.
- An update line names the exact commands; relay it as written.

This skill changes nothing. The default account is changed with /beezi-local-settings account; crash
reports and the status line with /beezi-local-settings.
