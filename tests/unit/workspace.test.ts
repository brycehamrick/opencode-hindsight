import { describe, it, expect } from "vitest";
import { resolveWorkspaceDirectory } from "../../src/workspace.js";

describe("resolveWorkspaceDirectory", () => {
  it("prefers ctx.worktree", () => {
    const dir = resolveWorkspaceDirectory({
      worktree: "/Users/brycehamrick/src/opencode-hindsight",
    });
    expect(dir).toBe("/Users/brycehamrick/src/opencode-hindsight");
  });

  it("uses ctx.project.path when worktree is absent", () => {
    const dir = resolveWorkspaceDirectory({
      project: { path: "/Users/brycehamrick/src/opencode-hindsight" },
    });
    expect(dir).toBe("/Users/brycehamrick/src/opencode-hindsight");
  });

  it("uses ctx.directory when worktree and project are absent", () => {
    const dir = resolveWorkspaceDirectory({
      directory: "/Users/brycehamrick/src/opencode-hindsight",
    });
    expect(dir).toBe("/Users/brycehamrick/src/opencode-hindsight");
  });

  it("falls back to ctx.workspace (legacy)", () => {
    const dir = resolveWorkspaceDirectory({
      workspace: "/Users/brycehamrick/src/opencode-hindsight",
    });
    expect(dir).toBe("/Users/brycehamrick/src/opencode-hindsight");
  });

  it("resolves ctx.workspace.directory", () => {
    const dir = resolveWorkspaceDirectory({
      workspace: { directory: "/Users/brycehamrick/src/opencode-hindsight" },
    });
    expect(dir).toBe("/Users/brycehamrick/src/opencode-hindsight");
  });

  it("falls back to process.cwd()", () => {
    const dir = resolveWorkspaceDirectory({});
    expect(dir).toBe(process.cwd());
  });

  it("finds the project root from the plugin file location even when ctx fields are wrong", () => {
    const dir = resolveWorkspaceDirectory({ directory: "/Users/brycehamrick" });
    expect(dir).toBe("/Users/brycehamrick/src/opencode-hindsight");
  });
});
