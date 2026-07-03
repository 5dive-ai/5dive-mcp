#!/usr/bin/env node
// 5dive MCP server (stdio).
//
// Exposes the 5dive agent-fleet CLI as Model Context Protocol tools. Every tool
// shells out to the local `5dive` binary with its machine-readable `--json`
// surface ({ok:true,data} | {ok:false,error}) and returns the `data` payload,
// so this server is a thin, honest adapter — the CLI does all the real work.
//
// Config (env):
//   FIVEDIVE_BIN   path to the 5dive binary (default: "5dive", found on PATH)
//   FIVEDIVE_SUDO  if set to "1"/"true", prefix invocations with sudo. Managed
//                  5dive boxes require root for most subcommands; self-hosted
//                  setups that already run as root should leave this unset.
//   FIVEDIVE_TIMEOUT_MS  per-call timeout in ms (default: 30000)

import { execFile } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BIN = process.env.FIVEDIVE_BIN || "5dive";
const SUDO = /^(1|true|yes)$/i.test(process.env.FIVEDIVE_SUDO || "");
const TIMEOUT_MS = Number(process.env.FIVEDIVE_TIMEOUT_MS) || 30000;

// Run `5dive --json <args...>` with no shell (argv passed directly, so user
// input can never be interpreted as shell syntax). Resolves to the parsed
// envelope; rejects with a readable message on transport or CLI-level error.
function run5dive(args) {
  const file = SUDO ? "sudo" : BIN;
  const argv = SUDO ? [BIN, "--json", ...args] : ["--json", ...args];
  return new Promise((resolve, reject) => {
    execFile(
      file,
      argv,
      { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = (stdout || "").trim();
        // The CLI emits its JSON envelope on stdout even for handled errors
        // (exit 1). Prefer parsing that over the raw process error.
        let parsed = null;
        if (out) {
          try {
            parsed = JSON.parse(out);
          } catch {
            /* fall through to error handling below */
          }
        }
        if (parsed && parsed.ok === true) return resolve(parsed.data);
        if (parsed && parsed.ok === false) {
          const e = parsed.error || {};
          return reject(
            new Error(`5dive: ${e.message || "error"}${e.code ? ` (${e.code})` : ""}`)
          );
        }
        if (err) {
          const detail = (stderr || err.message || "").trim();
          return reject(new Error(`5dive invocation failed: ${detail}`));
        }
        reject(new Error(`5dive: unparseable output: ${out.slice(0, 400)}`));
      }
    );
  });
}

// Push --flag=value onto argv when the input field is present and non-empty.
function pushFlag(argv, name, value) {
  if (value === undefined || value === null || value === "") return;
  argv.push(`--${name}=${value}`);
}

const TOOLS = [
  {
    name: "task_create",
    description:
      "Create a task in the shared 5dive task queue. Returns the new task's id (e.g. DIVE-N). Use for filing work for an agent or human on the fleet.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short task title." },
        body: { type: "string", description: "Full task description / context." },
        priority: {
          type: "string",
          enum: ["low", "medium", "high", "urgent"],
          description: "Task priority (default: medium).",
        },
        assignee: { type: "string", description: "Agent name to assign to." },
        parent: {
          type: "string",
          description: "Parent task id (numeric or DIVE-N) to nest under.",
        },
        from: { type: "string", description: "Who is filing the task." },
      },
      required: ["title"],
      additionalProperties: false,
    },
    toArgs(input) {
      // Flags first, then `--`, then the positional title. The `--`
      // end-of-options separator makes a title that starts with "--" safe
      // (the CLI treats everything after `--` as positional, not a flag).
      const argv = ["task", "add"];
      pushFlag(argv, "body", input.body);
      pushFlag(argv, "priority", input.priority);
      pushFlag(argv, "assignee", input.assignee);
      pushFlag(argv, "parent", input.parent);
      pushFlag(argv, "from", input.from);
      argv.push("--", String(input.title));
      return argv;
    },
  },
  {
    name: "task_show",
    description:
      "Fetch full detail for one task by id (numeric or DIVE-N): status, priority, body, result, subtasks, and blockers.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task id, e.g. 923 or DIVE-923." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    toArgs(input) {
      // `task show` reads its id positionally without a `--` separator, so
      // guard against an id that would be misparsed as a flag. Real ids are
      // numeric or DIVE-N and never start with "-".
      const id = String(input.id);
      if (id.startsWith("-")) throw new Error(`invalid task id: ${id}`);
      return ["task", "show", id];
    },
  },
  {
    name: "task_list",
    description:
      "List tasks in the shared queue. Defaults to open tasks in priority order; filter by status or assignee.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "Filter by status (e.g. todo, in_progress, blocked, done).",
        },
        assignee: { type: "string", description: "Filter by assignee agent name." },
        all: { type: "boolean", description: "Include closed tasks too." },
      },
      additionalProperties: false,
    },
    toArgs(input) {
      const argv = ["task", "ls"];
      pushFlag(argv, "status", input.status);
      pushFlag(argv, "assignee", input.assignee);
      if (input.all) argv.push("--all");
      return argv;
    },
  },
  {
    name: "agent_send",
    description:
      "Send a message to another agent on the fleet by name (inter-agent comms). The recipient receives it in-session.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Recipient agent name." },
        message: { type: "string", description: "Message text to deliver." },
        from: { type: "string", description: "Sender label (optional)." },
      },
      required: ["name", "message"],
      additionalProperties: false,
    },
    toArgs(input) {
      // Flags first, then `--`, then the positional recipient name, so a
      // name starting with "--" can't be misparsed as a flag.
      const argv = ["agent", "send", `--message=${input.message}`];
      pushFlag(argv, "from", input.from);
      argv.push("--", String(input.name));
      return argv;
    },
  },
  {
    name: "agent_list",
    description:
      "List every agent on the box: name, type, channels, model, and live state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    toArgs() {
      return ["agent", "list"];
    },
  },
  {
    name: "digest_get",
    description:
      "Get the fleet's daily standup digest (activity, token burn, health). Pass window=7d for the weekly view.",
    inputSchema: {
      type: "object",
      properties: {
        window: {
          type: "string",
          enum: ["1d", "7d"],
          description: "Digest window: 1d (default) or 7d.",
        },
      },
      additionalProperties: false,
    },
    toArgs(input) {
      const argv = ["digest"];
      if (input.window === "7d") argv.push("--7d");
      return argv;
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

const server = new Server(
  { name: "5dive-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = TOOL_BY_NAME.get(request.params.name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
    };
  }
  const input = request.params.arguments || {};
  try {
    const data = await run5dive(tool.toArgs(input));
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: err.message || String(err) }],
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs — stdout is the MCP framing channel.
  process.stderr.write(
    `5dive-mcp ready (${TOOLS.length} tools; bin=${SUDO ? "sudo " : ""}${BIN})\n`
  );
}

main().catch((err) => {
  process.stderr.write(`5dive-mcp fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
