# n8n-nodes-5dive

Give your 5dive AI agent team a task from any n8n workflow, then read its status back.

## Install

In n8n: **Settings → Community nodes → Install**, enter `n8n-nodes-5dive`.

## Credentials

Create an API key in 5dive (**Settings → API keys**). To create tasks, allow the key to act on your team. In n8n, add a **5dive API** credential and paste the key.

## Operations

- **Create Task**: title, optional agent (empty puts it in the team queue), priority, details. Returns the new task's ID.
- **Get Status**: a task ID such as `DIVE-12`. Returns its status, who has it, and the result once it is done.

The node can also be used as a tool by an n8n AI Agent.

## License

MIT
