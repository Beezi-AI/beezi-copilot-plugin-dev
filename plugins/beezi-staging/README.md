# Beezi plugin for GitHub Copilot

A Copilot plugin that (1) reports per-branch token and AI-credit analytics for Copilot sessions to
every Beezi account linked on this machine, and (2) brings the Beezi MCP tools into Copilot: Local Flow
and personal analytics.

This is the Copilot port of the Beezi Claude Code plugin. Auth, the credential store, the report
queue, git attribution and the MCP bridge are shared logic with it. The session reader, token and
cost capture, plan handling and the hooks are written for Copilot. A module that exists in the
Claude Code plugin but not here was removed on purpose because it has no Copilot meaning (cost-state
capture, key resolution, Cowork tracking and similar).

Install and sign-in are in the [repository README](../../README.md). This file is about what the
plugin sends and how it works. Host behaviour that has not been measured on a real Copilot build is
marked "unverified" in its sentence.

## What this plugin sends

**Sent, per session:**

- model names, and token counts (input, output, reasoning, cache read and write);
- the peak and final size of the context window, with its model name;
- AI credits and premium requests, as Copilot records them;
- how many model calls Copilot routed through Auto, and the AI credits those calls used;
- how many calls had to re-write Copilot's prompt cache (for example after a pause, a model switch or a compaction), how many model switches there were, and the AI credits those calls used (counts only; models that do not report cache writes are never counted as cold);
- tool-call counts by category (file, search, internet, MCP, shell, skill, other), an estimate of
  how large the results were, and the names of the MCP servers, skills and plugins that were used;
- per tool, how many calls ran and how many failed, by kind of failure (permission denied, timeout, interrupted, missing file, access or setup, command exited non-zero, other), never the tool's input or output; the permission-denied kind is unverified;
- how many times Copilot compacted the context;
- durations, and an activity timeline (working, planning, waiting for you, idle);
- lines added and removed, files changed, and how many changed files have each extension;
- the branch, and the `origin` remote with credentials stripped (or `local:<folder name>` outside a
  repository or when there is no remote, and `local:copilot-chats` for every Copilot app chat folder);
- Copilot's session name. When Copilot hasn't named the session, that is the start of your first
  prompt, cut to 200 characters, with anything that looks like a secret or a file path removed;
- the id, type and name of any subagents;
- for the main agent: time to first token, call duration, the model's context window and why a turn was
  aborted (for example `user_abort`), when Copilot records them;
- whether the repository has project instructions files, how many lines each has, and each file's path inside the repository (only `.github/copilot-instructions.md`, `AGENTS.md`, `CLAUDE.md` and `GEMINI.md`);
- which client created the session (`source`: `cli`, `app`, `vscode` for VS Code Local chat or
  `vscode-agent-host`), with that client's name and version when the session file records them. It is
  read from the session's own start, so a resumed session keeps it;
- your time zone, and (as request headers) this machine's host name, its Beezi sign-in client id and
  the plugin version, which Beezi shows in your list of linked machines;
