import { describe, expect, it } from "vitest";
import {
  buildVisibleAgentPaneEntries,
  buildVisibleScopedNotes,
  noteDraftStorageKey,
  buildVisibleScopedWorkspaces,
  buildVisibleTabEntries,
  nextVisibleAgentPaneEntry,
  nextVisibleTabEntry,
  resolveInitialSelectedBridgeId,
  shouldBlockDirtyNoteAutosave,
  shouldCollapseHostScope,
  sortScopedAgentPanes,
  stableBridgeRefreshOffsetMs,
} from "./App";
import type { BridgeConnectionView } from "./App";
import type { BridgeRuntime } from "./bridge";
import {
  currentConnectionSnapshot,
  isConnectionResultCurrent,
} from "./connectionState";
import type { AgentStatus, PaneInfo, Snapshot, TabInfo, WorkspaceInfo } from "./types";
import type { PaneNote } from "./notes";

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

  it("does not collapse all-host scope before enabled bridges are loaded", () => {
    expect(shouldCollapseHostScope("all", 1, false)).toBe(false);
    expect(shouldCollapseHostScope("all", 1, true)).toBe(true);
    expect(shouldCollapseHostScope("all", 2, true)).toBe(false);
    expect(shouldCollapseHostScope("selected", 1, true)).toBe(false);
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

  it("builds visible agent entries across hosts for all-host shortcut navigation", () => {
    const bridgeViews = [
      bridgeView(
        "bridge-a",
        bridgeSnapshot("workspace-a", "tab-a", pane("pane-a", "workspace-a", "tab-a")),
      ),
      bridgeView(
        "bridge-b",
        bridgeSnapshot("workspace-b", "tab-b", pane("pane-b", "workspace-b", "tab-b")),
      ),
    ];

    const scopedWorkspaces = buildVisibleScopedWorkspaces(
      bridgeViews,
      "bridge-a",
      "all",
      "space",
      null,
      { "bridge-a": "workspace-a", "bridge-b": "workspace-b" },
    );

    expect(
      buildVisibleAgentPaneEntries(scopedWorkspaces, bridgeViews, "all", "none", "workspace").map(
        (item) => `${item.bridgeId}:${item.pane.pane_id}`,
      ),
    ).toEqual(["bridge-a:pane-a", "bridge-b:pane-b"]);
  });

  it("limits visible shortcut entries to the selected host in selected-host scope", () => {
    const bridgeViews = [
      bridgeView(
        "bridge-a",
        bridgeSnapshot("workspace-a", "tab-a", pane("pane-a", "workspace-a", "tab-a")),
      ),
      bridgeView(
        "bridge-b",
        bridgeSnapshot("workspace-b", "tab-b", pane("pane-b", "workspace-b", "tab-b")),
      ),
    ];

    const scopedWorkspaces = buildVisibleScopedWorkspaces(
      bridgeViews,
      "bridge-b",
      "selected",
      "space",
      null,
      { "bridge-a": "workspace-a", "bridge-b": "workspace-b" },
    );

    expect(
      buildVisibleAgentPaneEntries(scopedWorkspaces, bridgeViews, "selected", "none", "workspace").map(
        (item) => `${item.bridgeId}:${item.pane.pane_id}`,
      ),
    ).toEqual(["bridge-b:pane-b"]);
  });

  it("keeps host/workspace grouped shortcut order aligned with the rendered sidebar", () => {
    const bridgeViews = [
      bridgeView(
        "bridge-a",
        bridgeSnapshot("workspace-a", "tab-a", pane("pane-a", "workspace-a", "tab-a", "idle")),
      ),
      bridgeView(
        "bridge-b",
        bridgeSnapshot("workspace-b", "tab-b", pane("pane-b", "workspace-b", "tab-b", "blocked")),
      ),
    ];

    const scopedWorkspaces = buildVisibleScopedWorkspaces(
      bridgeViews,
      "bridge-a",
      "all",
      "space",
      null,
      { "bridge-a": "workspace-a", "bridge-b": "workspace-b" },
    );

    expect(
      buildVisibleAgentPaneEntries(
        scopedWorkspaces,
        bridgeViews,
        "all",
        "hostWorkspace",
        "attention",
      ).map((item) => `${item.bridgeId}:${item.pane.pane_id}`),
    ).toEqual(["bridge-a:pane-a", "bridge-b:pane-b"]);
  });

  it("allows flat all-host agent shortcuts to follow attention priority across hosts", () => {
    const bridgeViews = [
      bridgeView(
        "bridge-a",
        bridgeSnapshot("workspace-a", "tab-a", pane("pane-a", "workspace-a", "tab-a", "idle")),
      ),
      bridgeView(
        "bridge-b",
        bridgeSnapshot("workspace-b", "tab-b", pane("pane-b", "workspace-b", "tab-b", "blocked")),
      ),
    ];

    const scopedWorkspaces = buildVisibleScopedWorkspaces(
      bridgeViews,
      "bridge-a",
      "all",
      "space",
      null,
      { "bridge-a": "workspace-a", "bridge-b": "workspace-b" },
    );

    expect(
      buildVisibleAgentPaneEntries(scopedWorkspaces, bridgeViews, "all", "none", "attention").map(
        (item) => `${item.bridgeId}:${item.pane.pane_id}`,
      ),
    ).toEqual(["bridge-b:pane-b", "bridge-a:pane-a"]);
  });

  it("builds visible tab entries across hosts for all-host shortcut navigation", () => {
    const bridgeViews = [
      bridgeView(
        "bridge-a",
        bridgeSnapshot("workspace-a", "tab-a", pane("pane-a", "workspace-a", "tab-a")),
      ),
      bridgeView(
        "bridge-b",
        bridgeSnapshot("workspace-b", "tab-b", pane("pane-b", "workspace-b", "tab-b")),
      ),
    ];

    const scopedWorkspaces = buildVisibleScopedWorkspaces(
      bridgeViews,
      "bridge-a",
      "all",
      "space",
      null,
      { "bridge-a": "workspace-a", "bridge-b": "workspace-b" },
    );

    expect(
      buildVisibleTabEntries(scopedWorkspaces, bridgeViews, "all", "none").map(
        (item) => `${item.bridgeId}:${item.tab.tab_id}`,
      ),
    ).toEqual(["bridge-a:tab-a", "bridge-b:tab-b"]);
  });

  it("navigates visible agent entries with fallback and wrap-around", () => {
    const bridgeViews = [
      bridgeView(
        "bridge-a",
        bridgeSnapshot("workspace-a", "tab-a", pane("pane-a", "workspace-a", "tab-a")),
      ),
      bridgeView(
        "bridge-b",
        bridgeSnapshot("workspace-b", "tab-b", pane("pane-b", "workspace-b", "tab-b")),
      ),
    ];
    const scopedWorkspaces = buildVisibleScopedWorkspaces(
      bridgeViews,
      "bridge-a",
      "all",
      "space",
      null,
      { "bridge-a": "workspace-a", "bridge-b": "workspace-b" },
    );
    const entries = buildVisibleAgentPaneEntries(
      scopedWorkspaces,
      bridgeViews,
      "all",
      "none",
      "workspace",
    );

    expect(nextVisibleAgentPaneEntry(entries, -1, 1).pane.pane_id).toBe("pane-a");
    expect(nextVisibleAgentPaneEntry(entries, -1, -1).pane.pane_id).toBe("pane-b");
    expect(nextVisibleAgentPaneEntry(entries, 0, -1).pane.pane_id).toBe("pane-b");
    expect(nextVisibleAgentPaneEntry(entries, 1, 1).pane.pane_id).toBe("pane-a");
  });

  it("navigates visible tab entries with fallback and wrap-around", () => {
    const bridgeViews = [
      bridgeView(
        "bridge-a",
        bridgeSnapshot("workspace-a", "tab-a", pane("pane-a", "workspace-a", "tab-a")),
      ),
      bridgeView(
        "bridge-b",
        bridgeSnapshot("workspace-b", "tab-b", pane("pane-b", "workspace-b", "tab-b")),
      ),
    ];
    const scopedWorkspaces = buildVisibleScopedWorkspaces(
      bridgeViews,
      "bridge-a",
      "all",
      "space",
      null,
      { "bridge-a": "workspace-a", "bridge-b": "workspace-b" },
    );
    const entries = buildVisibleTabEntries(scopedWorkspaces, bridgeViews, "all", "none");

    expect(nextVisibleTabEntry(entries, -1, 1).tab.tab_id).toBe("tab-a");
    expect(nextVisibleTabEntry(entries, -1, -1).tab.tab_id).toBe("tab-b");
    expect(nextVisibleTabEntry(entries, 0, -1).tab.tab_id).toBe("tab-b");
    expect(nextVisibleTabEntry(entries, 1, 1).tab.tab_id).toBe("tab-a");
  });

  it("keeps unresolved notes visible in space scope and filters archived/deleted notes explicitly", () => {
    const bridgeViews = [
      bridgeView(
        "bridge-a",
        bridgeSnapshot("workspace-a", "tab-a", pane("pane-a", "workspace-a", "tab-a")),
      ),
    ];
    const notes = [
      note("active-linked", "workspace-a", "linked"),
      note("unresolved-other-space", "workspace-b", "unresolved"),
      { ...note("archived", "workspace-a", "linked"), archived_at: "500" },
      { ...note("deleted", "workspace-a", "linked"), deleted_at: "600" },
    ];

    expect(
      buildVisibleScopedNotes(
        bridgeViews,
        notesState("bridge-a", "store-1", notes),
        "bridge-a",
        "selected",
        "space",
        bridgeViews[0].snapshot?.workspaces[0] ?? null,
        { "bridge-a": "workspace-a" },
        false,
        false,
      ).map((entry) => entry.note.note_id),
    ).toEqual(["unresolved-other-space", "active-linked"]);

    expect(
      buildVisibleScopedNotes(
        bridgeViews,
        notesState("bridge-a", "store-1", notes),
        "bridge-a",
        "selected",
        "space",
        bridgeViews[0].snapshot?.workspaces[0] ?? null,
        { "bridge-a": "workspace-a" },
        true,
        true,
      ).map((entry) => entry.note.note_id),
    ).toEqual(["deleted", "archived", "unresolved-other-space", "active-linked"]);
  });

  it("dedupes all-host notes when two bridge profiles point at the same store", () => {
    const bridgeViews = [
      bridgeView(
        "bridge-a",
        bridgeSnapshot("workspace-a", "tab-a", pane("pane-a", "workspace-a", "tab-a")),
      ),
      bridgeView(
        "bridge-b",
        bridgeSnapshot("workspace-a", "tab-a", pane("pane-a", "workspace-a", "tab-a")),
      ),
    ];

    expect(
      buildVisibleScopedNotes(
        bridgeViews,
        {
          ...notesState("bridge-a", "shared-store", [note("a", "workspace-a", "linked")]),
          ...notesState("bridge-b", "shared-store", [note("b", "workspace-a", "linked")]),
        },
        "bridge-a",
        "all",
        "all",
        null,
        {},
        false,
        false,
      ).map((entry) => `${entry.bridgeId}:${entry.note.note_id}`),
    ).toEqual(["bridge-a:a"]);
  });

  it("scopes note drafts by bridge connection, store, session, and note id", () => {
    const bridgeViews = [
      bridgeView(
        "bridge-a",
        bridgeSnapshot("workspace-a", "tab-a", pane("pane-a", "workspace-a", "tab-a")),
      ),
    ];
    const [first] = buildVisibleScopedNotes(
      bridgeViews,
      notesState("bridge-a", "store-1", [note("n1", "workspace-a", "linked")]),
      "bridge-a",
      "selected",
      "all",
      null,
      {},
      false,
      false,
    );
    const changedSession = { ...first, sessionKey: "session:other" };

    expect(noteDraftStorageKey(first)).not.toBe(noteDraftStorageKey(changedSession));
    expect(noteDraftStorageKey(first)).toContain("store-1");
    expect(noteDraftStorageKey(first)).toContain("session%3Adefault");
  });

  it("blocks note autosave when the server revision advances under a dirty draft", () => {
    expect(
      shouldBlockDirtyNoteAutosave({
        dirty: true,
        title: "Local title",
        body: "Local draft",
        baseRevision: 1,
        serverTitle: "Remote title",
        serverBody: "Remote edit",
        serverRevision: 2,
      }),
    ).toBe(true);
    expect(
      shouldBlockDirtyNoteAutosave({
        dirty: true,
        title: "Remote title",
        body: "Remote edit",
        baseRevision: 1,
        serverTitle: "Remote title",
        serverBody: "Remote edit",
        serverRevision: 2,
      }),
    ).toBe(false);
    expect(
      shouldBlockDirtyNoteAutosave({
        dirty: true,
        title: "Local title",
        body: "Local draft",
        baseRevision: 1,
        serverTitle: "Original title",
        serverBody: "Original body",
        serverRevision: 1,
      }),
    ).toBe(false);
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
    bridgeColor: "#89b4fa",
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

function pane(
  paneId: string,
  workspaceId: string,
  tabId: string,
  agentStatus: AgentStatus = "idle",
): PaneInfo {
  return {
    pane_id: paneId,
    terminal_id: `${paneId}-terminal`,
    workspace_id: workspaceId,
    tab_id: tabId,
    focused: false,
    agent_status: agentStatus,
    revision: 1,
  };
}

function bridgeView(bridgeId: string, snapshot: Snapshot): BridgeConnectionView {
  return {
    runtime: bridgeRuntime(bridgeId),
    snapshot,
    loadState: "ready",
  };
}

function bridgeRuntime(bridgeId: string): BridgeRuntime {
  return {
    id: bridgeId,
    mode: "configured",
    label: bridgeId,
    color: "#89b4fa",
    backend: null,
    connectionKey: bridgeId,
    resumeToken: 0,
    capabilities: null,
    capabilityState: "ready",
    capabilityError: null,
    canConnect: true,
    httpUrl: (path) => `http://${bridgeId}${path}`,
    wsUrl: (path) => `ws://${bridgeId}${path}`,
  };
}

function bridgeSnapshot(workspaceId: string, tabId: string, paneInfo: PaneInfo): Snapshot {
  const workspaceInfo: WorkspaceInfo = {
    ...workspace(workspaceId, 1),
    active_tab_id: tabId,
    agent_status: paneInfo.agent_status,
  };
  const tabInfo: TabInfo = {
    tab_id: tabId,
    workspace_id: workspaceId,
    number: 1,
    label: tabId,
    focused: false,
    pane_count: 1,
    agent_status: paneInfo.agent_status,
  };
  return {
    workspaces: [workspaceInfo],
    tabs: [tabInfo],
    panes: [paneInfo],
    layouts: [],
  };
}

function notesState(bridgeId: string, storeId: string, notes: PaneNote[]) {
  return {
    [bridgeId]: {
      connectionKey: bridgeId,
      response: {
        store_id: storeId,
        session_key: "session:default",
        notes,
      },
      loadState: "ready" as const,
      error: null,
    },
  };
}

function note(
  noteId: string,
  workspaceId: string,
  linkState: PaneNote["link_state"],
): PaneNote {
  const paneId = `${workspaceId}-pane`;
  return {
    note_id: noteId,
    title: noteId,
    body: "",
    created_at: "100",
    updated_at:
      noteId === "deleted"
        ? "600"
        : noteId === "archived"
          ? "500"
          : noteId === "unresolved-other-space"
            ? "300"
            : "200",
    session_key: "session:default",
    attachment: {
      type: "pane",
      pane_id: paneId,
      workspace_id: workspaceId,
      tab_id: "tab-a",
      terminal_id: `${paneId}-terminal`,
      captured_at: "100",
      context: {},
    },
    attachment_history: [],
    revision: 1,
    link_state: linkState,
    resolved_pane:
      linkState === "linked"
        ? pane(paneId, workspaceId, "tab-a")
        : undefined,
  };
}
