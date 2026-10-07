# Beezi plugin for GitHub Copilot

A Copilot plugin that (1) reports per-branch token and AI-credit analytics for Copilot sessions to
every Beezi account linked on this machine, and (2) brings the Beezi MCP tools into Copilot: Local Flow
and personal analytics.

This is the Copilot port of the Beezi Claude Code plugin. Auth, the credential store, the report
queue, git attribution and the MCP bridge are shared logic with it. The session reader, token and
cost capture, plan handling and the hooks are written for Copilot. A module that exists in the
Claude Code plugin but not here was removed on purpose because it has no Copilot meaning (cost-state
capture, key resolution, Cowork tracking and similar).

Install, sign-in and what Beezi receives are in the [repository README](../../README.md). This file is
about how the plugin works. Host behaviour that has not been measured on a real Copilot build is
marked "unverified" in its sentence.

## Package layout

<!-- gate: V-01 -->

The plugin follows the Agent Plugins 1.0 format:

```
plugin.json                          # $schema, name, version, description
mcp.json                             # MCP stdio server `beezi-copilot`, started with `node` from PATH
env.json                             # environment identity: name, apiBase, updateManifestUrl
com.github.copilot/hooks/hooks.json  # Copilot-only: hook registration
skills/<name>/SKILL.md               # one folder per skill; the folder name equals the skill name
lib/  scripts/                       # zero-dependency Node engine, on a Node 13.2 floor
tools/verify-minimum-runtime.cjs     # parses every lib/ and scripts/ file and imports lib/
```

