module.exports = function (RED) {
  const run = require("./run.js");
  function CreateTask(config) {
    RED.nodes.createNode(this, config);
    // Node settings win; anything left empty comes from msg.payload
    // (a string is the title, an object may carry title/agent/priority/details).
    run(RED, this, config, (client, msg) => {
      const p = msg.payload;
      const from = p && typeof p === "object" ? p : { title: typeof p === "string" ? p : "" };
      const title = config.title || from.title || msg.topic || "";
      if (!String(title).trim()) throw new Error("A task needs a title: set it here or send it as msg.payload");
      return client.createTask({
        title: String(title),
        agent: config.agent || from.agent,
        priority: config.priority || from.priority || "medium",
        details: config.details || from.details,
      });
    });
  }
  RED.nodes.registerType("fivedive-create-task", CreateTask);
};
