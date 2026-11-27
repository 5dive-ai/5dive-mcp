// DIVE-9427 — the hosted connector's team-lead tools, run on the box through
// a stubbed `5dive --json`. One test per tool, plus the negative controls:
// gates_answer on a money / secret / manual / tier-2 gate is refused with its
// reason and never reaches `task answer`; a write tool on a read-only token is
// refused before the CLI runs.
// Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { TOOLS, callTool } from "../src/tools.js";
import { OPS, answerRefusal, replyText } from "../src/ops.js";
import { createServer } from "../src/http.js";
import { createToken } from "../src/tokens.js";

// ---------------------------------------------------------------------------
// A stub CLI: argv prefix -> data (or a function of argv). Records every call.

const ROSTER = [
  { name: "marcus", type: "claude", model: "opus", operationalState: "running", channels: "telegram", heartbeat: { lastSeenWhy: "2m ago" } },
  { name: "dev", type: "codex", channels: "telegram" },
  { name: "quinn", type: "claude" },
];

const gate = (ident, extra) => ({
  ident,
  title: "Pick a launch day",
  status: "blocked",
  assignee: "marcus",
  need_type: "decision",
  ask: "Ship Tuesday or Thursday?",
  need_options: "Tuesday|Thursday",
  recommend: "Tuesday",
  tier: 1,
  ...extra,
});

function stub(table = {}) {
  const calls = [];
  const exec = async (argv, opts = {}) => {
    calls.push({ argv, opts });
    const key = Object.keys(table)
      .filter((k) => argv.join(" ").startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) {
      if (argv[0] === "agent" && argv[1] === "list") return ROSTER;
      throw new Error(`stub: no answer for ${argv.join(" ")}`);
    }
    const v = table[key];
    if (v instanceof Error) throw v;
    return typeof v === "function" ? v(argv, opts) : v;
  };
  return { exec, calls, argvs: () => calls.map((c) => c.argv.join(" ")) };
}

async function run(name, input, s, ctx) {
  const r = await callTool(name, input, s.exec, ctx);
  const text = r.content[0].text;
  return { isError: !!r.isError, text, data: r.isError ? null : JSON.parse(text) };
}

// ---------------------------------------------------------------------------

test("the listed set is the hosted connector's 16 tools plus digest_get; the 0.2 names stay callable", async () => {
  const names = TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "agents_hire", "agents_list", "agents_read", "agents_send", "digest_get", "fleet_status", "gates_answer", "gates_list",
    "marketplace_list", "projects_list", "secrets_request", "tasks_assign", "tasks_create", "tasks_get", "tasks_list",
    "tasks_update", "wiki_search",
  ]);
  const writes = OPS.filter((t) => t.write).map((t) => t.name).sort();
  assert.deepEqual(writes, ["agents_hire", "agents_send", "gates_answer", "secrets_request", "tasks_assign", "tasks_create", "tasks_update"]);
  const s = stub({ "task show": { task: { ident: "DIVE-1" } } });
  assert.equal((await run("task_show", { id: "DIVE-1" }, s)).isError, false);
  assert.deepEqual(s.argvs(), ["task show DIVE-1"]);
});

test("fleet_status: agents, open tasks by status, blocked, unassigned and needs-you in one call", async () => {
  const s = stub({
    "task ls": { tasks: [
      { ident: "DIVE-1", title: "a", status: "blocked", assignee: "dev" },
      { ident: "DIVE-2", title: "b", status: "todo" },
      { ident: "DIVE-3", title: "c", status: "in_progress", assignee: "marcus" },
    ] },
    "task inbox": { inbox: [gate("DIVE-1")] },
  });
  const { data } = await run("fleet_status", {}, s);
  assert.equal(data.agents.length, 3);
  assert.equal(data.agents[0].last_seen, "2m ago");
  assert.deepEqual(data.tasks_by_status, { blocked: 1, todo: 1, in_progress: 1 });
  assert.deepEqual(data.unassigned.map((t) => t.task), ["DIVE-2"]);
  assert.equal(data.needs_you[0].you_can_answer, true);
  assert.deepEqual(data.needs_you[0].options, ["Tuesday", "Thursday"]);
});

