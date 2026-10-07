---
name: beezi-local-analytics
description: Show a short personal Beezi analytics summary (spend, sessions, status, recommendations) for the last 7 or 30 days. Use when the user asks for their Beezi analytics, usage summary or spend summary.
argument-hint: "7d | 30d [workspace]"
allowed-tools: shell(node:*)
---

# Beezi: personal analytics summary

Every script below is at `<plugin-root>/scripts/…`, where `<plugin-root>` is the folder that contains this skill's `skills/` folder (this file is `<plugin-root>/skills/<name>/SKILL.md`). If you do not know that path, call the `beezi_status` tool from the Beezi MCP server and use its `Plugin root:` line. Always use the absolute path, in double quotes.

This skill is a launcher. The summary workflow lives on the Beezi MCP server so it stays current — do
not improvise your own flow and do not restate the workflow from memory. Tools are named below without
any server prefix; use the Beezi MCP server's tool of that name.

Arguments: the text the user typed after the skill's slash command in the message that started this skill; none if they typed only the command.

1. Parse the arguments: `7d` or `30d` is the period (none → `7d`); any other words name a workspace.
2. Only when a workspace is named, run EXACTLY
   `node "<plugin-root>/scripts/workspace.mjs" read "<workspace>"` and write its first line verbatim
   (an error line too; on an error, stop there).
3. Call `get_analytics_instructions` from the Beezi MCP server, before producing any summary.
4. Follow the returned instructions exactly, passing the period from step 1. They decide when
   `get_my_usage_summary` is called and how its numbers are shown.

Every number is copied from the tool results verbatim — never recalculated, averaged or estimated. A
figure invented here reads to the user as a billing fact.

The figures are the user's own usage **combined across every AI coding agent linked to their Beezi
account, not Copilot alone**. Present them as their overall Beezi usage; never call them "your Copilot
usage". If the fetched instructions describe the total as one specific agent's usage, follow them for
the workflow and the numbers, but tell the user the scope wording is inconsistent.

For an account in several workspaces, tool results end with `Beezi: reading from <workspace>.` — name
that workspace in the summary.

When something fails, stop and tell the user; never retry blindly and never compute a summary yourself:
- `beezi_status` is the only Beezi tool listed → the server has no account to read from: call
  `beezi_status` and relay its text; when it says not linked, the fix is /beezi-local-login.
- No Beezi tools at all → the Beezi MCP server is not connected: ask the user to check that `/mcp`
  lists the Beezi server, then /restart.
- Linked, but no `get_analytics_instructions` → personal analytics are not enabled for this Beezi
  deployment; only their Beezi admin can turn them on.
- An authentication error → reply exactly: `Sign in to Beezi first: run /beezi-local-login.`
- Anything else → report the message, plus the `correlationId` when the result has one, and stop.
