import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep test-run diagnostics out of the user's real ~/.hindsight directory.
// Every vitest worker gets its own scratch log.
const dir = mkdtempSync(join(tmpdir(), "hindsight-diag-"));
process.env.HINDSIGHT_DIAG_FILE = join(dir, "diagnostics.log");