test("agents_list projects the roster", async () => {
  const { data } = await run("agents_list", {}, stub());
  assert.deepEqual(data.agents.map((a) => a.agent), ["marcus", "dev", "quinn"]);
  assert.equal(data.agents[0].state, "running");
});

test("agents_send: resolves the seat, sends with --wake under the connection's label, returns the reply_id", async () => {
  const s = stub({ "agent send": { name: "dev", delivered: true, msg_id: "a1b2c3d4" } });
  const { data } = await run("agents_send", { agent: "dev", message: "status?" }, s, { sender: "mcp-chatgpt" });
  assert.equal(data.reply_id, "a1b2c3d4");
  assert.deepEqual(s.calls.at(-1).argv, ["agent", "send", "dev", "--message=status?", "--wake", "--from=mcp-chatgpt"]);
  // A name not on the box never reaches an argv position.
  const s2 = stub();
  const r = await run("agents_send", { agent: "ghost", message: "hi" }, s2);
  assert.match(r.text, /no agent called "ghost"/);
  assert.deepEqual(s2.argvs(), ["agent list"]);
  const r2 = await run("agents_send", { agent: "dev", message: "--wake" }, stub());
  assert.match(r2.text, /may not start with a dash/);
});

test("agents_read: reads only the reply window for that reply_id, fenced reply preferred", async () => {
  const s = stub({ "agent _capture": "thinking…\n<5dive-r:a1b2c3d4>\nAll green, shipping at 5.\n</5dive-r:a1b2c3d4>\n" });
  const { data } = await run("agents_read", { agent: "dev", reply_id: "a1b2c3d4" }, s);
  assert.equal(data.answer, "All green, shipping at 5.");
  const last = s.calls.at(-1);
  assert.deepEqual(last.argv, ["agent", "_capture", "dev", "--after-id=a1b2c3d4"]);
  assert.equal(last.opts.text, true);
  const empty = await run("agents_read", { agent: "dev", reply_id: "a1b2c3d4" }, stub({ "agent _capture": "" }));
  assert.equal(empty.data.answer, null);
  assert.match(empty.data.note, /No answer yet/);
  const bad = await run("agents_read", { agent: "dev", reply_id: "--after-id=x" }, stub());
  assert.equal(bad.isError, true);
  assert.equal(replyText("x".repeat(5000), "z").length, 4001);
});

test("tasks_list: status/assignee/project filters, delivered, and since", async () => {
  const s = stub({ "task ls": { tasks: [
    { ident: "DIVE-5", status: "done", done_at: "2026-11-25 10:00:00" },
    { ident: "DIVE-6", status: "done", done_at: "2026-11-26 10:00:00" },
  ] } });
  const { data } = await run("tasks_list", { status: "done", assignee: "dev", project: "Web", since: "2026-11-26T00:00:00Z" }, s);
  assert.deepEqual(s.calls.at(-1).argv, ["task", "ls", "--status=done", "--assignee=dev", "--project=web"]);
  assert.deepEqual(data.tasks.map((t) => t.task), ["DIVE-6"]);
  const d = await run("tasks_list", { status: "delivered" }, stub({ "task ls": { tasks: [
    { ident: "DIVE-7", status: "in_progress", handoff_delivered_at: "2026-11-26 11:00:00" },
    { ident: "DIVE-8", status: "in_progress" },
  ] } }));
  assert.deepEqual(d.data.tasks.map((t) => t.task), ["DIVE-7"]);
  assert.match((await run("tasks_list", { since: "2026-11-26" }, stub())).text, /since works with status/);
});