`env.json` ships in every build. The production build carries `{ "name": "", "apiBase": … }`; an
internal build carries its environment name (see [Variants](#variants)). `lib/paths.mjs` and
`lib/config.mjs` are the only readers.

## Entry points

**Hooks.** `com.github.copilot/hooks/hooks.json` registers each script below. Events are written in
PascalCase, which makes Copilot send Claude-style snake_case payloads and Claude tool names
(`Bash`); `subagentStart` exists only in camelCase and is registered that way. Every script exits 0
and prints nothing, except `session-start.mjs`, which prints at most one JSON object.
<!-- gate: V-03, V-04, V-23, V-25 -->

| Event | Script | Work |
|---|---|---|
| `SessionStart` | `session-start.mjs` | link check, notices, workspace question, queue flush, prune, billing reconcile, account check-in, update check |
| `UserPromptSubmit` | `track-prompt.mjs` | records the interaction mode; asks for a background quota refresh when one is due (a no-op while the quota probe is off) |
| `PostToolUse` (shell) | `checkpoint.mjs` | checkpoint on `git commit`, `switch` and `checkout` |
| `PostToolUse` | `pulse.mjs` | checkpoint at most every 15 minutes |
| `PreCompact` | `pulse.mjs --precompact` | checkpoint before compaction |
| `PermissionRequest` | `permission-request.mjs` | appends an approval-wait marker; prints nothing |
| `subagentStart` | `subagent-start.mjs` | appends a subagent start marker |
| `SubagentStop` | `subagent-stop.mjs` | appends a subagent end marker |
| `Stop` | `stop.mjs` | full turn-end checkpoint and timeline |
| `SessionEnd` | `report.mjs` | final checkpoint; Copilot writes `session.shutdown` after this hook returns, so it also starts `shutdown-worker.mjs`, a detached process (one per session) that waits up to 12 minutes for that event and bills it |
| `ErrorOccurred` | `error-occurred.mjs` | hands the failed model call to the checkpoint, which delivers the error (replaces the Claude `StopFailure`) |

**MCP server.** `scripts/mcp.mjs` speaks MCP over stdio. `lib/mcp-bridge.mjs` forwards to
`<apiBase>/mcp` with the stored login and the default account, and adds one local tool,
`beezi_status`. When no account is linked, `beezi_status` is the only tool and the server answers
`initialize` itself, because a failed handshake would strand the server for the whole session. The
session watcher runs in the same process (see [Two capture paths](#two-capture-paths)).
The bridge hides the server's ticket, estimation and repository-browsing tools: they never appear in
the tool list, a call to one is refused locally, and the bridge replaces the server's startup instructions.

**Skills.** Every user flow is a skill. `ls skills` is the authority on which exist.

| Skill | Runs |
|---|---|
| `beezi-login` | `preflight.mjs`, `login.mjs`, `workspace.mjs`, `billing-capture.mjs`, `accounts.mjs`, `backfill.mjs` |
| `beezi-logout` | `preflight.mjs`, `logout.mjs` |
| `beezi-settings` | `preflight.mjs`, `settings.mjs`, `workspace.mjs`, `accounts.mjs`, `billing-capture.mjs`, `telemetry.mjs`, `statusline-install.mjs` |
| `beezi-sync` | `preflight.mjs`, `accounts.mjs`, `workspace.mjs routes`, `sync.mjs` |
| `beezi-status` | `settings.mjs status`, or the `beezi_status` MCP tool |
| `beezi-analytics` | the MCP tools `get_analytics_instructions` and `get_my_usage_summary` (plus `workspace.mjs read` when a workspace is named) |

The interactive skills call `preflight.mjs` first and refuse to continue in autopilot, so an
auto-answered question can never create a routing rule or grant consent. <!-- gate: V-14, V-39 -->

Skill names are prefixed `beezi-` because Copilot already has `/login`, `/logout`, `/settings`,
`/usage` and `/statusline`. Skills name MCP tools bare (`get_analytics_instructions`) and never with a
server prefix, because Copilot shows tools as `<server>-<tool>` and the server key differs per build.

## Two capture paths

- **Hooks** are the primary path on the Copilot CLI.
- **The watcher** runs inside the MCP server. It is the primary path on VS Code Agent Host, where hook
  events are only partly delivered, and a safety net everywhere, including when an organisation
  allows only managed hooks. <!-- gate: V-02, V-31, V-53 --> It is on by default.
  `BEEZI_COPILOT_WATCHER` set to `0`, `false`, `no`, `off` or `disabled` turns it off and loads none
  of its code, because the gate sits before the import in `scripts/mcp.mjs`.

The watcher wakes every 20 seconds and needs exactly one process to do the work, so it elects one
holder with a 90-second lease. It skips a session whose hooks reported in the last 5 minutes, waits
60 seconds between passes over one session, and handles at most 5 sessions per pass. For each session
file that changed it does one of three things:

- **Established session:** an ordinary incremental checkpoint.
- **Active session it has not seen before:** it establishes a start line from what Beezi already
  holds (the same rule `/beezi-sync` uses) and then checkpoints. Every hook-less Agent Host session
  lands here.
- **Idle session it has not seen before:** it counts as history and goes through the sync path, and
  only after the login import has finished. The watcher never performs the one-time import.

Files over 64 MB are skipped and logged once. Once every 6 hours the elected watcher also runs the
housekeeping that `SessionStart` runs (prune, billing reconcile, account check-in, queue flush), so
those still happen where `SessionStart` never fires. It writes its notes to
`<data root>/logs/watcher.log` and never to stdout or stderr, because stdout belongs to JSON-RPC.

**No double counting.**

- Both paths go through `runCheckpoint` under one per-session lock that covers read, enqueue and
  save. A stale lock is broken after 2 minutes.
- They share the per-session state file `<data root>/state/<sessionId>.json`: the line cursor, the
  usage mode, the shutdowns already billed and the covered time intervals.
- The queue file is on disk before the cursor moves.
- The Beezi API upserts on `segmentId`.

## Session data sources

| File | Read for |
|---|---|
| `<copilot home>/session-state/<id>/events.jsonl` | every event of a session (append-only lines `{type, id, parentId, timestamp, data}`) <!-- gate: V-05, V-21, V-43 --> |
| `<copilot home>/session-state/<id>/workspace.yaml` | the session name |
| `<copilot home>/session-store.db` | per-call usage rows, opened read-only, only when `node:sqlite` exists (see Token modes) |
| `<copilot home>/config.json` | the signed-in GitHub login and host (`loggedInUsers`) <!-- gate: V-19 --> |
| `<copilot home>/settings.json` | read for `askUser`; written only by the status line install |

`<copilot home>` is `COPILOT_HOME` when set and `~/.copilot` otherwise. Every location comes from
`lib/copilot-paths.mjs`. The plugin writes nothing under the Copilot home except the status line
setting, and only on request.

### VS Code Local sessions

VS Code's built-in Copilot Chat ("Local" agent) keeps its sessions in VS Code's own storage, not in
the Copilot home. The plugin reads them read-only from `Code` and `Code - Insiders`.

| File | Read for |
|---|---|
| `<VS Code user>/workspaceStorage/<hash>/chatSessions/<id>.jsonl` | a session in a folder window; `workspace.json` beside it names the folder |
| `<VS Code user>/globalStorage/emptyWindowChatSessions/<id>.jsonl` | a session in a window with no folder |
| `<VS Code logs>/<launch>/window*/exthost/GitHub.copilot-chat/GitHub Copilot Chat.log` | the `Logged in as <login>` line, for the session's account |

- **File format.** The first line is a full snapshot (`kind: 0`). Each later line patches it:
  `kind: 1` sets a path, and `kind: 2` appends to an array, or with `i`, truncates it to `i` and
  then appends. The format is VS Code's own and may change between releases.
- **Reports.** One segment per finished request. `from_line` and `to_line` are request numbers. A
  request still running waits for the next pass.
  - `source` is `vscode`, `originator` is the agent id and `cli_version` is the Copilot Chat
    version.
  - Credits: `copilotCredits` is in AI credits, so `ai_credits_nano` is `copilotCredits × 1e9`.
    Requests from versions before 0.50 have no credits and send `premium_requests` from the `Nx`
    multiplier instead.
  - Tokens: `token_output` is the request's `completionTokens`, summed over its model calls.
    `token_input` is its `promptTokens`, which VS Code records only for the last call, so input is
    under-reported. There is no cache split.
  - Model: a request with no model of its own borrows the nearest one in the session. A session
    with no model at all uploads nothing.
- **Account.** It comes from the Copilot Chat log of the VS Code launch that covered the session,
  else from `state.vscdb`, but only when the session's own account label agrees. Otherwise the
  session is sent without one; it is never guessed.
- **Capture.**
  - The watcher scans these folders whenever any plugin MCP server is running.
  - The plugin's hooks reach these sessions when VS Code runs them (`chat.useHooks`, trusted
    workspace).
  - `/beezi-sync` uploads the rest.

## Token modes

<!-- gate: V-08, V-09, V-10, V-27, V-41, V-42 -->

- **`per_call`** (the default when Node has `node:sqlite`): every checkpoint reports the
  `assistant_usage_events` rows in `session-store.db` written since the last checkpoint, attributed to
  segments by `created_at`. The database is opened read-only. A row written after the hook ran goes
  to the next checkpoint. Copilot sometimes writes a row twice; the copy is dropped.
- **`session_totals`** (the fallback when `node:sqlite` is missing): the `modelMetrics` totals in the
  `session.shutdown` event are reported once, on the segment that contains the shutdown event.
  Earlier checkpoints of the same session carry duration, operations and code changes with zero
  tokens.
- A session never reports both. The mode is stored in the state file, so a session that started in
  one mode keeps it, and `usage_source` on every segment says which was used.
- **Subagents.** In `per_call` mode a subagent's rows (`agent_id`) go to its own segment and are
  left out of the parent's. In `session_totals` mode the shutdown's `agentMetrics` splits the totals
  by agent. Each subagent's share is billed on its own segment, which sits at the shutdown line
  when the subagent had no events in that window. If `agentMetrics` is missing, does not add up
  to `modelMetrics`, or is missing on the previous shutdown, the whole delta goes to the main
  segment.
- **Subagent hooks.** Copilot fires hooks from inside a subagent with the subagent's id as
  `sessionId`. A hook whose `transcriptPath` lies in another session's folder is reported as that
  session. A hook with no path and no session file of its own does nothing, so a subagent never
  becomes a session of its own.
- **Input tokens.** Copilot's `inputTokens` already includes cache reads and cache writes, so
  `token_input` is `inputTokens` minus both, never below zero.
- **Reasoning tokens.** `token_output` is Copilot's `outputTokens`; reasoning tokens are not added
  (unverified whether `outputTokens` already includes them).
- **Resume.** Shutdown totals are cumulative across `--resume`: each shutdown is billed as its
  difference from the previous one in the file, never below zero.
- **Model names.** `auto` is a routing choice, not a model. The model comes from
  `session.auto_mode_resolved` and the turns, never from `selectedModel: "auto"`.
- **Late shutdown.** If the worker misses the `session.shutdown` event, the next resume or the
  watcher's next pass over the file bills it.
- **Accepted gap.** A session that crashes and is never resumed has no `session.shutdown`, so it
  reports zero tokens in `session_totals` mode.

## Billing in AI credits

- The plugin sends raw nano AIU (`ai_credits_nano`, per model and per segment) and the Beezi server
  converts it. For legacy plans it sends `premium_requests`.
- `billing_source` is `subscription` or `unknown`. `subscription_plan` is one of `copilot_free`,
  `copilot_student`, `copilot_pro`, `copilot_pro_plus`, `copilot_max`, `copilot_business`,
  `copilot_enterprise` or `unknown`. `subscription_type` is `individual`, `organization` or
  `enterprise`. A plan the user has not declared is omitted, never sent as `unknown`.
- **The plan is declared, not read.** This build has no local source for the Copilot plan
  (`readLocalPlanRaw` in `lib/copilot-account.mjs` returns nothing), so `/beezi-login` and
  `/beezi-settings` ask the user. A declared plan applies only to the GitHub account it was declared
  for. <!-- gate: V-19, V-38 -->
- **The account** on a report is `account_uuid`, the lowercase GitHub identity `<host>/<login>`, up to
  64 characters. It is omitted when Copilot is signed in through a token environment variable, or
  has several signed-in users and no active one can be told. No email is sent.
  <!-- gate: V-19, V-38 -->
- **One account per session.** Copilot writes no email or user id into a session. The plugin binds
  each session to the account that ran it, so a later account switch never moves an earlier
  session. The first source that names one wins:
  1. Copilot's own process log, `<copilot home>/logs/process-*.log`: the sign-in or settings line
     next to the line that registered that session id. Only the host and login are kept.
  2. A `Signed in successfully as <login>!` notice in the transcript, written when `/login` runs
     inside the session.

  A live session saves the binding in its state file on the first checkpoint that finds one and
  never re-resolves it. A plan applies only to the account it was declared or observed for. When
  neither source names an account, a live session takes the current account. In sync and backfill
  a session started before that account was first seen carries none.
- **The monthly quota probe is off in this build.** The code that would ask the Copilot runtime for
  the monthly premium-request quota and post it to `/me/copilot/usage` as
  `limits: [{ kind: "monthly", … }]` is present but inert (`SERVER_ARGS` in `lib/quota-copilot.mjs` is
  unset), so no usage snapshot is posted. Copilot does not expose session or weekly rate-limit usage
  anywhere, and none is reported. <!-- gate: V-36, V-37 -->

## Report contract and backend-first

Reports use the Claude plugin's `POST /sessions/report` shape plus these optional fields:
`models.<model>.ai_credits_nano`, `models.<model>.premium_requests`, `ai_credits_nano`,
`usage_source` and `project_instructions_status`.

The Beezi API validates reports against a strict whitelist, so **one unknown field rejects the whole
report**. A field ships in the plugin only after the API change that accepts it is deployed to every
environment the build reports to. The same holds for `/cli-agent/plugin-diagnostics` codes and
sources.

## Accounts and workspace routing

Any number of Beezi accounts can be linked to one machine, and every linked account receives this
machine's analytics. The default account decides which one the MCP tools and `/beezi-analytics` read
from. Switching it changes what you read, not what is reported. Run `/beezi-login` again to add an
account, `/beezi-settings account` to change the default, and `/beezi-logout` to remove one.

An account that belongs to several Beezi workspaces chooses where each repo or folder sends its
analytics: **rules** for specific repos and folders, and a **New folders** default for the rest
(ask once, send to chosen workspaces, or don't send). `/beezi-settings` shows and changes both.
Analytics held for an unanswered question wait on disk and are sent once you answer.

## Data root

`~/.beezi-copilot`, plus `-<env>` on an internal build. `BEEZI_COPILOT_HOME` overrides it. The tree
comes from `lib/paths.mjs`:

```
accounts.json                 # linked accounts and the default
accounts/<key>/               # per account: credentials/, queue/, tracking.json, audit-ledger*.json, coverage*.json, account-sync.json, usage-pending.json
state/                        # per-session state, markers and locks (swept after 14 days)
billing.json                  # the declared Copilot plan and the last identity seen
repo-map.json                 # directory-to-repository cache
quota-copilot.json  usage-series.json   # monthly quota cache and usage series; written only when the quota probe is on
update-check.json  plan-nudge.json  upgrade-notice.json  installation.json
telemetry.json  telemetry-send.json  telemetry/
watcher.json  locks/  logs/watcher.log  hooks-seen.json
statusline/  statusline.sh  statusline-original.json   # status line snapshots; the shim and the saved original exist only while it is on
```

The plugin never reads `~/.beezi` (Claude Code) or `~/.beezi-codex` (Codex) and ignores `BEEZI_HOME`,
because the three plugins use the same file names and a shared folder would mix their queues and
`billing.json`. The operating system's secret-store service is `beezi-copilot`, plus `-<env>` on an
internal build. With a custom `BEEZI_COPILOT_HOME` a short hash of its path is added, so each home
has its own credentials.

## Client identity

Every request carries `X-Beezi-Agent: copilot`, `X-Beezi-Host`, `X-Beezi-Client`, the plugin version
header and, for an account in several workspaces, `X-Beezi-Tenant`. The OAuth client registers as
`Beezi Copilot plugin — <hostname>`. Copilot-specific routes are `/me/copilot/whoami`,
`/me/copilot/machine` and `/me/copilot/usage`; the rest (`/sessions/*`, `/repos/status`,
`/me/cli-agent/account`, `/cli-agent/plugin-diagnostics/*`) are shared with the other agents and read
the vendor from the header.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `BEEZI_API_URL` | the build's `env.json` `apiBase` | Beezi API base |
| `BEEZI_MCP_URL` | `<apiBase>/mcp` | MCP endpoint the bridge forwards to |
| `BEEZI_ENV` | the build's `env.json` `name` | `dev`, `staging` or `local` selects the namespace: data root and secret-store entry |
| `BEEZI_COPILOT_HOME` | `~/.beezi-copilot` | queue, state and credentials |
| `BEEZI_UPDATE_MANIFEST_URL` | the build's `env.json` `updateManifestUrl` | marketplace manifest the update check reads; for local verification |
| `BEEZI_COPILOT_WATCHER` | unset (on) | `0`, `false`, `no`, `off` or `disabled` turns the watcher off |
| `BEEZI_COPILOT_QUOTA` | unset (on) | `0`, `false`, `no` or `off` turns the monthly quota probe off; it is off in this build whatever this says |
| `BEEZI_COPILOT_CLI` | `copilot` | the binary the quota probe starts, for a machine where `copilot` is not on the `PATH` hooks inherit |
| `BEEZI_STATUSLINE_CHAIN` | set by the status line shim | the status line command Beezi wrapped; it runs and its output is shown unchanged |
| `BEEZI_STATUSLINE_SILENT` | unset | `1` keeps the status line capture and shows nothing |
| `BEEZI_DEBUG` | unset | any value makes the CLI scripts print the raw error text |
| `COPILOT_HOME` | `~/.copilot` | read, not owned: where Copilot keeps its files |
| `PLUGIN_ROOT` | set by Copilot | read, not owned: the plugin's install folder |

Which of these variables reach the MCP server process is unverified: Copilot's documentation says a
server added by hand inherits only `PATH` plus its declared `env`. <!-- gate: V-33 --> Overrides
that the server has to see (`BEEZI_API_URL`, `BEEZI_MCP_URL`, `BEEZI_COPILOT_WATCHER`) work only where
the server process can see them; an internal build bakes the API into `env.json` and does not depend
on them.

## Variants

Internal builds exist for Beezi staff: `beezi-dev`, `beezi-staging` and `beezi-local`. They are not
edited by hand. A build step derives each one from this plugin and rewrites only:

- `plugin.json`: the name `beezi-<env>`, the version `<version>-<env>.<build>` and the description, which
  gains ` — <env> environment build.`;
- `package.json`: the same version;
- `env.json`: the environment name, the API base and the update manifest URL;
- `mcp.json`: the server key, from `beezi-copilot` to `beezi-copilot-<env>`;
- the skill folders, their `name` fields and every `/beezi-<skill>` mention in `skills/`, `lib/` and
  `scripts/`, from `beezi-<skill>` to `beezi-<env>-<skill>`, for example `/beezi-dev-login`.

Each variant gets its own data root (`~/.beezi-copilot-<env>`), secret-store service
(`beezi-copilot-<env>`), update manifest and MCP server key.

The renames exist because of Copilot's documented precedence for duplicate names: skills are
first-found-wins and the duplicate is silently dropped, and MCP servers are last-loaded-wins with a
warning. Two plugins that share a skill name or a server key cannot both work. <!-- gate: V-34, Q-1 -->

## Updating

At session start the plugin compares its own version (from `plugin.json`) with the `version` in the
marketplace manifest at `env.json` `updateManifestUrl`. The check runs at most once an hour and gives
up after 1.5 seconds. Being offline, having no manifest URL and an unreadable manifest are all silent.
The plugin never updates itself. When a newer version is published it prints one line with the
commands: `copilot plugin marketplace update <marketplace>`, then `copilot plugin update <plugin>`,
then start a new Copilot session. <!-- gate: V-56, V-06, V-50, V-02 --> `/beezi-status` shows the same
line.

## Coexistence

- **Claude Code plugin.** Separate data roots, secret-store services and agent header. The marketplace
  and MCP server names are distinct too: `beezi-copilot` here against `beezi` there. <!-- gate: V-34, Q-1 -->
  A Claude Code plugin copy that Copilot loads (installed into Copilot, or turned on by a repository's
  `.claude/settings.json`) stays inactive from Claude plugin version `<guard version>` on.
  <!-- gate: G1, V-57 --> Whether VS Code's Local agent can load that plugin is unverified, so it is not
  covered.
- **Codex plugin.** Separate data roots.

## Known caveats

- **Platforms.** Tested on macOS only. Windows path handling and the Linux bash hooks were checked
  in emulation. `git` and `secret-tool` run from an absolute path found on `PATH`, never from the
  repo folder. The macOS keychain is written through `/usr/bin/security -i`, so the secret never
  appears in a process's arguments. Windows renames and locks retry on EPERM, EBUSY and EACCES.
  The PowerShell hooks force UTF-8. Still unverified on real machines:
  - Windows hook stdin encoding under PowerShell 5.1 and 7;
  - the shell VS Code uses for these hooks on Windows;
  - whether `shutdown-worker.mjs` survives Copilot exiting (V-29);
  - Credential Manager limits;
  - Linux keyring behaviour on desktop and headless machines.
- In `copilot -p` mode `SessionEnd` fires on every turn, so nothing in `report.mjs` is one-shot.
  <!-- gate: V-07 -->
- The built-in `general-purpose` subagent fires no subagent hooks. Its events are still in
  `events.jsonl`.
- `ErrorOccurred` replaces the Claude `StopFailure`. It carries no HTTP status; the status comes from
  the `session.error` events in the session file. <!-- gate: V-22 -->
- `PermissionRequest` output is a decision channel, so the script prints nothing at all. Any byte on
  stdout could approve or deny a real prompt.
- Whether `SessionStart` output shown to the user (`systemMessage`) is honoured by Copilot is
  unverified. The most important actionable notice rides `additionalContext` as one line the model is
  asked to relay. <!-- gate: V-06, V-50 -->
- A `node:sqlite` ExperimentalWarning must not reach a hook's stderr, so hook commands run
  `node --no-warnings`. <!-- gate: V-12 -->
- On VS Code Agent Host only part of the hook events fire, which is why the watcher exists. <!-- gate: V-02 -->
- Detached child processes started by a hook are assumed to outlive it (unverified). <!-- gate: V-29 -->

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
