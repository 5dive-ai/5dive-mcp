// Minimal MCP stdio client that exercises the 5dive-mcp server against the
// live CLI. Sends framed JSON-RPC over the child's stdin, reads newline-delimited
// JSON-RPC responses from stdout. Exits non-zero on any failure.
import { spawn } from "node:child_process";

const child = spawn(process.execPath, [new URL("../src/index.js", import.meta.url).pathname], {
  env: { ...process.env, FIVEDIVE_SUDO: "1" },
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let idc = 0;
function rpc(method, params) {
  const id = ++idc;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => reject(new Error(`timeout: ${method}`)), 20000);
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
  console.log("  ok:", msg);
}

try {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  assert(init.result?.serverInfo?.name === "5dive-mcp", "initialize handshake");

  const list = await rpc("tools/list", {});
  const names = (list.result?.tools || []).map((t) => t.name).sort();
  assert(names.length === 6, `tools/list returns 6 tools (${names.join(",")})`);
  assert(names.includes("task_show") && names.includes("agent_send"), "core tools present");

  const show = await rpc("tools/call", { name: "task_show", arguments: { id: "DIVE-923" } });
  const showText = show.result?.content?.[0]?.text || "";
  assert(!show.result?.isError && showText.includes("DIVE-923"), "task_show DIVE-923 returns live data");

  const agents = await rpc("tools/call", { name: "agent_list", arguments: {} });
  const agentsText = agents.result?.content?.[0]?.text || "";
  assert(!agents.result?.isError && agentsText.includes("\"name\""), "agent_list returns fleet");

  // error path: bad task id should surface a clean isError, not crash
  const bad = await rpc("tools/call", { name: "task_show", arguments: { id: "DIVE-000000" } });
  assert(bad.result?.isError === true, "unknown task id -> clean isError");

  console.log("\nALL SMOKE CHECKS PASSED");
  child.kill();
  process.exit(0);
} catch (e) {
  console.error("\nSMOKE FAILED:", e.message);
  child.kill();
  process.exit(1);
}