test("tasks_assign: returns the previous owner as an undo", async () => {
  const s = stub({ "task show": { task: { ident: "DIVE-9", assignee: "marcus" } }, "task assign": { ok: 1 } });
  const { data } = await run("tasks_assign", { task: "dive-9", agent: "dev" }, s);
  assert.deepEqual(data.undo, { tool: "tasks_assign", task: "DIVE-9", agent: "marcus" });
  assert.ok(s.argvs().includes("task assign DIVE-9 dev"));
});

test("tasks_create: accept, reviewer and project as `task add` takes them; the connection is named in the body", async () => {
  const s = stub({
    "project ls": { projects: [{ key: "web", status: "active" }] },
    "task add": { ident: "DIVE-42" },
  });
  const { data } = await run(
    "tasks_create",
    { title: "Fix the signup form", agent: "dev", reviewer: "quinn", project: "web", accept: "form submits", details: "see #12", priority: "high" },
    s,
    { via: "chatgpt" },
  );
  assert.equal(data.task, "DIVE-42");
  assert.deepEqual(s.calls.at(-1).argv, [
    "task", "add", "--priority=high", "--assignee=dev", "--verifier=quinn", "--project=web", "--accept=form submits",
    '--body=see #12\n\nFiled over MCP by the "chatgpt" connection.', "--", "Fix the signup form",
  ]);
  assert.match((await run("tasks_create", { title: "x", agent: "dev", reviewer: "dev" }, stub())).text, /different agent/);
  assert.match((await run("tasks_create", { title: "x", priority: "urgent" }, stub())).text, /low, medium or high/);
  assert.match((await run("tasks_create", { title: "x", project: "nope" }, stub({ "project ls": { projects: [] } }))).text, /no project "nope"/);
});

test("tasks_get: result, delivery link, review verdict, blockers and what it blocks", async () => {
  const s = stub({
    "task show DIVE-10 --no-body": { task: { ident: "DIVE-10" }, blocked_by: [] },
    "task show DIVE-10": {
      task: {
        ident: "DIVE-10", title: "t", status: "in_progress", result: "done it ❌ quinn rejected: no test", acceptance_criteria: "has a test",
        verifier: "quinn", delivery_ref: "https://github.com/o/r/pull/1", handoff_delivered_at: "2026-11-26 09:00:00", graded_verdict: "reject",
      },
      blocked_by: [{ ident: "DIVE-3", title: "dep", status: "todo" }],
    },
    "task ls --status=blocked": { tasks: [{ ident: "DIVE-11", title: "waits", status: "blocked" }] },
    "task show DIVE-11 --no-body": { task: { ident: "DIVE-11" }, blocked_by: [{ ident: "DIVE-10" }] },
  });
  const { data } = await run("tasks_get", { task: "DIVE-10" }, s);
  assert.equal(data.delivered.link, "https://github.com/o/r/pull/1");
  assert.equal(data.review.verdict, "reject");
  assert.match(data.review.feedback, /^❌ quinn rejected/);
  assert.deepEqual(data.blocked_by.map((b) => b.task), ["DIVE-3"]);
  assert.deepEqual(data.blocks.map((b) => b.task), ["DIVE-11"]);
});

test("projects_list projects the board", async () => {
  const { data } = await run("projects_list", {}, stub({ "project ls": { projects: [{ key: "web", name: "Web", lead_agent: "dev", status: "active", goal: "ship" }] } }));
  assert.deepEqual(data.projects, [{ project: "web", name: "Web", lead: "dev", status: "active", about: "ship" }]);
});

test("wiki_search reads --store=wiki only and drops any agent-memory path", async () => {
  const out = [
    "[0.91] community/wiki/launch-checklist.md  ›  Launch checklist",
    "    Run the smoke before you tag.",
    "",
    "[0.80] /home/agent-dev/.claude/projects/x/memory/secret.md  ›  private",
    "    my own notes",
    "",
  ].join("\n");
  const s = stub({ "memory search": out });
  const { data } = await run("wiki_search", { query: "--launch", limit: 3 }, s);
  assert.deepEqual(s.calls[0].argv, ["memory", "search", "--store=wiki", "--limit=3", "--max-tokens=1500", "launch"]);
  assert.deepEqual(data.pages.map((p) => p.page), ["launch-checklist"]);
  const none = await run("wiki_search", { query: "x" }, stub({ "memory search": new Error("5dive: no shared wiki on this box") }));
  assert.match(none.data.note, /no shared wiki/);
});

