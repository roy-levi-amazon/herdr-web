import {
  ChevronLeft,
  MoreVertical,
  PanelLeft,
  Plus,
  RefreshCw,
  Settings,
  SplitSquareHorizontal,
  SplitSquareVertical,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, Dispatch, MutableRefObject, SetStateAction } from "react";
import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { AgentIcon, agentIconKind } from "./AgentIcon";
import { applyActivityMessage, parseActivityEventData, replayActivityMessages } from "./activity";
import type { ActivityLogEntry } from "./activity";
import { BackendSettingsDialog } from "./BackendSettingsDialog";
import { useBridge } from "./bridge";
import type { BridgeId, BridgeRuntime } from "./bridge";
import { createCommands, createdPaneId } from "./commands";
import type { LaunchSpec, PaneFocusDirection, SplitDirection } from "./commands";
import { isConnectionResultCurrent } from "./connectionState";
import {
  DEFAULT_CONTENT_INSET_BOTTOM_PX,
  DEFAULT_CONTENT_INSET_TOP_PX,
  DEFAULT_MOBILE_CONTROLS_SCALE_PERCENT,
  parseContentInsetBottomPx,
  parseContentInsetTopPx,
  parseMobileControlsScalePercent,
} from "./displayPrefs";
import { LaunchDialog } from "./LaunchDialog";
import { resolveLaunchSpec } from "./launch";
import type { LaunchTarget } from "./launch";
import {
  DEFAULT_MOBILE_KEYBOARD_HIDE_REFIT,
  DEFAULT_MOBILE_TOUCH_SELECTION,
  DEFAULT_MOBILE_TERMINAL_TAP_TARGET,
  parseMobileKeyboardHideRefit,
  parseMobileTouchSelection,
  parseMobileTerminalTapTarget,
} from "./mobileTerminalPrefs";
import type { MobileTerminalTapTarget } from "./mobileTerminalPrefs";
import { addNativeBackHandler, addNativeKeyboardHideHandler, isNativeAndroid } from "./native";
import { ActionMenu, ConfirmDialog, RenameDialog, useLongPress } from "./overlays";
import type { MenuItem } from "./overlays";
import { createSnapshotRefreshController } from "./refreshCoordinator";
import { TerminalView } from "./TerminalView";
import {
  DEFAULT_TERMINAL_INPUT_BATCH_DELAY_MS,
  DEFAULT_TERMINAL_INPUT_TRANSPORT,
  parseTerminalInputBatchDelayMs,
  parseTerminalInputTransport,
} from "./terminalInputTransport";
import type { TerminalInputTransport } from "./terminalInputTransport";
import {
  DEFAULT_TERMINAL_OUTPUT_COALESCE_MS,
  parseTerminalOutputCoalesceMs,
} from "./terminalOutputCoalescing";
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
import type {
  AgentStatus,
  PaneInfo,
  Snapshot,
  TabInfo,
  WorkspaceInfo,
} from "./types";

type LoadState = "loading" | "ready" | "error";
type Scope = "space" | "all";
type HostScope = "selected" | "all";
type SidebarView = "agents" | "tabs";
type AgentSort = "attention" | "status" | "workspace";
type AgentGroup = "none" | "host" | "workspace" | "hostWorkspace";
type MenuKind = "space" | "tab" | "pane";
type ScopedPaneRef = {
  bridgeId: BridgeId;
  paneId: string;
};
type ScopedWorkspaceRef = {
  bridgeId: BridgeId;
  workspaceId: string;
};
type ScopedLaunchTarget = LaunchTarget & {
  bridgeId: BridgeId;
};
type BridgeConnectionView = {
  runtime: BridgeRuntime;
  snapshot: Snapshot | null;
  loadState: LoadState;
};
type BridgeConnectionState = {
  connectionKey: string;
  snapshot: Snapshot | null;
  loadState: LoadState;
};
type BridgeConnectionRef = {
  connectionKey: string;
  snapshot: Snapshot | null;
  activityGeneration: number;
  resyncBarrierGeneration: number;
  activityLog: ActivityLogEntry[];
};
export type ScopedAgentPane = {
  bridgeId: BridgeId;
  bridgeIndex: number;
  bridgeLabel: string;
  bridgeColor: string;
  pane: PaneInfo;
  snapshot: Snapshot;
  workspace?: WorkspaceInfo;
  tabNumber?: number;
  tabLabel?: string;
};
type ScopedWorkspace = {
  bridgeId: BridgeId;
  bridgeIndex: number;
  bridgeLabel: string;
  bridgeColor: string;
  snapshot: Snapshot;
  workspace: WorkspaceInfo;
};
type ScopedTabWorkspace = ScopedWorkspace & {
  tabs: { tab: TabInfo; panes: PaneInfo[] }[];
};
type ScopedAgentGroup = {
  key: string;
  bridgeId: BridgeId;
  label: string;
  bridgeColor?: string;
  status?: AgentStatus;
  panes: ScopedAgentPane[];
};
type MenuState = {
  kind: MenuKind;
  bridgeId: BridgeId;
  id: string;
  label: string;
  x: number;
  y: number;
  clearable?: boolean;
};
type DialogState = {
  mode: "rename" | "close";
  kind: MenuKind;
  bridgeId: BridgeId;
  id: string;
  label: string;
  clearable?: boolean;
};
type DisplayPrefs = {
  hostScope: HostScope;
  scope: Scope;
  sidebarView: SidebarView;
  agentSort: AgentSort;
  agentGroup: AgentGroup;
  sidebarWidth: number;
  sidebarOpen: boolean;
  selectedBridgeId: BridgeId | null;
  selectedPane: ScopedPaneRef | null;
  activeWorkspace: ScopedWorkspaceRef | null;
  selectedPanesByBridgeId: Record<string, string>;
  activeWorkspacesByBridgeId: Record<string, string>;
  terminalInputTransport: TerminalInputTransport;
  terminalInputBatchDelayMs: number;
  terminalOutputCoalesceMs: number;
  contentInsetTopPx: number;
  contentInsetBottomPx: number;
  mobileControlsScalePercent: number;
  mobileTerminalTapTarget: MobileTerminalTapTarget;
  mobileTouchSelection: boolean;
  mobileKeyboardHideRefit: boolean;
};
type LegacyDisplaySelectionPrefs = {
  activeSpaceId: string | null;
  selectedPaneId: string | null;
};
const COMPACT_LAYOUT_QUERY = "(max-width: 820px)";
const TOUCH_INPUT_QUERY = "(hover: none) and (pointer: coarse)";
const DISPLAY_PREFS_KEY = "herdr.mobileWeb.displayPrefs.v2";
const LEGACY_DISPLAY_PREFS_KEY = "herdr.mobileWeb.displayPrefs.v1";
const MOBILE_SIDEBAR_HISTORY_KEY = "herdrWebMobileSidebar";
const MOBILE_DETAIL_HISTORY_KEY = "herdrWebMobileDetail";
const DEFAULT_SIDEBAR_WIDTH = 320;
const MIN_SIDEBAR_WIDTH = 260;
const MAX_SIDEBAR_WIDTH = 560;

function readDisplayPrefs(): DisplayPrefs {
  const fallback: DisplayPrefs = {
    hostScope: "selected",
    scope: "space",
    sidebarView: "agents",
    agentSort: "attention",
    agentGroup: "none",
    sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    sidebarOpen: true,
    selectedBridgeId: null,
    selectedPane: null,
    activeWorkspace: null,
    selectedPanesByBridgeId: {},
    activeWorkspacesByBridgeId: {},
    terminalInputTransport: DEFAULT_TERMINAL_INPUT_TRANSPORT,
    terminalInputBatchDelayMs: DEFAULT_TERMINAL_INPUT_BATCH_DELAY_MS,
    terminalOutputCoalesceMs: DEFAULT_TERMINAL_OUTPUT_COALESCE_MS,
    contentInsetTopPx: DEFAULT_CONTENT_INSET_TOP_PX,
    contentInsetBottomPx: DEFAULT_CONTENT_INSET_BOTTOM_PX,
    mobileControlsScalePercent: DEFAULT_MOBILE_CONTROLS_SCALE_PERCENT,
    mobileTerminalTapTarget: DEFAULT_MOBILE_TERMINAL_TAP_TARGET,
    mobileTouchSelection: DEFAULT_MOBILE_TOUCH_SELECTION,
    mobileKeyboardHideRefit: DEFAULT_MOBILE_KEYBOARD_HIDE_REFIT,
  };
  try {
    const raw = window.localStorage.getItem(DISPLAY_PREFS_KEY);
    if (!raw) {
      return readLegacyDisplayPrefs(fallback);
    }
    const parsed = JSON.parse(raw) as Partial<DisplayPrefs>;
    return parseDisplayPrefsValue(parsed, fallback);
  } catch {
    return fallback;
  }
}

async function loadDisplayPrefs(): Promise<DisplayPrefs> {
  const localPrefs = readDisplayPrefs();
  if (!isNativeApp()) {
    return localPrefs;
  }
  try {
    const { value } = await Preferences.get({ key: DISPLAY_PREFS_KEY });
    if (value) {
      return parseDisplayPrefsValue(JSON.parse(value) as Partial<DisplayPrefs>, localPrefs);
    }
  } catch {
    // Fall back to browser storage backup.
  }
  return localPrefs;
}

function parseDisplayPrefsValue(
  parsed: Partial<DisplayPrefs>,
  fallback: DisplayPrefs,
): DisplayPrefs {
  return {
    hostScope:
      parsed.hostScope === "selected" || parsed.hostScope === "all"
        ? parsed.hostScope
        : fallback.hostScope,
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
      parsed.agentGroup === "none" ||
      parsed.agentGroup === "host" ||
      parsed.agentGroup === "workspace" ||
      parsed.agentGroup === "hostWorkspace"
        ? parsed.agentGroup
        : fallback.agentGroup,
    sidebarWidth:
      typeof parsed.sidebarWidth === "number"
        ? clampSidebarWidth(parsed.sidebarWidth)
        : fallback.sidebarWidth,
    sidebarOpen:
      typeof parsed.sidebarOpen === "boolean" ? parsed.sidebarOpen : fallback.sidebarOpen,
    selectedBridgeId:
      typeof parsed.selectedBridgeId === "string" ? parsed.selectedBridgeId : fallback.selectedBridgeId,
    selectedPane: parseScopedPaneRef(parsed.selectedPane),
    activeWorkspace: parseScopedWorkspaceRef(parsed.activeWorkspace),
    selectedPanesByBridgeId: parseStringRecord(parsed.selectedPanesByBridgeId),
    activeWorkspacesByBridgeId: parseStringRecord(parsed.activeWorkspacesByBridgeId),
    terminalInputTransport: parseTerminalInputTransport(parsed.terminalInputTransport),
    terminalInputBatchDelayMs: parseTerminalInputBatchDelayMs(parsed.terminalInputBatchDelayMs),
    terminalOutputCoalesceMs: parseTerminalOutputCoalesceMs(
      parsed.terminalOutputCoalesceMs,
    ),
    contentInsetTopPx: parseContentInsetTopPx(parsed.contentInsetTopPx),
    contentInsetBottomPx: parseContentInsetBottomPx(parsed.contentInsetBottomPx),
    mobileControlsScalePercent: parseMobileControlsScalePercent(
      parsed.mobileControlsScalePercent,
    ),
    mobileTerminalTapTarget: parseMobileTerminalTapTarget(parsed.mobileTerminalTapTarget),
    mobileTouchSelection: parseMobileTouchSelection(parsed.mobileTouchSelection),
    mobileKeyboardHideRefit: parseMobileKeyboardHideRefit(parsed.mobileKeyboardHideRefit),
  };
}

function readLegacyDisplaySelectionPrefs(): LegacyDisplaySelectionPrefs {
  try {
    const raw = window.localStorage.getItem(LEGACY_DISPLAY_PREFS_KEY);
    if (!raw) {
      return { activeSpaceId: null, selectedPaneId: null };
    }
    const parsed = JSON.parse(raw) as { activeSpaceId?: unknown; selectedPaneId?: unknown };
    return {
      activeSpaceId: typeof parsed.activeSpaceId === "string" ? parsed.activeSpaceId : null,
      selectedPaneId: typeof parsed.selectedPaneId === "string" ? parsed.selectedPaneId : null,
    };
  } catch {
    return { activeSpaceId: null, selectedPaneId: null };
  }
}

function readLegacyDisplayPrefs(fallback: DisplayPrefs): DisplayPrefs {
  try {
    const raw = window.localStorage.getItem(LEGACY_DISPLAY_PREFS_KEY);
    if (!raw) {
      return fallback;
    }
    const parsed = JSON.parse(raw) as {
      activeSpaceId?: unknown;
      selectedPaneId?: unknown;
    } & Partial<DisplayPrefs>;
    return {
      ...fallback,
      hostScope:
        parsed.hostScope === "selected" || parsed.hostScope === "all"
          ? parsed.hostScope
          : fallback.hostScope,
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
        parsed.agentGroup === "none" ||
        parsed.agentGroup === "host" ||
        parsed.agentGroup === "workspace" ||
        parsed.agentGroup === "hostWorkspace"
          ? parsed.agentGroup
          : fallback.agentGroup,
      sidebarWidth:
        typeof parsed.sidebarWidth === "number"
          ? clampSidebarWidth(parsed.sidebarWidth)
          : fallback.sidebarWidth,
      sidebarOpen:
        typeof parsed.sidebarOpen === "boolean" ? parsed.sidebarOpen : fallback.sidebarOpen,
      terminalInputTransport: parseTerminalInputTransport(parsed.terminalInputTransport),
      terminalInputBatchDelayMs: parseTerminalInputBatchDelayMs(parsed.terminalInputBatchDelayMs),
      terminalOutputCoalesceMs: parseTerminalOutputCoalesceMs(
        parsed.terminalOutputCoalesceMs,
      ),
      contentInsetTopPx: parseContentInsetTopPx(parsed.contentInsetTopPx),
      contentInsetBottomPx: parseContentInsetBottomPx(parsed.contentInsetBottomPx),
      mobileControlsScalePercent: parseMobileControlsScalePercent(
        parsed.mobileControlsScalePercent,
      ),
      mobileTerminalTapTarget: parseMobileTerminalTapTarget(parsed.mobileTerminalTapTarget),
      mobileTouchSelection: parseMobileTouchSelection(parsed.mobileTouchSelection),
      mobileKeyboardHideRefit: parseMobileKeyboardHideRefit(parsed.mobileKeyboardHideRefit),
    };
  } catch {
    return fallback;
  }
}

