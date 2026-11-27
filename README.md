# 5dive MCP server

[![npm](https://img.shields.io/npm/v/@5dive/mcp)](https://www.npmjs.com/package/@5dive/mcp)
[![Awesome MCP Servers](https://img.shields.io/badge/Awesome-MCP%20Servers-8A2BE2)](https://github.com/punkpeye/awesome-mcp-servers)

Expose the [**5dive**](https://5dive.ai) agent-fleet CLI as [Model Context
Protocol](https://modelcontextprotocol.io) tools, so the assistant you already
chat with (Claude, ChatGPT, OpenAI dots, Grok, Cursor, …) can run your 5dive
team: see what is blocked, file and assign work, message agents and read their
answers, hire from the marketplace, and answer the team's ordinary decisions.

It has the same tools, names and refusals as 5dive's hosted connector
(`https://api.5dive.com/mcp`), running on your own box.

[5dive](https://5dive.ai) is the CLI + control plane for running a fleet of
autonomous coding agents as a self-governing company. This server is a thin,
honest adapter: every tool shells out to the local `5dive` binary's
machine-readable `--json` surface and returns the result — so it inherits the
CLI's auth, permissions, and audit log for free, and never handles secrets itself.

## Tools

| Tool | Writes | What it does |
| --- | --- | --- |
| `fleet_status` | | One-call overview: agents, open tasks, what is blocked, what waits on you. |
| `agents_list` | | Every agent: type, model, live state, channels. |
| `agents_send` | ✓ | Message an agent and wake it. Returns a `reply_id`. |
| `agents_read` | | That agent's answer to your message (by `reply_id`), nothing else on its screen. |
| `tasks_list` | | Tasks by status, assignee or project; `since` to catch finished work. |
| `tasks_get` | | One task: result, delivery link, review verdict, blockers. |
| `tasks_create` | ✓ | File a task, with acceptance criteria, a reviewer and a project. |
| `tasks_assign` | ✓ | Give a task to an agent; returns the undo. |
| `tasks_update` | ✓ | Add a note, raise to high, add or drop a blocker, or cancel. |
| `projects_list` | | The team's projects. |
| `wiki_search` | | The shared team wiki only, never an agent's private notes. |
| `marketplace_list` | | Agents you can hire. |
| `agents_hire` | ✓ | Hire one onto the team. Never a paid one. |
| `gates_list` | | What the team waits on you for, and which ones the assistant may answer. |
| `gates_answer` | ✓ | Answer an ordinary decision or approval. Money, keys, manual steps and anything marked for you are refused. |
| `secrets_request` | ✓ | A one-time link where you type a key; the assistant never sees it. |
| `digest_get` | | The daily standup digest (`window: "7d"` for the week). |

The 0.2 tool names (`task_create`, `task_show`, `task_list`, `agent_send`,
`agent_list`) still work for existing setups but are no longer listed.

**Differences from the hosted connector.** Your box has no 5dive app chat, so
`agents_send` goes straight into the agent's session and `agents_read` reads its
answer there (it needs `FIVEDIVE_SUDO=1` or root). There is no plan, so
`agents_hire` stops at the team size you set in `FIVEDIVE_MCP_MAX_AGENTS`, if
any. MCP events (pushes when a task is delivered or done) are left out: poll
`tasks_list` with `since` instead.

## Requirements

- Node.js >= 18
- The `5dive` CLI installed and on `PATH` (`curl https://install.5dive.ai | sudo bash`).

## Install & run

```bash
npx @5dive/mcp        # run directly
# or
npm i -g @5dive/mcp && 5dive-mcp
```

### Client config (Claude Desktop / Cursor / Cline)

```json
{
  "mcpServers": {
    "5dive": {
      "command": "npx",
      "args": ["-y", "@5dive/mcp"],
      "env": { "FIVEDIVE_SUDO": "1" }
    }
  }
}
```

## Remote mode: `5dive-mcp serve` (ChatGPT, OpenAI dots)

A client that runs in someone else's cloud can't spawn a stdio process on your
box. `serve` puts the same tools behind MCP's Streamable HTTP transport, on
loopback, for your reverse proxy to publish over HTTPS.

> Using **managed 5dive**? You don't need this: connect to
> `https://api.5dive.com/mcp` and sign in. See
> [the guide](https://5dive.ai/docs/openai-dots).

```bash
# 1. Mint a token. It is printed once; only its hash is kept.
5dive-mcp token create --name=chatgpt            # read-only
5dive-mcp token create --name=chatgpt --write    # may also change things (the ✓ tools)

# 2. Serve on loopback (default 127.0.0.1:8741, path /mcp).
FIVEDIVE_SUDO=1 5dive-mcp serve

# 3. Publish it over HTTPS, e.g. with Caddy (automatic certificates):
#    agents.example.com {
#        reverse_proxy /mcp* 127.0.0.1:8741
#    }
```

Then point the client at it:

- **Clients that can send a header** (Claude Code, the MCP inspector, most SDKs):
  `https://agents.example.com/mcp` with `Authorization: Bearer <token>`.
- **ChatGPT developer mode** offers only OAuth or "No authentication", so put
  the token in the URL and choose "No authentication":
  `https://agents.example.com/mcp/<token>`.

`5dive-mcp token list` shows the tokens; `5dive-mcp token revoke --name=chatgpt`
cuts one off, and a running server refuses it from the next request.

| `serve` flag | Default | Purpose |
| --- | --- | --- |
| `--listen` | `127.0.0.1:8741` | Address to bind. A non-loopback address is refused unless you pass `--allow-public-http`. |
| `--path` | `/mcp` | Mount point. |
| `--rate` | `60` | Tool calls per token per minute. |

### Security: what opening this endpoint means

- **What a token can do.** A read-only token can only read (the tools with no
  ✓). A `--write` token can also use the ✓ tools. No token can answer a gate
  about money, a key, a manual step or anything marked for you, see a key,
  hire a paid agent, change settings, or run anything outside these tools'
  CLI calls, each built as a fixed argv with no shell. Whatever sender the
  remote client claims is dropped: its messages arrive labelled
  `mcp-<token name>`, its tasks say in their body which connection filed
  them, and a gate it answers is recorded as answered by `connector`.
- **Who it runs as.** The tools run with the rights of the user running
  `serve`, plus root through `sudo` when `FIVEDIVE_SUDO=1`. The server only
  ever runs these tools' subcommands, but a compromised server process holds that
  user's rights, so run it as a dedicated user whose sudo grant covers only
  the `5dive` binary.
- **Rate limit.** 60 calls a minute per token by default (`--rate`), counted per
  JSON-RPC message: batches are refused before anything runs. Bodies over 1 MiB
  are refused.
- **Audit.** Every tool call, allowed or refused, appends one line to
  `audit.jsonl`: time, token name, tool, outcome, client IP (from
  `X-Forwarded-For` when the proxy is on loopback), and the ids and names
  involved. Message text and task bodies are never written.
- **Tokens at rest.** `tokens.json` (mode 0600) holds a SHA-256 of each
  token, never the token. Both files live in `$FIVEDIVE_MCP_HOME`, default
  `~/.config/5dive-mcp`.
- **A token in the URL is a password in the URL.** Your reverse proxy's access
  log records request paths. Turn path logging off for `/mcp/*`, or use header
  auth where the client supports it. Anyone holding the URL holds the token.
- **Plain HTTP stays on loopback.** `serve` refuses a public bind by default,
  because the token would cross the network unencrypted.

Prefer no inbound port at all? OpenAI's
[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
runs a small client next to the server and connects out to OpenAI. Its
`tunnel-client` can launch the stdio server directly
(`--mcp-command "npx -y @5dive/mcp"`), but it needs an OpenAI Platform
organization with tunnel permissions.

## Configuration (env vars)

| Var | Default | Purpose |
| --- | --- | --- |
| `FIVEDIVE_BIN` | `5dive` | Path to the 5dive binary. |
| `FIVEDIVE_SUDO` | *(unset)* | Set to `1` to prefix calls with `sudo`. Managed 5dive boxes require root for most subcommands; leave unset if you already run as root. |
| `FIVEDIVE_TIMEOUT_MS` | `30000` | Per-call timeout in milliseconds. |
| `FIVEDIVE_MCP_HOME` | `~/.config/5dive-mcp` | Where `serve` keeps `tokens.json` and `audit.jsonl`. |
| `FIVEDIVE_MCP_MAX_AGENTS` | *(no limit)* | Team size `agents_hire` will not hire past. |

## Safety

Arguments are passed to the CLI as an argv array with **no shell**, so tool input
can never be interpreted as shell syntax. The server never sees secrets: the CLI
reads its own credentials from the box.

## Scope

This mirrors the hosted connector's team-lead slice of the CLI, not its full
surface. It is a distribution and convenience layer, not a new API. For
everything else, use the `5dive` CLI directly (`5dive --help`). Full docs: https://5dive.ai/docs/5dive-cli

## License

MIT
