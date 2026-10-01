// DIVE-5328 — `5dive-mcp serve`: the Streamable HTTP transport and its guards.
// Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createServer, rateLimiter } from "../src/http.js";
import { createToken, revokeToken, readTokens, tokenVerifier } from "../src/tokens.js";

const ROOT = new URL("..", import.meta.url).pathname;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "5dive-mcp-"));

async function boot(opts = {}) {
  const home = tmp();
  const tokensFile = path.join(home, "tokens.json");
  const calls = [];
  const audits = [];
  const server = createServer({
    tokensFile,
    ratePerMin: opts.ratePerMin,
    exec: async (argv) => {
      calls.push(argv);
      return { argv };
    },
    audit: (e) => audits.push(e),
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, { token, url = "/mcp", raw } = {}) =>
    fetch(base + url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: raw ?? JSON.stringify(body),
    });
  return { home, tokensFile, calls, audits, server, base, post, close: () => server.close() };
}

const call = (name, args, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

test("no token, a wrong token, or a revoked token is a 401 and runs nothing", async () => {
  const s = await boot();
  const tok = createToken({ name: "chatgpt" }, s.tokensFile);
  try {
    let r = await s.post(call("agent_list", {}));
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate"), /^Bearer /);
    r = await s.post(call("agent_list", {}), { token: tok.slice(0, -1) + (tok.endsWith("A") ? "B" : "A") });
    assert.equal(r.status, 401);
    r = await s.post(call("agent_list", {}), { url: "/mcp/5dmcp_nope" });
    assert.equal(r.status, 401);
    // Valid first, then revoked: the running server picks the file change up.
    r = await s.post(call("agent_list", {}), { token: tok });
    assert.equal(r.status, 200);
    assert.equal(revokeToken("chatgpt", s.tokensFile), true);
    r = await s.post(call("agent_list", {}), { token: tok });
    assert.equal(r.status, 401);
    assert.equal(s.calls.length, 1);
  } finally {
    s.close();
  }
});

test("the token works as a header and as the last URL segment (ChatGPT no-auth connector)", async () => {
  const s = await boot();
  const tok = createToken({ name: "chatgpt" }, s.tokensFile);
  try {
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } };
    let r = await s.post(init, { token: tok });
    let j = await r.json();
    assert.equal(j.result.protocolVersion, "2025-06-18");
    assert.equal(j.result.serverInfo.name, "5dive");
    r = await s.post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { url: `/mcp/${tok}` });
    j = await r.json();
    assert.deepEqual(
      j.result.tools.map((t) => [t.name, t.annotations.readOnlyHint]),
      [
        ["task_create", false],
        ["task_show", true],
        ["task_list", true],
        ["agent_send", false],
        ["agent_list", true],
        ["digest_get", true],
      ]
    );
    // A notification gets 202 and no body.
    r = await s.post({ jsonrpc: "2.0", method: "notifications/initialized" }, { token: tok });
    assert.equal(r.status, 202);
    // Read tool reaches the CLI with the expected argv.
    r = await s.post(call("task_show", { id: "DIVE-7" }), { url: `/mcp/${tok}/` });
    j = await r.json();
    assert.equal(j.result.isError, undefined);
    assert.deepEqual(s.calls.at(-1), ["task", "show", "DIVE-7"]);
  } finally {
    s.close();
  }
});

test("a read-only token cannot write; the refusal is audited and the CLI never runs", async () => {
  const s = await boot();
  const tok = createToken({ name: "reader" }, s.tokensFile);
  try {
    const r = await s.post(call("agent_send", { name: "marcus", message: "hi" }), { token: tok });
    const j = await r.json();
    assert.equal(j.result.isError, true);
    assert.match(j.result.content[0].text, /read-only/);
    assert.equal(s.calls.length, 0);
    assert.equal(s.audits.length, 1);
    assert.equal(s.audits[0].ok, false);
    assert.equal(s.audits[0].tool, "agent_send");
    assert.equal(s.audits[0].token, "reader");
  } finally {
    s.close();
  }
});

test("a write token's `from` claim is dropped: sends are labelled mcp-<token>, tasks say who filed them, and bodies stay out of the audit", async () => {
  const s = await boot();
  const tok = createToken({ name: "chatgpt", write: true }, s.tokensFile);
  try {
    await s.post(
      call("task_create", { title: "Draft the launch post", body: "SECRET-BODY", assignee: "marketing", from: "marcus" }),
      { token: tok }
    );
    await s.post(call("agent_send", { name: "marcus", message: "SECRET-MESSAGE", from: "lodar" }), { token: tok });
    // The CLI refuses a --from that is not a registered seat, so a task keeps
    // the default filer and carries its provenance in the body.
    assert.deepEqual(s.calls[0], [
      "task", "add", '--body=SECRET-BODY\n\nFiled over MCP by the "chatgpt" connection.', "--assignee=marketing", "--", "Draft the launch post",
    ]);
    assert.deepEqual(s.calls[1], ["agent", "send", "--message=SECRET-MESSAGE", "--from=mcp-chatgpt", "--", "marcus"]);
    await s.post(call("task_create", { title: "No body" }), { token: tok });
    assert.deepEqual(s.calls[2], ["task", "add", '--body=Filed over MCP by the "chatgpt" connection.', "--", "No body"]);
    assert.equal(s.audits.length, 3);
    assert.ok(s.audits.every((a) => a.ok === true && a.token === "chatgpt"));
    assert.equal(s.audits[1].name, "marcus");
    assert.doesNotMatch(JSON.stringify(s.audits), /SECRET/);
  } finally {
    s.close();
  }
});

