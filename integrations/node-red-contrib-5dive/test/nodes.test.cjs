// Loads the three nodes into a minimal fake RED runtime and drives them against
// a fake hosted 5dive MCP (global fetch stub).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");

function fakeRED() {
  const types = {}, nodes = {};
  const RED = {
    nodes: {
      registerType: (name, ctor, opts) => (types[name] = { ctor, opts }),
      createNode: (node, config) => {
        Object.setPrototypeOf(node, EventEmitter.prototype);
        EventEmitter.call(node);
        node.id = config.id;
        node.credentials = config._creds;
        node.statuses = [];
        node.status = (s) => node.statuses.push(s);
        node.error = (e) => (node.lastError = e);
        nodes[config.id] = node;
      },
      getNode: (id) => nodes[id],
    },
  };
  for (const f of ["fivedive-config", "fivedive-create-task", "fivedive-get-task"]) require(`../nodes/${f}.js`)(RED);
  const make = (type, config) => new types[type].ctor(config);
  return { RED, types, make };
}
function fakeMcp(reply) {
  const calls = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, auth: init.headers.Authorization, tool: body.params.name, args: body.params.arguments });
    const data = reply(body.params.name, body.params.arguments);
    return { status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data } }) };
  };
  return calls;
}
const fire = (node, msg) =>
  new Promise((resolve) => node.emit("input", msg, (m) => resolve({ msg: m }), (e) => e && resolve({ err: e })));

test("package.json lists every node file, and each has its editor HTML", () => {
  const fs = require("node:fs");
  const pkg = require("../package.json");
  assert.ok(pkg.keywords.includes("node-red"));
  for (const f of Object.values(pkg["node-red"].nodes)) {
    assert.ok(fs.existsSync(`${__dirname}/../${f}`), f);
    assert.ok(fs.existsSync(`${__dirname}/../${f.replace(/\.js$/, ".html")}`), f);
  }
  const { types } = fakeRED();
  assert.deepEqual(types["fivedive-config"].opts.credentials, { apiKey: { type: "password" } });
});

test("create task: a string payload is the title, node settings win, the key rides as Bearer", async () => {
  const { make } = fakeRED();
  make("fivedive-config", { id: "acc", baseUrl: "https://api.example.test", _creds: { apiKey: "5d_k" } });
  const node = make("fivedive-create-task", { id: "n1", account: "acc", agent: "main", priority: "high" });
  const calls = fakeMcp((_t, a) => ({ task: "DIVE-5", status: "todo", ...a }));
  const { msg } = await fire(node, { payload: "Write the post" });
  assert.equal(msg.payload.task, "DIVE-5");
  assert.deepEqual(calls, [{ url: "https://api.example.test/mcp", auth: "Bearer 5d_k", tool: "tasks_create", args: { title: "Write the post", agent: "main", priority: "high" } }]);
  assert.equal(node.statuses.at(-1).fill, "green");
});

test("get task: id from msg.payload.task; no id is an error, never a call", async () => {
  const { make } = fakeRED();
  make("fivedive-config", { id: "acc", _creds: { apiKey: "5d_k" } });
  const node = make("fivedive-get-task", { id: "n2", account: "acc" });
  const calls = fakeMcp((_t, a) => ({ task: a.task, status: "done", result: "Done." }));
  const { msg } = await fire(node, { payload: { task: "DIVE-5" } });
  assert.equal(msg.payload.result, "Done.");
  assert.equal(calls[0].url, "https://api.5dive.com/mcp");
  const { err } = await fire(node, { payload: "" });
  assert.match(err.message, /Which task/);
  assert.equal(calls.length, 1);
});

test("no account picked: red status and a plain error", async () => {
  const { make } = fakeRED();
  const node = make("fivedive-get-task", { id: "n3", account: "missing", task: "DIVE-1" });
  const { err } = await fire(node, {});
  assert.match(err.message, /Pick a 5dive account/);
  assert.equal(node.statuses.at(-1).fill, "red");
});
