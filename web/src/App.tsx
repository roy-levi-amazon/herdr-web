import {
  ChevronLeft,
  PanelLeft,
  Plus,
  RefreshCw,
  SplitSquareHorizontal,
  SplitSquareVertical,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { commands, createdPaneId, probeSupportedCommands } from "./commands";
import type { LaunchSpec } from "./commands";
import { LaunchDialog } from "./LaunchDialog";
import { resolveLaunchSpec } from "./launch";
import type { LaunchTarget } from "./launch";
import { ActionMenu, ConfirmDialog, RenameDialog, useLongPress } from "./overlays";
import type { MenuItem } from "./overlays";
import { TerminalView } from "./TerminalView";
import {
  aggregateStatus,
  canClearTabName,
  canClearWorkspaceName,
  choosePaneForTab,
  choosePaneForWorkspace,
  chooseSelectedPane,
  countAttention,
  displayTabLabel,
  isAttention,
  isLoud,
  paneMeta,
  paneTitle,
  sortPanesForTab,
  sortTabsForWorkspace,
  spaceSubtitle,
  statusLabel,
} from "./state";
import type { AgentStatus, PaneInfo, Snapshot, WorkspaceInfo } from "./types";

type LoadState = "loading" | "ready" | "error";
type Scope = "space" | "all";
type SidebarView = "agents" | "tabs";
type AgentSort = "attention" | "status" | "workspace";
type AgentGroup = "none" | "workspace";
type MenuKind = "space" | "tab" | "pane";
type MenuState = {
  kind: MenuKind;
  id: string;
  label: string;
  x: number;
  y: number;
  clearable?: boolean;
};
type DialogState = {
  mode: "rename" | "close";
  kind: MenuKind;
  id: string;
  label: string;
  clearable?: boolean;
};
type DisplayPrefs = {
  scope: Scope;
  sidebarView: SidebarView;
  agentSort: AgentSort;
  agentGroup: AgentGroup;
  sidebarWidth: number;
  sidebarOpen: boolean;
  activeSpaceId: string | null;
  selectedPaneId: string | null;
};

const NARROW_QUERY = "(max-width: 1024px), (hover: none) and (pointer: coarse)";
const DISPLAY_PREFS_KEY = "herdr.mobileWeb.displayPrefs.v1";
const MOBILE_SIDEBAR_HISTORY_KEY = "herdrWebMobileSidebar";
const MOBILE_DETAIL_HISTORY_KEY = "herdrWebMobileDetail";
const DEFAULT_SIDEBAR_WIDTH = 320;
const MIN_SIDEBAR_WIDTH = 260;
const MAX_SIDEBAR_WIDTH = 560;
function readDisplayPrefs(): DisplayPrefs {
  const fallback: DisplayPrefs = {
    scope: "space",
    sidebarView: "agents",
    agentSort: "attention",
    agentGroup: "none",
    sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    sidebarOpen: true,
    activeSpaceId: null,
    selectedPaneId: null,
  };
  try {
    const raw = window.localStorage.getItem(DISPLAY_PREFS_KEY);
    if (!raw) {
      return fallback;
    }
    const parsed = JSON.parse(raw) as Partial<DisplayPrefs>;
    return {
      scope: parsed.scope === "all" || parsed.scope === "space" ? parsed.scope : fallback.scope,
      sidebarView:
        parsed.sidebarView === "agents" || parsed.sidebarView === "tabs"
          ? parsed.sidebarView
          : fallback.sidebarView,
      agentSort:
        parsed.agentSort === "attention" ||
        parsed.agentSort === "status" ||
        parsed.agentSort === "workspace"
          ? parsed.agentSort
          : fallback.agentSort,
      agentGroup:
        parsed.agentGroup === "none" || parsed.agentGroup === "workspace"
          ? parsed.agentGroup
          : fallback.agentGroup,
      sidebarWidth:
        typeof parsed.sidebarWidth === "number"
          ? clampSidebarWidth(parsed.sidebarWidth)
          : fallback.sidebarWidth,
      sidebarOpen:
        typeof parsed.sidebarOpen === "boolean" ? parsed.sidebarOpen : fallback.sidebarOpen,
      activeSpaceId:
        typeof parsed.activeSpaceId === "string" ? parsed.activeSpaceId : fallback.activeSpaceId,
      selectedPaneId:
        typeof parsed.selectedPaneId === "string" ? parsed.selectedPaneId : fallback.selectedPaneId,
    };
  } catch {
    return fallback;
  }
}

function clampSidebarWidth(width: number) {
  const viewportMax =
    typeof window === "undefined"
      ? MAX_SIDEBAR_WIDTH
      : Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, window.innerWidth - 360));
  return Math.round(Math.min(Math.max(width, MIN_SIDEBAR_WIDTH), viewportMax));
}

