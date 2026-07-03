# 5dive MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) (stdio) server that
exposes the [5dive](https://5dive.com) agent-fleet CLI as MCP tools. Point any
MCP client (Claude Desktop, Cursor, Cline, or your own) at it to file tasks,
inspect and message agents, and read the fleet digest from inside a model
context.

It is a thin, honest adapter: every tool shells out to the local `5dive` binary's
machine-readable `--json` surface and returns the result. The CLI does all the
real work, so the server inherits its auth, permissions, and audit log for free.

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
everything else, use the `5dive` CLI directly (`5dive --help`).

## License

MIT
