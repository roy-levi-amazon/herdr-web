import { afterEach, describe, expect, it, vi } from "vitest";
import { createdPaneId, probePaneMoveSupported, probeSplitSupported } from "./commands";

describe("command helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("finds created pane ids from supported response shapes", () => {
    expect(createdPaneId({ root_pane: { pane_id: "root" } })).toBe("root");
    expect(createdPaneId({ pane: { pane_id: "pane" } })).toBe("pane");
    expect(createdPaneId({ agent: { pane_id: "agent" } })).toBe("agent");
    expect(createdPaneId({ move_result: { pane: { pane_id: "moved" } } })).toBe("moved");
    expect(createdPaneId({})).toBeNull();
  });

  it("reads split support from bridge capabilities", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ commands: ["pane.split"] }), { status: 200 }),
    );

    await expect(probeSplitSupported()).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledWith("/api/capabilities");
  });

  it("treats missing split capability as unsupported", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ commands: ["tab.create"] }), { status: 200 }),
    );

    await expect(probeSplitSupported()).resolves.toBe(false);
  });

  it("reads pane move support from bridge capabilities", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ commands: ["pane.move"] }), { status: 200 }),
    );

    await expect(probePaneMoveSupported()).resolves.toBe(true);
  });
});
