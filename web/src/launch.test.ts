import { describe, expect, it } from "vitest";
import { agentArgv, resolveLaunchSpec } from "./launch";
import { shellCommand, shellQuote } from "./shell";
import type { PaneInfo } from "./types";

const pane = (pane_id: string, label?: string, display_agent?: string) =>
  ({
    pane_id,
    terminal_id: `terminal-${pane_id}`,
    workspace_id: "1",
    tab_id: "1-1",
    focused: false,
    label,
    display_agent,
    agent_status: "idle",
    revision: 1,
  }) satisfies PaneInfo;

describe("launch helpers", () => {
  it("maps supported agents to argv", () => {
    expect(agentArgv("codex")).toEqual(["codex"]);
    expect(agentArgv("claude")).toEqual(["claude"]);
    expect(agentArgv("pi")).toEqual(["pi"]);
  });

  it("keeps custom launch titles", () => {
    expect(resolveLaunchSpec({ kind: "codex", title: "reviewer" }, [pane("1", "Codex")])).toEqual({
      kind: "codex",
      title: "reviewer",
    });
  });

  it("uniquifies default agent launch titles", () => {
    expect(
      resolveLaunchSpec({ kind: "codex", title: "Codex" }, [
        pane("1", "Codex"),
        pane("2", undefined, "Codex 2"),
      ]),
    ).toEqual({ kind: "codex", title: "Codex 3" });
  });
});

describe("shell quoting", () => {
  it("leaves simple command words unquoted", () => {
    expect(shellQuote("/tmp/file-name.txt")).toBe("/tmp/file-name.txt");
    expect(shellCommand(["codex"])).toBe("codex");
  });

  it("quotes spaces and single quotes", () => {
    expect(shellQuote("/tmp/has space.txt")).toBe("'/tmp/has space.txt'");
    expect(shellQuote("/tmp/it's.txt")).toBe("'/tmp/it'\\''s.txt'");
  });
});