test("marketplace_list reads the box's own marketplace", async () => {
  const s = stub({ "agent marketplace ls": { packs: [{ slug: "theo", name: "Theo", role: "Designer", tagline: "draws" }] } });
  const { data } = await run("marketplace_list", {}, s);
  assert.deepEqual(data.agents[0], { agent_id: "theo", name: "Theo", job: "Designer", about: "draws", department: null });
});

test("agents_hire: imports the pack under a free name; refuses a paid pack, a taken name and a full box", async () => {
  const packs = { packs: [{ slug: "theo", name: "Theo", role: "Designer" }, { slug: "vip", name: "Vip", premium: true }] };
  const s = stub({ "agent marketplace ls": packs, "agent import": { name: "theo" } });
  const { data } = await run("agents_hire", { agent_id: "theo" }, s, { maxAgents: null });
  assert.equal(data.hired, true);
  const imp = s.calls.at(-1);
  assert.deepEqual(imp.argv, ["agent", "import", "theo", "--as=theo"]);
  assert.equal(imp.opts.timeoutMs, 300000);
  assert.match((await run("agents_hire", { agent_id: "vip" }, stub({ "agent marketplace ls": packs }), { maxAgents: null })).text, /costs money/);
  assert.match((await run("agents_hire", { agent_id: "theo", name: "dev" }, stub({ "agent marketplace ls": packs }), { maxAgents: null })).text, /already has an agent called "dev"/);
  const full = stub({ "agent marketplace ls": packs });
  const r = await run("agents_hire", { agent_id: "theo" }, full, { maxAgents: 3 });
  assert.match(r.text, /allows 3 agents and the team has 3/);
  assert.ok(!full.argvs().some((a) => a.startsWith("agent import")));
  // A slow import is reported as joining, not failed.
  const slow = stub({ "agent marketplace ls": packs, "agent import": () => new Promise(() => {}) });
  const j = await run("agents_hire", { agent_id: "theo" }, slow, { maxAgents: null, hireWaitMs: 10 });
  assert.equal(j.data.hired, "joining");
});

test("gates_list: says which gates the connector may answer, and hands a secret gate its one-time link", async () => {
  const s = stub({
    "task inbox": { inbox: [gate("DIVE-20"), gate("DIVE-21", { need_type: "secret", ask: "Paste the API key" })] },
    "secret link DIVE-21": { url: "https://box.example/s/abc", expires_at: "2026-11-27T10:00:00Z" },
  });
  const { data } = await run("gates_list", {}, s);
  const [a, b] = data.needs_you;
  assert.equal(a.you_can_answer, true);
  assert.equal(b.you_can_answer, false);
  assert.match(b.why_not_you, /key or password/);
  assert.equal(b.answer_at, "https://box.example/s/abc");
});

