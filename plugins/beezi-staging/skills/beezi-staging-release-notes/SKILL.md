---
name: beezi-staging-release-notes
description: Show what changed in the Beezi plugin — the installed version's release notes, every release, or one named version, plus how to update when a newer one is out. Use when the user asks what's new in Beezi, for the Beezi changelog or release notes, or what changed in a Beezi version.
argument-hint: "[all | <version>]"
allowed-tools: shell(node:*)
---

# Beezi: release notes

Every script below is at `<plugin-root>/scripts/…`, where `<plugin-root>` is the folder that contains this skill's `skills/` folder (this file is `<plugin-root>/skills/<name>/SKILL.md`). If you do not know that path, call the `beezi_status` tool from the Beezi MCP server and use its `Plugin root:` line. Always use the absolute path, in double quotes.

Do not read, open or inspect any files yourself, and do not ask the user anything first; run only the
command below, exactly as written.

Arguments: the text the user typed after the skill's slash command in the message that started this skill; none if they typed only the command.

Run EXACTLY `node "<plugin-root>/scripts/release-notes.mjs"`. Add `all` when the arguments are `all`,
or the version when the arguments are exactly a version like `0.1.92` (digits and dots only). Never pass
anything else:

- `node "<plugin-root>/scripts/release-notes.mjs" all`
- `node "<plugin-root>/scripts/release-notes.mjs" <version>`

Copy the command's whole output into your reply exactly as printed. It is markdown, so write it as
markdown, NOT in a code block; never summarize or paraphrase it, and add nothing else. A `✗` line or
the usage line is shown verbatim too; then stop.

This skill changes nothing. Never run the update steps it names yourself (`copilot plugin marketplace
update …`, `copilot plugin update …`, `/plugin`), even if the user asks in this same message: updating
replaces the plugin under the running session, so the user runs them (and starts a new Copilot session)
on their own.
