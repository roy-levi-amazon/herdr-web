// Mutating commands proxied through the bridge's allow-listed /api/command.

import { agentArgv } from "./launch";
import type { LaunchSpec, SplitDirection } from "./launch";
import { shellCommand } from "./shell";

export type CommandResult = { type?: string; [key: string]: unknown };
export type PaneFocusDirection = "left" | "right" | "up" | "down";
export type { LaunchSpec, SplitDirection };
export type BridgeHttpUrl = (path: string, query?: URLSearchParams) => string;

const sameOriginHttpUrl: BridgeHttpUrl = (path, query) => {
  const suffix = query && query.toString() ? `?${query.toString()}` : "";
  return `${path}${suffix}`;
};

async function runCommand(
  httpUrl: BridgeHttpUrl,
  method: string,
  params: Record<string, unknown>,
): Promise<CommandResult> {
  const response = await fetch(httpUrl("/api/command"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  if (!response.ok) {
    let message = `command failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body?.error) {
        message = body.error;
      }
    } catch {
      // keep the default message
    }
    throw new Error(message);
  }
  return (await response.json()) as CommandResult;
}

/** Pull a pane id out of a {workspace,tab}_created result so the UI can jump to it. */
export function createdPaneId(result: CommandResult): string | null {
  const rootPane = result.root_pane as { pane_id?: string } | undefined;
  const pane = result.pane as { pane_id?: string } | undefined;
  const agent = result.agent as { pane_id?: string } | undefined;
  const moveResult = result.move_result as { pane?: { pane_id?: string } } | undefined;
  const focus = result.focus as { focused_pane_id?: string | null } | undefined;
  return (
    rootPane?.pane_id ??
    pane?.pane_id ??
    agent?.pane_id ??
    moveResult?.pane?.pane_id ??
    focus?.focused_pane_id ??
    null
  );
}

export function createCommands(httpUrl: BridgeHttpUrl = sameOriginHttpUrl) {
  const api = {
    createWorkspace: () => runCommand(httpUrl, "workspace.create", { focus: true }),
    renameWorkspace: (workspaceId: string, label: string | null) =>
      runCommand(httpUrl, "workspace.rename", { workspace_id: workspaceId, label }),
    closeWorkspace: (workspaceId: string) =>
      runCommand(httpUrl, "workspace.close", { workspace_id: workspaceId }),
    focusWorkspace: (workspaceId: string) =>
      runCommand(httpUrl, "workspace.focus", { workspace_id: workspaceId }),

    createTab: (workspaceId: string, label?: string) =>
      runCommand(httpUrl, "tab.create", { workspace_id: workspaceId, focus: true, label }),
    renameTab: (tabId: string, label: string | null) =>
      runCommand(httpUrl, "tab.rename", { tab_id: tabId, label }),
    closeTab: (tabId: string) => runCommand(httpUrl, "tab.close", { tab_id: tabId }),
    focusTab: (tabId: string) => runCommand(httpUrl, "tab.focus", { tab_id: tabId }),

    renamePane: (paneId: string, label: string) =>
      runCommand(httpUrl, "pane.rename", { pane_id: paneId, label }),
    closePane: (paneId: string) => runCommand(httpUrl, "pane.close", { pane_id: paneId }),
    runPaneCommand: (paneId: string, command: string) =>
      runCommand(httpUrl, "pane.send_input", { pane_id: paneId, text: command, keys: ["Enter"] }),
    // Layout-mutating: requires the bridge allow-list to include `pane.split`.
    splitPane: (targetPaneId: string, direction: SplitDirection) =>
      runCommand(httpUrl, "pane.split", { target_pane_id: targetPaneId, direction, focus: true }),
    focusPaneDirection: (paneId: string, direction: PaneFocusDirection) =>
      runCommand(httpUrl, "pane.focus_direction", { pane_id: paneId, direction }),
    movePaneToNewTab: (paneId: string, workspaceId: string, label?: string) =>
      runCommand(httpUrl, "pane.move", {
        pane_id: paneId,
        destination: { type: "new_tab", workspace_id: workspaceId, label },
        focus: true,
      }),
    movePaneToNewWorkspace: (paneId: string, label?: string) =>
      runCommand(httpUrl, "pane.move", {
        pane_id: paneId,
        destination: { type: "new_workspace", label },
        focus: true,
      }),

    startAgentSplit: (tabId: string, direction: SplitDirection, spec: LaunchSpec) =>
      runCommand(httpUrl, "agent.start", {
        name: spec.title,
        tab_id: tabId,
        split: direction,
        focus: true,
        argv: agentArgv(spec.kind),
      }),

    createLaunchTab: async (workspaceId: string, spec: LaunchSpec) => {
      const result = await api.createTab(workspaceId);
      const paneId = createdPaneId(result);
      if (!paneId) {
        throw new Error("new tab did not return a root pane");
      }
      const title = spec.title.trim();
      if (title) {
        await api.renamePane(paneId, title);
      }
      if (spec.kind !== "shell") {
        await api.runPaneCommand(paneId, shellCommand(agentArgv(spec.kind)));
      }
      return result;
    },

    splitLaunchPane: async (
      targetPaneId: string,
      tabId: string,
      direction: SplitDirection,
      spec: LaunchSpec,
    ) => {
      if (spec.kind !== "shell") {
        return api.startAgentSplit(tabId, direction, spec);
      }
      const result = await api.splitPane(targetPaneId, direction);
      const paneId = createdPaneId(result);
      if (paneId && spec.title.trim()) {
        await api.renamePane(paneId, spec.title.trim());
      }
      return result;
    },
  };
  return api;
}

export const commands = createCommands();

export async function probeSupportedCommands(
  httpUrl: BridgeHttpUrl = sameOriginHttpUrl,
): Promise<Set<string>> {
  try {
    const response = await fetch(httpUrl("/api/capabilities"));
    if (!response.ok) {
      return new Set();
    }
    const body = (await response.json()) as { commands?: unknown };
    if (!Array.isArray(body.commands)) {
      return new Set();
    }
    return new Set(body.commands.filter((command): command is string => typeof command === "string"));
  } catch {
    return new Set();
  }
}
