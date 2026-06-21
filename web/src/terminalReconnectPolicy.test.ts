import { describe, expect, it } from "vitest";
import {
  TERMINAL_CONNECT_TIMEOUT_MS,
  TERMINAL_FOREGROUND_CONNECT_TIMEOUT_MS,
  TERMINAL_RECONNECT_BASE_DELAY_MS,
  TERMINAL_RECONNECT_MAX_DELAY_MS,
  terminalReconnectPolicy,
} from "./terminalReconnectPolicy";

describe("terminalReconnectPolicy", () => {
  it("connects immediately without advancing normal backoff attempts", () => {
    expect(
      terminalReconnectPolicy({
        attempt: 0,
        mode: "normal",
        immediate: true,
        foregroundFastAttemptsRemaining: 0,
      }),
    ).toEqual({
      delayMs: 0,
      connectTimeoutMs: TERMINAL_CONNECT_TIMEOUT_MS,
      nextAttempt: 0,
      nextForegroundFastAttemptsRemaining: 0,
    });
  });

  it("uses capped exponential delay for normal reconnects", () => {
    expect(
      terminalReconnectPolicy({
        attempt: 0,
        mode: "normal",
        immediate: false,
        foregroundFastAttemptsRemaining: 0,
      }).delayMs,
    ).toBe(500);
    expect(
      terminalReconnectPolicy({
        attempt: 4,
        mode: "normal",
        immediate: false,
        foregroundFastAttemptsRemaining: 0,
      }).delayMs,
    ).toBe(TERMINAL_RECONNECT_MAX_DELAY_MS);
  });

  it("keeps the foreground fast-attempt transition in the pure policy", () => {
    const first = terminalReconnectPolicy({
      attempt: 0,
      mode: "foreground",
      immediate: true,
      foregroundFastAttemptsRemaining: 2,
    });
    expect(first.connectTimeoutMs).toBe(TERMINAL_FOREGROUND_CONNECT_TIMEOUT_MS);
    expect(first.nextForegroundFastAttemptsRemaining).toBe(1);

    const second = terminalReconnectPolicy({
      attempt: first.nextAttempt,
      mode: "foreground",
      immediate: false,
      foregroundFastAttemptsRemaining: first.nextForegroundFastAttemptsRemaining,
    });
    expect(second.delayMs).toBe(TERMINAL_RECONNECT_BASE_DELAY_MS);
    expect(second.connectTimeoutMs).toBe(TERMINAL_FOREGROUND_CONNECT_TIMEOUT_MS);
    expect(second.nextForegroundFastAttemptsRemaining).toBe(0);

    const third = terminalReconnectPolicy({
      attempt: second.nextAttempt,
      mode: "foreground",
      immediate: false,
      foregroundFastAttemptsRemaining: second.nextForegroundFastAttemptsRemaining,
    });
    expect(third.connectTimeoutMs).toBe(TERMINAL_CONNECT_TIMEOUT_MS);
    expect(third.nextForegroundFastAttemptsRemaining).toBe(0);
  });
});