test("gates_answer: answers an ordinary decision with the gate's own option, as the connector", async () => {
  const g = gate("DIVE-30");
  const s = stub({ "task inbox": { inbox: [g] }, "task show": { task: g }, "task answer": { pinged: true } });
  const { data } = await run("gates_answer", { task: "DIVE-30", answer: "thursday" }, s);
  assert.deepEqual(data, { task: "DIVE-30", answered: "Thursday", kind: "decision", agent_told: true });
  assert.deepEqual(s.calls.at(-1).argv, ["task", "answer", "DIVE-30", "--value=Thursday", "--from=connector"]);
  const ap = gate("DIVE-31", { need_type: "approval", need_options: undefined });
  const s2 = stub({ "task inbox": { inbox: [ap] }, "task show": { task: ap }, "task answer": {} });
  assert.equal((await run("gates_answer", { task: "DIVE-31", answer: "yes" }, s2)).data.answered, "approve");
  assert.match((await run("gates_answer", { task: "DIVE-30", answer: "Friday" }, stub({ "task inbox": { inbox: [g] }, "task show": { task: g } }))).text, /one of the gate's options/);
  // A gate routed to an agent seat, not the user, is theirs.
  const r = await run("gates_answer", { task: "DIVE-30", answer: "Tuesday" }, stub({ "task inbox": { inbox: [] }, "task show": { task: g } }));
  assert.match(r.text, /waiting on an agent on the team/);
});

// NEGATIVE CONTROLS: each gate below is refused with its reason, and the CLI's
// `task answer` never runs.
for (const [label, extra, reason] of [
  ["money in the ask", { ask: "Approve the $100 ad spend?", need_options: "yes|no" }, /it is about money/],
  ["money in the options", { ask: "Which plan?", need_options: "Upgrade the subscription|Stay" }, /it is about money/],
  ["money in floor provenance", { ask: "Go ahead?", floor_provenance: "floor term=wallet" }, /it is about money/],
  ["a secret", { need_type: "secret", ask: "Paste the key" }, /key or password/],
  ["a manual step", { need_type: "manual", ask: "Plug in the drive" }, /only the user can take/],
  ["tier 2", { tier: 2 }, /marked for the user only/],
  ["no tier at all", { tier: null }, /marked for the user only/],
  ["a declared capability", { needs_capability: "human_tap" }, /marked for the user only/],
]) {
  test(`gates_answer refuses ${label}, says why, and never answers`, async () => {
    const g = gate("DIVE-40", extra);
    const s = stub({ "task inbox": { inbox: [g] }, "task show": { task: g }, "task answer": { pinged: true } });
    const r = await run("gates_answer", { task: "DIVE-40", answer: "yes" }, s);
    assert.equal(r.isError, true);
    assert.match(r.text, /^You cannot answer DIVE-40: /);
    assert.match(r.text, reason);
    assert.ok(!s.argvs().some((a) => a.startsWith("task answer")), "task answer must not run");
  });
}

test("answerRefusal lets through only an ordinary low-tier decision or approval", () => {
  assert.equal(answerRefusal(gate("D-1")), null);
  assert.equal(answerRefusal(gate("D-1", { need_type: "approval", tier: 0 })), null);
  assert.match(answerRefusal(gate("D-1", { need_type: "info" })), /not a decision or an approval/);
});

test("tasks_update: edges, raise to high, note and cancel; never lowers or reopens", async () => {
  const s = stub({
    "task show": { task: { ident: "DIVE-50", status: "in_progress", priority: "medium" } },
    "task block": {}, "task unblock": {}, "task escalate": {}, "task followup": { delivered: true }, "task cancel": {},
  });
  const { data } = await run("tasks_update", { task: "DIVE-50", blocked_by: "DIVE-49", unblock: "DIVE-48", priority: "high", note: "use the new API", cancel: "superseded" }, s);
  assert.deepEqual(data.changed, { blocked_by: "DIVE-49", unblocked: "DIVE-48", priority: "high", note: { delivered: true }, status: "cancelled" });
  assert.deepEqual(s.argvs().slice(1), [
    "task block DIVE-50 --by=DIVE-49",
    "task unblock DIVE-50 --by=DIVE-48",
    "task escalate DIVE-50 --from=connector",
    "task followup DIVE-50 --text=use the new API --from=connector",
    "task cancel DIVE-50 --result=superseded",
  ]);
  const done = stub({ "task show": { task: { ident: "DIVE-51", status: "done" } } });
  assert.match((await run("tasks_update", { task: "DIVE-51", cancel: "x" }, done)).text, /already done/);
  const open = stub({ "task show": { task: { ident: "DIVE-52", status: "todo", priority: "medium" } } });
  assert.match((await run("tasks_update", { task: "DIVE-52", priority: "low" }, open)).text, /only raising to high/);
  assert.deepEqual(open.argvs(), ["task show DIVE-52 --no-body"]);
  assert.match((await run("tasks_update", { task: "DIVE-51" }, stub())).text, /say what to change/);
});

test("secrets_request files a secret gate and returns its one-time link, never a value", async () => {
  const s = stub({ "task need": { secret_link_url: "https://box.example/s/x", drop_link_expires_at: "2026-11-27T11:00:00Z" } });
  const { data } = await run("secrets_request", { task: "DIVE-60", key: "STRIPE_API_KEY", ask: "Your Stripe secret key, from the dashboard." }, s);
  assert.equal(data.link, "https://box.example/s/x");
  assert.deepEqual(s.calls[0].argv, ["task", "need", "DIVE-60", "--type=secret", "--secret-key=STRIPE_API_KEY", "--connector=tools", "--ask=Your Stripe secret key, from the dashboard."]);
  assert.match((await run("secrets_request", { task: "DIVE-60", key: "stripe", ask: "x" }, stub())).text, /name in capitals/);
  // No https link from the box: filed, and says where the user answers.
  const n = await run("secrets_request", { task: "DIVE-60", key: "A_KEY", ask: "x" }, stub({ "task need": {}, "secret link": new Error("no public url") }));
  assert.equal(n.data.link, null);
  assert.match(n.data.note, /5dive task answer DIVE-60/);
});

// NEGATIVE CONTROL: every write tool on a read-only token is refused over HTTP
// before the CLI runs, and the refusal is audited.
test("a read-only token is refused every write tool, and the CLI never runs", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "5dive-mcp-"));
  const tokensFile = path.join(home, "tokens.json");
  const calls = [];
  const audits = [];
  const server = createServer({ tokensFile, exec: async (argv) => (calls.push(argv), {}), audit: (e) => audits.push(e) });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const tok = createToken({ name: "dots" }, tokensFile);
  const writes = OPS.filter((t) => t.write).map((t) => t.name);
  try {
    for (const [i, name] of writes.entries()) {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name, arguments: { task: "DIVE-1", agent: "dev" } } }),
      });
      const j = await res.json();
      assert.equal(j.result.isError, true, name);
      assert.match(j.result.content[0].text, /read-only/, name);
    }
    assert.equal(calls.length, 0);
    assert.deepEqual(audits.map((a) => [a.tool, a.ok, a.reason]), writes.map((n) => [n, false, "read-only token"]));
  } finally {
    server.close();
  }
});

