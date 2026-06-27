import { describe, expect, it } from "vitest";
import {
  agentActivityKey,
  agentActivityTimestamps,
  parseAgentActivityListResponse,
  supportsAgentActivity,
} from "./agentActivity";

describe("agent activity helpers", () => {
  it("checks bridge support", () => {
    expect(supportsAgentActivity({ commands: [], agent_activity: { version: 1 } })).toBe(true);
    expect(supportsAgentActivity({ commands: [] })).toBe(false);
    expect(supportsAgentActivity(null)).toBe(false);
  });

  it("parses records with optional transition timestamps", () => {
    const response = parseAgentActivityListResponse({
      session_key: "session-a",
      records: [
        {
          pane_id: "pane-1",
          terminal_id: "terminal-1",
          workspace_id: "workspace-a",
          tab_id: "tab-a",
          agent_status: "working",
          last_status_transition_at: "123",
        },
        {
          pane_id: "pane-2",
          terminal_id: "terminal-2",
          workspace_id: "workspace-a",
          tab_id: "tab-a",
          agent_status: "idle",
          last_status_transition_at: null,
        },
      ],
    });

    expect(response.records).toHaveLength(2);
    expect(response.records[0].last_status_transition_at).toBe("123");
    expect(response.records[1].last_status_transition_at).toBeUndefined();
  });

  it("rejects invalid timestamps and statuses", () => {
    expect(() =>
      parseAgentActivityListResponse({
        session_key: "session-a",
        records: [
          {
            pane_id: "pane-1",
            terminal_id: "terminal-1",
            workspace_id: "workspace-a",
            tab_id: "tab-a",
            agent_status: "busy",
            last_status_transition_at: "123",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseAgentActivityListResponse({
        session_key: "session-a",
        records: [
          {
            pane_id: "pane-1",
            terminal_id: "terminal-1",
            workspace_id: "workspace-a",
            tab_id: "tab-a",
            agent_status: "working",
            last_status_transition_at: "12ms",
          },
        ],
      }),
    ).toThrow();
  });

  it("keys timestamps by bridge pane and terminal", () => {
    const timestamps = agentActivityTimestamps("bridge-a", {
      session_key: "session-a",
      records: [
        {
          pane_id: "pane-1",
          terminal_id: "terminal-1",
          workspace_id: "workspace-a",
          tab_id: "tab-a",
          agent_status: "working",
          last_status_transition_at: "456",
        },
        {
          pane_id: "pane-1",
          terminal_id: "terminal-2",
          workspace_id: "workspace-a",
          tab_id: "tab-a",
          agent_status: "working",
        },
      ],
    });

    expect(timestamps.get(agentActivityKey("bridge-a", "pane-1", "terminal-1"))).toBe(456);
    expect(timestamps.has(agentActivityKey("bridge-a", "pane-1", "terminal-2"))).toBe(false);
  });
});
