// `5dive-mcp serve` — the same tools over MCP's Streamable HTTP transport, so
// an agent in someone else's cloud (a ChatGPT connector, an OpenAI dot,
// claude.ai) can reach a self-hosted 5dive box. The hosted twin of this is
// POST https://api.5dive.com/mcp; this one runs on the box itself.
//
// Shape: every POST carries one JSON-RPC message and gets one JSON reply (the
// spec's non-streaming mode — no tool streams, so there is no SSE leg and GET
// is 405). It listens on loopback; the owner's reverse proxy terminates HTTPS.
//
// What guards it:
//   - a bearer token minted on the box (tokens.js), sent as
//     `Authorization: Bearer <token>` or as the last path segment of the URL
//     (`/mcp/<token>`) for clients that cannot set a header — ChatGPT's
//     connector form offers OAuth or "No authentication", nothing in between;
//   - tokens are read-only unless minted with --write; a read-only token
//     calling task_create or agent_send gets a refusal, and the refusal is
//     audited;
//   - a per-token rate limit (default 60 calls a minute);
//   - one message per POST (batches refused before anything runs), a 1 MiB
//     body cap;
//   - whatever `from` the client claims is dropped: a message goes out
//     labelled `mcp-<token name>`, and a task says in its body which
//     connection filed it (stampSender below);
//   - an audit line per tool call: when, which token, which tool, allowed or
//     not, and the ids involved — never a message or task body.

import http from "node:http";
import fs from "node:fs";
import { TOOLS, TOOL_BY_NAME, callTool, run5dive } from "./tools.js";
import { auditPath, tokenVerifier, tokensPath } from "./tokens.js";

/** Newest first. We answer in the client's version when we know it. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const SERVER_INFO = { name: "5dive", title: "5dive agent team", version: "0.2.0" };
const INSTRUCTIONS =
  "These tools operate the user's own self-hosted 5dive team of AI agents. Start with " +
  "agent_list and task_list. You can file tasks and message agents only if this connection " +
  "was set up with write access.";
const MAX_BODY = 1024 * 1024;

const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export function toolList() {
  return TOOLS.map(({ name, description, inputSchema, write }) => ({
    name,
    description,
    inputSchema,
    annotations: { readOnlyHint: !write, destructiveHint: false, openWorldHint: false },
  }));
}

// Only ids and names go to the audit log; a message or a task body is the
// owner's content, not ours to keep.
function auditFields(input) {
  const out = {};
  for (const k of ["id", "name", "assignee", "status", "parent"]) {
    if (typeof input?.[k] === "string") out[k] = input[k].slice(0, 64);
  }
  return out;
}

// The client's own `from` claim is dropped: it could name any agent. The CLI
// takes a send's --from as an envelope label ([a-z][a-z0-9-]{0,31}), so a send
// is labelled mcp-<token>. A task's --from must be a registered seat, which a
// token is not, so the task keeps the CLI's default filer and says in its body
// which connection filed it.
export function stampSender(toolName, input, tokenName) {
  delete input.from;
  if (toolName === "agent_send") input.from = `mcp-${tokenName}`;
  if (toolName === "task_create") {
    const note = `Filed over MCP by the "${tokenName}" connection.`;
    input.body = input.body ? `${input.body}\n\n${note}` : note;
  }
}

/**
 * Handle one JSON-RPC message for an authenticated caller.
 * Returns null for a notification (no reply).
 */
export async function handleRpc(msg, { caller, exec = run5dive, audit = () => {} }) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    return rpcError(null, -32600, "invalid request");
  }
  const { id, method } = msg;
  if (msg.jsonrpc !== "2.0" || typeof method !== "string") {
    return "result" in msg || "error" in msg ? null : rpcError(id, -32600, "invalid request");
  }
  if (id === undefined) return null; // notifications/initialized, cancelled, …
  const params = msg.params && typeof msg.params === "object" ? msg.params : {};

  switch (method) {
    case "initialize": {
      const asked = params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(asked)
        ? asked
        : SUPPORTED_PROTOCOL_VERSIONS[0];
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: toolList() } };
    case "tools/call": {
      const name = params.name;
      const tool = typeof name === "string" ? TOOL_BY_NAME.get(name) : undefined;
      if (!tool) return rpcError(id, -32602, `unknown tool: ${String(name)}`);
      const input =
        params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
          ? { ...params.arguments }
          : {};
      if (tool.write && !caller.write) {
        audit({ token: caller.name, tool: tool.name, ok: false, reason: "read-only token", ...auditFields(input) });
        return {
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [
              {
                type: "text",
                text: "This connection is read-only. The box owner can mint a token with --write to allow it.",
              },
            ],
          },
        };
      }
      if (tool.write) stampSender(tool.name, input, caller.name);
      const result = await callTool(tool.name, input, exec);
      audit({ token: caller.name, tool: tool.name, ok: !result.isError, ...auditFields(input) });
      return { jsonrpc: "2.0", id, result };
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

