#!/usr/bin/env node
// 5dive MCP server.
//
//   5dive-mcp                         stdio (Claude Desktop, Cursor, Cline, …)
//   5dive-mcp serve [--listen=H:P]    Streamable HTTP, for a client in someone
//                                     else's cloud (ChatGPT, an OpenAI dot)
//   5dive-mcp token create|list|revoke
//
// The tools live in tools.js and are the same over both transports; the HTTP
// side and its guards are in http.js, the bearer tokens in tokens.js.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, BIN_LABEL, callTool } from "./tools.js";
import { createServer, isLoopback } from "./http.js";
import { auditPath, createToken, listTokens, revokeToken, tokensPath } from "./tokens.js";

const USAGE = `usage:
  5dive-mcp                          run over stdio (the default)
  5dive-mcp serve [--listen=127.0.0.1:8741] [--path=/mcp] [--rate=60]
                  [--allow-public-http]
  5dive-mcp token create --name=<name> [--write]
  5dive-mcp token list
  5dive-mcp token revoke --name=<name>`;

function flags(argv) {
  const out = { _: [] };
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
    else out._.push(a);
  }
  return out;
}

function die(msg) {
  process.stderr.write(`5dive-mcp: ${msg}\n`);
  process.exit(2);
}

async function stdio() {
  const server = new Server(
    { name: "5dive-mcp", version: "0.2.0" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(request.params.name, request.params.arguments || {})
  );
  await server.connect(new StdioServerTransport());
  // stderr is safe for logs — stdout is the MCP framing channel.
  process.stderr.write(`5dive-mcp ready (${TOOLS.length} tools; bin=${BIN_LABEL})\n`);
}

function serve(f) {
  const listen = typeof f.listen === "string" ? f.listen : "127.0.0.1:8741";
  const i = listen.lastIndexOf(":");
  const host = listen.slice(0, i).replace(/^\[|\]$/g, "");
  const port = Number(listen.slice(i + 1));
  if (i < 0 || !host || !Number.isInteger(port) || port <= 0 || port > 65535) {
    die(`--listen must be host:port, got "${listen}"`);
  }
  // Plain HTTP on a public interface sends the bearer token in the clear.
  if (!isLoopback(host) && !f["allow-public-http"]) {
    die(
      `refusing to listen on ${host}: this server speaks plain HTTP. Listen on 127.0.0.1 and put ` +
        `HTTPS in front of it (Caddy, nginx), or pass --allow-public-http if something else ` +
        `already encrypts the hop.`
    );
  }
  const ratePerMin = f.rate === undefined ? 60 : Number(f.rate);
  if (!Number.isInteger(ratePerMin) || ratePerMin < 1) die("--rate must be a positive integer");
  const path = typeof f.path === "string" ? f.path : "/mcp";
  if (!path.startsWith("/")) die("--path must start with /");
  if (listTokens().length === 0) {
    process.stderr.write(
      `5dive-mcp: no tokens yet, so every request will be refused. Mint one: 5dive-mcp token create --name=chatgpt\n`
    );
  }
  const server = createServer({ path, ratePerMin });
  server.listen(port, host, () => {
    process.stderr.write(
      `5dive-mcp serving http://${listen}${path} (${TOOLS.length} tools; bin=${BIN_LABEL}; ` +
        `${ratePerMin}/min per token; tokens ${tokensPath()}; audit ${auditPath()})\n`
    );
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

function token(f) {
  const [, sub] = f._;
  if (sub === "create") {
    if (typeof f.name !== "string") die("token create needs --name=<name>");
    let t;
    try {
      t = createToken({ name: f.name, write: Boolean(f.write) });
    } catch (err) {
      die(err.message);
    }
    process.stdout.write(
      `${t}\n\n` +
        `Token "${f.name}" (${f.write ? "read + write" : "read-only"}). This is the only time it is shown.\n` +
        `  Header clients:  Authorization: Bearer <token>   at  https://<your-domain>/mcp\n` +
        `  ChatGPT (no-auth connector):                        https://<your-domain>/mcp/<token>\n` +
        `Revoke: 5dive-mcp token revoke --name=${f.name}\n`
    );
    return;
  }
  if (sub === "list") {
    const rows = listTokens();
    if (rows.length === 0) return process.stdout.write("no tokens\n");
    for (const r of rows) {
      process.stdout.write(`${r.name}\t${r.write ? "read+write" : "read-only"}\t${r.created_at}\n`);
    }
    return;
  }
  if (sub === "revoke") {
    if (typeof f.name !== "string") die("token revoke needs --name=<name>");
    if (!revokeToken(f.name)) die(`no token named "${f.name}"`);
    process.stdout.write(`revoked "${f.name}" (a running server refuses it from the next request)\n`);
    return;
  }
  die(USAGE);
}

const f = flags(process.argv.slice(2));
const cmd = f._[0];
if (f.help || cmd === "help") {
  process.stdout.write(USAGE + "\n");
} else if (cmd === undefined || cmd === "stdio") {
  stdio().catch((err) => {
    process.stderr.write(`5dive-mcp fatal: ${err?.stack || err}\n`);
    process.exit(1);
  });
} else if (cmd === "serve") {
  serve(f);
} else if (cmd === "token") {
  token(f);
} else {
  die(`unknown command "${cmd}"\n${USAGE}`);
}