function parseScopedPaneRef(value: unknown): ScopedPaneRef | null {
  if (!isRecord(value) || typeof value.bridgeId !== "string" || typeof value.paneId !== "string") {
    return null;
  }
  return { bridgeId: value.bridgeId, paneId: value.paneId };
}

function parseScopedWorkspaceRef(value: unknown): ScopedWorkspaceRef | null {
  if (
    !isRecord(value) ||
    typeof value.bridgeId !== "string" ||
    typeof value.workspaceId !== "string"
  ) {
    return null;
  }
  return { bridgeId: value.bridgeId, workspaceId: value.workspaceId };
}

function parseStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return Object.fromEntries(entries);
}

function clampSidebarWidth(width: number) {
  const viewportMax =
    typeof window === "undefined"
      ? MAX_SIDEBAR_WIDTH
      : Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, window.innerWidth - 360));
  return Math.round(Math.min(Math.max(width, MIN_SIDEBAR_WIDTH), viewportMax));
}

async function writeDisplayPrefs(prefs: DisplayPrefs) {
  const value = JSON.stringify(prefs);
  if (isNativeApp()) {
    try {
      await Preferences.set({ key: DISPLAY_PREFS_KEY, value });
    } catch {
      // Browser storage below remains a best-effort backup.
    }
  }
  try {
    window.localStorage.setItem(DISPLAY_PREFS_KEY, value);
    window.localStorage.removeItem(LEGACY_DISPLAY_PREFS_KEY);
  } catch {
    // Storage can be unavailable in private or locked-down browser contexts.
  }
}

