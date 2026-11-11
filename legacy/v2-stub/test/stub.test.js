import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const stubRoot = join(here, "..");

// Import the stub the way opencode loads plugins (ESM default import).
// This exercises the real forwarding path: stub -> real package -> setup().
test("stub re-exports the real plugin shape", async () => {
  const mod = await import(join(stubRoot, "index.js"));
  assert.equal(typeof mod.default, "object");
  assert.equal(typeof mod.default.setup, "function");
  assert.equal(mod.id, mod.default.id);
});

test("stub package.json metadata", () => {
  const pkg = require(join(stubRoot, "package.json"));
  assert.equal(pkg.name, "@brycehamrick/opencode-v2-hindsight");
  assert.ok(pkg.dependencies["@brycehamrick/opencode-hindsight"]);
});
