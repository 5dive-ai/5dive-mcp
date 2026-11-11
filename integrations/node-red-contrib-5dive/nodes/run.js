// Shared input handler: status dot, msg.payload out, errors via node.error(err, msg).
module.exports = function run(RED, node, config, work) {
  const account = RED.nodes.getNode(config.account);
  node.on("input", async (msg, send, done) => {
    send = send || ((m) => node.send(m));
    done = done || ((e) => e && node.error(e, msg));
    if (!account) {
      node.status({ fill: "red", shape: "ring", text: "no 5dive account" });
      return done(new Error("Pick a 5dive account in this node's settings"));
    }
    node.status({ fill: "blue", shape: "dot", text: "working" });
    try {
      msg.payload = await work(account.client(), msg);
      node.status({ fill: "green", shape: "dot", text: msg.payload.task + " " + (msg.payload.status || "") });
      send(msg);
      done();
    } catch (err) {
      node.status({ fill: "red", shape: "ring", text: "failed" });
      done(err);
    }
  });
};