function writeDisplayPrefs(prefs: DisplayPrefs) {
  try {
    window.localStorage.setItem(DISPLAY_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage can be unavailable in private or locked-down browser contexts.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMobileDetailHistoryState(value: unknown) {
  return isRecord(value) && value[MOBILE_DETAIL_HISTORY_KEY] === true;
}

function isMobileSidebarHistoryState(value: unknown) {
  return isRecord(value) && value[MOBILE_SIDEBAR_HISTORY_KEY] === true;
}

function withMobileSidebarHistoryState(value: unknown) {
  const next = { ...(isRecord(value) ? value : {}) };
  delete next[MOBILE_DETAIL_HISTORY_KEY];
  return {
    ...next,
    [MOBILE_SIDEBAR_HISTORY_KEY]: true,
  };
}

function withMobileDetailHistoryState(value: unknown) {
  return {
    ...(isRecord(value) ? value : {}),
    [MOBILE_SIDEBAR_HISTORY_KEY]: true,
    [MOBILE_DETAIL_HISTORY_KEY]: true,
  };
}

function stripMobileHistoryState(value: unknown) {
  if (!isRecord(value)) {
    return {};
  }
  const next = { ...value };
  delete next[MOBILE_SIDEBAR_HISTORY_KEY];
  delete next[MOBILE_DETAIL_HISTORY_KEY];
  return next;
}

export function App() {
  const initialPrefs = useMemo(readDisplayPrefs, []);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(initialPrefs.selectedPaneId);
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(initialPrefs.activeSpaceId);
  const [scope, setScope] = useState<Scope>(initialPrefs.scope);
  const [sidebarView, setSidebarView] = useState<SidebarView>(initialPrefs.sidebarView);
  const [agentSort, setAgentSort] = useState<AgentSort>(initialPrefs.agentSort);
  const [agentGroup, setAgentGroup] = useState<AgentGroup>(initialPrefs.agentGroup);
  const [sidebarWidth, setSidebarWidth] = useState(initialPrefs.sidebarWidth);
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [sidebarOpen, setSidebarOpen] = useState(initialPrefs.sidebarOpen);
  const [showDetail, setShowDetail] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [launchTarget, setLaunchTarget] = useState<LaunchTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [splitSupported, setSplitSupported] = useState(false);
  const [paneMoveSupported, setPaneMoveSupported] = useState(false);
  const [refitToken, setRefitToken] = useState(0);
  const isNarrow = useIsNarrow();
  const snapshotRef = useRef<Snapshot | null>(null);
  const isNarrowRef = useRef(isNarrow);
  const showDetailRef = useRef(showDetail);
  const mobileSidebarHistoryRef = useRef(false);
  const mobileDetailHistoryRef = useRef(false);

  const resolvedPaneId = chooseSelectedPane(snapshot, selectedPaneId);

  const ensureMobileSidebarHistory = () => {
    if (!isNarrowRef.current || isMobileDetailHistoryState(window.history.state)) {
      return;
    }
    if (isMobileSidebarHistoryState(window.history.state)) {
      mobileSidebarHistoryRef.current = true;
      return;
    }
    window.history.pushState(
      withMobileSidebarHistoryState(window.history.state),
      "",
      window.location.href,
    );
    mobileSidebarHistoryRef.current = true;
  };

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    isNarrowRef.current = isNarrow;
    if (isNarrow) {
      ensureMobileSidebarHistory();
      return;
    }
    mobileSidebarHistoryRef.current = false;
    mobileDetailHistoryRef.current = false;
    if (
      isMobileSidebarHistoryState(window.history.state) ||
      isMobileDetailHistoryState(window.history.state)
    ) {
      window.history.replaceState(stripMobileHistoryState(window.history.state), "", window.location.href);
    }
  }, [isNarrow]);

  useEffect(() => {
    showDetailRef.current = showDetail;
  }, [showDetail]);

  useEffect(() => {
    setSelectedPaneId((current) => chooseSelectedPane(snapshot, current));
  }, [snapshot]);

  useEffect(() => {
    writeDisplayPrefs({
      scope,
      sidebarView,
      agentSort,
      agentGroup,
      sidebarWidth,
      sidebarOpen,
      activeSpaceId,
      selectedPaneId,
    });
  }, [
    scope,
    sidebarView,
    agentSort,
    agentGroup,
    sidebarWidth,
    sidebarOpen,
    activeSpaceId,
    selectedPaneId,
  ]);

  useEffect(() => {
    setSidebarWidth((width) => clampSidebarWidth(width));
  }, [isNarrow]);

  useEffect(() => {
    if (!resizingSidebar) {
      return;
    }
    const onPointerMove = (event: PointerEvent) => {
      setSidebarWidth(clampSidebarWidth(event.clientX));
    };
    const onPointerUp = () => setResizingSidebar(false);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
    window.addEventListener("pointercancel", onPointerUp, { once: true });
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [resizingSidebar]);

  useEffect(() => {
    let disposed = false;
    const refresh = () => refreshSnapshot(setSnapshot, setLoadState, () => disposed);
    void refresh();
    const interval = window.setInterval(refresh, 10000);
    const events = openEventsSocket("/ws/events", () => void refresh());
    const uiEvents = openEventsSocket("/ws/ui-events", (event) => {
      const paneId = selectionPaneId(event);
      if (paneId) {
        setSelectedPaneId(paneId);
        const pane = snapshotRef.current?.panes.find((item) => item.pane_id === paneId);
        if (pane) {
          setActiveSpaceId(pane.workspace_id);
        }
      }
      void refresh();
    });
    return () => {
      disposed = true;
      events?.close();
      uiEvents?.close();
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!error) {
      return;
    }
    const timer = window.setTimeout(() => setError(null), 4500);
    return () => window.clearTimeout(timer);
  }, [error]);

  // Feature-detect bridge-gated commands so controls only appear when they work.
  useEffect(() => {
    let cancelled = false;
    void probeSupportedCommands().then((supportedCommands) => {
      if (!cancelled) {
        setSplitSupported(supportedCommands.has("pane.split"));
        setPaneMoveSupported(supportedCommands.has("pane.move"));
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      if (!isNarrowRef.current) {
        return;
      }
      if (isMobileDetailHistoryState(event.state)) {
        mobileSidebarHistoryRef.current = true;
        mobileDetailHistoryRef.current = true;
        if (!showDetailRef.current) {
          showDetailRef.current = true;
          setShowDetail(true);
        }
        return;
      }
      if (mobileDetailHistoryRef.current || showDetailRef.current) {
        mobileDetailHistoryRef.current = false;
        mobileSidebarHistoryRef.current = isMobileSidebarHistoryState(event.state);
        showDetailRef.current = false;
        setShowDetail(false);
        return;
      }
      if (isMobileSidebarHistoryState(event.state)) {
        mobileSidebarHistoryRef.current = true;
        return;
      }
      mobileSidebarHistoryRef.current = false;
      window.setTimeout(ensureMobileSidebarHistory, 0);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const selectedPane = useMemo(
    () => snapshot?.panes.find((pane) => pane.pane_id === resolvedPaneId) ?? null,
    [snapshot, resolvedPaneId],
  );
  const selectedPaneMenuPress = useLongPress((x, y) => {
    if (selectedPane) {
      setMenu({
        kind: "pane",
        id: selectedPane.pane_id,
        label: paneTitle(selectedPane),
        x,
        y,
      });
    }
  });

  useEffect(() => {
    if (isNarrow) {
      window.scrollTo(0, 0);
      document.documentElement.scrollLeft = 0;
      document.body.scrollLeft = 0;
    }
  }, [isNarrow, showDetail]);

  const activeSpace = useMemo(() => {
    if (!snapshot || snapshot.workspaces.length === 0) {
      return null;
    }
    return (
      (activeSpaceId &&
        snapshot.workspaces.find((workspace) => workspace.workspace_id === activeSpaceId)) ||
      (selectedPane &&
        snapshot.workspaces.find(
          (workspace) => workspace.workspace_id === selectedPane.workspace_id,
        )) ||
      snapshot.workspaces.find((workspace) => workspace.focused) ||
      snapshot.workspaces[0] ||
      null
    );
  }, [snapshot, activeSpaceId, selectedPane]);

  // The active tab's split layout, normalized to fractions of the tab area so we
  // can reproduce the herdr split geometry in the browser. Null when the tab has
  // a single pane (or is zoomed) — then we render one terminal full-screen.
  const splitCells = useMemo<{ pane: PaneInfo; style: CSSProperties }[] | null>(() => {
    if (!snapshot || !selectedPane) {
      return null;
    }
    const layout = snapshot.layouts.find((item) =>
      item.panes.some((pane) => pane.pane_id === selectedPane.pane_id),
    );
    if (!layout || layout.zoomed || layout.panes.length < 2) {
      return null;
    }
    const { area } = layout;
    if (area.width <= 0 || area.height <= 0) {
      return null;
    }
    const cells: { pane: PaneInfo; style: CSSProperties }[] = [];
    for (const lp of layout.panes) {
      const pane = snapshot.panes.find((item) => item.pane_id === lp.pane_id);
      if (!pane) {
        continue;
      }
      cells.push({
        pane,
        style: {
          left: `${((lp.rect.x - area.x) / area.width) * 100}%`,
          top: `${((lp.rect.y - area.y) / area.height) * 100}%`,
          width: `${(lp.rect.width / area.width) * 100}%`,
          height: `${(lp.rect.height / area.height) * 100}%`,
        },
      });
    }
    return cells.length > 1 ? cells : null;
  }, [snapshot, selectedPane]);

  const showSplit = !isNarrow && splitCells !== null;

  // Mirror browser navigation to the herdr session so `active_tab_id` tracks
  // what we're viewing here. `tab.focus` also activates the tab's workspace, so
  // a workspace-only focus is just the fallback for a space with no panes yet.
  const pushFocus = (tabId?: string, workspaceId?: string) => {
    if (tabId) {
      void commands.focusTab(tabId).catch(() => {});
    } else if (workspaceId) {
      void commands.focusWorkspace(workspaceId).catch(() => {});
    }
  };

  const openMobileDetail = () => {
    ensureMobileSidebarHistory();
    showDetailRef.current = true;
    setShowDetail(true);
    if (!mobileDetailHistoryRef.current) {
      window.history.pushState(
        withMobileDetailHistoryState(window.history.state),
        "",
        window.location.href,
      );
      mobileDetailHistoryRef.current = true;
    }
  };

  const closeMobileDetail = () => {
    if (mobileDetailHistoryRef.current && isMobileDetailHistoryState(window.history.state)) {
      window.history.back();
      return;
    }
    mobileDetailHistoryRef.current = false;
    showDetailRef.current = false;
    setShowDetail(false);
  };

  const openPane = (pane: PaneInfo) => {
    setSelectedPaneId(pane.pane_id);
    setActiveSpaceId(pane.workspace_id);
    void syncSelectedPane(pane.pane_id).catch(() => {});
    pushFocus(pane.tab_id, pane.workspace_id);
    if (isNarrow) {
      openMobileDetail();
    }
  };

  const selectSpace = (workspaceId: string) => {
    setActiveSpaceId(workspaceId);
    if (!isNarrow && snapshot) {
      const paneId = choosePaneForWorkspace(snapshot, workspaceId);
      if (paneId) {
        setSelectedPaneId(paneId);
        const pane = snapshot.panes.find((item) => item.pane_id === paneId);
        void syncSelectedPane(paneId).catch(() => {});
        pushFocus(pane?.tab_id, workspaceId);
        return;
      }
      setSelectedPaneId(null);
    }
    pushFocus(undefined, workspaceId);
  };

  const selectTab = (tabId: string) => {
    if (!snapshot) {
      return;
    }
    const paneId = choosePaneForTab(snapshot, tabId);
    if (paneId) {
      const pane = snapshot.panes.find((item) => item.pane_id === paneId);
      if (pane) {
        openPane(pane);
      }
    }
  };

  const refreshNow = () => {
    setLoadState("loading");
    void fetchSnapshot()
      .then((next) => {
        setSnapshot(next);
        setLoadState("ready");
      })
      .catch(() => setLoadState("error"));
  };

  async function exec(action: () => Promise<{ [key: string]: unknown }>, selectCreated = false) {
    setBusy(true);
    try {
      const result = await action();
      const next = await fetchSnapshot();
      setSnapshot(next);
      setLoadState("ready");
      if (selectCreated) {
        const paneId = createdPaneId(result);
        const created = paneId ? next.panes.find((pane) => pane.pane_id === paneId) : undefined;
        if (created) {
          setSelectedPaneId(created.pane_id);
          setActiveSpaceId(created.workspace_id);
          void syncSelectedPane(created.pane_id).catch(() => {});
          if (isNarrow) {
            openMobileDetail();
          }
        }
      }
      setError(null);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Command failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const onMenuPick = (key: string) => {
    if (!menu) {
      return;
    }
    const { kind, id, label, clearable } = menu;
    setMenu(null);
    if (key === "rename") {
      setDialog({ mode: "rename", kind, id, label, clearable });
    } else if (key === "close") {
      setDialog({ mode: "close", kind, id, label });
    } else if (key === "newtab") {
      setActiveSpaceId(id);
      setLaunchTarget({ mode: "tab", workspaceId: id });
    } else if (key === "move_new_tab" && kind === "pane") {
      const pane = snapshotRef.current?.panes.find((item) => item.pane_id === id);
      if (!pane) {
        setError("Pane not found");
        return;
      }
      void exec(() => commands.movePaneToNewTab(id, pane.workspace_id, label), true);
    } else if (key === "move_new_space" && kind === "pane") {
      void exec(() => commands.movePaneToNewWorkspace(id, label), true);
    }
  };

  const submitRename = (value: string) => {
    if (!dialog) {
      return;
    }
    const { kind, id } = dialog;
    const action =
      kind === "space"
        ? () => commands.renameWorkspace(id, value)
        : kind === "tab"
          ? () => commands.renameTab(id, value)
          : () => commands.renamePane(id, value);
    void exec(action).then((ok) => ok && setDialog(null));
  };

  const clearRename = () => {
    if (!dialog || dialog.kind === "pane") {
      return;
    }
    const { kind, id } = dialog;
    const action =
      kind === "space"
        ? () => commands.renameWorkspace(id, null)
        : () => commands.renameTab(id, null);
    void exec(action).then((ok) => ok && setDialog(null));
  };

  const confirmClose = () => {
    if (!dialog) {
      return;
    }
    const { kind, id } = dialog;
    const action =
      kind === "space"
        ? () => commands.closeWorkspace(id)
        : kind === "tab"
          ? () => commands.closeTab(id)
          : () => commands.closePane(id);
    void exec(action).then((ok) => ok && setDialog(null));
  };

  const submitLaunch = (spec: LaunchSpec) => {
    if (!launchTarget) {
      return;
    }
    const resolvedSpec = resolveLaunchSpec(spec, snapshot?.panes ?? []);
    const action =
      launchTarget.mode === "tab"
        ? () => commands.createLaunchTab(launchTarget.workspaceId, resolvedSpec)
        : () =>
            commands.splitLaunchPane(
              launchTarget.pane.pane_id,
              launchTarget.pane.tab_id,
              launchTarget.direction,
              resolvedSpec,
            );
    void exec(action, true).then((ok) => ok && setLaunchTarget(null));
  };

  const renderTerminal = !isNarrow || showDetail;
  const appStyle = { "--sidebar-w": `${sidebarWidth}px` } as CSSProperties &
    Record<"--sidebar-w", string>;

  return (
    <div
      className="app"
      style={appStyle}
      data-sidebar={sidebarOpen ? "open" : "closed"}
      data-resizing-sidebar={resizingSidebar ? "true" : "false"}
      data-mobile={isNarrow ? "true" : "false"}
      data-detail={isNarrow && showDetail ? "true" : "false"}
    >
      <aside className="sidebar" aria-label="Switcher">
        <Switcher
          snapshot={snapshot}
          loadState={loadState}
          scope={scope}
          sidebarView={sidebarView}
          agentSort={agentSort}
          agentGroup={agentGroup}
          activeSpace={activeSpace}
          selectedPane={selectedPane}
          onScope={setScope}
          onSidebarView={setSidebarView}
          onAgentSort={setAgentSort}
          onAgentGroup={setAgentGroup}
          onSelectSpace={selectSpace}
          onSelectTab={selectTab}
          onSelectPane={openPane}
          onRefresh={refreshNow}
          onCreateSpace={() => void exec(() => commands.createWorkspace(), true)}
          onCreateTab={(workspaceId) => setLaunchTarget({ mode: "tab", workspaceId })}
          onMenu={(kind, id, label, x, y, clearable) =>
            setMenu({ kind, id, label, x, y, clearable })
          }
        />
        <div
          className="sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          onPointerDown={(event) => {
            if (isNarrow || !sidebarOpen) {
              return;
            }
            event.preventDefault();
            setResizingSidebar(true);
          }}
          onKeyDown={(event) => {
            if (isNarrow) {
              return;
            }
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              const step = event.shiftKey ? 32 : 12;
              setSidebarWidth((width) =>
                clampSidebarWidth(width + (event.key === "ArrowRight" ? step : -step)),
              );
            } else if (event.key === "Home") {
              event.preventDefault();
              setSidebarWidth(MIN_SIDEBAR_WIDTH);
            } else if (event.key === "End") {
              event.preventDefault();
              setSidebarWidth(MAX_SIDEBAR_WIDTH);
            }
          }}
        />
      </aside>

      <section className="stage" aria-label="Terminal">
        <TabBar
          snapshot={snapshot}
          activeSpace={activeSpace}
          selectedPane={selectedPane}
          onSelectTab={selectTab}
          onCreateTab={(workspaceId) => setLaunchTarget({ mode: "tab", workspaceId })}
          onMenu={(kind, id, label, x, y, clearable) =>
            setMenu({ kind, id, label, x, y, clearable })
          }
        />
        <header className="stage-bar">
          <button
            className="icon-btn"
            type="button"
            aria-label={isNarrow ? "Back to switcher" : "Toggle sidebar"}
            title={isNarrow ? "Back" : "Toggle sidebar"}
            onClick={() => (isNarrow ? closeMobileDetail() : setSidebarOpen((open) => !open))}
          >
            {isNarrow ? <ChevronLeft size={20} /> : <PanelLeft size={18} />}
          </button>
          <div className="stage-id" {...selectedPaneMenuPress}>
            <span className="stage-title">{selectedPane ? paneTitle(selectedPane) : "herdr-web"}</span>
            <span className="stage-sub mono">
              {stageBreadcrumb(snapshot, selectedPane, loadState)}
            </span>
          </div>
          {splitSupported && selectedPane && !isNarrow ? (
            <>
              <button
                className="icon-btn"
                type="button"
                aria-label="Split right"
                title="Split right"
                disabled={busy}
                onClick={() =>
                  setLaunchTarget({ mode: "split", pane: selectedPane, direction: "right" })
                }
              >
                <SplitSquareHorizontal size={18} />
              </button>
              <button
                className="icon-btn"
                type="button"
                aria-label="Split down"
                title="Split down"
                disabled={busy}
                onClick={() =>
                  setLaunchTarget({ mode: "split", pane: selectedPane, direction: "down" })
                }
              >
                <SplitSquareVertical size={18} />
              </button>
            </>
          ) : null}
          {selectedPane ? (
            <button
              className="icon-btn"
              type="button"
              aria-label="Refit terminal"
              title="Refit terminal"
              onClick={() => setRefitToken((token) => token + 1)}
            >
              <RefreshCw size={18} />
            </button>
          ) : null}
          {selectedPane ? <StatusBadge status={selectedPane.agent_status} /> : null}
        </header>
        {showSplit && splitCells ? (
          <SplitGrid
            cells={splitCells}
            selectedPaneId={selectedPane?.pane_id ?? null}
            onSelectPane={openPane}
            refitToken={refitToken}
          />
        ) : renderTerminal ? (
          <TerminalView
            pane={selectedPane}
            autoFocus={!isNarrow}
            scrollSensitivity={isNarrow ? 2 : 0.4}
            mobileControls={isNarrow}
            refitToken={refitToken}
          />
        ) : (
          <div className="terminal-stage" aria-hidden="true" />
        )}
      </section>

      {menu ? (
        <ActionMenu
          x={menu.x}
          y={menu.y}
          title={menu.label}
          items={menuItems(menu.kind, paneMoveSupported)}
          onPick={onMenuPick}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {dialog?.mode === "rename" ? (
        <RenameDialog
          title={`Rename ${dialog.kind}`}
          initial={dialog.label}
          placeholder={dialog.label}
          busy={busy}
          onCancel={() => setDialog(null)}
          onSubmit={submitRename}
          onClear={dialog.clearable ? clearRename : undefined}
        />
      ) : null}

      {dialog?.mode === "close" ? (
        <ConfirmDialog
          title={closeCopy(dialog.kind).title}
          message={closeCopy(dialog.kind).message}
          confirmLabel={closeCopy(dialog.kind).confirm}
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={confirmClose}
        />
      ) : null}

      {launchTarget ? (
        <LaunchDialog
          target={launchTarget}
          busy={busy}
          onCancel={() => setLaunchTarget(null)}
          onSubmit={submitLaunch}
        />
      ) : null}

      {error ? (
        <div className="toast" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function SplitGrid({
  cells,
  selectedPaneId,
  onSelectPane,
  refitToken,
}: {
  cells: { pane: PaneInfo; style: CSSProperties }[];
  selectedPaneId: string | null;
  onSelectPane: (pane: PaneInfo) => void;
  refitToken: number;
}) {
  return (
    <div className="pane-grid" aria-label="Split panes">
      {cells.map(({ pane, style }) => (
        <div
          key={pane.pane_id}
          className="pane-cell"
          data-selected={pane.pane_id === selectedPaneId}
          style={style}
          onPointerDown={() => onSelectPane(pane)}
        >
          <TerminalView
            pane={pane}
            autoFocus={pane.pane_id === selectedPaneId}
            scrollSensitivity={0.4}
            refitToken={pane.pane_id === selectedPaneId ? refitToken : 0}
          />
        </div>
      ))}
    </div>
  );
}

function TabBar({
  snapshot,
  activeSpace,
  selectedPane,
  onSelectTab,
  onCreateTab,
  onMenu,
}: {
  snapshot: Snapshot | null;
  activeSpace: WorkspaceInfo | null;
  selectedPane: PaneInfo | null;
  onSelectTab: (tabId: string) => void;
  onCreateTab: (workspaceId: string) => void;
  onMenu: (
    kind: MenuKind,
    id: string,
    label: string,
    x: number,
    y: number,
    clearable?: boolean,
  ) => void;
}) {
  if (!snapshot || !activeSpace) {
    return null;
  }
  const tabs = sortTabsForWorkspace(snapshot.tabs, activeSpace.workspace_id);
  if (tabs.length === 0) {
    return null;
  }
  const activeTabId =
    selectedPane && selectedPane.workspace_id === activeSpace.workspace_id
      ? selectedPane.tab_id
      : activeSpace.active_tab_id;
  return (
    <div className="tabbar" role="tablist" aria-label="Tabs">
      {tabs.map((tab) => {
        const label = displayTabLabel(tab, snapshot.panes);
        return (
          <button
            key={tab.tab_id}
            type="button"
            className="tabbar-tab"
            role="tab"
            aria-selected={tab.tab_id === activeTabId}
            data-active={tab.tab_id === activeTabId}
            onClick={() => onSelectTab(tab.tab_id)}
            onContextMenu={(event) => {
              event.preventDefault();
              onMenu("tab", tab.tab_id, label, event.clientX, event.clientY, canClearTabName(tab));
            }}
          >
            <span className="dot" data-status={tab.agent_status} />
            <span className="tabbar-name">{label}</span>
          </button>
        );
      })}
      <button
        className="tabbar-add"
        type="button"
        aria-label="New tab"
        title="New tab"
        onClick={() => onCreateTab(activeSpace.workspace_id)}
      >
        <Plus size={14} />
      </button>
    </div>
  );
}

function Switcher({
  snapshot,
  loadState,
  scope,
  sidebarView,
  agentSort,
  agentGroup,
  activeSpace,
  selectedPane,
  onScope,
  onSidebarView,
  onAgentSort,
  onAgentGroup,
  onSelectSpace,
  onSelectTab,
  onSelectPane,
  onRefresh,
  onCreateSpace,
  onCreateTab,
  onMenu,
}: {
  snapshot: Snapshot | null;
  loadState: LoadState;
  scope: Scope;
  sidebarView: SidebarView;
  agentSort: AgentSort;
  agentGroup: AgentGroup;
  activeSpace: WorkspaceInfo | null;
  selectedPane: PaneInfo | null;
  onScope: (scope: Scope) => void;
  onSidebarView: (view: SidebarView) => void;
  onAgentSort: (sort: AgentSort) => void;
  onAgentGroup: (group: AgentGroup) => void;
  onSelectSpace: (workspaceId: string) => void;
  onSelectTab: (tabId: string) => void;
  onSelectPane: (pane: PaneInfo) => void;
  onRefresh: () => void;
  onCreateSpace: () => void;
  onCreateTab: (workspaceId: string) => void;
  onMenu: (
    kind: MenuKind,
    id: string,
    label: string,
    x: number,
    y: number,
    clearable?: boolean,
  ) => void;
}) {
  const panes = snapshot?.panes ?? [];
  const roll = aggregateStatus(panes);
  const headerSummary = summary(panes);

  const agentPanes = useMemo(() => {
    if (!snapshot) {
      return [];
    }
    const scoped =
      scope === "all"
        ? snapshot.panes
        : snapshot.panes.filter((pane) => pane.workspace_id === activeSpace?.workspace_id);
    return sortAgentPanes(scoped.filter(isAgentPane), agentSort, snapshot);
  }, [snapshot, scope, activeSpace?.workspace_id, agentSort]);

  const agentGroups = useMemo(() => {
    if (!snapshot || agentGroup !== "workspace") {
      return [];
    }
    const paneBuckets = new Map<string, PaneInfo[]>();
    for (const pane of agentPanes) {
      const panesForWorkspace = paneBuckets.get(pane.workspace_id) ?? [];
      panesForWorkspace.push(pane);
      paneBuckets.set(pane.workspace_id, panesForWorkspace);
    }
    return snapshot.workspaces
      .filter((workspace) => paneBuckets.has(workspace.workspace_id))
      .map((workspace) => ({
        workspace,
        panes: paneBuckets.get(workspace.workspace_id) ?? [],
      }));
  }, [snapshot, agentGroup, agentPanes]);

  const spaceGroups = useMemo(() => {
    if (!snapshot) {
      return [];
    }
    const spaces =
      scope === "all"
        ? snapshot.workspaces
        : snapshot.workspaces.filter(
            (workspace) => workspace.workspace_id === activeSpace?.workspace_id,
          );
    return spaces.map((workspace) => ({
      workspace,
      tabs: sortTabsForWorkspace(snapshot.tabs, workspace.workspace_id)
        .map((tab) => ({ tab, panes: sortPanesForTab(snapshot.panes, tab.tab_id) }))
        .filter((group) => group.panes.length > 0),
    }));
  }, [snapshot, scope, activeSpace?.workspace_id]);

  let agentPaneIndex = 0;
  let paneIndex = 0;

  return (
    <>
      <header className="sb-head">
        <div className="brand">
            <span className="brand-mark">
              <span className="brand-dot dot" data-status={roll} />
              herdr-web
            </span>
          {headerSummary ? (
            <span className="brand-sub">
              <b>{headerSummary}</b>
            </span>
          ) : null}
        </div>
        <button
          className="icon-btn"
          type="button"
          aria-label="Refresh"
          title="Refresh"
          data-spin={loadState === "loading" ? "" : undefined}
          onClick={onRefresh}
        >
          <RefreshCw size={16} />
        </button>
      </header>

      <div className="sidebar-mode" role="group" aria-label="Sidebar view">
        <button
          type="button"
          data-on={sidebarView === "agents"}
          aria-pressed={sidebarView === "agents"}
          onClick={() => onSidebarView("agents")}
        >
          Agents
        </button>
        <button
          type="button"
          data-on={sidebarView === "tabs"}
          aria-pressed={sidebarView === "tabs"}
          onClick={() => onSidebarView("tabs")}
        >
          Tabs
        </button>
      </div>
      <div className="sidebar-scope" role="group" aria-label="Sidebar scope">
        <button
          type="button"
          data-on={scope === "space"}
          aria-pressed={scope === "space"}
          onClick={() => onScope("space")}
        >
          space
        </button>
        <button
          type="button"
          data-on={scope === "all"}
          aria-pressed={scope === "all"}
          onClick={() => onScope("all")}
        >
          all
        </button>
      </div>

      <div className="list">
        {!snapshot ? (
          <div className="empty">
            <strong>{loadState === "error" ? "Bridge unavailable" : "Connecting…"}</strong>
            <span>{loadState === "error" ? "Could not reach the herdr bridge." : ""}</span>
          </div>
        ) : (
          <>
            {/* SPACES ---------------------------------------------------- */}
            {scope === "space" ? (
            <section className="sec">
              <div className="sec-head">
                <span className="sec-label">spaces</span>
                <span className="sec-rule" />
                <span className="sec-count mono">{snapshot.workspaces.length}</span>
                <button
                  className="sec-add"
                  type="button"
                  aria-label="New space"
                  title="New space"
                  onClick={onCreateSpace}
                >
                  <Plus size={14} />
                </button>
              </div>
              {snapshot.workspaces.length === 0 ? (
                <div className="empty">
                  <strong>No spaces yet</strong>
                  <span>Tap + to create one.</span>
                </div>
              ) : (
                snapshot.workspaces.map((workspace, index) => (
                  <SpaceRow
                    key={workspace.workspace_id}
                    index={index}
                    workspace={workspace}
                    active={workspace.workspace_id === activeSpace?.workspace_id}
                    attention={countAttention(
                      snapshot.panes.filter((pane) => pane.workspace_id === workspace.workspace_id),
                    )}
                    onSelect={() => onSelectSpace(workspace.workspace_id)}
                    onMenu={(x, y) =>
                      onMenu(
                        "space",
                        workspace.workspace_id,
                        workspace.label,
                        x,
                        y,
                        canClearWorkspaceName(workspace, snapshot.panes),
                      )
                    }
                  />
                ))
              )}
            </section>
            ) : null}

            {/* PANES ----------------------------------------------------- */}
            {snapshot.workspaces.length > 0 ? (
            <section className="sec">
              <div className="sec-head">
                <span className="sec-label">
                  {sidebarView === "agents"
                    ? scope === "all"
                      ? "all agents"
                      : "space agents"
                    : scope === "all"
                      ? "all tabs"
                      : (activeSpace?.label ?? "tabs")}
                </span>
                <span className="sec-rule" />
                {sidebarView === "agents" ? (
                  <div className="agent-list-controls">
                    <label className="sort-control">
                      <span>sort</span>
                      <select
                        value={agentSort}
                        onChange={(event) => onAgentSort(event.currentTarget.value as AgentSort)}
                      >
                        <option value="attention">attention</option>
                        <option value="status">status</option>
                        <option value="workspace">workspace</option>
                      </select>
                    </label>
                    <label className="sort-control">
                      <span>group</span>
                      <select
                        value={agentGroup}
                        onChange={(event) => onAgentGroup(event.currentTarget.value as AgentGroup)}
                      >
                        <option value="none">none</option>
                        <option value="workspace">workspace</option>
                      </select>
                    </label>
                  </div>
                ) : scope === "space" && activeSpace ? (
                  <button
                    className="sec-add"
                    type="button"
                    aria-label="New tab"
                    title="New tab"
                    onClick={() => onCreateTab(activeSpace.workspace_id)}
                  >
                    <Plus size={14} />
                  </button>
                ) : null}
              </div>

              {sidebarView === "agents" ? (
                agentPanes.length === 0 ? (
                  <div className="empty">
                    <strong>No detected agents</strong>
                    <span>Open the Tabs view for plain panes.</span>
                  </div>
                ) : agentGroup === "workspace" ? (
                  agentGroups.map((group) => (
                    <Fragment key={group.workspace.workspace_id}>
                      <div className="grp-space">
                        <span className="dot" data-status={group.workspace.agent_status} />
                        <span className="grp-space-name">{group.workspace.label}</span>
                        <span className="grp-space-line" />
                      </div>
                      {group.panes.map((pane) => {
                        const tab = snapshot.tabs.find((item) => item.tab_id === pane.tab_id);
                        return (
                          <AgentRow
                            key={pane.pane_id}
                            index={agentPaneIndex++}
                            pane={pane}
                            workspace={group.workspace}
                            tabLabel={tab ? displayTabLabel(tab, snapshot.panes) : undefined}
                            active={pane.pane_id === selectedPane?.pane_id}
                            onSelect={() => onSelectPane(pane)}
                            onMenu={(x, y) => onMenu("pane", pane.pane_id, paneTitle(pane), x, y)}
                          />
                        );
                      })}
                    </Fragment>
                  ))
                ) : (
                  agentPanes.map((pane, index) => {
                    const tab = snapshot.tabs.find((item) => item.tab_id === pane.tab_id);
                    return (
                      <AgentRow
                        key={pane.pane_id}
                        index={index}
                        pane={pane}
                        workspace={snapshot.workspaces.find(
                          (workspace) => workspace.workspace_id === pane.workspace_id,
                        )}
                        tabLabel={tab ? displayTabLabel(tab, snapshot.panes) : undefined}
                        active={pane.pane_id === selectedPane?.pane_id}
                        onSelect={() => onSelectPane(pane)}
                        onMenu={(x, y) => onMenu("pane", pane.pane_id, paneTitle(pane), x, y)}
                      />
                    );
                  })
                )
              ) : spaceGroups.every((group) => group.tabs.length === 0) ? (
                <div className="empty">
                  <strong>No panes</strong>
                  <span>This space has no panes yet.</span>
                </div>
              ) : (
                spaceGroups.map((group) => (
                  <Fragment key={group.workspace.workspace_id}>
                    {scope === "all" ? (
                      <div className="grp-space">
                        <span className="dot" data-status={group.workspace.agent_status} />
                        <span className="grp-space-name">{group.workspace.label}</span>
                        <span className="grp-space-line" />
                      </div>
                    ) : null}
                    {group.tabs.map(({ tab, panes: tabPanes }) => {
                      const label = displayTabLabel(tab, snapshot.panes);
                      return (
                        <div className="tabgrp" key={tab.tab_id}>
                          {group.workspace.tab_count > 1 || tabPanes.length > 1 ? (
                            <TabDivider
                              label={label}
                              count={tabPanes.length}
                              onSelect={() => onSelectTab(tab.tab_id)}
                              onMenu={(x, y) =>
                                onMenu("tab", tab.tab_id, label, x, y, canClearTabName(tab))
                              }
                            />
                          ) : null}
                          {tabPanes.map((pane) => (
                            <PaneRow
                              key={pane.pane_id}
                              index={paneIndex++}
                              pane={pane}
                              active={pane.pane_id === selectedPane?.pane_id}
                              onSelect={() => onSelectPane(pane)}
                              onMenu={(x, y) => onMenu("pane", pane.pane_id, paneTitle(pane), x, y)}
                            />
                          ))}
                        </div>
                      );
                    })}
                  </Fragment>
                ))
              )}
            </section>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

function SpaceRow({
  workspace,
  active,
  attention,
  index,
  onSelect,
  onMenu,
}: {
  workspace: WorkspaceInfo;
  active: boolean;
  attention: number;
  index: number;
  onSelect: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  const press = useLongPress(onMenu, onSelect);
  return (
    <button
      className="space-row"
      type="button"
      data-active={active}
      style={{ animationDelay: `${Math.min(index, 14) * 22}ms` }}
      {...press}
    >
      <span className="dot" data-status={workspace.agent_status} />
      <span className="space-body">
        <span className="space-name">{workspace.label}</span>
        <span className="space-sub mono">{spaceSubtitle(workspace)}</span>
      </span>
      {attention > 0 ? <span className="attn">{attention}</span> : null}
    </button>
  );
}

function TabDivider({
  label,
  count,
  onSelect,
  onMenu,
}: {
  label: string;
  count: number;
  onSelect: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  const press = useLongPress(onMenu, onSelect);
  return (
    <div className="tab-div">
      <button type="button" className="tab-head" {...press}>
        <span className="tab-name">{label}</span>
        {count > 1 ? (
          <span className="tab-split mono">
            <SplitGlyph />
            {count}
          </span>
        ) : null}
      </button>
      <span className="tab-line" />
    </div>
  );
}

function PaneRow({
  pane,
  active,
  index,
  onSelect,
  onMenu,
}: {
  pane: PaneInfo;
  active: boolean;
  index: number;
  onSelect: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  const press = useLongPress(onMenu, onSelect);
  const meta = paneMeta(pane);
  return (
    <button
      className="pane-row"
      type="button"
      data-active={active}
      data-status={pane.agent_status}
      style={{ animationDelay: `${Math.min(index, 14) * 22}ms` }}
      {...press}
    >
      <span className="dot" data-status={pane.agent_status} />
      <span className="pane-body">
        <span className="pane-name">{paneTitle(pane)}</span>
        {meta ? <span className="pane-meta mono">{meta}</span> : null}
      </span>
      {isLoud(pane.agent_status) ? (
        <span className="pane-word" data-status={pane.agent_status}>
          {statusLabel(pane.agent_status)}
        </span>
      ) : null}
    </button>
  );
}

function AgentRow({
  pane,
  workspace,
  tabLabel,
  active,
  index,
  onSelect,
  onMenu,
}: {
  pane: PaneInfo;
  workspace?: WorkspaceInfo;
  tabLabel?: string;
  active: boolean;
  index: number;
  onSelect: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  const press = useLongPress(onMenu, onSelect);
  const iconKind = agentIconKind(pane);
  return (
    <button
      className="pane-row agent-row"
      type="button"
      data-active={active}
      data-status={pane.agent_status}
      style={{ animationDelay: `${Math.min(index, 14) * 22}ms` }}
      {...press}
    >
      <span className="dot" data-status={pane.agent_status} />
      <span className="pane-body">
        <span className="pane-name agent-title">
          {iconKind ? <AgentIcon kind={iconKind} /> : null}
          <span className="agent-title-text">{agentTitle(pane)}</span>
        </span>
        <span className="pane-meta mono">{agentSubtitle(pane, workspace, tabLabel)}</span>
      </span>
      {isLoud(pane.agent_status) ? (
        <span className="pane-word" data-status={pane.agent_status}>
          {statusLabel(pane.agent_status)}
        </span>
      ) : null}
    </button>
  );
}

type AgentIconKind = "claude" | "codex" | "pi";

function agentIconKind(pane: PaneInfo): AgentIconKind | null {
  // Best-effort cosmetic match: prefer structured agent fields before user labels.
  const values = [pane.agent, pane.display_agent, pane.label, pane.title];
  for (const value of values) {
    const label = value?.toLowerCase().trim();
    if (!label) {
      continue;
    }
    if (label.includes("claude")) {
      return "claude";
    }
    if (label.includes("codex")) {
      return "codex";
    }
    if (/(^|[^a-z0-9])pi([^a-z0-9]|$)/u.test(label)) {
      return "pi";
    }
  }
  return null;
}

function AgentIcon({ kind }: { kind: AgentIconKind }) {
  if (kind === "claude") {
    return (
      <svg className="agent-icon agent-icon-claude" viewBox="0 0 256 257" aria-hidden="true">
        <path d="m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z" />
      </svg>
    );
  }
  if (kind === "codex") {
    return (
      <svg className="agent-icon agent-icon-codex" viewBox="0 0 256 260" aria-hidden="true">
        <path d="M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z" />
      </svg>
    );
  }
  return (
    <svg className="agent-icon agent-icon-pi" viewBox="0 0 800 800" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
      />
      <path d="M517.36 400H634.72V634.72H517.36Z" />
    </svg>
  );
}

function StatusBadge({ status }: { status: AgentStatus }) {
  return (
    <span className="badge" data-status={status}>
      <span className="dot" data-status={status} />
      {statusLabel(status)}
    </span>
  );
}

function isAgentPane(pane: PaneInfo) {
  return Boolean(
    pane.agent ||
      pane.display_agent ||
      pane.custom_status ||
      pane.title ||
      pane.agent_status !== "unknown",
  );
}

function sortAgentPanes(panes: PaneInfo[], sort: AgentSort, snapshot: Snapshot) {
  const workspaceNumber = new Map(
    snapshot.workspaces.map((workspace) => [workspace.workspace_id, workspace.number]),
  );
  const tabNumber = new Map(snapshot.tabs.map((tab) => [tab.tab_id, tab.number]));
  const statusOrder: Record<AgentStatus, number> = {
    blocked: 0,
    working: 1,
    done: 2,
    idle: 3,
    unknown: 4,
  };
  const attentionOrder: Record<AgentStatus, number> = {
    blocked: 0,
    done: 1,
    working: 2,
    idle: 3,
    unknown: 4,
  };

  return [...panes].sort((a, b) => {
    if (sort === "attention") {
      const attention = Number(isAttention(b.agent_status)) - Number(isAttention(a.agent_status));
      if (attention !== 0) {
        return attention;
      }
      const status = attentionOrder[a.agent_status] - attentionOrder[b.agent_status];
      if (status !== 0) {
        return status;
      }
    } else if (sort === "status") {
      const status = statusOrder[a.agent_status] - statusOrder[b.agent_status];
      if (status !== 0) {
        return status;
      }
    }

    const workspace =
      (workspaceNumber.get(a.workspace_id) ?? Number.MAX_SAFE_INTEGER) -
      (workspaceNumber.get(b.workspace_id) ?? Number.MAX_SAFE_INTEGER);
    if (workspace !== 0) {
      return workspace;
    }
    const tab =
      (tabNumber.get(a.tab_id) ?? Number.MAX_SAFE_INTEGER) -
      (tabNumber.get(b.tab_id) ?? Number.MAX_SAFE_INTEGER);
    if (tab !== 0) {
      return tab;
    }
    return a.pane_id.localeCompare(b.pane_id, undefined, { numeric: true });
  });
}

function agentTitle(pane: PaneInfo) {
  return pane.display_agent || pane.label || pane.agent || pane.title || paneTitle(pane);
}

function agentSubtitle(pane: PaneInfo, workspace?: WorkspaceInfo, tabLabel?: string) {
  const stateText =
    pane.custom_status ||
    pane.state_labels?.[statusLabel(pane.agent_status)] ||
    statusLabel(pane.agent_status);
  const dir = basename(pane.foreground_cwd || pane.cwd);
  return [stateText, workspace?.label, tabLabel, dir].filter(Boolean).join(" · ");
}

function basename(path?: string) {
  if (!path) {
    return "";
  }
  const trimmed = path.replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }
  return trimmed.split("/").pop() ?? "";
}

function SplitGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <rect
        x="0.75"
        y="0.75"
        width="10.5"
        height="10.5"
        rx="1.75"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <line x1="6" y1="1" x2="6" y2="11" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function menuItems(kind: MenuKind, paneMoveSupported: boolean): MenuItem[] {
  if (kind === "space") {
    return [
      { key: "rename", label: "Rename" },
      { key: "newtab", label: "New tab" },
      { key: "close", label: "Close space", danger: true },
    ];
  }
  if (kind === "tab") {
    return [
      { key: "rename", label: "Rename" },
      { key: "close", label: "Close tab", danger: true },
    ];
  }
  const paneItems: MenuItem[] = [
    { key: "rename", label: "Rename" },
  ];
  if (paneMoveSupported) {
    paneItems.push(
      { key: "move_new_tab", label: "Move to new tab" },
      { key: "move_new_space", label: "Move to new space" },
    );
  }
  paneItems.push({ key: "close", label: "Close pane", danger: true });
  return paneItems;
}

function closeCopy(kind: MenuKind) {
  switch (kind) {
    case "space":
      return {
        title: "Close space?",
        message: "This closes the space and every tab and pane inside it.",
        confirm: "Close space",
      };
    case "tab":
      return {
        title: "Close tab?",
        message: "This closes the tab and all of its panes.",
        confirm: "Close tab",
      };
    case "pane":
      return {
        title: "Close pane?",
        message: "This ends the pane's terminal session.",
        confirm: "Close pane",
      };
  }
}

function useIsNarrow() {
  const [narrow, setNarrow] = useState(() => isMobileLayout());
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const update = () => setNarrow(isMobileLayout());
    update();
    mq.addEventListener("change", update);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    window.visualViewport?.addEventListener("resize", update);
    return () => {
      mq.removeEventListener("change", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      window.visualViewport?.removeEventListener("resize", update);
    };
  }, []);
  return narrow;
}

function isMobileLayout() {
  if (typeof window === "undefined") {
    return false;
  }
  return (
    window.matchMedia(NARROW_QUERY).matches ||
    navigator.maxTouchPoints > 0 ||
    window.innerWidth <= 1024
  );
}

function summary(panes: PaneInfo[]) {
  const blocked = panes.filter((pane) => pane.agent_status === "blocked").length;
  const done = panes.filter((pane) => pane.agent_status === "done").length;
  const working = panes.filter((pane) => pane.agent_status === "working").length;
  return blocked
    ? `${blocked} blocked`
    : done
      ? `${done} done`
      : working
        ? `${working} working`
        : null;
}

function stageBreadcrumb(snapshot: Snapshot | null, pane: PaneInfo | null, loadState: LoadState) {
  if (!pane) {
    if (loadState === "error") {
      return "bridge unavailable";
    }
    return snapshot ? "no pane selected" : "connecting…";
  }
  const workspace = snapshot?.workspaces.find((item) => item.workspace_id === pane.workspace_id);
  const tab = snapshot?.tabs.find((item) => item.tab_id === pane.tab_id);
  const tabLabel = tab && snapshot ? displayTabLabel(tab, snapshot.panes) : undefined;
  return [workspace?.label, tabLabel].filter(Boolean).join(" · ") || pane.pane_id;
}

async function fetchSnapshot() {
  const response = await fetch("/api/snapshot");
  if (!response.ok) {
    throw new Error(`snapshot failed: ${response.status}`);
  }
  return (await response.json()) as Snapshot;
}

async function syncSelectedPane(paneId: string) {
  const response = await fetch("/api/selection", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pane_id: paneId }),
  });
  if (!response.ok) {
    throw new Error(`selection failed: ${response.status}`);
  }
}

async function refreshSnapshot(
  setSnapshot: (snapshot: Snapshot) => void,
  setLoadState: (state: LoadState) => void,
  isDisposed: () => boolean,
) {
  try {
    const next = await fetchSnapshot();
    if (!isDisposed()) {
      setSnapshot(next);
      setLoadState("ready");
    }
  } catch {
    if (!isDisposed()) {
      setLoadState("error");
    }
  }
}

function selectionPaneId(event: MessageEvent) {
  if (typeof event.data !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(event.data) as { type?: unknown; pane_id?: unknown };
    return parsed.type === "herdr_web.selection_changed" && typeof parsed.pane_id === "string"
      ? parsed.pane_id
      : null;
  } catch {
    return null;
  }
}

function openEventsSocket(path: string, onEvent: (event: MessageEvent) => void) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${window.location.host}${path}`;
  let socket: WebSocket | null = null;
  let closed = false;
  let reconnectTimer: number | null = null;
  let attempts = 0;

  const connect = () => {
    if (closed) {
      return;
    }
    const next = new WebSocket(url);
    socket = next;
    next.addEventListener("open", () => {
      attempts = 0;
    });
    next.addEventListener("message", onEvent);
    next.addEventListener("close", () => {
      if (closed || socket !== next || reconnectTimer !== null) {
        return;
      }
      const delay = Math.min(500 * 2 ** attempts, 5000);
      attempts += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    });
  };

  connect();
  return {
    close() {
      closed = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      socket?.close();
    },
  };
}