// The real adapter against a stub `5dive` binary: JSON envelopes, text mode,
// and a refusal surfacing as a readable error.
test("run5dive against a stub 5dive binary: data, text mode and refusals", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "5dive-bin-"));
  const bin = path.join(dir, "5dive");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] !== "--json") { console.log("no --json"); process.exit(3); }
const v = a.slice(1).join(" ");
if (v === "agent list") console.log(JSON.stringify({ ok: true, data: [{ name: "dev" }] }));
else if (v.startsWith("memory search")) console.log("[0.5] wiki/a.md  ›  A\\n    body");
else { console.log(JSON.stringify({ ok: false, error: { message: "refused: nope", code: 10 } })); process.exit(1); }
`,
    { mode: 0o755 },
  );
  const script = `
    import { run5dive } from ${JSON.stringify(new URL("../src/tools.js", import.meta.url).href)};
    const out = {};
    out.list = await run5dive(["agent", "list"]);
    out.text = await run5dive(["memory", "search", "--store=wiki", "x"], { text: true });
    out.err = await run5dive(["task", "answer", "D-1"]).catch((e) => e.message);
    console.log(JSON.stringify(out));`;
  const res = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, FIVEDIVE_BIN: bin, FIVEDIVE_SUDO: "" } }).toString(),
  );
  assert.deepEqual(res.list, [{ name: "dev" }]);
  assert.match(res.text, /^\[0\.5\] wiki\/a\.md/);
  assert.equal(res.err, "5dive: refused: nope (10)");
});
