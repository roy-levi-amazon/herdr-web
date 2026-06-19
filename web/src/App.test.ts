import { describe, expect, it } from "vitest";
import {
  resolveInitialSelectedBridgeId,
  sortScopedAgentPanes,
  stableBridgeRefreshOffsetMs,
} from "./App";
import {
  currentConnectionSnapshot,
  isConnectionResultCurrent,
} from "./connectionState";
import type { PaneInfo, Snapshot, WorkspaceInfo } from "./types";

describe("App connection guards", () => {
  it("hides snapshots from stale backend connections", () => {
    const snapshot = { panes: ["pane-a"] };

    expect(currentConnectionSnapshot(snapshot, "same-origin", "same-origin")).toBe(snapshot);
    expect(currentConnectionSnapshot(snapshot, "configured:a", "configured:b")).toBeNull();
  });

  it("rejects async results from stale backend connections", () => {
    expect(isConnectionResultCurrent("configured:a", "configured:a")).toBe(true);
    expect(isConnectionResultCurrent("configured:b", "configured:a")).toBe(false);
  });
});

describe("App multi-bridge helpers", () => {
  it("uses display preference selection before store fallback", () => {
    expect(resolveInitialSelectedBridgeId("bridge-b", ["bridge-a", "bridge-b"], "bridge-a")).toBe(
      "bridge-b",
    );
    expect(resolveInitialSelectedBridgeId("missing", ["bridge-a", "bridge-b"], "bridge-b")).toBe(
      "bridge-b",
    );
    expect(resolveInitialSelectedBridgeId(null, ["bridge-a", "bridge-b"], "missing")).toBe(
      "bridge-a",
    );
    expect(resolveInitialSelectedBridgeId(null, [], "bridge-a")).toBeNull();
  });

  it("keeps bridge refresh offsets deterministic and inside the fallback interval", () => {
    const first = stableBridgeRefreshOffsetMs("bridge-a");
    expect(stableBridgeRefreshOffsetMs("bridge-a")).toBe(first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(10000);
    expect(stableBridgeRefreshOffsetMs("bridge-b")).toBeLessThan(10000);
  });

  it("sorts scoped agents by bridge display order, workspace, tab, then scoped pane id", () => {
    const workspaceA = workspace("workspace-a", 2);
    const workspaceB = workspace("workspace-b", 1);
    const entries = [
      entry("bridge-b", 1, workspaceA, pane("pane-1", "workspace-a", "tab-2"), 2),
      entry("bridge-a", 0, workspaceA, pane("pane-1", "workspace-a", "tab-2"), 2),
      entry("bridge-a", 0, workspaceB, pane("pane-9", "workspace-b", "tab-1"), 1),
      entry("bridge-a", 0, workspaceA, pane("pane-2", "workspace-a", "tab-1"), 1),
    ];

    expect(
      sortScopedAgentPanes(entries, "workspace").map(
        (item) => `${item.bridgeId}:${item.pane.workspace_id}:${item.tabNumber}:${item.pane.pane_id}`,
      ),
    ).toEqual([
      "bridge-a:workspace-b:1:pane-9",
      "bridge-a:workspace-a:1:pane-2",
      "bridge-a:workspace-a:2:pane-1",
      "bridge-b:workspace-a:2:pane-1",
    ]);
  });
});

function entry(
  bridgeId: string,
  bridgeIndex: number,
  workspaceInfo: WorkspaceInfo,
  paneInfo: PaneInfo,
  tabNumber: number,
) {
  const snapshot: Snapshot = {
    workspaces: [workspaceInfo],
    tabs: [],
    panes: [paneInfo],
    layouts: [],
  };
  return {
    bridgeId,
    bridgeIndex,
    bridgeLabel: bridgeId,
    pane: paneInfo,
    snapshot,
    workspace: workspaceInfo,
    tabNumber,
    tabLabel: `tab-${tabNumber}`,
  };
}

function workspace(workspaceId: string, number: number): WorkspaceInfo {
  return {
    workspace_id: workspaceId,
    number,
    label: workspaceId,
    focused: false,
    pane_count: 1,
    tab_count: 1,
    active_tab_id: "tab-1",
    agent_status: "unknown",
  };
}

function pane(paneId: string, workspaceId: string, tabId: string): PaneInfo {
  return {
    pane_id: paneId,
    terminal_id: `${paneId}-terminal`,
    workspace_id: workspaceId,
    tab_id: tabId,
    focused: false,
    agent_status: "idle",
    revision: 1,
  };
}
