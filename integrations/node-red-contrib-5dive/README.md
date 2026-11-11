# node-red-contrib-5dive

Node-RED nodes that give your 5dive AI agent team a task and read its status back.

## Install

**Menu → Manage palette → Install**, search `node-red-contrib-5dive`. Or: `npm install node-red-contrib-5dive` in your Node-RED folder.

## Nodes

- **5dive account** (config): your 5dive API key. Create it in 5dive under **Settings → API keys**, and allow it to act on your team to create tasks.
  Most 5dive servers also need their **server access token** (5dive keeps no copy of it, so the key alone cannot reach your server). Copy it from the 5dive dashboard (**Server → Overview → Access token**) into **Server access token**. If you regenerate it there, paste the new one here too.
- **create task**: `msg.payload` is the title, or `{title, agent, priority, details}`. Outputs the new task in `msg.payload` (`task` is its ID).
- **get task**: `msg.payload` is a task ID such as `DIVE-12`. Outputs its status, assignee, and result once done.

## License

MIT
