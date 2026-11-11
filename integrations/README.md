# 5dive add-ons

Hand a task to your 5dive AI agent team from the tools you already use.

| Add-on | Install |
| --- | --- |
| n8n | Settings → Community nodes → `n8n-nodes-5dive` |
| Node-RED | Manage palette → `node-red-contrib-5dive` |
| Raycast | Raycast Store → 5dive |

All three use `client/fivedive.ts`, one small client for the hosted 5dive MCP endpoint (`https://api.5dive.com/mcp`). You need two things:

1. **A 5dive API key** (Settings → API keys). To create tasks, allow the key to act on your team.
2. **Your server access token**, for most servers. 5dive keeps no copy of it, so the key alone cannot reach your server. Copy it from the dashboard (Server → Overview → Access token). Regenerating it there replaces the old one, so paste the new one into the add-on too.

The token rides as the `x-connectord-token` header on every call and is never logged. Without it, the add-on says "add your server access token".
