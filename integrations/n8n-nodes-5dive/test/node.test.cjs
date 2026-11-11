// Drives the built node against a fake hosted 5dive MCP (global fetch stub).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { FiveDive } = require("../dist/nodes/FiveDive/FiveDive.node.js");
const { FiveDiveApi } = require("../dist/credentials/FiveDiveApi.credentials.js");

function fakeMcp(reply) {
  const calls = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, auth: init.headers.Authorization, tool: body.params.name, args: body.params.arguments });
    if ("x-connectord-token" in init.headers) calls.at(-1).serverToken = init.headers["x-connectord-token"];
    const r = reply(body.params.name, body.params.arguments);
    return { status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result: r }) };
  };
  return calls;
}
const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });

function ctx(params, items = [{ json: {} }], failOk = false, extraCreds = {}) {
  return {
    getCredentials: async () => ({ apiKey: "5d_test", baseUrl: "https://api.example.test/", ...extraCreds }),
    getInputData: () => items,
    getNodeParameter: (name, i, dflt) => (params[i] && name in params[i] ? params[i][name] : dflt),
    continueOnFail: () => failOk,
    getNode: () => ({ name: "5dive", type: "fiveDive" }),
  };
}

test("the package manifest points at files the build produced", () => {
  const pkg = require("../package.json");
  assert.ok(pkg.keywords.includes("n8n-community-node-package"));
  for (const f of [...pkg.n8n.nodes, ...pkg.n8n.credentials]) require.resolve(`../${f}`);
  const d = new FiveDive().description;
  assert.equal(d.name, "fiveDive");
  assert.deepEqual(d.properties[0].options.map((o) => o.value), ["create", "get"]);
  assert.equal(new FiveDiveApi().name, d.credentials[0].name);
});

test("Create Task calls tasks_create with the key, drops empty fields, returns the new id", async () => {
  const calls = fakeMcp(() => ok({ task: "DIVE-9", title: "Write it", assignee: null, priority: "medium", status: "todo" }));
  const [[out]] = await new FiveDive().execute.call(
    ctx([{ operation: "create", title: " Write it ", agent: "", priority: "medium", details: "" }]),
  );
  assert.equal(out.json.task, "DIVE-9");
  assert.deepEqual(calls, [
    { url: "https://api.example.test/mcp", auth: "Bearer 5d_test", tool: "tasks_create", args: { title: "Write it", priority: "medium" } },
  ]);
});

test("Get Status calls tasks_get per item", async () => {
  const calls = fakeMcp((_t, a) => ok({ task: a.task, status: "done", result: "Done." }));
  const [out] = await new FiveDive().execute.call(
    ctx([{ operation: "get", task: "DIVE-1" }, { operation: "get", task: "DIVE-2" }], [{ json: {} }, { json: {} }]),
  );
  assert.deepEqual(out.map((o) => o.json.task), ["DIVE-1", "DIVE-2"]);
  assert.deepEqual(calls.map((c) => c.tool), ["tasks_get", "tasks_get"]);
});

test("a tool error reaches the user as its sentence; continueOnFail keeps the item", async () => {
  fakeMcp(() => ({ content: [{ type: "text", text: "This connection is read-only." }], isError: true }));
  await assert.rejects(
    new FiveDive().execute.call(ctx([{ operation: "create", title: "x" }])),
    /read-only/,
  );
  const [[out]] = await new FiveDive().execute.call(ctx([{ operation: "create", title: "x" }], undefined, true));
  assert.match(out.json.error, /read-only/);
});

test("a bad key is a plain 401 message", async () => {
  global.fetch = async () => ({ status: 401, text: async () => '{"error":"Unauthorized"}' });
  await assert.rejects(new FiveDive().execute.call(ctx([{ operation: "get", task: "DIVE-1" }])), /did not accept this API key/);
});

// DIVE-8214: most hosted servers need their server access token.
test("the credential has a password-type Server Access Token, and its test request sends it", () => {
  const c = new FiveDiveApi();
  const f = c.properties.find((p) => p.name === "serverToken");
  assert.ok(f, "serverToken field");
  assert.equal(f.typeOptions.password, true);
  assert.notEqual(f.required, true);
  assert.equal(c.authenticate.properties.headers["x-connectord-token"], "={{$credentials.serverToken}}");
});

test("the node sends the credential's server access token as x-connectord-token, and none when blank", async () => {
  const calls = fakeMcp((_t, a) => ok({ task: a.task, status: "todo" }));
  await new FiveDive().execute.call(ctx([{ operation: "get", task: "DIVE-1" }], undefined, false, { serverToken: "box-tok" }));
  await new FiveDive().execute.call(ctx([{ operation: "get", task: "DIVE-1" }], undefined, false, { serverToken: "" }));
  assert.equal(calls[0].serverToken, "box-tok");
  assert.ok(!("serverToken" in calls[1]));
});

test("no server access token: the error says to add it in the credential", async () => {
  fakeMcp(() => ({ content: [{ type: "text", text: "no server access token was presented, so the request never reached your server; regenerate the token and try again" }], isError: true }));
  await assert.rejects(
    new FiveDive().execute.call(ctx([{ operation: "get", task: "DIVE-1" }])),
    /Add it in the 5dive API credential \(Server access token\)/,
  );
});
