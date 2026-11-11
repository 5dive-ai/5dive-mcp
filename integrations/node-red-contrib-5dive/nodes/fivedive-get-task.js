module.exports = function (RED) {
  const run = require("./run.js");
  function GetTask(config) {
    RED.nodes.createNode(this, config);
    // The task id comes from this node, or msg.payload ("DIVE-12" or {task: "DIVE-12"}).
    run(RED, this, config, (client, msg) => {
      const p = msg.payload;
      const id = config.task || (p && typeof p === "object" ? p.task : p);
      if (!id) throw new Error("Which task? Set the ID here or send it as msg.payload");
      return client.getTask(String(id));
    });
  }
  RED.nodes.registerType("fivedive-get-task", GetTask);
};
