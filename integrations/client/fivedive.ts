// The one small client every 5dive add-on (n8n, Node-RED, Raycast) uses.
//
// It talks to the HOSTED 5dive MCP endpoint (POST {baseUrl}/mcp, JSON-RPC,
// one JSON reply per request) with a personal API key. Reads work with any
// key; creating a task, assigning one or messaging an agent needs a key that
// was allowed to act on the team.
//
// Most hosted servers also need their SERVER ACCESS TOKEN: 5dive keeps no copy
// of it, so the API key alone cannot reach the server. It rides as the
// `x-connectord-token` header on every call when set, and is never logged.
//
// No dependencies: global fetch (Node 18+), or pass your own.

export type Priority = "low" | "medium" | "high";
export type TaskStatus = "todo" | "in_progress" | "blocked" | "done" | "cancelled" | "parked";

export interface Task {
  task: string;
  title: string;
  status: TaskStatus | string;
  priority?: string;
  assignee: string | null;
  gate?: string;
  waiting_on?: string;
  result?: string;
  created_at?: string;
  started_at?: string;
  done_at?: string;
}

export interface Agent {
  agent: string;
  type: string;
  model: string | null;
  state: string | null;
  channels: unknown;
  last_seen: string | null;
}

export interface NeedsYou {
  task: string;
  title: string;
  kind: string;
  question: string;
  filed_by: string | null;
  answer_at: string;
}

export interface TeamStatus {
  agents: Agent[];
  open_tasks: number;
  tasks_by_status: Record<string, number>;
  blocked: Task[];
  in_progress: Task[];
  unassigned: Task[];
  needs_you: NeedsYou[];
}

export interface CreateTaskInput {
  title: string;
  agent?: string;
  priority?: Priority;
  details?: string;
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; text(): Promise<string> }>;

export interface FiveDiveOptions {
  apiKey: string;
  /** Default https://api.5dive.com */
  baseUrl?: string;
  fetch?: FetchLike;
  /** Sent as the client name, e.g. "n8n-nodes-5dive". */
  userAgent?: string;
  /** The server access token. Optional: only servers whose token 5dive does not keep need it. */
  serverToken?: string;
  /** Where the user types the server access token, for error messages. e.g. "the 5dive credential". */
  settingsName?: string;
}

export class FiveDiveError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "FiveDiveError";
  }
}

export const DEFAULT_BASE_URL = "https://api.5dive.com";

// The API's own sentences when the server access token is missing or replaced
// (5dive-api src/lib/connectord.ts, CONNECTORD_FAILURE_MESSAGE no_token and
// token_invalid). Matched loosely so a reworded tail still maps.
const NO_SERVER_TOKEN = /no server access token was presented/i;
const STALE_SERVER_TOKEN = /server access token is stale/i;

/** Turn the API's server-token sentence into one that says what to do in this add-on. */
export function explainServerTokenError(text: string, settingsName: string, hadToken: boolean): string | null {
  if (NO_SERVER_TOKEN.test(text)) {
    return hadToken
      ? `5dive could not reach your server with that server access token. Check it in ${settingsName}.`
      : `Your 5dive server needs its server access token. Add it in ${settingsName} (Server access token).`;
  }
  if (STALE_SERVER_TOKEN.test(text)) {
    return `Your server access token was replaced. Paste the new one in ${settingsName} (Server access token).`;
  }
  return null;
}

export class FiveDive {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly userAgent: string;
  private readonly serverToken: string;
  private readonly settingsName: string;
  private nextId = 1;

  constructor(opts: FiveDiveOptions) {
    const key = (opts.apiKey ?? "").trim();
    if (!key) throw new FiveDiveError("a 5dive API key is required");
    this.apiKey = key;
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
    const f = opts.fetch ?? (globalThis as { fetch?: FetchLike }).fetch;
    if (!f) throw new FiveDiveError("no fetch available: use Node 18 or newer, or pass one");
    this.fetchFn = f;
    this.userAgent = opts.userAgent || "5dive-client";
    this.serverToken = (opts.serverToken ?? "").trim();
    this.settingsName = opts.settingsName || "your 5dive settings";
  }

  private fail(text: string, status?: number): FiveDiveError {
    const plain = explainServerTokenError(text, this.settingsName, this.serverToken !== "");
    return new FiveDiveError(plain ?? text, status);
  }

  /** Call one tool on the hosted MCP and return its structured result. */
  async call<T = unknown>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name: tool, arguments: dropEmpty(args) },
    });
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.apiKey}`,
      "User-Agent": this.userAgent,
    };
    if (this.serverToken) headers["x-connectord-token"] = this.serverToken;
    let res: { status: number; text(): Promise<string> };
    try {
      res = await this.fetchFn(`${this.baseUrl}/mcp`, { method: "POST", headers, body });
    } catch (err) {
      throw new FiveDiveError(`could not reach 5dive: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await res.text();
    if (res.status === 401) throw new FiveDiveError("5dive did not accept this API key", 401);
    if (res.status === 429) throw new FiveDiveError("too many requests to 5dive; try again in a minute", 429);
    let msg: {
      error?: { message?: string };
      result?: { isError?: boolean; structuredContent?: unknown; content?: { type: string; text?: string }[] };
    };
    try {
      msg = JSON.parse(text);
    } catch {
      throw new FiveDiveError(`5dive answered ${res.status} with no JSON`, res.status);
    }
    if (msg.error) throw this.fail(`5dive: ${msg.error.message ?? "request failed"}`, res.status);
    const r = msg.result;
    if (!r) throw new FiveDiveError("5dive returned no result", res.status);
    const first = r.content?.find((c) => c.type === "text")?.text ?? "";
    if (r.isError) throw this.fail(first || "the 5dive tool failed", res.status);
    if (r.structuredContent !== undefined) return r.structuredContent as T;
    try {
      return JSON.parse(first) as T;
    } catch {
      return first as unknown as T;
    }
  }

  createTask(input: CreateTaskInput): Promise<Task> {
    return this.call<Task>("tasks_create", { ...input });
  }

  getTask(task: string): Promise<Task> {
    return this.call<Task>("tasks_get", { task });
  }

  async listTasks(filter: { status?: TaskStatus; assignee?: string } = {}): Promise<Task[]> {
    return (await this.call<{ tasks: Task[] }>("tasks_list", { ...filter })).tasks ?? [];
  }

  assignTask(task: string, agent: string): Promise<{ task: string; from: string | null; to: string }> {
    return this.call("tasks_assign", { task, agent });
  }

  async listAgents(): Promise<Agent[]> {
    return (await this.call<{ agents: Agent[] }>("agents_list")).agents ?? [];
  }

  sendMessage(agent: string, message: string): Promise<{ sent: boolean; agent: string }> {
    return this.call("agents_send", { agent, message });
  }

  teamStatus(): Promise<TeamStatus> {
    return this.call<TeamStatus>("fleet_status");
  }
}

function dropEmpty(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    out[k] = typeof v === "string" ? v.trim() : v;
  }
  return out;
}
