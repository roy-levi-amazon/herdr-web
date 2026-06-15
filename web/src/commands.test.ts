import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commands,
  createdPaneId,
  probeSupportedCommands,
} from "./commands";

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

  it("returns supported command names from bridge capabilities", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ commands: ["pane.split", "pane.move", 42] }), {
        status: 200,
      }),
    );

    await expect(probeSupportedCommands()).resolves.toEqual(new Set(["pane.split", "pane.move"]));
    expect(fetch).toHaveBeenCalledWith("/api/capabilities");
  });

  it("creates launch tabs without a tab label and renames the root pane", async () => {
    const requests: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      if (body.method === "tab.create") {
        return new Response(JSON.stringify({ root_pane: { pane_id: "pane-1" } }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ type: "ok" }), { status: 200 });
    });

    await commands.createLaunchTab("space-1", { kind: "shell", title: "Review" });

    expect(requests).toEqual([
      { method: "tab.create", params: { workspace_id: "space-1", focus: true } },
      { method: "pane.rename", params: { pane_id: "pane-1", label: "Review" } },
    ]);
  });

  it("clears workspace and tab names with null labels", async () => {
    const requests: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ type: "ok" }), { status: 200 });
    });

    await commands.renameWorkspace("space-1", null);
    await commands.renameTab("tab-1", null);

    expect(requests).toEqual([
      { method: "workspace.rename", params: { workspace_id: "space-1", label: null } },
      { method: "tab.rename", params: { tab_id: "tab-1", label: null } },
    ]);
  });
});
