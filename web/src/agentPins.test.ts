import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentPinsApiError,
  agentPinKey,
  agentPinKeys,
  pinAgent,
  supportsAgentPins,
} from "./agentPins";

describe("agent pin helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("checks the bridge agent pins capability", () => {
    expect(supportsAgentPins({ commands: [], agent_pins: { version: 1 } })).toBe(true);
    expect(supportsAgentPins({ commands: [] })).toBe(false);
    expect(supportsAgentPins(null)).toBe(false);
  });

  it("builds scoped pin keys", () => {
    expect(agentPinKey("bridge-a", "pane-a")).toBe("bridge-a:pane-a");
    expect(
      [...agentPinKeys("bridge-a", {
        session_key: "session:default",
        pins: [
          {
            pane_id: "pane-a",
            terminal_id: "terminal-a",
            workspace_id: "workspace-a",
            tab_id: "tab-a",
            created_at: "100",
            context: {},
          },
        ],
      })],
    ).toEqual(["bridge-a:pane-a"]);
  });

  it("preserves HTTP status for pin errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "pane not found: pane-a" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(pinAgent((path) => `http://bridge${path}`, "pane-a")).rejects.toMatchObject({
      name: "AgentPinsApiError",
      status: 400,
      message: "pane not found: pane-a",
    });

    expect(new AgentPinsApiError("bad", 400).status).toBe(400);
  });
});
