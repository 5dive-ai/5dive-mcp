# 5dive MCP server

[![npm](https://img.shields.io/npm/v/@5dive/mcp)](https://www.npmjs.com/package/@5dive/mcp)
[![Awesome MCP Servers](https://img.shields.io/badge/Awesome-MCP%20Servers-8A2BE2)](https://github.com/punkpeye/awesome-mcp-servers)

Expose the [**5dive**](https://5dive.ai) agent-fleet CLI as [Model Context
Protocol](https://modelcontextprotocol.io) tools. Point any MCP client (Claude
Desktop, Cursor, Cline, or your own) at this stdio server to file tasks, inspect
and message agents, and read the fleet digest — directly from inside a model
context.

[5dive](https://5dive.ai) is the CLI + control plane for running a fleet of
autonomous coding agents as a self-governing company. This server is a thin,
honest adapter: every tool shells out to the local `5dive` binary's
machine-readable `--json` surface and returns the result — so it inherits the
CLI's auth, permissions, and audit log for free, and never handles secrets itself.

## Tools

| Tool | Wraps | What it does |
| --- | --- | --- |
| `task_create` | `5dive task add` | File a task in the shared queue (title, body, priority, assignee, parent). |
| `task_show` | `5dive task show` | Full detail for one task by id (status, body, result, subtasks, blockers). |
| `task_list` | `5dive task ls` | List tasks (open by default; filter by status / assignee). |
| `agent_send` | `5dive agent send` | Send a message to another agent on the fleet. |
| `agent_list` | `5dive agent list` | List every agent: type, channels, model, live state. |
| `digest_get` | `5dive digest` | Fleet daily standup digest (`window: "7d"` for the weekly view). |

## Requirements

- Node.js >= 18
- The `5dive` CLI installed and on `PATH` (`curl https://install.5dive.com | sudo bash`).

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

## Configuration (env vars)

| Var | Default | Purpose |
| --- | --- | --- |
| `FIVEDIVE_BIN` | `5dive` | Path to the 5dive binary. |
| `FIVEDIVE_SUDO` | *(unset)* | Set to `1` to prefix calls with `sudo`. Managed 5dive boxes require root for most subcommands; leave unset if you already run as root. |
| `FIVEDIVE_TIMEOUT_MS` | `30000` | Per-call timeout in milliseconds. |

## Safety

Arguments are passed to the CLI as an argv array with **no shell**, so tool input
can never be interpreted as shell syntax. The server never sees secrets: the CLI
reads its own credentials from the box.

## Scope

This mirrors a curated slice of the CLI (tasks, agents, digest), not its full
surface. It is a distribution and convenience layer, not a new API. For
everything else, use the `5dive` CLI directly (`5dive --help`). Full docs: https://5dive.ai/docs/5dive-cli

## License

MIT
