# Container image for the 5dive MCP server (stdio).
#
# Used by Glama (glama.ai/mcp) for its build/introspection checks and by any
# host that wants to run @5dive/mcp in a sandbox. The server boots and lists
# its tools with zero external dependencies; tool *calls* shell out to the
# `5dive` binary, which a real deployment installs on PATH or mounts in
# (see FIVEDIVE_BIN / FIVEDIVE_SUDO in the README).
FROM node:20-slim

WORKDIR /app

# Install production deps first for layer caching (only @modelcontextprotocol/sdk).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source.
COPY src ./src

# stdio MCP server: speaks JSON-RPC over stdin/stdout.
ENTRYPOINT ["node", "src/index.js"]
