# Beezi analytics for GitHub Copilot

This plugin shows your own Beezi usage analytics inside GitHub Copilot: spend, sessions, top model, a status and up to three recommendations, for the last 7 or 30 days. It is read-only. It records nothing and changes nothing in Beezi.

## Requirements

A Beezi account. The plugin signs in as you, and the summary covers your default Beezi workspace.

## Install

From Beezi's marketplace:

```
copilot plugin marketplace add Beezi-AI/beezi-copilot-plugin-dev
copilot plugin install beezi-analytics-staging@beezi-copilot-internal
```

## Sign in

Run `/mcp`, choose the `beezi-staging` server, then sign in. A browser window opens for your Beezi sign-in. Until you have signed in, the summary replies with the same instruction.

## Usage

```
/beezi-staging-analytics
/beezi-staging-analytics 30d
/beezi-staging-about
```

`/beezi-staging-analytics` prints the summary for the period you give; with no period it uses 7 days. Key numbers cover all your coding agents; recommendations cover GitHub Copilot unless you ask for all agents. `/beezi-staging-about` explains what the plugin does and where the numbers come from.

## What it connects to

The plugin declares one MCP server, `beezi-staging`, at `https://beezi-api-staging.azurewebsites.net/api/mcp`. It sends the header `X-Beezi-Agent: copilot` so Beezi knows the request comes from GitHub Copilot. The plugin has no hooks, scripts or local code, and it sends nothing from your conversations. Its skills call only your personal summary. If you ask Copilot other questions about your Beezi analytics, it may use the server's other read-only tools, which return only what your Beezi role lets you see.

## The full Beezi plugin

Sessions come from the full Beezi plugin, `beezi-staging`, in this marketplace, which records GitHub Copilot usage. It includes this summary, so install one or the other.

## Links

- Documentation: https://docs.beezi.ai/coding-tool/beezi-analytics-plugin
- Privacy policy: https://beezi.ai/privacy-policy
- Terms: https://beezi.ai/terms-and-conditions
- Support: https://beezi.ai/contact-us

## License

Apache License 2.0. See `LICENSE`.