/** Fixed one-minute windows per token. In memory: a restart forgives. */
export function rateLimiter(max, windowMs = 60_000, now = Date.now) {
  const hits = new Map();
  return (key) => {
    const t = now();
    let w = hits.get(key);
    if (!w || t - w.start >= windowMs) {
      w = { start: t, count: 0 };
      hits.set(key, w);
    }
    w.count += 1;
    if (w.count > max) return Math.ceil((w.start + windowMs - t) / 1000);
    return 0;
  };
}

function fileAudit(file) {
  return (entry) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    fs.appendFile(file, line, { mode: 0o600 }, (err) => {
      if (err) process.stderr.write(`5dive-mcp: audit write failed: ${err.message}\n`);
    });
  };
}

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    ...(payload ? { "Content-Type": "application/json" } : {}),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => Object.assign(new Error("too large"), { status: 413 });
    if (Number(req.headers["content-length"]) > MAX_BODY) return reject(tooLarge());
    // A chunked body has no length up front: keep counting, stop keeping.
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on("end", () =>
      size > MAX_BODY ? reject(tooLarge()) : resolve(Buffer.concat(chunks).toString("utf8"))
    );
    req.on("error", reject);
  });
}

/**
 * Build the HTTP server. Options exist for tests; the CLI passes none.
 *   path       mount point (default "/mcp")
 *   tokensFile / auditFile
 *   ratePerMin calls per token per minute (default 60)
 *   exec       replaces run5dive
 *   audit      replaces the file audit
 */
export function createServer(opts = {}) {
  const base = (opts.path || "/mcp").replace(/\/+$/, "");
  const verify = tokenVerifier(opts.tokensFile || tokensPath());
  const limit = rateLimiter(opts.ratePerMin || 60);
  const audit = opts.audit || fileAudit(opts.auditFile || auditPath());
  const exec = opts.exec || run5dive;

  return http.createServer((req, res) => {
    route(req, res).catch((err) => {
      process.stderr.write(`5dive-mcp: request failed: ${err?.stack || err}\n`);
      if (!res.headersSent) send(res, 500, rpcError(null, -32603, "internal error"));
      else res.end();
    });
  });

  async function route(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    const p = url.pathname.replace(/\/+$/, "") || "/";

    if (p === "/healthz" && req.method === "GET") return send(res, 200, { ok: true });

    let pathToken = null;
    if (p === base) {
      // header auth
    } else if (p.startsWith(`${base}/`) && !p.slice(base.length + 1).includes("/")) {
      // Tokens are base64url: nothing to decode, and a stray % cannot throw.
      pathToken = p.slice(base.length + 1);
    } else {
      return send(res, 404, { error: "not found" });
    }

    if (req.method !== "POST") return send(res, 405, undefined, { Allow: "POST" });

    const header = req.headers.authorization || "";
    const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : pathToken;
    const caller = verify(presented);
    if (!caller) {
      return send(res, 401, { error: "Unauthorized" }, { "WWW-Authenticate": 'Bearer realm="5dive-mcp"' });
    }

    const wait = limit(caller.name);
    if (wait > 0) {
      return send(res, 429, rpcError(null, -32000, "rate limited: slow down"), { "Retry-After": String(wait) });
    }

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      if (err.status === 413) {
        return send(res, 413, rpcError(null, -32600, "request body over 1 MiB"), { Connection: "close" });
      }
      return send(res, 400, rpcError(null, -32700, "parse error"));
    }
    // One message per POST, so the rate limit counts tool calls, not HTTP
    // requests (MCP 2025-06-18 removed batching anyway).
    if (Array.isArray(body)) {
      return send(res, 400, rpcError(null, -32600, "JSON-RPC batches are not supported: send one message per request"));
    }

    const ip =
      (req.socket.remoteAddress === "127.0.0.1" || req.socket.remoteAddress === "::1"
        ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()
        : "") || req.socket.remoteAddress;
    const reply = await handleRpc(body, {
      caller,
      exec,
      audit: (e) => audit({ ip, ...e }),
    });
    return reply ? send(res, 200, reply) : send(res, 202);
  }
}

export function isLoopback(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
