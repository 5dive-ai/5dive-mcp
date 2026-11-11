module.exports = function (RED) {
  const { FiveDive } = require("./lib/fivedive.js");
  function FiveDiveConfig(config) {
    RED.nodes.createNode(this, config);
    this.name = config.name;
    this.baseUrl = config.baseUrl || "https://api.5dive.com";
    this.client = () =>
      new FiveDive({
        apiKey: (this.credentials && this.credentials.apiKey) || "",
        baseUrl: this.baseUrl,
        userAgent: "node-red-contrib-5dive",
      });
  }
  RED.nodes.registerType("fivedive-config", FiveDiveConfig, {
    credentials: { apiKey: { type: "password" } },
  });
};
