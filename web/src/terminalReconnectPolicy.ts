export type TerminalReconnectMode = "normal" | "foreground";

export type TerminalReconnectPolicyInput = {
  attempt: number;
  mode: TerminalReconnectMode;
  immediate: boolean;
  foregroundFastAttemptsRemaining: number;
};

export type TerminalReconnectPolicy = {
  delayMs: number;
  connectTimeoutMs: number;
  nextAttempt: number;
  nextForegroundFastAttemptsRemaining: number;
};

export const TERMINAL_RECONNECT_BASE_DELAY_MS = 500;
export const TERMINAL_RECONNECT_MAX_DELAY_MS = 5000;
export const TERMINAL_CONNECT_TIMEOUT_MS = 3500;
export const TERMINAL_FOREGROUND_CONNECT_TIMEOUT_MS = 1200;
export const TERMINAL_FOREGROUND_FAST_ATTEMPTS = 2;
export const TERMINAL_FOREGROUND_SIGNAL_COALESCE_MS = 400;

export function terminalReconnectPolicy({
  attempt,
  mode,
  immediate,
  foregroundFastAttemptsRemaining,
}: TerminalReconnectPolicyInput): TerminalReconnectPolicy {
  const foregroundFastAttempt = mode === "foreground" && foregroundFastAttemptsRemaining > 0;
  return {
    delayMs: immediate
      ? 0
      : Math.min(TERMINAL_RECONNECT_BASE_DELAY_MS * 2 ** attempt, TERMINAL_RECONNECT_MAX_DELAY_MS),
    connectTimeoutMs: foregroundFastAttempt
      ? TERMINAL_FOREGROUND_CONNECT_TIMEOUT_MS
      : TERMINAL_CONNECT_TIMEOUT_MS,
    nextAttempt: immediate ? attempt : attempt + 1,
    nextForegroundFastAttemptsRemaining: foregroundFastAttempt
      ? foregroundFastAttemptsRemaining - 1
      : foregroundFastAttemptsRemaining,
  };
}
