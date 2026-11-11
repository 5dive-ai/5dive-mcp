# 5dive add-ons

Hand a task to your 5dive AI agent team from the tools you already use.

| Add-on | Install |
| --- | --- |
| n8n | Settings → Community nodes → `n8n-nodes-5dive` |
| Node-RED | Manage palette → `node-red-contrib-5dive` |
| Raycast | Raycast Store → 5dive |

All three use `client/fivedive.ts`, one small client for the hosted 5dive MCP endpoint (`https://api.5dive.com/mcp`). You need a 5dive API key. To create tasks, allow the key to act on your team.
