import { fetchWithTimeout } from "./fetchWithTimeout";
import type { BridgeCapabilities } from "./bridge";
import type { AgentStatus } from "./types";

export type AgentActivityRecord = {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  agent_status: AgentStatus;
  last_status_transition_at?: string;
};

export type AgentActivityListResponse = {
  session_key: string;
  records: AgentActivityRecord[];
};

export type BridgeHttpUrl = (path: string, query?: URLSearchParams) => string;

export class AgentActivityApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "AgentActivityApiError";
    this.status = status;
  }
}

const agentStatuses: AgentStatus[] = ["idle", "working", "blocked", "done", "unknown"];

export function supportsAgentActivity(capabilities: BridgeCapabilities | null | undefined) {
  return capabilities?.agent_activity?.version === 1;
}

export async function fetchAgentActivity(
  httpUrl: BridgeHttpUrl,
): Promise<AgentActivityListResponse> {
  const response = await fetchWithTimeout(httpUrl("/api/agent-activity"));
  return parseAgentActivityResponse(response);
}

export function agentActivityKey(bridgeId: string, paneId: string, terminalId: string) {
  return `${bridgeId}:${paneId}:${terminalId}`;
}

export function agentActivityTimestamps(
  bridgeId: string,
  response: AgentActivityListResponse | null | undefined,
) {
  const timestamps = new Map<string, number>();
  for (const record of response?.records ?? []) {
    const timestamp = parseTransitionTimestamp(record.last_status_transition_at);
    if (timestamp === null) {
      continue;
    }
    timestamps.set(agentActivityKey(bridgeId, record.pane_id, record.terminal_id), timestamp);
  }
  return timestamps;
}

export function parseAgentActivityListResponse(value: unknown): AgentActivityListResponse {
  if (!isRecord(value) || typeof value.session_key !== "string" || !Array.isArray(value.records)) {
    throw new Error("agent activity response is invalid");
  }
  return {
    session_key: value.session_key,
    records: value.records.map(parseAgentActivityRecord),
  };
}

function parseAgentActivityRecord(value: unknown): AgentActivityRecord {
  if (
    !isRecord(value) ||
    typeof value.pane_id !== "string" ||
    typeof value.terminal_id !== "string" ||
    typeof value.workspace_id !== "string" ||
    typeof value.tab_id !== "string" ||
    !isAgentStatus(value.agent_status)
  ) {
    throw new Error("agent activity record is invalid");
  }
  const timestamp = parseTransitionTimestamp(value.last_status_transition_at);
  return {
    pane_id: value.pane_id,
    terminal_id: value.terminal_id,
    workspace_id: value.workspace_id,
    tab_id: value.tab_id,
    agent_status: value.agent_status,
    ...(timestamp === null ? {} : { last_status_transition_at: String(timestamp) }),
  };
}

function parseTransitionTimestamp(value: unknown) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error("agent activity timestamp is invalid");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("agent activity timestamp is invalid");
  }
  return parsed;
}

async function parseAgentActivityResponse(response: Response) {
  if (!response.ok) {
    throw await agentActivityApiError(response);
  }
  return parseAgentActivityListResponse(await response.json());
}

async function agentActivityApiError(response: Response) {
  try {
    const parsed = (await response.json()) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return new AgentActivityApiError(parsed.error, response.status);
    }
  } catch {
    // Fall through to the status-based error.
  }
  return new AgentActivityApiError(`agent activity failed: ${response.status}`, response.status);
}

function isAgentStatus(value: unknown): value is AgentStatus {
  return typeof value === "string" && agentStatuses.includes(value as AgentStatus);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