test("rate limit: the call past the per-token budget is a 429 with Retry-After, and runs nothing", async () => {
  const s = await boot({ ratePerMin: 3 });
  const a = createToken({ name: "a" }, s.tokensFile);
  const b = createToken({ name: "b" }, s.tokensFile);
  try {
    for (let i = 0; i < 3; i++) assert.equal((await s.post(call("agent_list", {}), { token: a })).status, 200);
    const r = await s.post(call("agent_list", {}), { token: a });
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get("retry-after")) >= 1);
    // Another token has its own budget.
    assert.equal((await s.post(call("agent_list", {}), { token: b })).status, 200);
    assert.equal(s.calls.length, 4);
  } finally {
    s.close();
  }
});

test("rateLimiter windows reset", () => {
  let t = 0;
  const lim = rateLimiter(2, 60_000, () => t);
  assert.equal(lim("x"), 0);
  assert.equal(lim("x"), 0);
  assert.equal(lim("x"), 60);
  t = 60_000;
  assert.equal(lim("x"), 0);
});

test("batches, bad JSON, oversized bodies, GET and stray paths are refused before any tool runs", async () => {
  const s = await boot();
  const tok = createToken({ name: "chatgpt", write: true }, s.tokensFile);
  try {
    const batch = Array.from({ length: 50 }, (_, i) => call("agent_send", { name: "x", message: "y" }, i + 1));
    let r = await s.post(batch, { token: tok });
    assert.equal(r.status, 400);
    r = await s.post(null, { token: tok, raw: "{nope" });
    assert.equal(r.status, 400);
    r = await s.post(null, { token: tok, raw: JSON.stringify({ pad: "x".repeat(1024 * 1024 + 10) }) });
    assert.equal(r.status, 413);
    r = await fetch(`${s.base}/mcp`, { headers: { authorization: `Bearer ${tok}` } });
    assert.equal(r.status, 405);
    r = await s.post(call("agent_list", {}), { token: tok, url: "/other" });
    assert.equal(r.status, 404);
    r = await s.post(call("agent_list", {}), { url: `/mcp/${tok}/extra` });
    assert.equal(r.status, 404);
    r = await s.post(call("no_such_tool", {}), { token: tok });
    assert.equal((await r.json()).error.code, -32602);
    assert.equal(s.calls.length, 0);
  } finally {
    s.close();
  }
});

test("token store keeps hashes only, at 0600, and refuses duplicate or malformed names", () => {
  const home = tmp();
  const file = path.join(home, "tokens.json");
  const tok = createToken({ name: "chatgpt" }, file);
  assert.match(tok, /^5dmcp_[A-Za-z0-9_-]{43}$/);
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!raw.includes(tok.slice(6)), "plaintext token must not be stored");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => createToken({ name: "chatgpt" }, file), /already exists/);
  assert.throws(() => createToken({ name: "Bad Name" }, file), /name must be/);
  assert.throws(() => createToken({ name: "x".repeat(29) }, file), /name must be/);
  assert.equal(readTokens(file).length, 1);
  assert.deepEqual(tokenVerifier(file)(tok), { name: "chatgpt", write: false });
  assert.equal(tokenVerifier(file)("not-a-token"), null);
});

test("real process: `token create` then `serve` answers a header client and a URL client end to end", async () => {
  const home = tmp();
  // A stand-in 5dive binary: echoes its argv inside the CLI's JSON envelope.
  const bin = path.join(home, "fake-5dive");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ok:true,data:{argv:process.argv.slice(2)}}))\n`,
    { mode: 0o755 }
  );
  const env = { ...process.env, FIVEDIVE_MCP_HOME: home, FIVEDIVE_BIN: bin, FIVEDIVE_SUDO: "" };
  const out = execFileSync(process.execPath, [`${ROOT}src/index.js`, "token", "create", "--name=chatgpt"], { env }).toString();
  const tok = out.split("\n")[0];
  assert.match(tok, /^5dmcp_/);
  assert.match(execFileSync(process.execPath, [`${ROOT}src/index.js`, "token", "list"], { env }).toString(), /chatgpt\tread-only/);

  // A public bind is refused without the explicit flag.
  assert.throws(
    () => execFileSync(process.execPath, [`${ROOT}src/index.js`, "serve", "--listen=0.0.0.0:8741"], { env, stdio: "pipe" }),
    (e) => e.status === 2 && /refusing to listen/.test(String(e.stderr))
  );

  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [`${ROOT}src/index.js`, "serve", `--listen=127.0.0.1:${port}`], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    await new Promise((resolve, reject) => {
      child.stderr.on("data", (d) => /serving/.test(String(d)) && resolve());
      child.on("exit", (c) => reject(new Error(`serve exited ${c}`)));
    });
    const url = `http://127.0.0.1:${port}/mcp`;
    let r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
      body: JSON.stringify(call("agent_list", {})),
    });
    let j = await r.json();
    assert.deepEqual(JSON.parse(j.result.content[0].text), { argv: ["--json", "agent", "list"] });
    r = await fetch(`${url}/${tok}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify(call("task_list", { status: "blocked" })),
    });
    j = await r.json();
    assert.deepEqual(JSON.parse(j.result.content[0].text), { argv: ["--json", "task", "ls", "--status=blocked"] });
    // The audit line lands on disk, attributed to the token and the proxied client.
    await new Promise((r) => setTimeout(r, 100));
    const lines = fs.readFileSync(path.join(home, "audit.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(lines.length, 2);
    assert.equal(lines[1].tool, "task_list");
    assert.equal(lines[1].token, "chatgpt");
    assert.equal(lines[1].ip, "203.0.113.9");
    assert.ok(!fs.readFileSync(path.join(home, "audit.jsonl"), "utf8").includes(tok));
    assert.equal(fs.statSync(path.join(home, "audit.jsonl")).mode & 0o777, 0o600);
  } finally {
    child.kill("SIGTERM");
  }
});
