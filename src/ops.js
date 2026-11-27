// The team-lead tool set: the same tools, names and refusals as 5dive's hosted
// connector (api.5dive.com/mcp), run on the box itself through the local
// `5dive --json` CLI. A model that learned the hosted tools uses these the
// same way.
//
// Each tool's `run(input, exec, ctx)` is pure over an injected `exec`:
//   exec(argv, {timeoutMs?, text?}) -> Promise<data>
// resolves with the CLI's `data` payload (or, with `text`, its plain stdout)
// and rejects with a readable Error on a CLI refusal. That is what the tests
// stub. `ctx.sender` is the envelope label a message goes out under
// (mcp-<token> over HTTP, "mcp" over stdio); `ctx.via` names the connection
// that filed a task.
//
// What differs from the hosted set, and why:
//   - agents_send / agents_read: a self-hosted box has no 5dive app chat, so a
//     message goes straight into the agent's session and agents_read returns
//     that agent's answer to it (the reply window after the message's own
//     marker, the same read `5dive agent ask` does). It takes the reply_id
//     agents_send returned, so it can never read anything else on the screen.
//   - agents_hire: the box has no plan. It respects the box's own limits: the
//     CLI's own refusals, plus a team size the owner can set with
//     FIVEDIVE_MCP_MAX_AGENTS. A pack with a price is still never hired here.
//   - MCP events (task.delivered / task.done pushes) are left out: they need a
//     sweeper holding state on the box. Poll tasks_list with since instead.
//
// Kept byte-for-byte in meaning: gates_answer answers only a decision or an
// approval below tier 2, with no declared capability and no money in its
// words. A secret, a manual step, a tier-2 gate or money is refused with the
// reason and stays the owner's.

// ---------------------------------------------------------------------------
// Bounds and shapes (the hosted connector's, unchanged)

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TASK_RE = /^(?:[A-Z][A-Z0-9]{0,15}-)?[0-9]{1,9}$/;
const STATUSES = new Set(["todo", "in_progress", "blocked", "done", "cancelled", "parked"]);
const MAX_MESSAGE = 4000;
const MAX_TITLE = 200;
const MAX_RESULT = 2000;
const PRIORITIES = new Set(["low", "medium", "high"]);
const MAX_ANSWER = 500;
const MAX_REASON = 500;
const MAX_NOTE = 2000;
const MAX_SECRET_LINKS = 5;
const MAX_BLOCK_SCAN = 10;
const MAX_LIST = 200;
const MAX_ACCEPT = 2000;
const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const WIKI_DEFAULT = 5;
const WIKI_MAX = 10;
const WIKI_MAX_TOKENS = 1500;
const WIKI_SNIPPET = 500;
const MAX_QUERY = 200;
const SECRET_KEY_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const SECRET_NOTE =
  "Give this link to the user; they type the key there, never in this chat. It works once and expires.";
const MONEY_RE =
  /[$€£¥]\s?\d|\b\d+(?:[.,]\d+)?\s?(?:usd|usdc|usdt|eur|gbp|sol|btc|eth|dollars?|euros?|cents?|bucks)\b|\b(?:pay|paid|paying|payment|payments|payout|spend|spending|spent|purchase|purchasing|buy|buying|invoice|billing|bill|subscription|subscribe|refund|charge|charged|price|pricing|budget|fund|funds|funding|wallet|stripe|credit card|top[- ]?up|cost|costs)\b/i;
const MONEY_TERM_RE = /term=(?:spend|money|pay|payment|billing|price|purchase|fund|cost|budget|wallet)/i;
const HIRE_NAME_RE = /^[a-z][a-z0-9-]{0,15}$/;
const PACK_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SYSTEM_SEATS = ["sysadmin"];
const IMPORT_TIMEOUT_MS = 300_000;
const HIRE_WAIT_MS = 20_000;

// Self-hosted only: the id `agent send` stamps on a message (gen_msg_id).
const REPLY_ID_RE = /^[A-Za-z0-9]{1,32}$/;
// An agent's answer is cut from the front: the end is the newest part.
const MAX_REPLY = 4000;

/** A tool failure the model should read. */
export class OpError extends Error {}

