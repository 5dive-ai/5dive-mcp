// The Raycast store needs its extension self-contained, so it carries a
// committed copy of the client. This keeps that copy identical to the source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the Raycast copy of the client matches client/fivedive.ts", () => {
  const src = readFileSync(new URL("./fivedive.ts", import.meta.url), "utf8");
  const copy = readFileSync(new URL("../raycast-5dive/src/fivedive.ts", import.meta.url), "utf8");
  assert.equal(copy, src);
});
