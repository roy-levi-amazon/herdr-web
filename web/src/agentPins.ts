import { fetchWithTimeout } from "./fetchWithTimeout";
import type { BridgeCapabilities } from "./bridge";

export type AgentPinContext = {
  pane_label?: string;
  pane_title?: string;
  agent?: string;
  display_agent?: string;
  cwd?: string;
  foreground_cwd?: string;
};

export type AgentPin = {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  created_at: string;
  context: AgentPinContext;
};

export type AgentPinsListResponse = {
  session_key: string;
  pins: AgentPin[];
};

export type BridgeHttpUrl = (path: string, query?: URLSearchParams) => string;

export class AgentPinsApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "AgentPinsApiError";
    this.status = status;
  }
}

export function supportsAgentPins(capabilities: BridgeCapabilities | null | undefined) {
  return capabilities?.agent_pins?.version === 1;
}

export async function fetchAgentPins(
  httpUrl: BridgeHttpUrl,
): Promise<AgentPinsListResponse> {
  const response = await fetchWithTimeout(httpUrl("/api/agent-pins"));
  return parseAgentPinsResponse(response);
}

export function pinAgent(httpUrl: BridgeHttpUrl, paneId: string) {
  return sendAgentPinMutation(httpUrl, `/api/agent-pins/${encodeURIComponent(paneId)}/pin`);
}

export function unpinAgent(httpUrl: BridgeHttpUrl, paneId: string) {
  return sendAgentPinMutation(httpUrl, `/api/agent-pins/${encodeURIComponent(paneId)}/unpin`);
}

export function agentPinKey(bridgeId: string, paneId: string) {
  return `${bridgeId}:${paneId}`;
}

export function agentPinKeys(bridgeId: string, response: AgentPinsListResponse | null | undefined) {
  return new Set((response?.pins ?? []).map((pin) => agentPinKey(bridgeId, pin.pane_id)));
}

async function sendAgentPinMutation(httpUrl: BridgeHttpUrl, path: string) {
  const response = await fetchWithTimeout(httpUrl(path), { method: "POST" });
  return parseAgentPinsResponse(response);
}

async function parseAgentPinsResponse(response: Response) {
  if (!response.ok) {
    throw await agentPinsApiError(response);
  }
  return (await response.json()) as AgentPinsListResponse;
}

async function agentPinsApiError(response: Response) {
  try {
    const parsed = (await response.json()) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return new AgentPinsApiError(parsed.error, response.status);
    }
  } catch {
    // Fall through to the status-based error.
  }
  return new AgentPinsApiError(`agent pins failed: ${response.status}`, response.status);
}
