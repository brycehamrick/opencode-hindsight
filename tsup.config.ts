import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: true,
  // Bundle every runtime dependency into dist so the plugin never resolves
  // bare specifiers through the host process. opencode's plugin loader runs
  // inside the compiled binary, where module resolution can pick the host's
  // embedded packages (see the note in src/index.ts).
  noExternal: ["@vectorize-io/hindsight-client"],
});