function isNativeApp() {
  return Capacitor.isNativePlatform();
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
  const bridge = useBridge();
  const initialPrefs = useMemo(readDisplayPrefs, []);
  const legacySelectionPrefs = useMemo(readLegacyDisplaySelectionPrefs, []);
  const [displayPrefsLoaded, setDisplayPrefsLoaded] = useState(() => !isNativeApp());
  const [connectionStates, setConnectionStates] = useState<Record<string, BridgeConnectionState>>({});
  const [selectedBridgeId, setSelectedBridgeId] = useState<BridgeId | null>(
    initialPrefs.selectedBridgeId,
  );
  const [selectedPaneRefState, setSelectedPaneRefState] = useState<ScopedPaneRef | null>(
    initialPrefs.selectedPane,
  );
  const [activeWorkspaceRefState, setActiveWorkspaceRefState] =
    useState<ScopedWorkspaceRef | null>(initialPrefs.activeWorkspace);
  const [selectedPanesByBridgeId, setSelectedPanesByBridgeId] = useState<Record<string, string>>(
    initialPrefs.selectedPanesByBridgeId,
  );
  const [activeWorkspacesByBridgeId, setActiveWorkspacesByBridgeId] = useState<Record<string, string>>(
    initialPrefs.activeWorkspacesByBridgeId,
  );
  const [hostScope, setHostScope] = useState<HostScope>(initialPrefs.hostScope);
  const [scope, setScope] = useState<Scope>(initialPrefs.scope);
  const [sidebarView, setSidebarView] = useState<SidebarView>(initialPrefs.sidebarView);
  const [agentSort, setAgentSort] = useState<AgentSort>(initialPrefs.agentSort);
  const [agentGroup, setAgentGroup] = useState<AgentGroup>(initialPrefs.agentGroup);
  const [sidebarWidth, setSidebarWidth] = useState(initialPrefs.sidebarWidth);
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(initialPrefs.sidebarOpen);
  const [showDetail, setShowDetail] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [backendSettingsOpen, setBackendSettingsOpen] = useState(false);
  const [terminalInputTransport, setTerminalInputTransport] = useState(
    initialPrefs.terminalInputTransport,
  );
  const [terminalInputBatchDelayMs, setTerminalInputBatchDelayMs] = useState(
    initialPrefs.terminalInputBatchDelayMs,
  );
  const [terminalOutputCoalesceMs, setTerminalOutputCoalesceMs] = useState(
    initialPrefs.terminalOutputCoalesceMs,
  );
  const [contentInsetTopPx, setContentInsetTopPx] = useState(initialPrefs.contentInsetTopPx);
  const [contentInsetBottomPx, setContentInsetBottomPx] = useState(
    initialPrefs.contentInsetBottomPx,
  );
  const [mobileControlsScalePercent, setMobileControlsScalePercent] = useState(
    initialPrefs.mobileControlsScalePercent,
  );
  const [mobileTerminalTapTarget, setMobileTerminalTapTarget] = useState(
    initialPrefs.mobileTerminalTapTarget,
  );
  const [mobileTouchSelection, setMobileTouchSelection] = useState(
    initialPrefs.mobileTouchSelection,
  );
  const [mobileKeyboardHideRefit, setMobileKeyboardHideRefit] = useState(
    initialPrefs.mobileKeyboardHideRefit,
  );
  const [launchTarget, setLaunchTarget] = useState<ScopedLaunchTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refitToken, setRefitToken] = useState(0);
  const [terminalFocusToken, setTerminalFocusToken] = useState(0);
  const isCompactLayout = useIsCompactLayout();
  const isTouchInput = useIsTouchInput();
  const showMobileKeyboardHideRefit = isNativeAndroid();
  const connectionRefs = useRef<Record<string, BridgeConnectionRef>>({});
  const isCompactLayoutRef = useRef(isCompactLayout);
  const showDetailRef = useRef(showDetail);
  const selectedBridgeIdRef = useRef(selectedBridgeId);
  const mobileSidebarHistoryRef = useRef(false);
  const mobileDetailHistoryRef = useRef(false);
  const legacySelectionAppliedRef = useRef(false);
  const sidebarResizePressRef = useRef<{
    timer: number;
    pointerId: number;
    x: number;
    y: number;
    target: HTMLDivElement;
  } | null>(null);

  useEffect(() => {
    if (displayPrefsLoaded) {
      return;
    }
    let cancelled = false;
    void loadDisplayPrefs().then((prefs) => {
      if (cancelled) {
        return;
      }
      setHostScope(prefs.hostScope);
      setScope(prefs.scope);
      setSidebarView(prefs.sidebarView);
      setAgentSort(prefs.agentSort);
      setAgentGroup(prefs.agentGroup);
      setSidebarWidth(prefs.sidebarWidth);
      setSidebarOpen(prefs.sidebarOpen);
      setSelectedBridgeId(prefs.selectedBridgeId);
      setSelectedPaneRefState(prefs.selectedPane);
      setActiveWorkspaceRefState(prefs.activeWorkspace);
      setSelectedPanesByBridgeId(prefs.selectedPanesByBridgeId);
      setActiveWorkspacesByBridgeId(prefs.activeWorkspacesByBridgeId);
      setTerminalInputTransport(prefs.terminalInputTransport);
      setTerminalInputBatchDelayMs(prefs.terminalInputBatchDelayMs);
      setTerminalOutputCoalesceMs(prefs.terminalOutputCoalesceMs);
      setContentInsetTopPx(prefs.contentInsetTopPx);
      setContentInsetBottomPx(prefs.contentInsetBottomPx);
      setMobileControlsScalePercent(prefs.mobileControlsScalePercent);
      setMobileTerminalTapTarget(prefs.mobileTerminalTapTarget);
      setMobileTouchSelection(prefs.mobileTouchSelection);
      setMobileKeyboardHideRefit(prefs.mobileKeyboardHideRefit);
      setDisplayPrefsLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [displayPrefsLoaded]);

  useEffect(() => {
    return addNativeBackHandler(() => {
      if (backendSettingsOpen) {
        setBackendSettingsOpen(false);
        return true;
      }
      if (launchTarget) {
        setLaunchTarget(null);
        return true;
      }
      if (dialog) {
        setDialog(null);
        return true;
      }
      if (menu) {
        setMenu(null);
        return true;
      }
      return false;
    });
  }, [backendSettingsOpen, dialog, launchTarget, menu]);

  const bridgeViews = useMemo<BridgeConnectionView[]>(
    () =>
      bridge.enabledRuntimes.map((runtime) => {
        const state = connectionStates[runtime.id];
        const currentState = state?.connectionKey === runtime.connectionKey ? state : null;
        return {
          runtime,
          snapshot: currentState?.snapshot ?? null,
          loadState: currentState?.loadState ?? (runtime.canConnect ? "loading" : "ready"),
        };
      }),
    [bridge.enabledRuntimes, connectionStates],
  );
  const selectedRuntime = useMemo(
    () =>
      selectedBridgeId
        ? (bridge.enabledRuntimes.find((runtime) => runtime.id === selectedBridgeId) ?? null)
        : null,
    [bridge.enabledRuntimes, selectedBridgeId],
  );
  const selectedConnectionState =
    selectedRuntime && connectionStates[selectedRuntime.id]?.connectionKey === selectedRuntime.connectionKey
      ? connectionStates[selectedRuntime.id]
      : null;
  const snapshot = selectedConnectionState?.snapshot ?? null;
  const loadState: LoadState = selectedConnectionState?.loadState ?? (selectedRuntime ? "loading" : "ready");
  const selectedRawPaneId =
    selectedRuntime && selectedPaneRefState?.bridgeId === selectedRuntime.id
      ? selectedPaneRefState.paneId
      : selectedRuntime
        ? (selectedPanesByBridgeId[selectedRuntime.id] ?? null)
        : null;
  const activeWorkspaceId =
    selectedRuntime && activeWorkspaceRefState?.bridgeId === selectedRuntime.id
      ? activeWorkspaceRefState.workspaceId
      : selectedRuntime
        ? (activeWorkspacesByBridgeId[selectedRuntime.id] ?? null)
        : null;
  const resolvedPaneId = chooseSelectedPane(snapshot, selectedRawPaneId);
  const supportedCommands =
    selectedRuntime?.capabilityState === "ready" ? (selectedRuntime.capabilities?.commands ?? []) : [];
  const splitSupported = supportedCommands.includes("pane.split");
  const paneFocusSupported = supportedCommands.includes("pane.focus_direction");
  const selectedHttpUrl = useMemo(
    () => selectedRuntime?.httpUrl ?? disconnectedHttpUrl,
    [selectedRuntime?.connectionKey],
  );
  const selectedWsUrl = useMemo(
    () => selectedRuntime?.wsUrl ?? disconnectedWsUrl,
    [selectedRuntime?.connectionKey],
  );
  const selectedCommands = useMemo(
    () => (selectedRuntime ? createCommands(selectedHttpUrl) : null),
    [selectedHttpUrl, selectedRuntime?.id],
  );
  const menuRuntime = menu ? bridge.getRuntime(menu.bridgeId) : null;
  const menuConnectionState =
    menuRuntime && connectionStates[menuRuntime.id]?.connectionKey === menuRuntime.connectionKey
      ? connectionStates[menuRuntime.id]
      : null;
  const menuCommandsReady = Boolean(
    menuRuntime?.canConnect &&
      menuRuntime.capabilityState === "ready" &&
      menuConnectionState?.loadState === "ready" &&
      menuConnectionState.snapshot,
  );
  const menuSupportedCommands = menuCommandsReady ? (menuRuntime?.capabilities?.commands ?? []) : [];
  const menuPaneMoveSupported = menuSupportedCommands.includes("pane.move");
  const activeMenuItems = menu ? menuItems(menu.kind, menuPaneMoveSupported, menuCommandsReady) : [];

  useEffect(() => {
    if (menu && activeMenuItems.length === 0) {
      setMenu(null);
    }
  }, [activeMenuItems.length, menu]);

  const ensureMobileSidebarHistory = () => {
    if (!isCompactLayoutRef.current || isMobileDetailHistoryState(window.history.state)) {
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
    selectedBridgeIdRef.current = selectedBridgeId;
  }, [selectedBridgeId]);

  useEffect(() => {
    if (!bridge.storeLoaded) {
      return;
    }
    const enabledIds = bridge.enabledBridgeIds;
    setSelectedBridgeId((current) => {
      return resolveInitialSelectedBridgeId(current, enabledIds, bridge.lastSelectedBridgeId);
    });
  }, [bridge.enabledBridgeIds, bridge.lastSelectedBridgeId, bridge.storeLoaded]);

  useEffect(() => {
    if (shouldCollapseHostScope(hostScope, bridge.enabledBridgeIds.length, bridge.storeLoaded)) {
      setHostScope("selected");
    }
  }, [bridge.enabledBridgeIds.length, bridge.storeLoaded, hostScope]);

  useEffect(() => {
    if (!bridge.storeLoaded) {
      return;
    }
    bridge.setLastSelectedBridgeId(selectedRuntime?.id ?? null);
  }, [bridge.setLastSelectedBridgeId, bridge.storeLoaded, selectedRuntime?.id]);

  useEffect(() => {
    if (
      legacySelectionAppliedRef.current ||
      !bridge.storeLoaded ||
      !selectedRuntime ||
      (!legacySelectionPrefs.selectedPaneId && !legacySelectionPrefs.activeSpaceId)
    ) {
      return;
    }
    legacySelectionAppliedRef.current = true;
    if (selectedPaneRefState || activeWorkspaceRefState) {
      return;
    }
    if (legacySelectionPrefs.selectedPaneId) {
      const paneId = legacySelectionPrefs.selectedPaneId;
      setSelectedPaneRefState({
        bridgeId: selectedRuntime.id,
        paneId,
      });
      setSelectedPanesByBridgeId((current) =>
        current[selectedRuntime.id]
          ? current
          : { ...current, [selectedRuntime.id]: paneId },
      );
    }
    if (legacySelectionPrefs.activeSpaceId) {
      const workspaceId = legacySelectionPrefs.activeSpaceId;
      setActiveWorkspaceRefState({
        bridgeId: selectedRuntime.id,
        workspaceId,
      });
      setActiveWorkspacesByBridgeId((current) =>
        current[selectedRuntime.id]
          ? current
          : { ...current, [selectedRuntime.id]: workspaceId },
      );
    }
  }, [
    activeWorkspaceRefState,
    bridge.storeLoaded,
    legacySelectionPrefs.activeSpaceId,
    legacySelectionPrefs.selectedPaneId,
    selectedPaneRefState,
    selectedRuntime,
  ]);

  useEffect(() => {
    isCompactLayoutRef.current = isCompactLayout;
    if (isCompactLayout) {
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
  }, [isCompactLayout]);

  useEffect(() => {
    showDetailRef.current = showDetail;
  }, [showDetail]);

  useEffect(() => {
    if (!selectedRuntime) {
      setSelectedPaneRefState(null);
      setActiveWorkspaceRefState(null);
      return;
    }
    const restoredPaneId = selectedPanesByBridgeId[selectedRuntime.id] ?? null;
    const nextPaneId = chooseSelectedPane(snapshot, restoredPaneId);
    setSelectedPaneRefState(nextPaneId ? { bridgeId: selectedRuntime.id, paneId: nextPaneId } : null);
    if (nextPaneId) {
      setSelectedPanesByBridgeId((current) =>
        current[selectedRuntime.id] === nextPaneId
          ? current
          : { ...current, [selectedRuntime.id]: nextPaneId },
      );
      const pane = snapshot?.panes.find((item) => item.pane_id === nextPaneId);
      if (pane) {
        setActiveWorkspaceRefState({
          bridgeId: selectedRuntime.id,
          workspaceId: pane.workspace_id,
        });
        setActiveWorkspacesByBridgeId((current) =>
          current[selectedRuntime.id] === pane.workspace_id
            ? current
            : { ...current, [selectedRuntime.id]: pane.workspace_id },
        );
      }
      return;
    }
    const restoredWorkspaceId = activeWorkspacesByBridgeId[selectedRuntime.id];
    setActiveWorkspaceRefState(
      restoredWorkspaceId
        ? { bridgeId: selectedRuntime.id, workspaceId: restoredWorkspaceId }
        : null,
    );
  }, [
    activeWorkspacesByBridgeId,
    selectedPanesByBridgeId,
    selectedRuntime?.id,
    snapshot,
  ]);

  useEffect(() => {
    if (!displayPrefsLoaded) {
      return;
    }
    void writeDisplayPrefs({
      hostScope,
      scope,
      sidebarView,
      agentSort,
      agentGroup,
      sidebarWidth,
      sidebarOpen,
      selectedBridgeId,
      selectedPane: selectedPaneRefState,
      activeWorkspace: activeWorkspaceRefState,
      selectedPanesByBridgeId,
      activeWorkspacesByBridgeId,
      terminalInputTransport,
      terminalInputBatchDelayMs,
      terminalOutputCoalesceMs,
      contentInsetTopPx,
      contentInsetBottomPx,
      mobileControlsScalePercent,
      mobileTerminalTapTarget,
      mobileTouchSelection,
      mobileKeyboardHideRefit,
    });
  }, [
    displayPrefsLoaded,
    hostScope,
    scope,
    sidebarView,
    agentSort,
    agentGroup,
    sidebarWidth,
    sidebarOpen,
    selectedBridgeId,
    selectedPaneRefState,
    activeWorkspaceRefState,
    selectedPanesByBridgeId,
    activeWorkspacesByBridgeId,
    terminalInputTransport,
    terminalInputBatchDelayMs,
    terminalOutputCoalesceMs,
    contentInsetTopPx,
    contentInsetBottomPx,
    mobileControlsScalePercent,
    mobileTerminalTapTarget,
    mobileTouchSelection,
    mobileKeyboardHideRefit,
  ]);

  useEffect(() => {
    if (!mobileKeyboardHideRefit || !showMobileKeyboardHideRefit) {
      return;
    }

    const requestRefit = () => setRefitToken((token) => token + 1);
    return addNativeKeyboardHideHandler(() => {
      blurActiveTextInput();
      requestRefit();
      const frame = window.requestAnimationFrame(requestRefit);
      const timers = [80, 280].map((delay) => window.setTimeout(requestRefit, delay));
      window.setTimeout(() => {
        window.cancelAnimationFrame(frame);
        for (const timer of timers) {
          window.clearTimeout(timer);
        }
      }, 360);
    });
  }, [mobileKeyboardHideRefit, showMobileKeyboardHideRefit]);

  useEffect(() => {
    setSidebarWidth((width) => clampSidebarWidth(width));
  }, [isCompactLayout]);

  const clearSidebarResizePress = () => {
    const pending = sidebarResizePressRef.current;
    if (!pending) {
      return;
    }
    window.clearTimeout(pending.timer);
    if (pending.target.hasPointerCapture(pending.pointerId)) {
      pending.target.releasePointerCapture(pending.pointerId);
    }
    sidebarResizePressRef.current = null;
  };

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

  useEffect(
    () => () => {
      const pending = sidebarResizePressRef.current;
      if (!pending) {
        return;
      }
      window.clearTimeout(pending.timer);
      if (pending.target.hasPointerCapture(pending.pointerId)) {
        pending.target.releasePointerCapture(pending.pointerId);
      }
      sidebarResizePressRef.current = null;
    },
    [],
  );

  const rememberPaneSelection = useCallback((
    bridgeId: BridgeId,
    paneId: string,
    workspaceId?: string,
  ) => {
    setSelectedPanesByBridgeId((current) =>
      current[bridgeId] === paneId ? current : { ...current, [bridgeId]: paneId },
    );
    if (workspaceId) {
      setActiveWorkspacesByBridgeId((current) =>
        current[bridgeId] === workspaceId ? current : { ...current, [bridgeId]: workspaceId },
      );
    }
    if (selectedBridgeIdRef.current !== bridgeId) {
      return;
    }
    setSelectedPaneRefState((current) =>
      current?.bridgeId === bridgeId && current.paneId === paneId
        ? current
        : { bridgeId, paneId },
    );
    if (workspaceId) {
      setActiveWorkspaceRefState((current) =>
        current?.bridgeId === bridgeId && current.workspaceId === workspaceId
          ? current
        : { bridgeId, workspaceId },
      );
    }
  }, []);

  useEffect(() => {
    const activeBridgeIds = new Set(bridge.enabledRuntimes.map((runtime) => runtime.id));

    for (const bridgeId of Object.keys(connectionRefs.current)) {
      if (!activeBridgeIds.has(bridgeId)) {
        delete connectionRefs.current[bridgeId];
      }
    }
    setConnectionStates((current) => {
      let changed = false;
      const next: Record<string, BridgeConnectionState> = {};
      for (const [bridgeId, state] of Object.entries(current)) {
        if (activeBridgeIds.has(bridgeId)) {
          next[bridgeId] = state;
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [bridge.enabledRuntimes]);

  useEffect(() => {
    if (!error) {
      return;
    }
    const timer = window.setTimeout(() => setError(null), 4500);
    return () => window.clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      if (!isCompactLayoutRef.current) {
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
    if (selectedPane && selectedRuntime) {
      setMenu({
        kind: "pane",
        bridgeId: selectedRuntime.id,
        id: selectedPane.pane_id,
        label: paneTitle(selectedPane),
        x,
        y,
      });
    }
  });

  useEffect(() => {
    if (isCompactLayout) {
      window.scrollTo(0, 0);
      document.documentElement.scrollLeft = 0;
      document.body.scrollLeft = 0;
    }
  }, [isCompactLayout, showDetail]);

  const activeSpace = useMemo(() => {
    if (!snapshot || snapshot.workspaces.length === 0) {
      return null;
    }
    return (
      (activeWorkspaceId &&
        snapshot.workspaces.find((workspace) => workspace.workspace_id === activeWorkspaceId)) ||
      (selectedPane &&
        snapshot.workspaces.find(
          (workspace) => workspace.workspace_id === selectedPane.workspace_id,
        )) ||
      snapshot.workspaces.find((workspace) => workspace.focused) ||
      snapshot.workspaces[0] ||
      null
    );
  }, [snapshot, activeWorkspaceId, selectedPane]);

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

  const showSplit = !isCompactLayout && splitCells !== null;

  // Mirror browser navigation to the herdr session so `active_tab_id` tracks
  // what we're viewing here. `tab.focus` also activates the tab's workspace, so
  // a workspace-only focus is just the fallback for a space with no panes yet.
  const pushFocus = (runtime: BridgeRuntime | null, tabId?: string, workspaceId?: string) => {
    if (!runtime || runtime.capabilityState !== "ready") {
      return;
    }
    const commands = createCommands(runtime.httpUrl);
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

  const openPane = (bridgeId: BridgeId, pane: PaneInfo) => {
    const runtime = bridge.getRuntime(bridgeId);
    if (!runtime) {
      return;
    }
    setSelectedBridgeId(bridgeId);
    bridge.markBridgeUsed(bridgeId);
    rememberPaneSelection(bridgeId, pane.pane_id, pane.workspace_id);
    if (runtime.capabilityState === "ready") {
      void syncSelectedPane(runtime.httpUrl, pane.pane_id).catch(() => {});
    }
    pushFocus(runtime, pane.tab_id, pane.workspace_id);
    if (isCompactLayout) {
      openMobileDetail();
    }
  };

  const requestTerminalFocus = () => setTerminalFocusToken((token) => token + 1);

  const snapshotForBridge = (bridgeId: BridgeId) => {
    const runtime = bridge.getRuntime(bridgeId);
    if (!runtime) {
      return null;
    }
    const ref = connectionRefs.current[bridgeId];
    if (ref?.connectionKey === runtime.connectionKey && ref.snapshot) {
      return ref.snapshot;
    }
    const state = connectionStates[bridgeId];
    return state?.connectionKey === runtime.connectionKey ? state.snapshot : null;
  };

  const selectSpace = (bridgeId: BridgeId, workspaceId: string) => {
    const runtime = bridge.getRuntime(bridgeId);
    if (!runtime) {
      return;
    }
    const bridgeSnapshot = snapshotForBridge(bridgeId);
    setSelectedBridgeId(bridgeId);
    bridge.markBridgeUsed(bridgeId);
    setActiveWorkspaceRefState({ bridgeId, workspaceId });
    setActiveWorkspacesByBridgeId((current) =>
      current[bridgeId] === workspaceId ? current : { ...current, [bridgeId]: workspaceId },
    );
    if (!isCompactLayout && bridgeSnapshot) {
      const paneId = choosePaneForWorkspace(bridgeSnapshot, workspaceId);
      if (paneId) {
        const pane = bridgeSnapshot.panes.find((item) => item.pane_id === paneId);
        rememberPaneSelection(bridgeId, paneId, pane?.workspace_id ?? workspaceId);
        if (runtime.capabilityState === "ready") {
          void syncSelectedPane(runtime.httpUrl, paneId).catch(() => {});
        }
        pushFocus(runtime, pane?.tab_id, workspaceId);
        return;
      }
      setSelectedPaneRefState(null);
    }
    pushFocus(runtime, undefined, workspaceId);
  };

  const selectTab = (bridgeId: BridgeId, tabId: string) => {
    const bridgeSnapshot = snapshotForBridge(bridgeId);
    if (!bridgeSnapshot) {
      return;
    }
    const paneId = choosePaneForTab(bridgeSnapshot, tabId);
    if (paneId) {
      const pane = bridgeSnapshot.panes.find((item) => item.pane_id === paneId);
      if (pane) {
        openPane(bridgeId, pane);
      }
    }
  };

  const focusTab = (bridgeId: BridgeId, tabId: string) => {
    selectTab(bridgeId, tabId);
    requestTerminalFocus();
  };

  const focusPane = (bridgeId: BridgeId, pane: PaneInfo) => {
    openPane(bridgeId, pane);
    requestTerminalFocus();
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const navigationShortcut = isAppNavigationShortcut(event);
      const closeTabShortcut = isCloseTabShortcut(event);
      const newTabShortcut = isNewTabShortcut(event);
      const splitDirection = splitSupported ? splitShortcutDirection(event) : null;
      const paneFocusDirection = paneFocusSupported ? paneFocusShortcutDirection(event) : null;
      const paneCycleStep = paneCycleShortcutStep(event);
      if (
        (!navigationShortcut &&
          !closeTabShortcut &&
          !newTabShortcut &&
          !splitDirection &&
          !paneFocusDirection &&
          paneCycleStep === 0) ||
        isShortcutTextEntryTarget(event.target) ||
        !snapshot ||
        !selectedRuntime ||
        busy ||
        menu ||
        dialog ||
        launchTarget ||
        hasOpenModal()
      ) {
        return;
      }

      if (paneFocusDirection) {
        if (!selectedPane || !selectedCommands) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        void exec(
          selectedRuntime,
          () => selectedCommands.focusPaneDirection(selectedPane.pane_id, paneFocusDirection),
          true,
        ).then((ok) => ok && requestTerminalFocus());
        return;
      }

      if (paneCycleStep !== 0) {
        const panes = orderedShortcutTabPanes(snapshot, activeSpace, selectedPane);
        if (panes.length === 0) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const currentIndex = selectedPane
          ? panes.findIndex((pane) => pane.pane_id === selectedPane.pane_id)
          : -1;
        const fallbackIndex = paneCycleStep > 0 ? 0 : panes.length - 1;
        const nextIndex =
          currentIndex === -1
            ? fallbackIndex
            : (currentIndex + paneCycleStep + panes.length) % panes.length;
        if (selectedRuntime) {
          focusPane(selectedRuntime.id, panes[nextIndex]);
        }
        return;
      }

      if (splitDirection) {
        if (!selectedPane || !selectedCommands) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        void exec(
          selectedRuntime,
          () => selectedCommands.splitPane(selectedPane.pane_id, splitDirection),
          true,
        ).then((ok) => ok && requestTerminalFocus());
        return;
      }

      if (newTabShortcut) {
        if (!activeSpace) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (selectedRuntime) {
          setLaunchTarget({
            mode: "tab",
            workspaceId: activeSpace.workspace_id,
            bridgeId: selectedRuntime.id,
          });
        }
        return;
      }

      if (closeTabShortcut) {
        const tab = activeShortcutTab(snapshot, activeSpace, selectedPane);
        if (!tab) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const tabPanes = sortPanesForTab(snapshot.panes, tab.tab_id);
        if (tabPanes.length > 1 && selectedPane?.tab_id === tab.tab_id) {
          setDialog({
            mode: "close",
            kind: "pane",
            bridgeId: selectedRuntime.id,
            id: selectedPane.pane_id,
            label: paneTitle(selectedPane),
          });
          return;
        }
        setDialog({
          mode: "close",
          kind: "tab",
          bridgeId: selectedRuntime.id,
          id: tab.tab_id,
          label: displayTabLabel(tab, snapshot.panes),
        });
        return;
      }

      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        const agentPanes = orderedShortcutAgentPanes(
          snapshot,
          scope,
          activeSpace?.workspace_id,
          agentSort,
          agentGroup,
        );
        if (agentPanes.length === 0) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const currentIndex = selectedPane
          ? agentPanes.findIndex((pane) => pane.pane_id === selectedPane.pane_id)
          : -1;
        const step = event.key === "ArrowDown" ? 1 : -1;
        const fallbackIndex = step > 0 ? 0 : agentPanes.length - 1;
        const nextIndex =
          currentIndex === -1
            ? fallbackIndex
            : (currentIndex + step + agentPanes.length) % agentPanes.length;
        if (selectedRuntime) {
          focusPane(selectedRuntime.id, agentPanes[nextIndex]);
        }
        return;
      }

      const workspace = activeSpace;
      if (!workspace || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) {
        return;
      }
      const tabs = sortTabsForWorkspace(snapshot.tabs, workspace.workspace_id);
      if (tabs.length === 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const activeTabId =
        selectedPane && selectedPane.workspace_id === workspace.workspace_id
          ? selectedPane.tab_id
          : workspace.active_tab_id;
      const currentIndex = tabs.findIndex((tab) => tab.tab_id === activeTabId);
      const step = event.key === "ArrowRight" ? 1 : -1;
      const fallbackIndex = step > 0 ? 0 : tabs.length - 1;
      const nextIndex =
        currentIndex === -1 ? fallbackIndex : (currentIndex + step + tabs.length) % tabs.length;
      if (selectedRuntime) {
        focusTab(selectedRuntime.id, tabs[nextIndex].tab_id);
      }
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [
    activeSpace,
    agentGroup,
    agentSort,
    busy,
    dialog,
    isCompactLayout,
    launchTarget,
    menu,
    paneFocusSupported,
    scope,
    selectedPane,
    selectedRuntime,
    selectedCommands,
    splitSupported,
    snapshot,
  ]);

  const refreshNow = () => {
    const connectableRuntimes = bridge.enabledRuntimes.filter((runtime) => runtime.canConnect);
    if (connectableRuntimes.length === 0) {
      setBackendSettingsOpen(true);
      return;
    }
    for (const runtime of connectableRuntimes) {
      void refreshBridgeSnapshot(runtime, true);
    }
  };

  async function refreshBridgeSnapshot(runtime: BridgeRuntime, setLoading: boolean) {
    const ref = ensureBridgeConnectionRef(connectionRefs, runtime);
    const requestConnectionKey = runtime.connectionKey;
    const refreshGeneration = ref.activityGeneration;
    if (setLoading) {
      setConnectionStates((current) => ({
        ...current,
        [runtime.id]: {
          connectionKey: requestConnectionKey,
          snapshot: current[runtime.id]?.snapshot ?? null,
          loadState: "loading",
        },
      }));
    }
    try {
      const next = await fetchSnapshot(runtime.httpUrl);
      const currentRef = connectionRefs.current[runtime.id];
      if (
        !currentRef ||
        !isConnectionResultCurrent(currentRef.connectionKey, requestConnectionKey)
      ) {
        return null;
      }
      if (currentRef.resyncBarrierGeneration > refreshGeneration) {
        return refreshBridgeSnapshot(runtime, false);
      }
      const patched = replayActivityMessages(next, currentRef.activityLog, refreshGeneration);
      currentRef.snapshot = patched;
      setConnectionStates((current) => ({
        ...current,
        [runtime.id]: {
          connectionKey: requestConnectionKey,
          snapshot: patched,
          loadState: "ready",
        },
      }));
      return patched;
    } catch {
      const currentRef = connectionRefs.current[runtime.id];
      if (currentRef?.connectionKey === requestConnectionKey) {
        setConnectionStates((current) => ({
          ...current,
          [runtime.id]: {
            connectionKey: requestConnectionKey,
            snapshot: current[runtime.id]?.snapshot ?? null,
            loadState: "error",
          },
        }));
      }
      return null;
    }
  }

  async function exec(
    runtime: BridgeRuntime | null,
    action: () => Promise<{ [key: string]: unknown }>,
    selectCreated = false,
  ) {
    if (
      !runtime ||
      runtime.capabilityState !== "ready" ||
      !runtime.canConnect ||
      !connectionRefs.current[runtime.id]?.snapshot
    ) {
      setError("Bridge is not ready");
      return false;
    }
    const requestConnectionKey = runtime.connectionKey;
    setBusy(true);
    try {
      const result = await action();
      let ref = connectionRefs.current[runtime.id];
      let refreshGeneration = ref?.activityGeneration ?? 0;
      let next = await fetchSnapshot(runtime.httpUrl);
      while (ref && ref.resyncBarrierGeneration > refreshGeneration) {
        refreshGeneration = ref.activityGeneration;
        next = await fetchSnapshot(runtime.httpUrl);
        ref = connectionRefs.current[runtime.id];
      }
      if (!ref || !isConnectionResultCurrent(ref.connectionKey, requestConnectionKey)) {
        return false;
      }
      const patched = replayActivityMessages(next, ref.activityLog, refreshGeneration);
      ref.snapshot = patched;
      setConnectionStates((current) => ({
        ...current,
        [runtime.id]: {
          connectionKey: requestConnectionKey,
          snapshot: patched,
          loadState: "ready",
        },
      }));
      if (selectCreated) {
        const paneId = createdPaneId(result);
        const created = paneId ? patched.panes.find((pane) => pane.pane_id === paneId) : undefined;
        if (created) {
          setSelectedBridgeId(runtime.id);
          rememberPaneSelection(runtime.id, created.pane_id, created.workspace_id);
          void syncSelectedPane(runtime.httpUrl, created.pane_id).catch(() => {});
          if (isCompactLayout) {
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
    const { kind, bridgeId, id, label, clearable } = menu;
    const runtime = bridge.getRuntime(bridgeId);
    const commands = runtime ? createCommands(runtime.httpUrl) : null;
    setMenu(null);
    if (key === "rename") {
      setDialog({ mode: "rename", kind, bridgeId, id, label, clearable });
    } else if (key === "close") {
      setDialog({ mode: "close", kind, bridgeId, id, label });
    } else if (key === "newtab") {
      setSelectedBridgeId(bridgeId);
      setActiveWorkspaceRefState({ bridgeId, workspaceId: id });
      setActiveWorkspacesByBridgeId((current) =>
        current[bridgeId] === id ? current : { ...current, [bridgeId]: id },
      );
      setLaunchTarget({ mode: "tab", workspaceId: id, bridgeId });
    } else if (key === "move_new_tab" && kind === "pane") {
      const pane = connectionRefs.current[bridgeId]?.snapshot?.panes.find(
        (item) => item.pane_id === id,
      );
      if (!pane || !commands) {
        setError("Pane not found");
        return;
      }
      void exec(runtime, () => commands.movePaneToNewTab(id, pane.workspace_id, label), true);
    } else if (key === "move_new_space" && kind === "pane") {
      if (!commands) {
        setError("Bridge is not ready");
        return;
      }
      void exec(runtime, () => commands.movePaneToNewWorkspace(id, label), true);
    }
  };

  const submitRename = (value: string) => {
    if (!dialog) {
      return;
    }
    const { kind, bridgeId, id } = dialog;
    const runtime = bridge.getRuntime(bridgeId);
    const commands = runtime ? createCommands(runtime.httpUrl) : null;
    if (!commands) {
      setError("Bridge is not ready");
      return;
    }
    const action =
      kind === "space"
        ? () => commands.renameWorkspace(id, value)
        : kind === "tab"
          ? () => commands.renameTab(id, value)
          : () => commands.renamePane(id, value);
    void exec(runtime, action).then((ok) => ok && setDialog(null));
  };

  const clearRename = () => {
    if (!dialog || dialog.kind === "pane") {
      return;
    }
    const { kind, bridgeId, id } = dialog;
    const runtime = bridge.getRuntime(bridgeId);
    const commands = runtime ? createCommands(runtime.httpUrl) : null;
    if (!commands) {
      setError("Bridge is not ready");
      return;
    }
    const action =
      kind === "space"
        ? () => commands.renameWorkspace(id, null)
        : () => commands.renameTab(id, null);
    void exec(runtime, action).then((ok) => ok && setDialog(null));
  };

  const confirmClose = () => {
    if (!dialog) {
      return;
    }
    const { kind, bridgeId, id } = dialog;
    const runtime = bridge.getRuntime(bridgeId);
    const commands = runtime ? createCommands(runtime.httpUrl) : null;
    if (!commands) {
      setError("Bridge is not ready");
      return;
    }
    const action =
      kind === "space"
        ? () => commands.closeWorkspace(id)
        : kind === "tab"
          ? () => commands.closeTab(id)
          : () => commands.closePane(id);
    void exec(runtime, action).then((ok) => ok && setDialog(null));
  };

  const submitLaunch = (spec: LaunchSpec) => {
    if (!launchTarget) {
      return;
    }
    const runtime = bridge.getRuntime(launchTarget.bridgeId);
    const commands = runtime ? createCommands(runtime.httpUrl) : null;
    if (!runtime || !commands) {
      setError("Bridge is not ready");
      return;
    }
    const launchSnapshot =
      connectionRefs.current[launchTarget.bridgeId]?.snapshot ??
      (launchTarget.bridgeId === selectedRuntime?.id ? snapshot : null);
    const resolvedSpec = resolveLaunchSpec(spec, launchSnapshot?.panes ?? []);
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
    void exec(runtime, action, true).then((ok) => ok && setLaunchTarget(null));
  };

  const renderTerminal = !isCompactLayout || showDetail;
  const appStyle = {
    "--sidebar-w": `${sidebarWidth}px`,
    "--content-inset-top": `${contentInsetTopPx}px`,
    "--content-inset-bottom": `${contentInsetBottomPx}px`,
    "--mobile-controls-scale": String(mobileControlsScalePercent / 100),
  } as CSSProperties &
    Record<
      | "--sidebar-w"
      | "--content-inset-top"
      | "--content-inset-bottom"
      | "--mobile-controls-scale",
      string
    >;

  return (
    <div
      className="app"
      style={appStyle}
      data-sidebar={sidebarOpen ? "open" : "closed"}
      data-resizing-sidebar={resizingSidebar ? "true" : "false"}
      data-compact={isCompactLayout ? "true" : "false"}
      data-touch={isTouchInput ? "true" : "false"}
      data-detail={isCompactLayout && showDetail ? "true" : "false"}
    >
      {bridge.enabledRuntimes.map((runtime) => (
        <BridgeConnectionController
          key={runtime.id}
          runtime={runtime}
          connectionRefs={connectionRefs}
          setConnectionStates={setConnectionStates}
          onPaneSelection={rememberPaneSelection}
        />
      ))}
      <aside className="sidebar" aria-label="Switcher">
        <Switcher
          bridgeViews={bridgeViews}
          selectedBridgeId={selectedRuntime?.id ?? null}
          hostScope={hostScope}
          snapshot={snapshot}
          loadState={loadState}
          bridgeCanConnect={selectedRuntime?.canConnect ?? false}
          bridgeError={selectedRuntime?.capabilityError ?? null}
          bridgeLabel={selectedRuntime?.label ?? "No bridge"}
          bridgeMode={selectedRuntime?.mode ?? "configured"}
          capabilityState={selectedRuntime?.capabilityState ?? "idle"}
          scope={scope}
          sidebarView={sidebarView}
          agentSort={agentSort}
          agentGroup={agentGroup}
          activeSpace={activeSpace}
          activeWorkspacesByBridgeId={activeWorkspacesByBridgeId}
          selectedPane={selectedPane}
          onHostScope={setHostScope}
          onScope={setScope}
          onSidebarView={setSidebarView}
          onAgentSort={setAgentSort}
          onAgentGroup={setAgentGroup}
          onSelectBridge={setSelectedBridgeId}
          onSelectSpace={selectSpace}
          onSelectTab={selectTab}
          onSelectPane={openPane}
          onRefresh={refreshNow}
          onRefreshBridge={(bridgeId) => {
            bridge.retryBridgeProbe(bridgeId);
            const runtime = bridge.getRuntime(bridgeId);
            if (runtime?.canConnect) {
              void refreshBridgeSnapshot(runtime, true);
            }
          }}
          onBackendSettings={() => setBackendSettingsOpen(true)}
          onCreateSpace={() =>
            selectedRuntime && selectedCommands
              ? void exec(selectedRuntime, () => selectedCommands.createWorkspace(), true)
              : setError("Bridge is not ready")
          }
          onCreateTab={(bridgeId, workspaceId) =>
            setLaunchTarget({ mode: "tab", workspaceId, bridgeId })
          }
          onMenu={(kind, id, label, x, y, clearable) =>
            selectedRuntime
              ? setMenu({ kind, bridgeId: selectedRuntime.id, id, label, x, y, clearable })
              : undefined
          }
          onScopedMenu={(kind, bridgeId, id, label, x, y, clearable) =>
            setMenu({ kind, bridgeId, id, label, x, y, clearable })
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
            if (isCompactLayout || !sidebarOpen) {
              return;
            }
            event.preventDefault();
            clearSidebarResizePress();
            if (event.pointerType === "mouse") {
              setResizingSidebar(true);
              return;
            }
            const target = event.currentTarget;
            target.setPointerCapture(event.pointerId);
            const x = event.clientX;
            const y = event.clientY;
            const pointerId = event.pointerId;
            const timer = window.setTimeout(() => {
              sidebarResizePressRef.current = null;
              if (target.hasPointerCapture(pointerId)) {
                target.releasePointerCapture(pointerId);
              }
              setSidebarWidth(clampSidebarWidth(x));
              setResizingSidebar(true);
            }, 360);
            sidebarResizePressRef.current = { timer, pointerId, x, y, target };
          }}
          onPointerMove={(event) => {
            const pending = sidebarResizePressRef.current;
            if (!pending || pending.pointerId !== event.pointerId) {
              return;
            }
            if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 12) {
              clearSidebarResizePress();
            }
          }}
          onPointerUp={clearSidebarResizePress}
          onPointerCancel={clearSidebarResizePress}
          onKeyDown={(event) => {
            if (isCompactLayout) {
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
          onSelectTab={(tabId) => selectedRuntime && selectTab(selectedRuntime.id, tabId)}
          onCreateTab={(workspaceId) =>
            selectedRuntime &&
            setLaunchTarget({ mode: "tab", workspaceId, bridgeId: selectedRuntime.id })
          }
          onMenu={(kind, id, label, x, y, clearable) =>
            selectedRuntime &&
            setMenu({ kind, bridgeId: selectedRuntime.id, id, label, x, y, clearable })
          }
        />
        <header className="stage-bar">
          <button
            className="icon-btn"
            type="button"
            aria-label={isCompactLayout ? "Back to switcher" : "Toggle sidebar"}
            title={isCompactLayout ? "Back" : "Toggle sidebar"}
            onClick={() => (isCompactLayout ? closeMobileDetail() : setSidebarOpen((open) => !open))}
          >
            {isCompactLayout ? <ChevronLeft size={20} /> : <PanelLeft size={18} />}
          </button>
          <div className="stage-id" {...selectedPaneMenuPress}>
            <span className="stage-title">{selectedPane ? paneTitle(selectedPane) : "herdr-web"}</span>
            <span className="stage-sub mono">
              {stageBreadcrumb(snapshot, selectedPane, loadState, selectedRuntime?.canConnect ?? false)}
            </span>
          </div>
          {splitSupported && selectedPane && !isCompactLayout ? (
            <>
              <button
                className="icon-btn"
                type="button"
                aria-label="Split right"
                title="Split right"
                disabled={busy}
                onClick={() =>
                  selectedRuntime
                    ? setLaunchTarget({
                        mode: "split",
                        pane: selectedPane,
                        direction: "right",
                        bridgeId: selectedRuntime.id,
                      })
                    : undefined
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
                  selectedRuntime
                    ? setLaunchTarget({
                        mode: "split",
                        pane: selectedPane,
                        direction: "down",
                        bridgeId: selectedRuntime.id,
                      })
                    : undefined
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
            onSelectPane={(pane) => {
              if (selectedRuntime) {
                openPane(selectedRuntime.id, pane);
              }
              if (isTouchInput) {
                requestTerminalFocus();
              }
            }}
            refitToken={refitToken}
            focusToken={terminalFocusToken}
            touchInput={isTouchInput}
            mobileTapTarget={mobileTerminalTapTarget}
            mobileTouchSelection={mobileTouchSelection}
            terminalInputTransport={terminalInputTransport}
            terminalInputBatchDelayMs={terminalInputBatchDelayMs}
            terminalOutputCoalesceMs={terminalOutputCoalesceMs}
            connectionKey={selectedRuntime?.connectionKey ?? "disconnected"}
            resumeToken={selectedRuntime?.resumeToken ?? 0}
            httpUrl={selectedHttpUrl}
            wsUrl={selectedWsUrl}
          />
        ) : renderTerminal ? (
          <TerminalView
            pane={selectedPane}
            connectionKey={selectedRuntime?.connectionKey ?? "disconnected"}
            resumeToken={selectedRuntime?.resumeToken ?? 0}
            httpUrl={selectedHttpUrl}
            wsUrl={selectedWsUrl}
            autoFocus={!isTouchInput}
            scrollSensitivity={isTouchInput ? 2 : 0.4}
            mobileControls={isTouchInput}
            mobileTapTarget={mobileTerminalTapTarget}
            mobileTouchSelection={mobileTouchSelection}
            terminalInputTransport={terminalInputTransport}
            terminalInputBatchDelayMs={terminalInputBatchDelayMs}
            terminalOutputCoalesceMs={terminalOutputCoalesceMs}
            refitToken={refitToken}
            focusToken={terminalFocusToken}
          />
        ) : (
          <div className="terminal-stage" aria-hidden="true" />
        )}
      </section>

      {menu && activeMenuItems.length > 0 ? (
        <ActionMenu
          x={menu.x}
          y={menu.y}
          title={menu.label}
          items={activeMenuItems}
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

      {backendSettingsOpen ? (
        <BackendSettingsDialog
          showMobileTerminalSettings={isTouchInput}
          terminalInputTransport={terminalInputTransport}
          onTerminalInputTransport={setTerminalInputTransport}
          terminalInputBatchDelayMs={terminalInputBatchDelayMs}
          onTerminalInputBatchDelayMs={setTerminalInputBatchDelayMs}
          terminalOutputCoalesceMs={terminalOutputCoalesceMs}
          onTerminalOutputCoalesceMs={setTerminalOutputCoalesceMs}
          contentInsetTopPx={contentInsetTopPx}
          onContentInsetTopPx={setContentInsetTopPx}
          contentInsetBottomPx={contentInsetBottomPx}
          onContentInsetBottomPx={setContentInsetBottomPx}
          mobileControlsScalePercent={mobileControlsScalePercent}
          onMobileControlsScalePercent={setMobileControlsScalePercent}
          mobileTerminalTapTarget={mobileTerminalTapTarget}
          onMobileTerminalTapTarget={setMobileTerminalTapTarget}
          mobileTouchSelection={mobileTouchSelection}
          onMobileTouchSelection={setMobileTouchSelection}
          showMobileKeyboardHideRefit={showMobileKeyboardHideRefit}
          mobileKeyboardHideRefit={mobileKeyboardHideRefit}
          onMobileKeyboardHideRefit={setMobileKeyboardHideRefit}
          onClose={() => setBackendSettingsOpen(false)}
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

const SNAPSHOT_REFRESH_INTERVAL_MS = 10000;

export function resolveInitialSelectedBridgeId(
  currentBridgeId: BridgeId | null,
  enabledBridgeIds: readonly BridgeId[],
  lastSelectedBridgeId: BridgeId | null,
) {
  if (currentBridgeId && enabledBridgeIds.includes(currentBridgeId)) {
    return currentBridgeId;
  }
  if (lastSelectedBridgeId && enabledBridgeIds.includes(lastSelectedBridgeId)) {
    return lastSelectedBridgeId;
  }
  return enabledBridgeIds[0] ?? null;
}

export function shouldCollapseHostScope(
  hostScope: HostScope,
  enabledBridgeCount: number,
  storeLoaded: boolean,
) {
  return storeLoaded && hostScope === "all" && enabledBridgeCount <= 1;
}

function BridgeConnectionController({
  runtime,
  connectionRefs,
  setConnectionStates,
  onPaneSelection,
}: {
  runtime: BridgeRuntime;
  connectionRefs: MutableRefObject<Record<string, BridgeConnectionRef>>;
  setConnectionStates: Dispatch<SetStateAction<Record<string, BridgeConnectionState>>>;
  onPaneSelection: (bridgeId: BridgeId, paneId: string, workspaceId?: string) => void;
}) {
  const httpUrlRef = useRef(runtime.httpUrl);
  const wsUrlRef = useRef(runtime.wsUrl);
  const refreshOffsetRef = useRef(stableBridgeRefreshOffsetMs(runtime.id));

  useEffect(() => {
    httpUrlRef.current = runtime.httpUrl;
    wsUrlRef.current = runtime.wsUrl;
  }, [runtime.httpUrl, runtime.wsUrl]);

  useEffect(() => {
    let disposed = false;
    let interval: number | null = null;
    let intervalStartTimer: number | null = null;
    const ref = ensureBridgeConnectionRef(connectionRefs, runtime);

    if (!runtime.canConnect) {
      ref.snapshot = null;
      setConnectionStates((current) => ({
        ...current,
        [runtime.id]: {
          connectionKey: runtime.connectionKey,
          snapshot: null,
          loadState: "ready",
        },
      }));
      return () => {
        disposed = true;
      };
    }

    setConnectionStates((current) => {
      const existing = current[runtime.id];
      if (existing?.connectionKey === runtime.connectionKey && existing.loadState !== "error") {
        return current;
      }
      return {
        ...current,
        [runtime.id]: {
          connectionKey: runtime.connectionKey,
          snapshot: existing?.connectionKey === runtime.connectionKey ? existing.snapshot : null,
          loadState: "loading",
        },
      };
    });

    const requestConnectionKey = runtime.connectionKey;
    const isCurrentConnection = () =>
      !disposed &&
      isConnectionResultCurrent(
        connectionRefs.current[runtime.id]?.connectionKey ?? "",
        requestConnectionKey,
      );
    const refreshController = createSnapshotRefreshController({
      fetchSnapshot: () => fetchSnapshot(httpUrlRef.current),
      getGeneration: () => connectionRefs.current[runtime.id]?.activityGeneration ?? 0,
      getBarrierGeneration: () =>
        connectionRefs.current[runtime.id]?.resyncBarrierGeneration ?? 0,
      isCurrent: isCurrentConnection,
      onError: () =>
        setConnectionStates((current) => ({
          ...current,
          [runtime.id]: {
            connectionKey: requestConnectionKey,
            snapshot:
              current[runtime.id]?.connectionKey === requestConnectionKey
                ? current[runtime.id]?.snapshot ?? null
                : null,
            loadState: "error",
          },
        })),
      applySnapshot: (next, refreshGeneration) => {
        const currentRef = connectionRefs.current[runtime.id];
        if (!currentRef || currentRef.connectionKey !== requestConnectionKey) {
          return;
        }
        const patched = replayActivityMessages(next, currentRef.activityLog, refreshGeneration);
        currentRef.snapshot = patched;
        setConnectionStates((current) => ({
          ...current,
          [runtime.id]: {
            connectionKey: requestConnectionKey,
            snapshot: patched,
            loadState: "ready",
          },
        }));
      },
    });
    const refresh = () => refreshController.request();
    const requestActivityResync = () => {
      const currentRef = connectionRefs.current[runtime.id];
      if (!currentRef) {
        return;
      }
      currentRef.activityGeneration += 1;
      currentRef.resyncBarrierGeneration = currentRef.activityGeneration;
      refresh();
    };

    refresh();
    const refreshOffset = refreshOffsetRef.current;
    intervalStartTimer = window.setTimeout(() => {
      refresh();
      interval = window.setInterval(refresh, SNAPSHOT_REFRESH_INTERVAL_MS);
    }, SNAPSHOT_REFRESH_INTERVAL_MS + refreshOffset);

    const events = openEventsSocket(wsUrlRef.current, "/ws/events", refresh);
    const activity = openEventsSocket(
      wsUrlRef.current,
      "/ws/activity",
      (event) => {
        if (!isCurrentConnection()) {
          return;
        }
        const currentRef = connectionRefs.current[runtime.id];
        if (!currentRef) {
          return;
        }
        const parsed = parseActivityEventData(event.data);
        if (parsed.status === "ignored") {
          return;
        }
        if (parsed.status === "invalid_known") {
          requestActivityResync();
          return;
        }
        const result = applyActivityMessage(currentRef.snapshot, parsed.message);
        if (result.status === "applied") {
          currentRef.activityGeneration += 1;
          currentRef.activityLog = [
            ...currentRef.activityLog,
            { generation: currentRef.activityGeneration, message: parsed.message },
          ].slice(-100);
          currentRef.snapshot = result.snapshot;
          setConnectionStates((current) => ({
            ...current,
            [runtime.id]: {
              connectionKey: requestConnectionKey,
              snapshot: result.snapshot,
              loadState: "ready",
            },
          }));
        } else if (result.status === "resync") {
          requestActivityResync();
        }
      },
      { onOpen: refresh },
    );
    const uiEvents = openEventsSocket(wsUrlRef.current, "/ws/ui-events", (event) => {
      if (!isCurrentConnection()) {
        return;
      }
      const paneId = selectionPaneId(event);
      if (paneId) {
        const pane = connectionRefs.current[runtime.id]?.snapshot?.panes.find(
          (item) => item.pane_id === paneId,
        );
        onPaneSelection(runtime.id, paneId, pane?.workspace_id);
      }
      refresh();
    });

    return () => {
      disposed = true;
      events?.close();
      activity?.close();
      uiEvents?.close();
      if (intervalStartTimer !== null) {
        window.clearTimeout(intervalStartTimer);
      }
      if (interval !== null) {
        window.clearInterval(interval);
      }
    };
  }, [
    connectionRefs,
    onPaneSelection,
    runtime.canConnect,
    runtime.connectionKey,
    runtime.id,
    runtime.resumeToken,
    setConnectionStates,
  ]);

  return null;
}

export function stableBridgeRefreshOffsetMs(bridgeId: BridgeId) {
  let hash = 0;
  for (let index = 0; index < bridgeId.length; index += 1) {
    hash = (hash * 31 + bridgeId.charCodeAt(index)) >>> 0;
  }
  return hash % SNAPSHOT_REFRESH_INTERVAL_MS;
}

function ensureBridgeConnectionRef(
  connectionRefs: MutableRefObject<Record<string, BridgeConnectionRef>>,
  runtime: BridgeRuntime,
) {
  const existing = connectionRefs.current[runtime.id];
  if (existing?.connectionKey === runtime.connectionKey) {
    return existing;
  }
  const next: BridgeConnectionRef = {
    connectionKey: runtime.connectionKey,
    snapshot: null,
    activityGeneration: 0,
    resyncBarrierGeneration: 0,
    activityLog: [],
  };
  connectionRefs.current[runtime.id] = next;
  return next;
}

function orderedShortcutAgentPanes(
  snapshot: Snapshot,
  scope: Scope,
  activeWorkspaceId: string | undefined,
  agentSort: AgentSort,
  agentGroup: AgentGroup,
) {
  const scoped =
    scope === "all"
      ? snapshot.panes
      : snapshot.panes.filter((pane) => pane.workspace_id === activeWorkspaceId);
  const agentPanes = sortAgentPanes(scoped.filter(isAgentPane), agentSort, snapshot);
  if (agentGroup !== "workspace" && agentGroup !== "hostWorkspace") {
    return agentPanes;
  }

  const panesByWorkspace = new Map<string, PaneInfo[]>();
  for (const pane of agentPanes) {
    const panes = panesByWorkspace.get(pane.workspace_id) ?? [];
    panes.push(pane);
    panesByWorkspace.set(pane.workspace_id, panes);
  }

  return snapshot.workspaces.flatMap((workspace) => panesByWorkspace.get(workspace.workspace_id) ?? []);
}

function orderedShortcutTabPanes(
  snapshot: Snapshot,
  activeSpace: WorkspaceInfo | null,
  selectedPane: PaneInfo | null,
) {
  const tab = activeShortcutTab(snapshot, activeSpace, selectedPane);
  return tab ? sortPanesForTab(snapshot.panes, tab.tab_id) : [];
}

function isAppNavigationShortcut(event: KeyboardEvent) {
  return (
    isPlatformShortcutModifier(event) &&
    event.shiftKey &&
    (event.key === "ArrowUp" ||
      event.key === "ArrowDown" ||
      event.key === "ArrowLeft" ||
      event.key === "ArrowRight")
  );
}

function isCloseTabShortcut(event: KeyboardEvent) {
  return (
    isPlatformShortcutModifier(event) &&
    event.shiftKey &&
    event.code === "KeyX"
  );
}

function isNewTabShortcut(event: KeyboardEvent) {
  return isPlatformShortcutModifier(event) && event.shiftKey && event.code === "KeyT";
}

function paneFocusShortcutDirection(event: KeyboardEvent): PaneFocusDirection | null {
  if (!isPlatformShortcutModifier(event)) {
    return null;
  }
  if (event.code === "KeyH") {
    return "left";
  }
  if (event.code === "KeyJ") {
    return "down";
  }
  if (event.code === "KeyK") {
    return "up";
  }
  if (event.code === "KeyL") {
    return "right";
  }
  return null;
}

function paneCycleShortcutStep(event: KeyboardEvent) {
  if (!isPlatformShortcutModifier(event) || event.key !== "Tab") {
    return 0;
  }
  return event.shiftKey ? -1 : 1;
}

function splitShortcutDirection(event: KeyboardEvent): SplitDirection | null {
  if (!isPlatformShortcutModifier(event) || !event.shiftKey) {
    return null;
  }
  if (event.code === "KeyV") {
    return "down";
  }
  if (event.code === "Minus") {
    return "right";
  }
  return null;
}

function isPlatformShortcutModifier(event: KeyboardEvent) {
  return !event.ctrlKey && event.metaKey !== event.altKey;
}

function activeShortcutTab(
  snapshot: Snapshot,
  activeSpace: WorkspaceInfo | null,
  selectedPane: PaneInfo | null,
): TabInfo | null {
  const tabId =
    selectedPane && selectedPane.workspace_id === activeSpace?.workspace_id
      ? selectedPane.tab_id
      : activeSpace?.active_tab_id;
  if (!tabId) {
    return null;
  }
  return snapshot.tabs.find((tab) => tab.tab_id === tabId) ?? null;
}

function isShortcutTextEntryTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.classList.contains("ghostty-hidden-input")) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  return target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement;
}

function hasOpenModal() {
  return document.querySelector(".overlay-root [role='dialog']") !== null;
}

function SplitGrid({
  cells,
  selectedPaneId,
  onSelectPane,
  refitToken,
  focusToken,
  touchInput,
  mobileTapTarget,
  mobileTouchSelection,
  terminalInputTransport,
  terminalInputBatchDelayMs,
  terminalOutputCoalesceMs,
  connectionKey,
  resumeToken,
  httpUrl,
  wsUrl,
}: {
  cells: { pane: PaneInfo; style: CSSProperties }[];
  selectedPaneId: string | null;
  onSelectPane: (pane: PaneInfo) => void;
  refitToken: number;
  focusToken: number;
  touchInput: boolean;
  mobileTapTarget: MobileTerminalTapTarget;
  mobileTouchSelection: boolean;
  terminalInputTransport: TerminalInputTransport;
  terminalInputBatchDelayMs: number;
  terminalOutputCoalesceMs: number;
  connectionKey: string;
  resumeToken: number;
  httpUrl: (path: string, query?: URLSearchParams) => string;
  wsUrl: (path: string, query?: URLSearchParams) => string;
}) {
  return (
    <div className="pane-grid" aria-label="Split panes">
      {cells.map(({ pane, style }) => {
        const selected = pane.pane_id === selectedPaneId;
        return (
          <div
            key={pane.pane_id}
            className="pane-cell"
            data-selected={selected}
            style={style}
            onPointerDown={() => onSelectPane(pane)}
          >
            <TerminalView
              pane={pane}
              connectionKey={connectionKey}
              resumeToken={resumeToken}
              httpUrl={httpUrl}
              wsUrl={wsUrl}
              autoFocus={selected && !touchInput}
              scrollSensitivity={touchInput ? 2 : 0.4}
              mobileControls={selected && touchInput}
              mobileTapTarget={mobileTapTarget}
              mobileTouchSelection={mobileTouchSelection}
              terminalInputTransport={terminalInputTransport}
              terminalInputBatchDelayMs={terminalInputBatchDelayMs}
              terminalOutputCoalesceMs={terminalOutputCoalesceMs}
              refitToken={selected ? refitToken : 0}
              focusToken={selected ? focusToken : 0}
            />
          </div>
        );
      })}
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
  bridgeViews,
  selectedBridgeId,
  hostScope,
  snapshot,
  loadState,
  bridgeCanConnect,
  bridgeError,
  bridgeLabel,
  bridgeMode,
  capabilityState,
  scope,
  sidebarView,
  agentSort,
  agentGroup,
  activeSpace,
  activeWorkspacesByBridgeId,
  selectedPane,
  onHostScope,
  onScope,
  onSidebarView,
  onAgentSort,
  onAgentGroup,
  onSelectBridge,
  onSelectSpace,
  onSelectTab,
  onSelectPane,
  onRefresh,
  onRefreshBridge,
  onBackendSettings,
  onCreateSpace,
  onCreateTab,
  onMenu,
  onScopedMenu,
}: {
  bridgeViews: BridgeConnectionView[];
  selectedBridgeId: BridgeId | null;
  hostScope: HostScope;
  snapshot: Snapshot | null;
  loadState: LoadState;
  bridgeCanConnect: boolean;
  bridgeError: string | null;
  bridgeLabel: string;
  bridgeMode: "same-origin" | "configured" | "disconnected";
  capabilityState: "idle" | "probing" | "ready" | "error";
  scope: Scope;
  sidebarView: SidebarView;
  agentSort: AgentSort;
  agentGroup: AgentGroup;
  activeSpace: WorkspaceInfo | null;
  activeWorkspacesByBridgeId: Record<string, string>;
  selectedPane: PaneInfo | null;
  onHostScope: (scope: HostScope) => void;
  onScope: (scope: Scope) => void;
  onSidebarView: (view: SidebarView) => void;
  onAgentSort: (sort: AgentSort) => void;
  onAgentGroup: (group: AgentGroup) => void;
  onSelectBridge: (bridgeId: BridgeId) => void;
  onSelectSpace: (bridgeId: BridgeId, workspaceId: string) => void;
  onSelectTab: (bridgeId: BridgeId, tabId: string) => void;
  onSelectPane: (bridgeId: BridgeId, pane: PaneInfo) => void;
  onRefresh: () => void;
  onRefreshBridge: (bridgeId: BridgeId) => void;
  onBackendSettings: () => void;
  onCreateSpace: () => void;
  onCreateTab: (bridgeId: BridgeId, workspaceId: string) => void;
  onMenu: (
    kind: MenuKind,
    id: string,
    label: string,
    x: number,
    y: number,
    clearable?: boolean,
  ) => void;
  onScopedMenu: (
    kind: MenuKind,
    bridgeId: BridgeId,
    id: string,
    label: string,
    x: number,
    y: number,
    clearable?: boolean,
  ) => void;
}) {
  const [optionsMenu, setOptionsMenu] = useState<{ x: number; y: number } | null>(null);
  const selectedBridgeView = selectedBridgeId
    ? (bridgeViews.find((view) => view.runtime.id === selectedBridgeId) ?? null)
    : null;
  const hostBridgeViews =
    hostScope === "all" ? bridgeViews : selectedBridgeView ? [selectedBridgeView] : [];
  const activeWorkspaceForView = useCallback((view: BridgeConnectionView) => {
    const viewSnapshot = view.snapshot;
    if (!viewSnapshot || viewSnapshot.workspaces.length === 0) {
      return null;
    }
    const preferredWorkspaceId =
      view.runtime.id === selectedBridgeId
        ? (activeSpace?.workspace_id ?? activeWorkspacesByBridgeId[view.runtime.id])
        : activeWorkspacesByBridgeId[view.runtime.id];
    return (
      (preferredWorkspaceId &&
        viewSnapshot.workspaces.find((workspace) => workspace.workspace_id === preferredWorkspaceId)) ||
      viewSnapshot.workspaces.find((workspace) => workspace.focused) ||
      viewSnapshot.workspaces[0] ||
      null
    );
  }, [activeSpace?.workspace_id, activeWorkspacesByBridgeId, selectedBridgeId]);
  const scopedWorkspaces = useMemo<ScopedWorkspace[]>(
    () =>
      hostBridgeViews.flatMap((view) => {
        const viewSnapshot = view.snapshot;
        if (!viewSnapshot) {
          return [];
        }
        const bridgeIndex = Math.max(
          0,
          bridgeViews.findIndex((candidate) => candidate.runtime.id === view.runtime.id),
        );
        const workspaces =
          scope === "all"
            ? viewSnapshot.workspaces
            : [activeWorkspaceForView(view)].filter(
                (workspace): workspace is WorkspaceInfo => workspace !== null,
              );
        return workspaces.map((workspace) => ({
          bridgeId: view.runtime.id,
          bridgeIndex,
          bridgeLabel: view.runtime.label,
          bridgeColor: view.runtime.color,
          snapshot: viewSnapshot,
          workspace,
        }));
      }),
    [
      activeWorkspaceForView,
      bridgeViews,
      hostBridgeViews,
      scope,
    ],
  );
  const panes = scopedWorkspaces.flatMap((entry) =>
    entry.snapshot.panes.filter((pane) => pane.workspace_id === entry.workspace.workspace_id),
  );
  const roll = aggregateStatus(panes);
  const headerSummary = summary(panes);
  const bridgeBlocked =
    bridgeViews.length === 0 ||
    (hostScope === "selected" && (!selectedBridgeView || !bridgeCanConnect));
  const disconnectedBridgeViews =
    hostScope === "all"
      ? bridgeViews.filter(
          (view) => !view.snapshot && (!view.runtime.canConnect || view.loadState === "error"),
        )
      : [];
  const hasListSnapshot =
    hostScope === "all"
      ? hostBridgeViews.some((view) => view.snapshot) || disconnectedBridgeViews.length > 0
      : Boolean(snapshot);

  const agentPanes = useMemo<ScopedAgentPane[]>(() => {
    return sortScopedAgentPanes(
      scopedWorkspaces.flatMap((entry) => {
        const sorted = sortAgentPanes(
          entry.snapshot.panes.filter(
            (pane) => pane.workspace_id === entry.workspace.workspace_id && isAgentPane(pane),
          ),
          agentSort,
          entry.snapshot,
        );
        return sorted.map((pane) => {
          const tab = entry.snapshot.tabs.find((item) => item.tab_id === pane.tab_id);
          return {
            bridgeId: entry.bridgeId,
            bridgeIndex: entry.bridgeIndex,
            bridgeLabel: entry.bridgeLabel,
            bridgeColor: entry.bridgeColor,
            pane,
            snapshot: entry.snapshot,
            workspace: entry.workspace,
            tabNumber: tab?.number,
            tabLabel: tab ? displayTabLabel(tab, entry.snapshot.panes) : undefined,
          };
        });
      }),
      agentSort,
    );
  }, [agentSort, scopedWorkspaces]);

  const agentGroups = useMemo(() => {
    if (agentGroup === "none") {
      return [];
    }
    const paneBuckets = new Map<string, ScopedAgentGroup>();
    const groupByWorkspace = agentGroup === "workspace" || agentGroup === "hostWorkspace";
    for (const entry of agentPanes) {
      const key = groupByWorkspace
        ? `${entry.bridgeId}:${entry.pane.workspace_id}`
        : entry.bridgeId;
      const label =
        agentGroup === "host"
          ? entry.bridgeLabel
          : agentGroup === "hostWorkspace"
            ? (entry.workspace?.label ?? "workspace")
          : hostScope === "all"
            ? `${entry.bridgeLabel} / ${entry.workspace?.label ?? "workspace"}`
            : (entry.workspace?.label ?? "workspace");
      const existing =
        paneBuckets.get(key) ??
        {
          key,
          bridgeId: entry.bridgeId,
          label,
          bridgeColor: entry.bridgeColor,
          status: groupByWorkspace ? entry.workspace?.agent_status : undefined,
          panes: [],
        };
      existing.panes.push(entry);
      paneBuckets.set(key, existing);
    }
    return [...paneBuckets.values()].map((group) => ({
      ...group,
      status: group.status ?? aggregateStatus(group.panes.map((entry) => entry.pane)),
    }));
  }, [agentGroup, agentPanes, hostScope]);

  const spaceGroups = useMemo<ScopedTabWorkspace[]>(
    () =>
      scopedWorkspaces.map((entry) => ({
        ...entry,
        tabs: sortTabsForWorkspace(entry.snapshot.tabs, entry.workspace.workspace_id)
          .map((tab) => ({ tab, panes: sortPanesForTab(entry.snapshot.panes, tab.tab_id) }))
          .filter((group) => group.panes.length > 0),
      })),
    [scopedWorkspaces],
  );
  const spaceCount = hostBridgeViews.reduce(
    (count, view) => count + (view.snapshot?.workspaces.length ?? 0),
    0,
  );
  const showGroupedHostContext = hostScope === "all";
  const showGroupControl =
    sidebarView === "agents" || hostScope === "all" || scope === "all" || agentGroup !== "none";
  const showOptionsControl = sidebarView === "agents" || showGroupControl;
  const canCreateTabFromHeader = Boolean(
    sidebarView === "tabs" &&
      scope === "space" &&
      activeSpace &&
      selectedBridgeId,
  );

  useEffect(() => {
    if (optionsMenu && !showOptionsControl) {
      setOptionsMenu(null);
    }
  }, [optionsMenu, showOptionsControl]);

  let agentPaneIndex = 0;
  let paneIndex = 0;
  const renderTabWorkspaceGroup = (
    group: ScopedTabWorkspace,
    showWorkspaceHeader: boolean,
    showContextInTabLabel: boolean,
    showBridgeInWorkspaceHeader = showGroupedHostContext,
  ) => (
    <Fragment key={`${group.bridgeId}:${group.workspace.workspace_id}`}>
      {showWorkspaceHeader ? (
        <GroupHeader
          label={
            showBridgeInWorkspaceHeader
              ? `${group.bridgeLabel} / ${group.workspace.label}`
              : group.workspace.label
          }
          bridgeColor={showBridgeInWorkspaceHeader ? group.bridgeColor : undefined}
          status={showBridgeInWorkspaceHeader ? undefined : group.workspace.agent_status}
        />
      ) : null}
      {group.tabs.map(({ tab, panes: tabPanes }) => {
        const tabLabel = displayTabLabel(tab, group.snapshot.panes);
        const label = showContextInTabLabel
          ? `${group.bridgeLabel} / ${group.workspace.label} / ${tabLabel}`
          : tabLabel;
        return (
          <div className="tabgrp" key={`${group.bridgeId}:${tab.tab_id}`}>
            {showContextInTabLabel || group.workspace.tab_count > 1 || tabPanes.length > 1 ? (
              <TabDivider
                label={label}
                count={tabPanes.length}
                onSelect={() => onSelectTab(group.bridgeId, tab.tab_id)}
                onMenu={(x, y) =>
                  onScopedMenu(
                    "tab",
                    group.bridgeId,
                    tab.tab_id,
                    tabLabel,
                    x,
                    y,
                    canClearTabName(tab),
                  )
                }
              />
            ) : null}
            {tabPanes.map((pane) => (
              <PaneRow
                key={`${group.bridgeId}:${pane.pane_id}`}
                index={paneIndex++}
                pane={pane}
                active={group.bridgeId === selectedBridgeId && pane.pane_id === selectedPane?.pane_id}
                onSelect={() => onSelectPane(group.bridgeId, pane)}
                onMenu={(x, y) =>
                  onScopedMenu("pane", group.bridgeId, pane.pane_id, paneTitle(pane), x, y)
                }
              />
            ))}
          </div>
        );
      })}
    </Fragment>
  );
  const renderTabGroups = () => {
    if (agentGroup === "host" || (agentGroup === "hostWorkspace" && hostScope === "all")) {
      return hostBridgeViews.map((view) => {
        const groups = spaceGroups.filter(
          (group) => group.bridgeId === view.runtime.id && group.tabs.length > 0,
        );
        if (groups.length === 0) {
          return null;
        }
        return (
          <Fragment key={view.runtime.id}>
            <GroupHeader label={view.runtime.label} bridgeColor={view.runtime.color} />
            {groups.map((group) => renderTabWorkspaceGroup(group, true, false, false))}
          </Fragment>
        );
      });
    }

    if (agentGroup === "workspace" || agentGroup === "hostWorkspace") {
      return spaceGroups.map((group) => renderTabWorkspaceGroup(group, true, false));
    }

    const showContextInTabLabel = hostScope === "all" || scope === "all";
    return spaceGroups.map((group) =>
      renderTabWorkspaceGroup(group, false, showContextInTabLabel),
    );
  };
  const renderDisconnectedBridgeRows = () =>
    disconnectedBridgeViews.map((view) => (
      <DisconnectedBridgeRow
        key={view.runtime.id}
        label={view.runtime.label}
        message={
          view.runtime.capabilityError ||
          (view.loadState === "error" ? "Could not reach bridge" : "Bridge disconnected")
        }
        onSelect={() => {
          onSelectBridge(view.runtime.id);
          onHostScope("selected");
        }}
        onRetry={() => onRefreshBridge(view.runtime.id)}
      />
    ));
  const showAgentRowBridgeLabel = showGroupedHostContext && agentGroup === "none";
  const renderAgentGroupRows = () => {
    const renderGroup = (group: ScopedAgentGroup) => (
      <Fragment key={group.key}>
        <GroupHeader
          label={group.label}
          bridgeColor={agentGroup === "host" ? group.bridgeColor : undefined}
          status={agentGroup === "workspace" || agentGroup === "hostWorkspace" ? group.status : undefined}
        />
        {group.panes.map((entry) => (
          <AgentRow
            key={`${entry.bridgeId}:${entry.pane.pane_id}`}
            index={agentPaneIndex++}
            pane={entry.pane}
            workspace={entry.workspace}
            tabLabel={entry.tabLabel}
            bridgeLabel={showAgentRowBridgeLabel ? entry.bridgeLabel : undefined}
            active={
              entry.bridgeId === selectedBridgeId &&
              entry.pane.pane_id === selectedPane?.pane_id
            }
            onSelect={() => onSelectPane(entry.bridgeId, entry.pane)}
            onMenu={(x, y) =>
              onScopedMenu(
                "pane",
                entry.bridgeId,
                entry.pane.pane_id,
                paneTitle(entry.pane),
                x,
                y,
              )
            }
          />
        ))}
      </Fragment>
    );

    if (agentGroup !== "hostWorkspace" || hostScope !== "all") {
      return agentGroups.map(renderGroup);
    }

    return hostBridgeViews.map((view) => {
      const groups = agentGroups.filter((group) => group.bridgeId === view.runtime.id);
      if (groups.length === 0) {
        return null;
      }
      return (
        <Fragment key={view.runtime.id}>
          <GroupHeader label={view.runtime.label} bridgeColor={view.runtime.color} />
          {groups.map(renderGroup)}
        </Fragment>
      );
    });
  };

  return (
    <>
      <header className="sb-head">
        <div className="brand">
          <span className="brand-mark">
            <img className="brand-logo" src="/herdr-logo.svg" alt="" aria-hidden="true" />
            <span className="brand-title">
              <span className="brand-dot dot" data-status={roll} />
              herdr-web
            </span>
          </span>
          {headerSummary ? (
            <span className="brand-sub">
              <b>{headerSummary}</b>
            </span>
          ) : bridgeMode === "configured" ? (
            <span className="brand-sub">{bridgeLabel}</span>
          ) : null}
        </div>
        <button
          className="icon-btn"
          type="button"
          aria-label="Settings"
          title={`Settings; bridge: ${bridgeLabel}`}
          data-spin={capabilityState === "probing" ? "" : undefined}
          onClick={onBackendSettings}
        >
          <Settings size={16} />
        </button>
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

      <div className="sidebar-scope host-scope" role="group" aria-label="Host">
        {bridgeViews.map((view) => (
          <button
            key={view.runtime.id}
            className="bridge-chip"
            type="button"
            style={{ "--bridge-color": view.runtime.color } as CSSProperties}
            data-on={hostScope === "selected" && selectedBridgeId === view.runtime.id}
            aria-pressed={hostScope === "selected" && selectedBridgeId === view.runtime.id}
            onClick={() => {
              onSelectBridge(view.runtime.id);
              onHostScope("selected");
            }}
          >
            <span className="bridge-chip-dot" aria-hidden="true" />
            <span className="bridge-chip-label">{view.runtime.label}</span>
          </button>
        ))}
        {bridgeViews.length > 1 ? (
          <button
            className="bridge-chip"
            type="button"
            data-on={hostScope === "all"}
            aria-pressed={hostScope === "all"}
            onClick={() => onHostScope("all")}
          >
            <span className="bridge-chip-label">All</span>
          </button>
        ) : null}
      </div>

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
          Space
        </button>
        <button
          type="button"
          data-on={scope === "all"}
          aria-pressed={scope === "all"}
          onClick={() => onScope("all")}
        >
          All
        </button>
      </div>

      <div className="list">
        {!hasListSnapshot ? (
          <div className="empty">
            <strong>
              {bridgeViews.length === 0
                ? "No bridges enabled"
                : bridgeBlocked
                ? "Bridge disconnected"
                : loadState === "error"
                  ? "Bridge unavailable"
                  : "Connecting…"}
            </strong>
            <span>
              {bridgeViews.length === 0
                ? "Enable one or more bridges in settings."
                : bridgeBlocked
                ? bridgeError || "Choose a usable bridge backend."
                : loadState === "error"
                  ? "Could not reach the herdr bridge."
                  : ""}
            </span>
            {bridgeBlocked ? (
              <button type="button" className="btn" onClick={onBackendSettings}>
                Settings
              </button>
            ) : null}
          </div>
        ) : (
          <>
            {/* SPACES ---------------------------------------------------- */}
            {scope === "space" && hostBridgeViews.some((view) => view.snapshot) ? (
            <section className="sec">
              <div className="sec-head">
                <span className="sec-label">spaces</span>
                <span className="sec-rule" />
                <span className="sec-count mono">{spaceCount}</span>
                {hostScope === "selected" ? (
                  <button
                    className="sec-add"
                    type="button"
                    aria-label="New space"
                    title="New space"
                    onClick={onCreateSpace}
                  >
                    <Plus size={14} />
                  </button>
                ) : null}
              </div>
              {spaceCount === 0 ? (
                <div className="empty">
                  <strong>No spaces yet</strong>
                  <span>{hostScope === "selected" ? "Tap + to create one." : "No enabled host has spaces."}</span>
                </div>
              ) : hostScope === "all" ? (
                hostBridgeViews.map((view) => {
                  const viewSnapshot = view.snapshot;
                  if (!viewSnapshot) {
                    return null;
                  }
                  const activeWorkspace = activeWorkspaceForView(view);
                  return (
                    <Fragment key={view.runtime.id}>
                      <GroupHeader label={view.runtime.label} bridgeColor={view.runtime.color} />
                      {viewSnapshot.workspaces.map((workspace, index) => (
                        <SpaceRow
                          key={`${view.runtime.id}:${workspace.workspace_id}`}
                          index={index}
                          workspace={workspace}
                          active={workspace.workspace_id === activeWorkspace?.workspace_id}
                          attention={countAttention(
                            viewSnapshot.panes.filter(
                              (pane) => pane.workspace_id === workspace.workspace_id,
                            ),
                          )}
                          onSelect={() => onSelectSpace(view.runtime.id, workspace.workspace_id)}
                          onMenu={(x, y) =>
                            onScopedMenu(
                              "space",
                              view.runtime.id,
                              workspace.workspace_id,
                              workspace.label,
                              x,
                              y,
                              canClearWorkspaceName(workspace, viewSnapshot.panes),
                            )
                          }
                        />
                      ))}
                    </Fragment>
                  );
                })
              ) : (
                snapshot?.workspaces.map((workspace, index) => (
                  <SpaceRow
                    key={workspace.workspace_id}
                    index={index}
                    workspace={workspace}
                    active={workspace.workspace_id === activeSpace?.workspace_id}
                    attention={countAttention(
                      snapshot.panes.filter((pane) => pane.workspace_id === workspace.workspace_id),
                    )}
                    onSelect={() =>
                      selectedBridgeId ? onSelectSpace(selectedBridgeId, workspace.workspace_id) : undefined
                    }
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
                )) ?? null
              )}
            </section>
            ) : null}

            {/* PANES ----------------------------------------------------- */}
            {(hostScope === "all" ? hasListSnapshot : snapshot && snapshot.workspaces.length > 0) ? (
            <section className="sec">
              <div className="sec-head">
                <span className="sec-label">
                  {sidebarView === "agents"
                    ? scope === "all"
                      ? "all agents"
                      : "space agents"
                    : scope === "all"
                      ? "all tabs"
                      : hostScope === "all"
                        ? "space tabs"
                        : (activeSpace?.label ?? "tabs")}
                </span>
                <span className="sec-rule" />
                {canCreateTabFromHeader ? (
                  <button
                    className="sec-add"
                    type="button"
                    aria-label="New tab"
                    title="New tab"
                    onClick={() =>
                      selectedBridgeId && activeSpace
                        ? onCreateTab(selectedBridgeId, activeSpace.workspace_id)
                        : undefined
                    }
                  >
                    <Plus size={14} />
                  </button>
                ) : null}
                {showOptionsControl ? (
                  <button
                    className="sec-add"
                    type="button"
                    aria-label={`${sidebarView === "agents" ? "Agent" : "Tab"} list options`}
                    title={`${sidebarView === "agents" ? "Agent" : "Tab"} list options`}
                    aria-haspopup="dialog"
                    aria-expanded={optionsMenu ? "true" : "false"}
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      setOptionsMenu({ x: rect.right, y: rect.bottom + 4 });
                    }}
                  >
                    <MoreVertical size={14} />
                  </button>
                ) : null}
              </div>

              {sidebarView === "agents" ? (
                agentPanes.length === 0 && disconnectedBridgeViews.length === 0 ? (
                  <div className="empty">
                    <strong>No detected agents</strong>
                    <span>Open the Tabs view for plain panes.</span>
                  </div>
                ) : (
                  <>
                    {renderDisconnectedBridgeRows()}
                    {agentGroup !== "none"
                      ? renderAgentGroupRows()
                      : agentPanes.map((entry, index) => (
                          <AgentRow
                            key={`${entry.bridgeId}:${entry.pane.pane_id}`}
                            index={index}
                            pane={entry.pane}
                            workspace={entry.workspace}
                            tabLabel={entry.tabLabel}
                            bridgeLabel={showAgentRowBridgeLabel ? entry.bridgeLabel : undefined}
                            active={
                              entry.bridgeId === selectedBridgeId &&
                              entry.pane.pane_id === selectedPane?.pane_id
                            }
                            onSelect={() => onSelectPane(entry.bridgeId, entry.pane)}
                            onMenu={(x, y) =>
                              onScopedMenu(
                                "pane",
                                entry.bridgeId,
                                entry.pane.pane_id,
                                paneTitle(entry.pane),
                                x,
                                y,
                              )
                            }
                          />
                        ))}
                  </>
                )
              ) : spaceGroups.every((group) => group.tabs.length === 0) ? (
                disconnectedBridgeViews.length > 0 ? (
                  <>{renderDisconnectedBridgeRows()}</>
                ) : (
                <div className="empty">
                  <strong>No panes</strong>
                  <span>{scope === "space" ? "This space has no panes yet." : "No workspace has panes yet."}</span>
                </div>
                )
              ) : (
                renderTabGroups()
              )}
            </section>
            ) : null}
          </>
        )}
      </div>
      {optionsMenu ? (
        <SidebarOptionsMenu
          x={optionsMenu.x}
          y={optionsMenu.y}
          sidebarView={sidebarView}
          showGroup={showGroupControl}
          agentSort={agentSort}
          agentGroup={agentGroup}
          onAgentSort={onAgentSort}
          onAgentGroup={onAgentGroup}
          onClose={() => setOptionsMenu(null)}
        />
      ) : null}
    </>
  );
}

function SidebarOptionsMenu({
  x,
  y,
  sidebarView,
  showGroup,
  agentSort,
  agentGroup,
  onAgentSort,
  onAgentGroup,
  onClose,
}: {
  x: number;
  y: number;
  sidebarView: SidebarView;
  showGroup: boolean;
  agentSort: AgentSort;
  agentGroup: AgentGroup;
  onAgentSort: (sort: AgentSort) => void;
  onAgentGroup: (group: AgentGroup) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const showSort = sidebarView === "agents";

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const rect = el.getBoundingClientRect();
    const margin = 8;
    let left = x - rect.width;
    let top = y;
    if (left < margin) {
      left = margin;
    }
    if (top + rect.height > window.innerHeight - margin) {
      top = window.innerHeight - margin - rect.height;
    }
    setPos({ left, top: Math.max(margin, top) });
    el.focus();
  }, [x, y]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    const removeNativeBackHandler = addNativeBackHandler(() => {
      onClose();
      return true;
    });
    return () => {
      window.removeEventListener("keydown", onKey);
      removeNativeBackHandler();
    };
  }, [onClose]);

  return (
    <div className="overlay-root">
      <button
        className="overlay-scrim overlay-scrim-clear"
        type="button"
        aria-label="Close list options"
        onClick={onClose}
      />
      <div
        ref={ref}
        className="sidebar-options-menu"
        role="dialog"
        aria-label={`${sidebarView === "agents" ? "Agent" : "Tab"} list options`}
        tabIndex={-1}
        style={{
          left: pos?.left ?? x,
          top: pos?.top ?? y,
          visibility: pos ? "visible" : "hidden",
        }}
      >
        {showSort ? (
          <label className="sidebar-option-field">
            <span>Sort</span>
            <select
              value={agentSort}
              onChange={(event) => onAgentSort(event.currentTarget.value as AgentSort)}
            >
              <option value="attention">Attention</option>
              <option value="status">Status</option>
              <option value="workspace">Workspace</option>
            </select>
          </label>
        ) : null}
        {showGroup ? (
          <label className="sidebar-option-field">
            <span>Group</span>
            <select
              value={agentGroup}
              onChange={(event) => onAgentGroup(event.currentTarget.value as AgentGroup)}
            >
              <option value="none">None</option>
              <option value="host">Host</option>
              <option value="workspace">Workspace</option>
              <option value="hostWorkspace">Host + workspace</option>
            </select>
          </label>
        ) : null}
      </div>
    </div>
  );
}

function GroupHeader({
  label,
  bridgeColor,
  status = "unknown",
}: {
  label: string;
  bridgeColor?: string;
  status?: AgentStatus;
}) {
  return (
    <div className="grp-space">
      {bridgeColor ? (
        <span
          className="bridge-chip-dot grp-bridge-dot"
          style={{ "--bridge-color": bridgeColor } as CSSProperties}
          aria-hidden="true"
        />
      ) : (
        <span className="dot" data-status={status} />
      )}
      <span className="grp-space-name">{label}</span>
      <span className="grp-space-line" />
    </div>
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
  bridgeLabel,
  active,
  index,
  onSelect,
  onMenu,
}: {
  pane: PaneInfo;
  workspace?: WorkspaceInfo;
  tabLabel?: string;
  bridgeLabel?: string;
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
        <span className="pane-meta mono">{agentSubtitle(pane, workspace, tabLabel, bridgeLabel)}</span>
      </span>
      {isLoud(pane.agent_status) ? (
        <span className="pane-word" data-status={pane.agent_status}>
          {statusLabel(pane.agent_status)}
        </span>
      ) : null}
    </button>
  );
}

function DisconnectedBridgeRow({
  label,
  message,
  onSelect,
  onRetry,
}: {
  label: string;
  message: string;
  onSelect: () => void;
  onRetry: () => void;
}) {
  return (
    <button className="pane-row" type="button" data-status="unknown" onClick={onSelect}>
      <span className="dot" data-status="unknown" />
      <span className="pane-body">
        <span className="pane-name">{label}</span>
        <span className="pane-meta mono">{message}</span>
      </span>
      <span
        className="pane-word"
        data-status="working"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onRetry();
        }}
      >
        retry
      </span>
    </button>
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

export function sortScopedAgentPanes(entries: ScopedAgentPane[], sort: AgentSort) {
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

  return [...entries].sort((a, b) => {
    if (sort === "attention") {
      const attention =
        Number(isAttention(b.pane.agent_status)) - Number(isAttention(a.pane.agent_status));
      if (attention !== 0) {
        return attention;
      }
      const status = attentionOrder[a.pane.agent_status] - attentionOrder[b.pane.agent_status];
      if (status !== 0) {
        return status;
      }
    } else if (sort === "status") {
      const status = statusOrder[a.pane.agent_status] - statusOrder[b.pane.agent_status];
      if (status !== 0) {
        return status;
      }
    }

    const bridge = a.bridgeIndex - b.bridgeIndex;
    if (bridge !== 0) {
      return bridge;
    }
    const workspace =
      (a.workspace?.number ?? Number.MAX_SAFE_INTEGER) -
      (b.workspace?.number ?? Number.MAX_SAFE_INTEGER);
    if (workspace !== 0) {
      return workspace;
    }
    const tab =
      (a.tabNumber ?? Number.MAX_SAFE_INTEGER) -
      (b.tabNumber ?? Number.MAX_SAFE_INTEGER);
    if (tab !== 0) {
      return tab;
    }
    return `${a.bridgeId}:${a.pane.pane_id}`.localeCompare(
      `${b.bridgeId}:${b.pane.pane_id}`,
      undefined,
      { numeric: true },
    );
  });
}

function agentTitle(pane: PaneInfo) {
  return pane.display_agent || pane.label || pane.agent || pane.title || paneTitle(pane);
}

function agentSubtitle(
  pane: PaneInfo,
  workspace?: WorkspaceInfo,
  tabLabel?: string,
  bridgeLabel?: string,
) {
  const stateText =
    pane.custom_status ||
    pane.state_labels?.[statusLabel(pane.agent_status)] ||
    statusLabel(pane.agent_status);
  const dir = basename(pane.foreground_cwd || pane.cwd);
  return [stateText, bridgeLabel, workspace?.label, tabLabel, dir].filter(Boolean).join(" · ");
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

function menuItems(kind: MenuKind, paneMoveSupported: boolean, commandsReady: boolean): MenuItem[] {
  if (!commandsReady) {
    return [];
  }
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

function useIsCompactLayout() {
  const [compact, setCompact] = useState(() => isCompactLayoutViewport());
  useEffect(() => {
    const mq = window.matchMedia(COMPACT_LAYOUT_QUERY);
    const update = () => setCompact(isCompactLayoutViewport());
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
  return compact;
}

function isCompactLayoutViewport() {
  if (typeof window === "undefined") {
    return false;
  }
  return window.matchMedia(COMPACT_LAYOUT_QUERY).matches || window.innerWidth <= 820;
}

function useIsTouchInput() {
  const [touchInput, setTouchInput] = useState(() => isTouchInputViewport());
  useEffect(() => {
    const mq = window.matchMedia(TOUCH_INPUT_QUERY);
    const update = () => setTouchInput(isTouchInputViewport());
    update();
    mq.addEventListener("change", update);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      mq.removeEventListener("change", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);
  return touchInput;
}

function isTouchInputViewport() {
  if (typeof window === "undefined") {
    return false;
  }
  return window.matchMedia(TOUCH_INPUT_QUERY).matches || navigator.maxTouchPoints > 0;
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

function stageBreadcrumb(
  snapshot: Snapshot | null,
  pane: PaneInfo | null,
  loadState: LoadState,
  bridgeCanConnect: boolean,
) {
  if (!pane) {
    if (!bridgeCanConnect) {
      return "bridge disconnected";
    }
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

async function fetchSnapshot(httpUrl: (path: string, query?: URLSearchParams) => string) {
  const response = await fetch(httpUrl("/api/snapshot"));
  if (!response.ok) {
    throw new Error(`snapshot failed: ${response.status}`);
  }
  return (await response.json()) as Snapshot;
}

function disconnectedHttpUrl(): string {
  throw new Error("Bridge is not connected");
}

function disconnectedWsUrl(): string {
  throw new Error("Bridge is not connected");
}

async function syncSelectedPane(
  httpUrl: (path: string, query?: URLSearchParams) => string,
  paneId: string,
) {
  const response = await fetch(httpUrl("/api/selection"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pane_id: paneId }),
  });
  if (!response.ok) {
    throw new Error(`selection failed: ${response.status}`);
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

function blurActiveTextInput() {
  const element = document.activeElement;
  if (!(element instanceof HTMLElement)) {
    return;
  }
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    element.isContentEditable
  ) {
    element.blur();
  }
}

function openEventsSocket(
  wsUrl: (path: string, query?: URLSearchParams) => string,
  path: string,
  onEvent: (event: MessageEvent) => void,
  options: { onOpen?: () => void } = {},
) {
  const url = wsUrl(path);
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
      options.onOpen?.();
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
