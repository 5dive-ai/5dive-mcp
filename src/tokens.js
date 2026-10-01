// Bearer tokens for `5dive-mcp serve`.
//
// The owner mints a token on the box (`5dive-mcp token create`), sees it once,
// and pastes it into the remote client. The file keeps only a SHA-256 of each
// token, never the token, so reading tokens.json does not hand out access.
// The server re-reads the file when it changes, so a revoke takes effect on the
// next request without a restart.
//
// Layout: $FIVEDIVE_MCP_HOME (default ${XDG_CONFIG_HOME:-~/.config}/5dive-mcp)
//   tokens.json   0600  {"tokens":[{name, hash, write, created_at}]}
//   audit.jsonl   0600  one line per tool call (see http.js)

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TOKEN_PREFIX = "5dmcp_";
// A label, not a secret. A message the token sends is labelled mcp-<name>,
// and the CLI caps that label at 32 characters of [a-z0-9-].
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,27}$/;

export function homeDir() {
  if (process.env.FIVEDIVE_MCP_HOME) return process.env.FIVEDIVE_MCP_HOME;
  const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(config, "5dive-mcp");
}

export const tokensPath = (home = homeDir()) => path.join(home, "tokens.json");
export const auditPath = (home = homeDir()) => path.join(home, "audit.jsonl");

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

function ensureHome(home) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
}

export function readTokens(file = tokensPath()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed?.tokens) ? parsed.tokens : [];
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw new Error(`cannot read ${file}: ${err.message}`);
  }
}

function writeTokens(tokens, file) {
  ensureHome(path.dirname(file));
  // Write-then-rename so a server reading mid-write never sees half a file.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ tokens }, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Mint a token. Returns the plaintext ONCE; only its hash is stored. */
export function createToken({ name, write = false }, file = tokensPath()) {
  if (!NAME_RE.test(name || "")) {
    throw new Error("name must be 1-28 lowercase letters, digits or dashes (e.g. chatgpt)");
  }
  const tokens = readTokens(file);
  if (tokens.some((t) => t.name === name)) {
    throw new Error(`a token named "${name}" already exists — revoke it first or pick another name`);
  }
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  tokens.push({ name, hash: sha256(token), write: Boolean(write), created_at: new Date().toISOString() });
  writeTokens(tokens, file);
  return token;
}

export function revokeToken(name, file = tokensPath()) {
  const tokens = readTokens(file);
  const kept = tokens.filter((t) => t.name !== name);
  if (kept.length === tokens.length) return false;
  writeTokens(kept, file);
  return true;
}

export function listTokens(file = tokensPath()) {
  return readTokens(file).map(({ name, write, created_at }) => ({ name, write, created_at }));
}

/**
 * A matcher over the token file that re-reads it only when its mtime moves.
 * Returns {name, write} for a valid token, null otherwise.
 */
export function tokenVerifier(file = tokensPath()) {
  let stamp = null;
  let cache = [];
  const load = () => {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      cache = [];
      stamp = null;
      return;
    }
    const next = `${st.mtimeMs}:${st.size}:${st.ino}`;
    if (next !== stamp) {
      cache = readTokens(file).map((t) => ({ ...t, digest: Buffer.from(String(t.hash), "hex") }));
      stamp = next;
    }
  };
  return (presented) => {
    if (typeof presented !== "string" || !presented.startsWith(TOKEN_PREFIX)) return null;
    load();
    const digest = Buffer.from(sha256(presented), "hex");
    for (const t of cache) {
      if (t.digest.length === digest.length && timingSafeEqual(t.digest, digest)) {
        return { name: t.name, write: Boolean(t.write) };
      }
    }
    return null;
  };
}