function str(input, key, max) {
  const v = input[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new OpError(`${key} must be a string`);
  const t = v.trim();
  if (!t) return undefined;
  if (t.length > max) throw new OpError(`${key} is longer than ${max} characters`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(t)) {
    throw new OpError(`${key} contains control characters`);
  }
  return t;
}

const isSet = (input, k) => input[k] !== undefined && input[k] !== null && input[k] !== "";

function agentName(input, key = "agent") {
  const v = str(input, key, 64);
  if (!v) throw new OpError(`${key} is required`);
  if (!NAME_RE.test(v)) throw new OpError(`${key} is not a valid agent name`);
  return v;
}

function projectKey(input, key = "project") {
  const v = str(input, key, 32)?.toLowerCase();
  if (!v) throw new OpError(`${key} is required`);
  if (!PROJECT_RE.test(v)) throw new OpError(`${key} is not a project key (see projects_list)`);
  return v;
}

function taskId(input, key = "task") {
  const v = str(input, key, 32)?.toUpperCase();
  if (!v) throw new OpError(`${key} is required (e.g. DIVE-123)`);
  if (!TASK_RE.test(v)) throw new OpError(`${key} must look like DIVE-123`);
  return v;
}

function intIn(input, key, max, dflt) {
  const v = input[key];
  if (v === undefined || v === null) return dflt;
  if (!Number.isInteger(v) || v < 1 || v > max) throw new OpError(`${key} must be a whole number from 1 to ${max}`);
  return v;
}

const optionsOf = (v) =>
  typeof v === "string" && v ? v.split("|").map((o) => o.trim()).filter(Boolean) : [];

/**
 * Why a connector may NOT answer this gate, or null if it may. The hosted
 * connector's rule, word for word. Unknown is refused.
 */
export function answerRefusal(t) {
  const type = t.need_type;
  if (type === "secret") return "it asks for a key or password, which only the user types, through its secure link";
  if (type === "manual") return "it is a step only the user can take";
  if (type !== "decision" && type !== "approval") return "it is not a decision or an approval";
  const tier = t.tier === null || t.tier === undefined || t.tier === "" ? NaN : Number(t.tier);
  if (!(tier < 2) || (typeof t.needs_capability === "string" && t.needs_capability)) {
    return "it is marked for the user only (money, something that cannot be undone, or a tap only they can make)";
  }
  const words = [t.title, t.ask, t.need_options, t.recommend].filter((x) => typeof x === "string").join(" \n ");
  if (MONEY_RE.test(words) || (typeof t.floor_provenance === "string" && MONEY_TERM_RE.test(t.floor_provenance))) {
    return "it is about money";
  }
  return null;
}

function answerOptions(t) {
  if (t.need_type === "approval") return ["approve", "deny"];
  return optionsOf(t.need_options);
}

// ---------------------------------------------------------------------------
// Projections: the fields that answer "what is blocked / who has it".

function asArray(v, key) {
  if (Array.isArray(v)) return v;
  if (key && v && typeof v === "object" && Array.isArray(v[key])) return v[key];
  return [];
}

function text(r, key) {
  const v = r[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

function taskRow(t) {
  const out = {
    task: t.ident ?? t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    assignee: t.assignee ?? null,
  };
  if (t.gate && t.gate !== "-" && t.gate !== "none") out.gate = t.gate;
  if (t.need_type) out.waiting_on = t.need_type;
  return out;
}

function agentRow(a) {
  const hb = a.heartbeat ?? {};
  return {
    agent: a.name,
    type: a.type,
    model: a.model ?? null,
    state: a.operationalState ?? a.active ?? null,
    channels: a.channels ?? null,
    last_seen: typeof hb.lastSeenWhy === "string" ? hb.lastSeenWhy : null,
  };
}

// No app on a self-hosted box: the owner answers a gate where their agents
// already reach them (Telegram), or with `5dive task answer` on the box.
const answerWhere = (task) => `the user answers it in their agent's chat or with: 5dive task answer ${task}`;

function gateRow(g) {
  const task = String(g.ident ?? g.id);
  const refusal = answerRefusal(g);
  const out = {
    task,
    title: g.title,
    kind: g.need_type,
    question: g.ask,
    filed_by: g.assignee ?? null,
    you_can_answer: refusal === null,
    answer_at: answerWhere(task),
  };
  if (refusal === null) {
    const opts = answerOptions(g);
    if (opts.length) out.options = opts;
    if (typeof g.recommend === "string" && g.recommend) out.recommended = g.recommend;
  } else {
    out.why_not_you = refusal;
  }
  return out;
}

function packRow(p) {
  return {
    agent_id: p.slug,
    name: text(p, "name"),
    job: text(p, "role"),
    about: text(p, "tagline"),
    department: text(p, "department"),
  };
}

async function roster(exec) {
  return asArray(await exec(["agent", "list"]), "agents");
}

async function requireSeat(exec, name) {
  // Resolved off the box: a name that is not one of the box's own agents never
  // reaches an argv position.
  const seat = (await roster(exec)).find((a) => a.name === name);
  if (!seat) throw new OpError(`there is no agent called "${name}" on your team`);
  return seat;
}

async function projects(exec) {
  return asArray(await exec(["project", "ls"]), "projects");
}

async function requireProject(exec, key) {
  const p = (await projects(exec)).find((r) => String(r.key).toLowerCase() === key);
  if (!p || (p.status !== undefined && p.status !== "active")) {
    throw new OpError(`there is no project "${key}" on your team; projects_list shows them`);
  }
}

/** `memory search` prints text. Only a shared-wiki page survives, never an agent's own store. */
export function parseWikiHits(out) {
  const hits = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    hits.push({ page: cur.page, title: cur.title, score: cur.score, snippet: cut(cur.lines.join("\n").trim(), WIKI_SNIPPET) });
    cur = null;
  };
  for (const line of out.split("\n")) {
    const m = /^\[(\d+(?:\.\d+)?)\] (\S.*?)  ›  (.*?)(?:  \[[^\]]*\])?$/.exec(line);
    if (m) {
      flush();
      const path = m[2];
      if (/(^|\/)\.claude\/|^memory\/|\/memory\/[^/]+\.md$/.test(path)) continue;
      cur = { page: path.split("/").pop().replace(/\.md$/, ""), title: m[3].trim(), score: Number(m[1]), lines: [] };
    } else if (cur && /^ {4}/.test(line)) {
      cur.lines.push(line.slice(4));
    } else if (cur && line.trim() === "") {
      flush();
    }
  }
  flush();
  return hits;
}

async function showTask(exec, task, noBody = false) {
  const shown = await exec(["task", "show", task, ...(noBody ? ["--no-body"] : [])]);
  const t = shown?.task ?? shown ?? null;
  if (!t || typeof t !== "object") throw new OpError(`there is no task ${task}`);
  return { t, blockedBy: asArray(shown?.blocked_by) };
}

const gateOpen = (t) =>
  typeof t.need_type === "string" && !!t.need_type && !t.need_answered_at && t.status !== "done" && t.status !== "cancelled";

function httpsLink(url, expires) {
  if (typeof url !== "string") return null;
  try {
    if (new URL(url).protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { link: url, expires_at: typeof expires === "string" ? expires : "" };
}

async function mintSecretLink(exec, task) {
  const d = await exec(["secret", "link", task]);
  return httpsLink(d?.url, d?.expires_at);
}

async function blocksOf(exec, task) {
  const blocked = asArray(await exec(["task", "ls", "--status=blocked", "--no-body"]), "tasks")
    .filter((t) => String(t.ident ?? t.id) !== task)
    .sort((a, b) => Number(!!a.need_type) - Number(!!b.need_type));
  const scan = blocked.slice(0, MAX_BLOCK_SCAN);
  const shown = await Promise.all(scan.map((t) => showTask(exec, String(t.ident ?? t.id), true).catch(() => null)));
  const tasks = [];
  shown.forEach((s, i) => {
    if (s?.blockedBy.some((b) => String(b.ident ?? b.id) === task)) {
      tasks.push({ task: scan[i].ident ?? scan[i].id, title: scan[i].title, status: scan[i].status });
    }
  });
  return { tasks, complete: blocked.length <= MAX_BLOCK_SCAN && shown.every(Boolean) };
}

function cliTime(v) {
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(v) || !/\d\d:\d\d/.test(v) ? v : `${v.replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) throw new OpError("since must be a time, e.g. 2026-11-25T14:00:00Z");
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function hireBaseName(slug) {
  const base = slug.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^[^a-z]+/, "").slice(0, 16).replace(/-+$/, "");
  return HIRE_NAME_RE.test(base) ? base : "agent";
}

function hireAgentName(slug, taken) {
  const base = hireBaseName(slug);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const name = `${base.slice(0, 16 - String(n).length - 1).replace(/-+$/, "")}-${n}`;
    if (!taken.has(name)) return name;
  }
  return `agent-${Date.now() % 100000}`;
}

async function settleOrPending(work, ms) {
  let timer;
  const pending = new Promise((resolve) => {
    timer = setTimeout(() => resolve("pending"), ms);
  });
  try {
    return await Promise.race([work, pending]);
  } finally {
    clearTimeout(timer);
  }
}

/** The owner's own team-size cap (FIVEDIVE_MCP_MAX_AGENTS), or null for none. */
export function maxAgents(env = process.env) {
  const n = Number(env.FIVEDIVE_MCP_MAX_AGENTS);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** An agent's answer out of `agent _capture`'s reply window: the fenced reply if there is one. */
export function replyText(raw, id) {
  const s = typeof raw === "string" ? raw : "";
  const fence = new RegExp(`<5dive-r:${id}>\\n?([\\s\\S]*?)\\n?</5dive-r:${id}>`).exec(s);
  const body = (fence ? fence[1] : s).replace(/\s+$/, "");
  return body.length > MAX_REPLY ? `…${body.slice(body.length - MAX_REPLY)}` : body;
}

// ---------------------------------------------------------------------------

export const OPS = [
  {
    name: "fleet_status",
    write: false,
    description:
      "One-call overview of the user's 5dive agent team: every agent and its state, open tasks by status, the blocked tasks, and the items waiting on the user (needs-you). Start here.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run(_input, exec) {
      const [agents, tasks, inbox] = await Promise.all([
        roster(exec),
        exec(["task", "ls"]).then((d) => asArray(d, "tasks")),
        exec(["task", "inbox"]),
      ]);
      const byStatus = {};
      for (const t of tasks) {
        const s = String(t.status ?? "unknown");
        byStatus[s] = (byStatus[s] ?? 0) + 1;
      }
      return {
        agents: agents.map(agentRow),
        open_tasks: tasks.length,
        tasks_by_status: byStatus,
        blocked: tasks.filter((t) => t.status === "blocked").map(taskRow),
        in_progress: tasks.filter((t) => t.status === "in_progress").map(taskRow),
        unassigned: tasks.filter((t) => !t.assignee && t.status === "todo").map(taskRow),
        needs_you: asArray(inbox, "inbox").map(gateRow),
      };
    },
  },
  {
    name: "agents_list",
    write: false,
    description: "List every agent on the user's 5dive team: name, type, model, live state and channels.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run(_input, exec) {
      return { agents: (await roster(exec)).map(agentRow) };
    },
  },
  {
    name: "agents_send",
    write: true,
    description:
      "Send a message to one agent on the user's team and wake it. It lands in the agent's session; read its answer with agents_read and the reply_id this returns, a little later (agents take a minute or two).",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Agent name, from fleet_status or agents_list." },
        message: { type: "string", description: "What to tell the agent." },
      },
      required: ["agent", "message"],
      additionalProperties: false,
    },
    async run(input, exec, ctx = {}) {
      const agent = agentName(input);
      const message = str(input, "message", MAX_MESSAGE);
      if (!message) throw new OpError("message is required");
      if (message.startsWith("-")) throw new OpError("message may not start with a dash");
      await requireSeat(exec, agent);
      const d = await exec(["agent", "send", agent, `--message=${message}`, "--wake", `--from=${ctx.sender || "mcp"}`]);
      const id = typeof d?.msg_id === "string" && REPLY_ID_RE.test(d.msg_id) ? d.msg_id : null;
      const out = { sent: true, agent, delivered: d?.delivered !== false };
      if (d?.queued) out.queued = true;
      if (id) {
        out.reply_id = id;
        out.reply = "Read the agent's answer with agents_read and this reply_id.";
      } else {
        out.reply = "The agent answers in its own channel; check the task with tasks_get.";
      }
      return out;
    },
  },
  {
    name: "agents_read",
    write: false,
    description:
      "Read one agent's answer to a message you sent with agents_send: pass the agent and the reply_id agents_send returned. Empty means it has not answered yet; try again in a minute.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Agent name, from fleet_status or agents_list." },
        reply_id: { type: "string", description: "The reply_id agents_send returned." },
      },
      required: ["agent", "reply_id"],
      additionalProperties: false,
    },
    async run(input, exec) {
      const agent = agentName(input);
      const id = str(input, "reply_id", 32);
      if (!id || !REPLY_ID_RE.test(id)) throw new OpError("reply_id is the id agents_send returned");
      await requireSeat(exec, agent);
      // The CLI's own a2a read: only the lines after this message's marker and
      // before the next message, never the rest of the agent's screen.
      const raw = await exec(["agent", "_capture", agent, `--after-id=${id}`], { text: true });
      const answer = replyText(raw, id);
      return answer
        ? { agent, reply_id: id, answer }
        : { agent, reply_id: id, answer: null, note: "No answer yet (or the message scrolled away). Try again in a minute." };
    },
  },
  {
    name: "tasks_list",
    write: false,
    description:
      "List the team's tasks in priority order. Filter by status (todo, in_progress, blocked, parked, done, cancelled, or delivered: handed in and waiting for its review), by assignee or by project (projects_list). To catch finished work, poll status done or delivered with since = the last time you looked.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: [...STATUSES, "delivered"], description: "Only tasks in this status." },
        assignee: { type: "string", description: "Only tasks assigned to this agent." },
        project: { type: "string", description: "Only tasks in this project (its key, from projects_list)." },
        since: {
          type: "string",
          description: "With status done, cancelled or delivered: only tasks that got there at or after this time (ISO 8601, UTC).",
        },
      },
      additionalProperties: false,
    },
    async run(input, exec) {
      const argv = ["task", "ls"];
      const status = str(input, "status", 32);
      const delivered = status === "delivered";
      if (status && !delivered) {
        if (!STATUSES.has(status)) throw new OpError(`unknown status: ${status}`);
        argv.push(`--status=${status}`);
      }
      if (isSet(input, "assignee")) argv.push(`--assignee=${agentName(input, "assignee")}`);
      if (isSet(input, "project")) argv.push(`--project=${projectKey(input)}`);
      const sinceRaw = str(input, "since", 40);
      const stamp = delivered ? "handoff_delivered_at" : status === "done" || status === "cancelled" ? "done_at" : null;
      if (sinceRaw && !stamp) throw new OpError("since works with status done, cancelled or delivered");
      const since = sinceRaw ? cliTime(sinceRaw) : null;
      let tasks = asArray(await exec(argv), "tasks");
      if (delivered) tasks = tasks.filter((t) => t.handoff_delivered_at && t.status !== "done" && t.status !== "cancelled");
      if (stamp && since) {
        tasks = tasks
          .filter((t) => typeof t[stamp] === "string" && t[stamp] >= since)
          .sort((x, y) => String(y[stamp]).localeCompare(String(x[stamp])));
      }
      const rows = tasks.slice(0, MAX_LIST).map((t) => {
        const r = taskRow(t);
        if (typeof t.done_at === "string" && t.done_at) r.done_at = t.done_at;
        if (typeof t.handoff_delivered_at === "string" && t.handoff_delivered_at) r.delivered_at = t.handoff_delivered_at;
        return r;
      });
      return tasks.length > MAX_LIST ? { tasks: rows, more: tasks.length - MAX_LIST } : { tasks: rows };
    },
  },
  {
    name: "tasks_assign",
    write: true,
    description:
      "Assign (or reassign) one task to an agent. Returns who had it before, so the change can be undone by assigning it back.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task id, e.g. DIVE-123." },
        agent: { type: "string", description: "Agent to assign it to." },
      },
      required: ["task", "agent"],
      additionalProperties: false,
    },
    async run(input, exec) {
      const task = taskId(input);
      const agent = agentName(input);
      await requireSeat(exec, agent);
      const { t } = await showTask(exec, task, true);
      const from = t.assignee || null;
      await exec(["task", "assign", task, agent]);
      return { task, from, to: agent, undo: from ? { tool: "tasks_assign", task, agent: from } : null };
    },
  },
  {
    name: "tasks_create",
    write: true,
    description:
      "Create a new task on the user's team, optionally assigned to one agent. Returns the new task id; read its progress with tasks_get. " +
      "File it the way a good lead does: say what done looks like in accept (the reviewer grades the work against it), name a reviewer " +
      "(another agent, never the one doing it) when the work should be checked before it closes, and put it in a project when the team " +
      "has one for this work (projects_list). Before filing, wiki_search shows what the team already knows.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "One line: what needs doing." },
        agent: { type: "string", description: "Agent to give it to. Leave out to put it in the team queue." },
        priority: { type: "string", enum: [...PRIORITIES], description: "Default medium." },
        details: { type: "string", description: "Longer description and links." },
        accept: {
          type: "string",
          description: "Acceptance criteria: what must be true for the task to count as done. The reviewer checks the work against this.",
        },
        reviewer: {
          type: "string",
          description: "Agent that reviews the work before it closes (agents_list). Must not be the agent doing it.",
        },
        project: {
          type: "string",
          description: "Key of an existing project to file it in (projects_list). Leave out for the team's main board.",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
    async run(input, exec, ctx = {}) {
      const title = str(input, "title", MAX_TITLE);
      if (!title) throw new OpError("title is required");
      if (/[\r\n]/.test(title)) throw new OpError("title must be one line; put the rest in details");
      const priority = str(input, "priority", 16) ?? "medium";
      if (!PRIORITIES.has(priority)) throw new OpError("priority must be low, medium or high");
      let details = str(input, "details", MAX_MESSAGE);
      const accept = str(input, "accept", MAX_ACCEPT);
      const agent = isSet(input, "agent") ? agentName(input) : null;
      const reviewer = isSet(input, "reviewer") ? agentName(input, "reviewer") : null;
      const project = isSet(input, "project") ? projectKey(input) : null;
      if (agent && reviewer && agent === reviewer) {
        throw new OpError("reviewer must be a different agent from the one doing the task");
      }
      if (agent || reviewer) {
        const seats = new Set((await roster(exec)).map((a) => a.name));
        for (const [k, v] of [["agent", agent], ["reviewer", reviewer]]) {
          if (v && !seats.has(v)) throw new OpError(`there is no agent called "${v}" on your team (${k})`);
        }
      }
      if (project) await requireProject(exec, project);
      // A token is not a seat, so the task keeps the CLI's own filer and says
      // in its body which connection filed it.
      if (ctx.via) {
        const note = `Filed over MCP by the "${ctx.via}" connection.`;
        details = details ? `${details}\n\n${note}` : note;
      }
      const argv = ["task", "add", `--priority=${priority}`];
      if (agent) argv.push(`--assignee=${agent}`);
      if (reviewer) argv.push(`--verifier=${reviewer}`);
      if (project) argv.push(`--project=${project}`);
      if (accept) argv.push(`--accept=${accept}`);
      if (details) argv.push(`--body=${details}`);
      argv.push("--", title);
      const data = await exec(argv);
      const ident = data?.ident;
      if (typeof ident !== "string") throw new OpError("5dive created no task id");
      const out = { task: ident, title, assignee: agent, priority, status: "todo" };
      if (reviewer) out.reviewer = reviewer;
      if (project) out.project = project;
      if (accept) out.accept = accept;
      return out;
    },
  },
  {
    name: "tasks_get",
    write: false,
    description:
      "Read one task by id, open or finished: status, who has it, what it waits on (its blockers) and what waits on it, and what was delivered: the result, the link to the work (pull request or file), and the reviewer's verdict and feedback.",
    inputSchema: {
      type: "object",
      properties: { task: { type: "string", description: "Task id, e.g. DIVE-123." } },
      required: ["task"],
      additionalProperties: false,
    },
    async run(input, exec) {
      const task = taskId(input);
      const [{ t, blockedBy }, blocks] = await Promise.all([showTask(exec, task), blocksOf(exec, task).catch(() => null)]);
      const out = taskRow(t);
      const result = typeof t.result === "string" ? t.result.trim() : "";
      if (result) out.result = cut(result, MAX_RESULT);
      for (const k of ["created_at", "started_at", "done_at"]) {
        if (typeof t[k] === "string" && t[k]) out[k] = t[k];
      }
      const acc = typeof t.acceptance_criteria === "string" ? t.acceptance_criteria.trim() : "";
      if (acc) out.accept = cut(acc, MAX_ACCEPT);
      if (typeof t.verifier === "string" && t.verifier) out.reviewer = t.verifier;
      if (typeof t.project_key === "string" && t.project_key) out.project = t.project_key;
      const link = [t.merge_landed_ref, t.delivery_ref].find((v) => typeof v === "string" && /^https:\/\//.test(v));
      if (link || t.handoff_delivered_at || t.delivered_at) {
        const d = {};
        if (link) d.link = link;
        const at = t.handoff_delivered_at || t.delivered_at;
        if (typeof at === "string" && at) d.delivered_at = at;
        if (typeof t.merge_landed_at === "string" && t.merge_landed_at) d.merged_at = t.merge_landed_at;
        out.delivered = d;
      }
      if (typeof t.graded_verdict === "string" && t.graded_verdict) {
        const v = { verdict: t.graded_verdict, by: t.graded_by ?? null, at: t.graded_verdict_at ?? t.graded_at ?? null };
        const at = result.lastIndexOf("❌");
        if (at >= 0) v.feedback = result.slice(at, at + MAX_RESULT);
        out.review = v;
      }
      out.blocked_by = blockedBy.map((b) => ({ task: b.ident ?? b.id, title: b.title, status: b.status }));
      if (blocks) {
        out.blocks = blocks.tasks;
        if (!blocks.complete) out.blocks_note = "Checked only the first blocked tasks; there may be more.";
      }
      return out;
    },
  },
  {
    name: "projects_list",
    write: false,
    description:
      "List the team's projects: key, name, lead and one line about each. Use a key with tasks_create or tasks_list. Projects are created on the team, not here.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run(_input, exec) {
      return {
        projects: (await projects(exec)).slice(0, MAX_LIST).map((p) => {
          const r = { project: p.key, name: p.name ?? null, lead: p.lead_agent || null, status: p.status ?? null };
          const d = text(p, "description") ?? text(p, "goal");
          if (d) r.about = cut(d, 200);
          return r;
        }),
      };
    },
  },
  {
    name: "wiki_search",
    write: false,
    description:
      "Search the team's shared wiki: what the agents have written down for each other (decisions, how things work, past causes). " +
      "Check it before you ask the team something it may already know. Returns the best pages with a short excerpt each. " +
      "Agents' private notes are never searched.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words the page itself would use." },
        limit: { type: "integer", minimum: 1, maximum: WIKI_MAX, description: `How many pages, default ${WIKI_DEFAULT}.` },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async run(input, exec) {
      const query = str(input, "query", MAX_QUERY)?.replace(/^[\s-]+/, "");
      if (!query) throw new OpError("query is required");
      if (/[\r\n]/.test(query)) throw new OpError("query must be one line");
      const limit = intIn(input, "limit", WIKI_MAX, WIKI_DEFAULT);
      let out;
      try {
        // ONLY --store=wiki: never an agent's own memory.
        out = await exec(
          ["memory", "search", "--store=wiki", `--limit=${limit}`, `--max-tokens=${WIKI_MAX_TOKENS}`, query],
          { text: true },
        );
      } catch (e) {
        if (/no shared wiki/i.test(e.message)) return { query, pages: [], note: "This team has no shared wiki yet." };
        throw e;
      }
      const pages = parseWikiHits(typeof out === "string" ? out : "").slice(0, limit);
      return pages.length ? { query, pages } : { query, pages: [], note: "Nothing in the team wiki matches. Try other words." };
    },
  },
  {
    name: "marketplace_list",
    write: false,
    description:
      "List the agents in the 5dive Marketplace that can be hired onto the user's team: id, name, job and one line about them. Hire one with agents_hire.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run(_input, exec) {
      const packs = asArray(await exec(["agent", "marketplace", "ls"]), "packs");
      return { agents: packs.filter((p) => typeof p.slug === "string").map(packRow) };
    },
  },
  {
    name: "agents_hire",
    write: true,
    description:
      "Hire one agent from the 5dive Marketplace onto the user's team, by its agent_id from marketplace_list. Hiring is free; the box's own limits apply. Check with the user before you hire.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "The agent's id from marketplace_list, e.g. theo." },
        name: {
          type: "string",
          description: "Name for the new agent on the team (lowercase letters, digits, dashes). Leave out to use the agent's own.",
        },
      },
      required: ["agent_id"],
      additionalProperties: false,
    },
    async run(input, exec, ctx = {}) {
      const slug = str(input, "agent_id", 64)?.toLowerCase();
      if (!slug) throw new OpError("agent_id is required (from marketplace_list)");
      if (!PACK_SLUG_RE.test(slug)) throw new OpError("agent_id is not a marketplace id");
      const asked = str(input, "name", 16)?.toLowerCase();
      if (asked !== undefined && !HIRE_NAME_RE.test(asked)) {
        throw new OpError("name must start with a letter and use only lowercase letters, digits and dashes (at most 16)");
      }
      const pack = asArray(await exec(["agent", "marketplace", "ls"]), "packs").find((p) => p.slug === slug);
      if (!pack) throw new OpError(`There is no "${slug}" in the 5dive Marketplace. marketplace_list shows who can be hired.`);
      // No money moves through a connector.
      if (pack.price !== undefined || pack.premium) {
        throw new OpError(`Hiring ${text(pack, "name") ?? slug} costs money, so it is not done over this connection.`);
      }
      const team = (await roster(exec)).map((a) => String(a.name));
      const taken = new Set([...team, ...SYSTEM_SEATS]);
      if (asked !== undefined && taken.has(asked)) {
        throw new OpError(`The team already has an agent called "${asked}". Pick another name.`);
      }
      const cap = ctx.maxAgents === undefined ? maxAgents() : ctx.maxAgents;
      const size = team.filter((n) => !SYSTEM_SEATS.includes(n)).length;
      if (cap && size >= cap) {
        throw new OpError(`Not hired: this box allows ${cap} agents and the team has ${size}. The box owner sets that limit.`);
      }
      const name = asked ?? hireAgentName(slug, taken);
      const outcome = await settleOrPending(
        exec(["agent", "import", slug, `--as=${name}`], { timeoutMs: IMPORT_TIMEOUT_MS }),
        ctx.hireWaitMs ?? HIRE_WAIT_MS,
      );
      const who = text(pack, "name") ?? slug;
      const job = text(pack, "role");
      const label = `${who}${job ? ` (${job})` : ""}`;
      const as = name === slug ? "" : ` as "${name}"`;
      return outcome === "pending"
        ? {
            hired: "joining",
            agent: name,
            agent_id: slug,
            message: `Hiring ${label}${as}. Setup is still running and takes a few minutes; check agents_list for "${name}".`,
          }
        : { hired: true, agent: name, agent_id: slug, message: `Hired ${label}${as}. ${who} is on the team now.` };
    },
  },
  {
    name: "gates_list",
    write: false,
    description:
      "List every decision, approval, key or manual step the team is waiting on the user for. Each says you_can_answer: an ordinary decision or approval you may answer with gates_answer; the rest (money, keys and passwords, manual steps, anything marked for the user) only the user answers, so tell the user. For a key, answer_at is a one-time secure link when the box can make one: give it to the user, never ask them to type the key in this chat.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run(_input, exec) {
      const gates = asArray(await exec(["task", "inbox"]), "inbox").map(gateRow);
      const secrets = gates.filter((g) => g.kind === "secret").slice(0, MAX_SECRET_LINKS);
      await Promise.all(
        secrets.map(async (g) => {
          const l = await mintSecretLink(exec, String(g.task)).catch(() => null);
          if (!l) return;
          g.answer_at = l.link;
          if (l.expires_at) g.link_expires_at = l.expires_at;
          g.note = SECRET_NOTE;
        }),
      );
      return {
        needs_you: gates,
        note: "Answer the ones marked you_can_answer with gates_answer if you know what the user wants; tell the user about the rest.",
      };
    },
  },
  {
    name: "gates_answer",
    write: true,
    description:
      "Answer one decision or approval the team is waiting on, with one of the gate's own options (approve or deny for an approval). Only gates gates_list marks you_can_answer: never money, keys, manual steps or anything marked for the user; those are refused and stay with the user. The agent that asked is woken with your answer.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The gate's task id, from gates_list." },
        answer: { type: "string", description: "One of the gate's options, or approve / deny for an approval." },
      },
      required: ["task", "answer"],
      additionalProperties: false,
    },
    async run(input, exec) {
      const task = taskId(input);
      const answer = str(input, "answer", MAX_ANSWER);
      if (!answer) throw new OpError("answer is required");
      const [inbox, { t }] = await Promise.all([exec(["task", "inbox"]), showTask(exec, task, true)]);
      if (!gateOpen(t)) throw new OpError(`${task} is not waiting on an answer`);
      if (!asArray(inbox, "inbox").some((g) => String(g.ident ?? g.id) === task)) {
        throw new OpError(`${task} is waiting on an agent on the team, not on the user; leave it to them`);
      }
      const why = answerRefusal(t);
      if (why) throw new OpError(`You cannot answer ${task}: ${why}. Relay it to the user: ${answerWhere(task)}`);
      const opts = answerOptions(t);
      let value = answer;
      if (t.need_type === "approval") {
        const a = answer.toLowerCase();
        value = ["approve", "approved", "yes", "allow"].includes(a) ? "approve" : ["deny", "denied", "no", "reject"].includes(a) ? "deny" : "";
        if (!value) throw new OpError("an approval takes approve or deny");
      } else if (opts.length) {
        const hit = opts.find((o) => o.toLowerCase() === answer.toLowerCase());
        if (!hit) throw new OpError(`answer with one of the gate's options: ${opts.join(" | ")}`);
        value = hit;
      }
      // --from names the relay on the row, never --human: the user did not tap this.
      const d = await exec(["task", "answer", task, `--value=${value}`, "--from=connector"]);
      return { task, answered: value, kind: t.need_type, agent_told: d?.pinged === true };
    },
  },
  {
    name: "tasks_update",
    write: true,
    description:
      "Change one task: add a note for its agent (they are woken with it), raise its priority to high, record that it waits on another task (blocked_by) or no longer does (unblock), or close it as cancelled with a reason. Tasks are never deleted. tasks_get shows the result.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task id, e.g. DIVE-123." },
        note: { type: "string", description: "Feedback or instructions for the task's agent." },
        priority: { type: "string", enum: ["high"], description: "Raise the task to high. Lowering is the user's call." },
        blocked_by: { type: "string", description: "A task this one must wait for, e.g. DIVE-120." },
        unblock: { type: "string", description: "A task this one no longer waits for." },
        cancel: { type: "string", description: "Close the task as cancelled; the reason, in one or two sentences." },
      },
      required: ["task"],
      additionalProperties: false,
    },
    async run(input, exec) {
      const task = taskId(input);
      const note = str(input, "note", MAX_NOTE);
      const priority = str(input, "priority", 16);
      if (priority && !PRIORITIES.has(priority)) throw new OpError("priority must be low, medium or high");
      const by = isSet(input, "blocked_by") ? taskId(input, "blocked_by") : null;
      const unblock = isSet(input, "unblock") ? taskId(input, "unblock") : null;
      const cancel = str(input, "cancel", MAX_REASON);
      if (by === task || unblock === task) throw new OpError("a task cannot wait on itself");
      if (!note && !priority && !by && !unblock && !cancel) {
        throw new OpError("say what to change: note, priority, blocked_by, unblock or cancel");
      }
      const { t } = await showTask(exec, task, true);
      const closed = t.status === "done" || t.status === "cancelled";
      if (closed && (cancel || by || priority)) throw new OpError(`${task} is already ${t.status}`);
      const current = String(t.priority ?? "medium");
      if (priority && priority !== "high" && priority !== current) {
        throw new OpError("only raising to high works here; lowering a priority is the user's call");
      }
      const changed = {};
      if (by) {
        await exec(["task", "block", task, `--by=${by}`]);
        changed.blocked_by = by;
      }
      if (unblock) {
        await exec(["task", "unblock", task, `--by=${unblock}`]);
        changed.unblocked = unblock;
      }
      if (priority === "high") {
        if (current === "high" || current === "urgent") {
          changed.priority = `already ${current}`;
        } else {
          await exec(["task", "escalate", task, "--from=connector"]);
          changed.priority = "high";
        }
      }
      if (note) {
        const d = await exec(["task", "followup", task, `--text=${note}`, "--from=connector"]);
        changed.note = d?.child ? { filed_as: d.child } : { delivered: d?.delivered === true };
      }
      if (cancel) {
        await exec(["task", "cancel", task, `--result=${cancel}`]);
        changed.status = "cancelled";
      }
      return { task, changed };
    },
  },
  {
    name: "secrets_request",
    write: true,
    description:
      "When a task needs a key or password from the user (an API key, a login), create a one-time secure link for it. Give the link to the user; they type the value there and it goes straight to their 5dive server, where the task's agent can use it. You never see the value: never ask the user to type a key or password in this chat.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The task that needs the key, e.g. DIVE-123." },
        key: { type: "string", description: "The key's name in capitals, e.g. STRIPE_API_KEY." },
        ask: { type: "string", description: "One plain sentence for the user: what it is and where they find it." },
      },
      required: ["task", "key", "ask"],
      additionalProperties: false,
    },
    async run(input, exec) {
      const task = taskId(input);
      const key = str(input, "key", 64);
      if (!key || !SECRET_KEY_RE.test(key)) throw new OpError("key must be a name in capitals, like STRIPE_API_KEY");
      const ask = str(input, "ask", 300);
      if (!ask) throw new OpError("ask is required: one plain sentence for the user");
      if (/[\r\n]/.test(ask)) throw new OpError("ask must be one line");
      const d = await exec(["task", "need", task, "--type=secret", `--secret-key=${key}`, "--connector=tools", `--ask=${ask}`]);
      const l = httpsLink(d?.secret_link_url, d?.drop_link_expires_at) ?? (await mintSecretLink(exec, task).catch(() => null));
      return {
        task,
        key,
        link: l?.link ?? null,
        link_expires_at: l?.expires_at || null,
        lands_in: `the user's 5dive server, as ${key} in its tools connector; the task's agent reads it from there`,
        note: l
          ? SECRET_NOTE
          : `The request is filed, but the box gave no https link (it needs a public address for that); ${answerWhere(task)}`,
      };
    },
  },
];
