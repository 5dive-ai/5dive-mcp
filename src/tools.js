// The 5dive tool set, shared by both transports (stdio in index.js, Streamable
// HTTP in http.js). Every tool shells out to the local `5dive` binary with its
// machine-readable `--json` surface ({ok:true,data} | {ok:false,error}) and
// returns the `data` payload, so this is a thin, honest adapter — the CLI does
// all the real work.
//
// Config (env):
//   FIVEDIVE_BIN   path to the 5dive binary (default: "5dive", found on PATH)
//   FIVEDIVE_SUDO  if set to "1"/"true", prefix invocations with sudo. Managed
//                  5dive boxes require root for most subcommands; self-hosted
//                  setups that already run as root should leave this unset.
//   FIVEDIVE_TIMEOUT_MS  per-call timeout in ms (default: 30000)

import { execFile } from "node:child_process";

const BIN = process.env.FIVEDIVE_BIN || "5dive";
const SUDO = /^(1|true|yes)$/i.test(process.env.FIVEDIVE_SUDO || "");
const TIMEOUT_MS = Number(process.env.FIVEDIVE_TIMEOUT_MS) || 30000;

export const BIN_LABEL = `${SUDO ? "sudo " : ""}${BIN}`;

// Run `5dive --json <args...>` with no shell (argv passed directly, so user
// input can never be interpreted as shell syntax). Resolves to the parsed
// envelope; rejects with a readable message on transport or CLI-level error.
export function run5dive(args) {
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

// `write: true` marks a tool that changes the team (files a task, wakes an
// agent). Over stdio that changes nothing; over HTTP it needs a token minted
// with --write (see http.js).
export const TOOLS = [
  {
    name: "task_create",
    write: true,
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
    write: false,
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
    write: false,
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
    write: true,
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
    write: false,
    description:
      "List every agent on the box: name, type, channels, model, and live state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    toArgs() {
      return ["agent", "list"];
    },
  },
  {
    name: "digest_get",
    write: false,
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

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Run one tool and shape the MCP result. A failure is a result, not a throw. */
export async function callTool(name, input, exec = run5dive) {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) {
    return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
  }
  try {
    const data = await exec(tool.toArgs(input || {}));
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: err.message || String(err) }] };
  }
}
