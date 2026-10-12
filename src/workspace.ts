import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { statSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const PROJECT_MARKERS = [
  ".opencode/opencode.json",
  ".opencode/opencode.jsonc",
  "opencode.jsonc",
  "opencode.json",
];

// OpenCode's plugin setup context does not always expose the current project
// directory (especially for npm-loaded plugins). As a last resort, search for
// an OpenCode config file that references this plugin package.
const PLUGIN_PACKAGE_NAMES = [
  "@brycehamrick/opencode-hindsight",
  "opencode-hindsight",
  // Legacy name (pre-rename) — configs may still reference it.
  "@brycehamrick/opencode-v2-hindsight",
  "opencode-v2-hindsight",
];

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function findGitRoot(startDir: string): string | null {
  if (!startDir) return null;
  try {
    const root = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        cwd: startDir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1000,
      }
    ).trim();
    if (!root) return null;
    if (root.endsWith("/.git")) {
      return dirname(root);
    }
    return root;
  } catch {
    return null;
  }
}

function findMarkerDir(startDir: string, marker: string): string | null {
  let dir = resolve(startDir);
  let last = "";
  while (dir !== last) {
    if (exists(join(dir, marker))) return dir;
    last = dir;
    dir = dirname(dir);
  }
  return null;
}

function findProjectRoot(startDir: string): string | null {
  if (!startDir) return null;

  // Prefer explicit project config markers.
  for (const marker of PROJECT_MARKERS) {
    const configDir = findMarkerDir(startDir, marker);
    if (configDir) return configDir;
  }

  // Fall back to git root.
  return findGitRoot(startDir);
}

function referencesPlugin(text: string): boolean {
  const lower = text.toLowerCase();
  return PLUGIN_PACKAGE_NAMES.some((name) => lower.includes(name.toLowerCase()));
}

function findConfigReferencingPlugin(startDir: string, maxDepth = 2): string | null {
  if (!startDir || !exists(startDir)) return null;

  const queue: { dir: string; depth: number }[] = [{ dir: resolve(startDir), depth: 0 }];
  const seen = new Set<string>();

  while (queue.length) {
    const { dir, depth } = queue.shift()!;
    if (seen.has(dir)) continue;
    seen.add(dir);

    for (const marker of PROJECT_MARKERS) {
      const configPath = join(dir, marker);
      if (exists(configPath)) {
        try {
          const raw = readFileSync(configPath, "utf-8");
          if (referencesPlugin(raw)) return dir;
        } catch {
          // Ignore unreadable files.
        }
      }
    }

    if (depth < maxDepth) {
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory() && !entry.name.startsWith(".")) {
            queue.push({ dir: join(dir, entry.name), depth: depth + 1 });
          }
        }
      } catch {
        // Ignore unreadable directories.
      }
    }
  }

  return null;
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

/**
 * Resolve the most accurate workspace directory available.
 *
 * OpenCode V2 exposes the project directory through several possible fields.
 * We try the known ones in order of preference and fall back to git/project
 * markers and process.cwd().
 *
 * When OpenCode loads the plugin from npm, the setup context often lacks the
 * current project directory, so we also search nearby directories for an
 * OpenCode config file that references this plugin package.
 */
export function resolveWorkspaceDirectory(ctx: any): string {
  const candidates: string[] = [];

  // OpenCode 2.0.27+ exposes the host location (directory plus project info)
  // directly on the plugin context.
  const locationPath = pickString(ctx?.location?.directory, ctx?.location?.project?.directory, ctx?.location?.project?.canonical);
  if (locationPath) candidates.push(locationPath);

  // Documented / legacy fields.
  const worktree = pickString(ctx?.worktree);
  if (worktree) candidates.push(worktree);

  const directory = pickString(ctx?.directory);
  if (directory) candidates.push(directory);

  const projectPath = pickString(ctx?.project?.path, ctx?.project?.directory, ctx?.project?.root);
  if (projectPath) candidates.push(projectPath);

  // Legacy / undocumented fallbacks.
  const workspacePath =
    typeof ctx?.workspace === "string"
      ? ctx.workspace
      : pickString(ctx?.workspace?.directory, ctx?.workspace?.path, ctx?.workspace?.root, ctx?.workspace?.dir);
  if (workspacePath) candidates.push(workspacePath);

  // Nested client/project fields (some OpenCode builds pass these).
  const clientProjectPath = pickString(
    ctx?.client?.project?.path,
    ctx?.client?.project?.directory,
    ctx?.client?.worktree,
    ctx?.client?.directory
  );
  if (clientProjectPath) candidates.push(clientProjectPath);

  if (typeof process !== "undefined" && process.cwd) {
    candidates.push(process.cwd());
  }

  // For local plugin installs, the plugin file lives inside the project.
  try {
    const pluginFile = fileURLToPath(import.meta.url);
    candidates.push(dirname(pluginFile));
  } catch {
    // Ignore if import.meta.url is unavailable.
  }

  for (const candidate of candidates) {
    const root = findProjectRoot(candidate);
    if (root) return root;
  }

  // Last resort: search for an OpenCode config that references this plugin.
  for (const candidate of candidates) {
    const found = findConfigReferencingPlugin(candidate, 2);
    if (found) return found;
  }

  return locationPath || worktree || directory || projectPath || workspacePath || process.cwd();
}
