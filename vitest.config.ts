import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    // legacy/v2-stub is a published forwarding stub with node:test suites of
    // its own — vitest finds no suite in them and reports a spurious failure.
    exclude: ["**/node_modules/**", "legacy/**"],
  },
});
