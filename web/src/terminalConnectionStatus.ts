export type TerminalConnectionState = "idle" | "connecting" | "attached" | "closed" | "error";

export const TERMINAL_CONNECTION_OVERLAY_DELAY_MS = 500;

export function parseTerminalCloseReason(message: string) {
  try {
    const parsed = JSON.parse(message) as { type?: unknown; reason?: unknown };
    return parsed.type === "closed" && typeof parsed.reason === "string" ? parsed.reason : null;
  } catch {
    return null;
  }
}

export function isNonRetryableTerminalClose(reason: string | null) {
  return (
    reason !== null &&
    (reason.includes("already has an attached client") ||
      reason.includes("terminal attach taken over") ||
      reason.includes("terminal attach failed: terminal"))
  );
}

export function terminalConnectionCopy(
  state: TerminalConnectionState,
  reason: string | null,
  hasAttachedForTerminal = false,
) {
  if (reason?.includes("already has an attached client")) {
    return "Attached elsewhere";
  }
  if (reason?.includes("terminal attach taken over")) {
    return "Detached elsewhere";
  }
  switch (state) {
    case "connecting":
      return hasAttachedForTerminal ? "Reconnecting" : "Connecting";
    case "closed":
      return "Detached";
    case "error":
      return "Connection failed";
    case "idle":
    case "attached":
      return "";
  }
}

export function terminalConnectionOverlayDelayMs(
  state: TerminalConnectionState,
  delayConnecting: boolean,
) {
  return state === "connecting" && delayConnecting ? TERMINAL_CONNECTION_OVERLAY_DELAY_MS : 0;
}