- your Copilot plan and the GitHub account the session ran under (see [Billing](#billing-in-ai-credits)).

**Sent about the account, not a session:** the monthly premium-request quota Copilot reports (percent
used, reset date and, on an unlimited plan, the count used), posted only to the Beezi workspaces this
GitHub account works for.

**Sent when a turn fails:** the error class, type, code and status, when it happened, and Copilot's
error message (cut to 1000 characters).

**Never sent:** your prompts (apart from the session-name fallback above), your code, file contents,
tool arguments, command text and tool results, and your GitHub or Copilot tokens. Your Beezi sign-in
is kept in your operating system's secret store when there is one, and otherwise in a file only your
user account can read.

**Crash reports** are off unless you turn them on in `/beezi-settings`. They carry the plugin, Copilot
and Node versions, your OS, OS version and CPU type, the plugin file and line that failed, the error's
name, code and HTTP status, your sign-in state, and how many times and when it happened. If you choose
"Correlate", a random installation ID also ties them to your Beezi account. They never carry your code,
prompts, repository names or any path outside the plugin.

## Package layout

The plugin follows the Agent Plugins 1.0 format:

```
plugin.json                          # $schema, name, version, description
mcp.json                             # MCP stdio server `beezi-copilot`, started with `node` from PATH
env.json                             # environment identity: name, apiBase, updateManifestUrl
com.github.copilot/hooks/hooks.json  # Copilot-only: hook registration
skills/<name>/SKILL.md               # one folder per skill; the folder name equals the skill name
lib/<area>/*.mjs                     # zero-dependency Node engine, on a Node 13.2 floor, one folder per area
scripts/*.mjs                        # hook, skill and MCP entry points
tools/verify-minimum-runtime.cjs     # parses every lib/ and scripts/ file, imports lib/, checks the Node 13.2 floor
RELEASE_NOTES.md                     # what changed in each version, shown by /beezi-release-notes
```

`env.json` ships in every build. The production build carries `{ "name": "", "apiBase": … }`; an
internal build carries its environment name (see [Variants](#variants)). `lib/config/paths.mjs` and
`lib/config/api.mjs` are the only readers.

## Entry points

**Hooks.** `com.github.copilot/hooks/hooks.json` registers each script below. Events are written in
PascalCase, which makes Copilot send Claude-style snake_case payloads and Claude tool names
(`Bash`). `subagentStart`, `postToolUseFailure` and `notification` are registered in camelCase, the
form every Copilot CLI release that has them accepts; they get camelCase payloads. VS Code Local chat
ignores those three, `PermissionRequest` and any `matcher`. Every script exits 0 and prints nothing, except
`session-start.mjs`, which prints at most one JSON object: `additionalContext` for the Copilot CLI and
the same text in `hookSpecificOutput.additionalContext` for VS Code.

| Event | Script | Work |
|---|---|---|
| `SessionStart` | `session-start.mjs` | link check, notices, workspace question, queue flush, prune, billing reconcile, account check-in, update check |
| `SessionStart` (detached) | `history-worker.mjs` | sends past sessions to a workspace that a rule or the New folders default newly reaches; rule changes, `/beezi-sync`, the login upload and the watcher start it too |
| `SessionStart` (detached) | `catch-up-worker.mjs` | checkpoints up to 3 recent sessions whose file grew past what was reported or whose final shutdown is still owed; one per machine at a time |
| `UserPromptSubmit` | `track-prompt.mjs` | records the interaction mode; asks for a background quota refresh when one is due |
| `PostToolUse` (shell) | `checkpoint.mjs` | checkpoint after `git commit`, `switch`, `checkout`, `merge`, `rebase` or `pull` (also with `-C <dir>`) and `gh pr checkout` |
| `PostToolUse` | `pulse.mjs` | checkpoint at most every 15 minutes |
| `postToolUseFailure` | `pulse.mjs` | the same pulse after a failed tool call |
| `notification` (`agent_completed`, `agent_idle`) | `pulse.mjs` | the same pulse when a background agent finishes or goes idle |
| `PreCompact` | `pulse.mjs --precompact` | checkpoint before compaction |
| `PermissionRequest` | `permission-request.mjs` | appends an approval-wait marker; prints nothing |
| `subagentStart` | `subagent-start.mjs` | appends a subagent start marker |
| `SubagentStop` | `subagent-stop.mjs` | appends a subagent end marker |
| `Stop` | `stop.mjs` | full turn-end checkpoint and timeline; in VS Code Local chat only requests already finished are billed, the rest at the next run |
| `SessionEnd` | `report.mjs` | final checkpoint; Copilot writes `session.shutdown` after this hook returns, so it also starts `shutdown-worker.mjs`, a detached process (one per session) that waits up to 12 minutes for that event and bills it. No worker starts for a VS Code Agent Host session, whose shutdown comes when VS Code disposes the session, or while one already waits for this session |
| `ErrorOccurred` | `error-occurred.mjs` | hands the failed model call to the checkpoint, which delivers the error (replaces the Claude `StopFailure`) |

**MCP server.** `scripts/mcp.mjs` speaks MCP over stdio. `lib/mcp/bridge.mjs` forwards to
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
| `beezi-release-notes` | `release-notes.mjs` |
| `beezi-analytics` | the MCP tools `get_analytics_instructions` and `get_my_usage_summary` (plus `workspace.mjs read` when a workspace is named) |

The interactive skills call `preflight.mjs` first and refuse to continue in autopilot, so an
auto-answered question can never create a routing rule or grant consent.

**Terminal setup.** The one-line installers run `setup.mjs` once, right after the install, in the same
terminal: the `beezi-login` steps (minus the current session's folder rule; there is no session), then crash
reports and the status line. It runs `preflight.mjs`, `accounts.mjs`, `login.mjs`, `workspace.mjs`,
`billing-capture.mjs`, `backfill.mjs`, `settings.mjs`, `telemetry.mjs` and `statusline-install.mjs` as child
processes. Where no browser can open (SSH, a Codespace, a dev container, Linux with no display) it signs in
with the paste-back flow: `login.mjs --no-browser`, then `--complete` with the pasted address.

Skill names are prefixed `beezi-` because Copilot already has `/login`, `/logout`, `/settings`,
`/usage` and `/statusline`. Skills name MCP tools bare (`get_analytics_instructions`) and never with a
server prefix, because Copilot shows tools as `<server>-<tool>` and the server key differs per build.

## Two capture paths

- **Hooks** are the primary path on the Copilot CLI.
- **The watcher** runs inside the MCP server. It is the primary path on VS Code Agent Host, where hook
  events are only partly delivered, and a safety net everywhere, including when an organisation
  allows only managed hooks. It is on by default.
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
- **Idle session it has not seen before:** it counts as history and goes through the sync path, for
  each workspace only once that workspace's past sessions were sent: the login import finished, or a
  `/beezi-sync` or history-worker run covered it. The watcher never performs the one-time import.
  When a workspace still owes its past sessions, the watcher starts the history worker for it (see
  [Accounts and workspace routing](#accounts-and-workspace-routing)) instead of uploading them itself.

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
| `<copilot home>/session-state/<id>/events.jsonl` | every event of a session (append-only lines `{type, id, parentId, timestamp, data}`) |
| `<copilot home>/session-state/<id>/workspace.yaml` | the session name |
| `<copilot home>/session-store.db` | per-call usage rows, opened read-only, only when `node:sqlite` exists (see Token modes) |
| `<copilot home>/config.json` | the signed-in GitHub login and host (`loggedInUsers`); when it is missing or lists nobody, VS Code's Copilot Chat sign-in stands in (see VS Code Local sessions) |
| `<copilot home>/settings.json` | read for `askUser`; written only by the status line install |

`<copilot home>` is `COPILOT_HOME` when set and `~/.copilot` otherwise. Every location comes from
`lib/config/copilot-paths.mjs`. The plugin writes nothing under the Copilot home except the status line
setting, and only on request.

### VS Code Local sessions

VS Code's built-in Copilot Chat ("Local" agent) keeps its sessions in VS Code's own storage, not in
the Copilot home. The plugin reads them read-only from `Code`, `Code - Insiders`, `Code - OSS` and
`VSCodium`, from the folders `VSCODE_APPDATA` and `VSCODE_PORTABLE` name, from the Flatpak build on Linux,
and from a VS Code Server's `~/.vscode-server` and `~/.vscode-remote` on a remote host (where a remote
window keeps its chat sessions is unverified). Cursor and Windsurf are not read.

| File | Read for |
|---|---|
| `<VS Code user>/workspaceStorage/<hash>/chatSessions/<id>.jsonl` | a session in a folder window; `workspace.json` beside it names the folder |
| `<VS Code user>/globalStorage/emptyWindowChatSessions/<id>.jsonl` | a session in a window with no folder |
| `<VS Code logs>/<launch>/window*/exthost/GitHub.copilot-chat/GitHub Copilot Chat.log` | the `Logged in as <login>` line, for the session's account; in the newest launch, also the `copilot token sku: <sku>` line, for the plan |

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
    `token_input` sums every `promptTokens` value VS Code wrote for the request. VS Code overwrites
    that value between calls, so input is a lower bound. There is no cache split.
  - Model: a request with no model of its own borrows the nearest one in the session. A session
    with no model at all uploads nothing.
- **Account.** It comes from the Copilot Chat log of the VS Code launch that covered the session,
  else from `state.vscdb`, but only when the session's own account label agrees. Otherwise the
  session takes the account VS Code's Copilot Chat is signed in as now (unless the label names someone
  else), else the account Copilot is signed in as now.
- **Capture.**
  - The watcher scans these folders whenever any plugin MCP server is running.
  - The plugin's hooks reach these sessions when VS Code runs them (`chat.useHooks`, trusted
    workspace).
  - `/beezi-sync` uploads the rest.
  - An organization can turn off hooks ("Editor preview features") or MCP servers for Local chat.
    `/beezi-status` says so when VS Code's cached policy shows it; those sessions are then captured
    only while the Copilot CLI or app runs the watcher, or by `/beezi-sync`. Sessions on the Copilot
    (Agent Host) harness are still captured live.

## Token modes

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
- **Reasoning tokens.** `token_output` is Copilot's `outputTokens`, which already contains the reasoning tokens (in the local session store reasoning never exceeds output). The reasoning share is reported separately as `token_reasoning_output`, per model and per effort, and is never added to any total.
- **Auto and cache counters.** The Auto and cache-rewrite counts are built from per-call rows, so they exist only in `per_call` mode; in `session_totals` mode and in VS Code Local they are absent, not zero.
- **Resume.** Shutdown totals are cumulative across `--resume`: each shutdown is billed as its
  difference from the previous one in the file, never below zero.
- **Model names.** `auto` is a routing choice, not a model. The model comes from
  `session.auto_mode_resolved` and the turns, never from `selectedModel: "auto"`.
- **Late shutdown.** If the worker misses the `session.shutdown` event, the next resume or the
  watcher's next pass over the file bills it.
- **Accepted gap.** A session that crashes and is never resumed has no `session.shutdown`, so it
  reports zero tokens in `session_totals` mode.

## Billing in AI credits

- **Credits.** The plugin sends raw nano AIU (`ai_credits_nano`, per model and per segment) and the
  Beezi server converts it. For legacy plans it sends `premium_requests`.
- **Billing source.** `billing_source` is `subscription` when Copilot is signed in to GitHub and the
  session used Copilot's own models. It is `unknown` when the session ran on your own model provider
  (`COPILOT_PROVIDER_BASE_URL` for the CLI, a custom provider in the Copilot app, a bring-your-own-key
  model in VS Code), when Copilot runs offline, and when no GitHub sign-in can be read.
- **Plan.** With `subscription`, `subscription_plan` is one of `copilot_free`, `copilot_student`,
  `copilot_pro`, `copilot_pro_plus`, `copilot_max`, `copilot_business` or `copilot_enterprise`, and
  `subscription_type` is `individual`, `organization` or `enterprise`. Both are omitted when the plan is
  not known; neither is ever sent as `unknown`.
- **Where the plan comes from**, newest reading first, for the GitHub account the session ran under:

  | Source | Read from |
  |---|---|
  | A plan you declared | `/beezi-login` or `/beezi-settings refresh`, for one GitHub account; a newer observed plan replaces it |
  | The Copilot runtime | its account answer from the quota probe below, else its own user cache |
  | VS Code | the Copilot entitlement VS Code stored for the newest signed-in launch, else the plan sku Copilot Chat logged |

  A report carries the plan that was in force when the session started, so a session uploaded late
  is not repriced by a later plan change.
- **Two sign-ins.** The Copilot CLI and VS Code's Copilot Chat sign in separately, and a token
  environment variable (`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`) overrides only the CLI's.
  `billing.json` keeps an observed and a declared plan per GitHub account, so a VS Code session bound
  to its own account gets that account's plan whatever the CLI is signed in as. When VS Code's account
  differs from the CLI's and has no plan, `/beezi-login` and `/beezi-settings refresh` ask for it
  separately (`billing-capture.mjs --plan <plan> --github <host/login>`).
- **The account** on a report is `account_uuid`, the lowercase GitHub identity `<host>/<login>`, up to
  64 characters. No email is sent. The account a session ran under is found in this order:

  | Surface | Order |
  |---|---|
  | Copilot CLI and app | the account named in the hook's own environment (live hooks only); the Copilot app's record of the session; for a VS Code Agent Host session, the account VS Code's Copilot Chat had at its start; Copilot's process log next to the line that registered the session; a `Signed in successfully as <login>!` notice in the transcript |
  | VS Code Local chat | the Copilot Chat log of the launch that covered the session, else `state.vscdb` when the session's own account label agrees |

  A live session saves the account on the first checkpoint that finds one and never re-resolves it.
  When none of these names an account and this machine knows only one GitHub account, that account
  is used. When it knows several (Copilot CLI logins, Copilot app accounts, VS Code's sign-in), the
  report carries no account rather than a guess. The same order applies in live capture,
  `/beezi-sync` and the login upload.
- **Monthly quota.** A detached worker asks the Copilot runtime (`copilot --headless --stdio`,
  `account.getQuota` and `account.getCurrentAuth`) for the monthly premium-request quota at most every
  15 minutes, behind a lock and a failure backoff, and posts it to `/me/copilot/usage` as
  `limits: [{ kind: "monthly", … }]` (plus `monthly_used` on an unlimited plan). No hook ever starts the
  runtime itself. A machine with only the Copilot app or VS Code uses the runtime's own user cache
  instead. `BEEZI_COPILOT_QUOTA=0` turns the probe off. Copilot exposes no session or weekly
  rate-limit usage, and none is reported.

## Report contract and backend-first

Reports use the Claude plugin's `POST /sessions/report` shape plus these optional fields:
`models.<model>.ai_credits_nano`, `models.<model>.premium_requests`, `models.<model>.token_reasoning_output`,
`models.<model>.auto_requests`, `models.<model>.auto_ai_credits_nano`, `ai_credits_nano`, `usage_source`,
`project_instructions_status`, `project_instructions_files`, `cold_prefix_calls`,
`cold_prefix_ai_credits_nano`, `model_switches`, `idle_cold_calls`, `compactions`, `operations.failures`,
`time_to_first_token_ms`, `duration_ms`, `turn_aborted`, `model_context_window`, `originator`,
`cli_version` and `source` (`cli`, `app`, `vscode` or `vscode-agent-host`).

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
(ask once, send to chosen workspaces, or don't send). `/beezi-settings` shows and changes both: its rules
table starts with a Default row, marks the row that applies to this folder "← you're here", and lists each
rule's path or remote and its sessions over the last 30 days. A rule or New folders change made there ends
with "Undo: /beezi-settings undo", which puts the last change back. `/beezi-login` and the terminal setup ask
one question, "Where should analytics from this machine go?", and a session in a repo or folder with no
rule yet asks where that place's analytics go. On the Copilot CLI the status line can end with a Beezi
badge naming where this folder's analytics go; it is off until `/beezi-settings statusline badge on`.
Analytics held for an unanswered question wait on disk and are sent once you answer.

When a rule or the New folders default starts sending to a workspace it did not reach before, a
detached history worker (`history-worker.mjs`) sends that workspace this machine's past sessions,
skipping what it already holds. If it cannot finish, the next session start or the watcher tries
again. A later session start tells you in one line how it went.

## Data root

`~/.beezi-copilot`, plus `-<env>` on an internal build. `BEEZI_COPILOT_HOME` overrides it. The tree
comes from `lib/config/paths.mjs`:

```
accounts.json                 # linked accounts and the default
accounts/<key>/               # per account: credentials/, queue/, health.json, tracking.json, audit-ledger*.json, coverage*.json, account-sync.json, usage-pending.json
state/                        # per-session state, markers and locks (swept after 14 days)
billing.json                  # observed and declared Copilot plans per GitHub account, and the last identity seen
repo-map.json                 # directory-to-repository cache
quota-copilot.json  usage-series.json   # monthly quota cache and usage series
update-check.json  plan-nudge.json  upgrade-notice.json  installation.json
telemetry.json  telemetry-send.json  telemetry/
watcher.json  locks/  logs/watcher.log  hooks-seen.json
statusline/  statusline.sh  statusline-original.json   # status line snapshots; the shim and the saved original exist only while it is on
statusline-badge.json         # whether the CLI status line ends with the Beezi badge (off unless turned on)
rule-undo.json                # the last routing change, for /beezi-settings undo
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
`/me/copilot/machine` and `/me/copilot/usage`; the rest (`/sessions/*`,
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
| `BEEZI_COPILOT_QUOTA` | unset (on) | `0`, `false`, `no` or `off` turns the monthly quota probe off |
| `BEEZI_COPILOT_CLI` | `copilot` | the binary the quota probe starts, for a machine where `copilot` is not on the `PATH` hooks inherit |
| `BEEZI_STATUSLINE_CHAIN` | set by the status line shim | the status line command Beezi wrapped; it runs and its output is shown unchanged, plus the Beezi badge at the end when it is on |
| `BEEZI_STATUSLINE_SILENT` | unset | `1` keeps the status line capture and shows nothing, and no badge |
| `BEEZI_DEBUG` | unset | any value makes the CLI scripts print the raw error text |
| `COPILOT_HOME` | `~/.copilot` | read, not owned: where Copilot keeps its files |
| `PLUGIN_ROOT` | set by Copilot | read, not owned: the plugin's install folder |

Which of these variables reach the MCP server process is unverified: Copilot's documentation says a
server added by hand inherits only `PATH` plus its declared `env`. Overrides
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
- the skill folders, their `name` fields and every `/beezi-<skill>` mention in `skills/`, `lib/`,
  `scripts/` and `RELEASE_NOTES.md`, from `beezi-<skill>` to `beezi-<env>-<skill>`, for example `/beezi-dev-login`.

Each variant gets its own data root (`~/.beezi-copilot-<env>`), secret-store service
(`beezi-copilot-<env>`), update manifest and MCP server key.

The renames exist because of Copilot's documented precedence for duplicate names: skills are
first-found-wins and the duplicate is silently dropped, and MCP servers are last-loaded-wins with a
warning. Two plugins that share a skill name or a server key cannot both work.

## Updating

At session start the plugin compares its own version (from `plugin.json`) with the `version` in the
marketplace manifest at `env.json` `updateManifestUrl`. The check runs at most once an hour and gives
up after 1.5 seconds. Being offline, having no manifest URL and an unreadable manifest are all silent.
The plugin never updates itself. When a newer version is published it prints one line with the
commands: `copilot plugin marketplace update <marketplace>`, then `copilot plugin update <plugin>`
(in the Copilot app: Customize → Plugins → Update), then restart Copilot to apply it.
`/beezi-status` lists the same steps, and `/beezi-release-notes` shows what changed in the installed
version, the releases before it and, when a newer one is out, the same update commands.

## Coexistence

- **Claude Code plugin.** Separate data roots, secret-store services and agent header. The marketplace
  and MCP server names are distinct too: `beezi-copilot` here against `beezi` there.
- **Codex plugin.** Separate data roots.

## Node.js and the network

- Hooks, skills and the MCP server run `node` from the `PATH` Copilot hands them. Node.js 13.2 or later
  runs the plugin. Per-call token detail needs Node.js 22.13 or later (`node:sqlite`); older Node
  reports session totals, and `/beezi-status` says which one this machine uses. A machine without
  `node` on that `PATH` captures nothing; Copilot shows each hook as failed.
- Node.js uses its own certificate list. Behind a TLS-inspecting proxy, set `NODE_EXTRA_CA_CERTS` to a
  PEM file with your company's root certificate (any Node version), or `NODE_USE_SYSTEM_CA=1` to use
  the operating system's store (Node.js 22.19 or later, 24.6 or later). Either must be set in the
  environment Copilot starts from.
- The plugin does not apply proxy settings such as `HTTPS_PROXY`. On a network that allows traffic
  only through a proxy, uploads fail and wait in the queue; `/beezi-status` shows them.

## Known caveats

- **Platforms.** Tested on macOS only. Windows path handling and the Linux bash hooks were checked
  in emulation. `git` and `secret-tool` run from an absolute path found on `PATH`, never from the
  repo folder. The macOS keychain is written through `/usr/bin/security -i`, so the secret never
  appears in a process's arguments. Windows renames and locks retry on EPERM, EBUSY and EACCES.
  The PowerShell hooks force UTF-8; hook input is read with retries on a non-blocking pipe. VS Code
  runs Windows hooks through Windows PowerShell 5.1. Still unverified on real machines:
  - Windows hook stdin encoding under PowerShell 5.1 and 7;
  - whether `shutdown-worker.mjs` survives Copilot exiting;
  - Credential Manager limits;
  - Linux keyring behaviour on desktop and headless machines.
- In `copilot -p` mode `SessionEnd` fires on every turn, so nothing in `report.mjs` is one-shot.
- The built-in `general-purpose` subagent fires no subagent hooks. Its events are still in
  `events.jsonl`.
- `ErrorOccurred` replaces the Claude `StopFailure`. It carries no HTTP status; the status comes from
  the `session.error` events in the session file.
- `PermissionRequest` output is a decision channel, so the script prints nothing at all. Any byte on
  stdout could approve or deny a real prompt.
- The most important actionable `SessionStart` notice rides `additionalContext` as one line the model
  is asked to relay. Delivery trouble (reports refused or waiting for more than a day) is one of those
  notices; `/beezi-status` shows each account's queue, last error and where its sign-in is stored.
- A `node:sqlite` ExperimentalWarning must not reach a hook's stderr, so hook commands run
  `node --no-warnings`.
- On VS Code Agent Host only part of the hook events fire, which is why the watcher exists.
- Detached child processes started by a hook are assumed to outlive it (unverified).

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
