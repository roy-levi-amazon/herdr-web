import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_INPUT_BATCH_DELAY_MS,
  DEFAULT_TERMINAL_INPUT_TRANSPORT,
  parseTerminalInputBatchDelayMs,
  parseTerminalInputTransport,
  TERMINAL_INPUT_BATCH_MAX_BYTES,
} from "./terminalInputTransport";

describe("terminal input transport preferences", () => {
  it("parses supported transports", () => {
    expect(parseTerminalInputTransport("json")).toBe("json");
    expect(parseTerminalInputTransport("binary")).toBe("binary");
  });

  it("falls back for unknown transports", () => {
    expect(parseTerminalInputTransport("text")).toBe(DEFAULT_TERMINAL_INPUT_TRANSPORT);
    expect(parseTerminalInputTransport(null)).toBe(DEFAULT_TERMINAL_INPUT_TRANSPORT);
  });

  it("parses supported batch delays", () => {
    expect(parseTerminalInputBatchDelayMs(0)).toBe(0);
    expect(parseTerminalInputBatchDelayMs(32)).toBe(32);
    expect(parseTerminalInputBatchDelayMs(64)).toBe(64);
    expect(parseTerminalInputBatchDelayMs(128)).toBe(128);
    expect(parseTerminalInputBatchDelayMs(256)).toBe(256);
  });

  it("falls back for unknown batch delays", () => {
    expect(parseTerminalInputBatchDelayMs(16)).toBe(DEFAULT_TERMINAL_INPUT_BATCH_DELAY_MS);
    expect(parseTerminalInputBatchDelayMs(512)).toBe(DEFAULT_TERMINAL_INPUT_BATCH_DELAY_MS);
    expect(parseTerminalInputBatchDelayMs("128")).toBe(DEFAULT_TERMINAL_INPUT_BATCH_DELAY_MS);
  });

  it("uses a fixed small input batch size", () => {
    expect(TERMINAL_INPUT_BATCH_MAX_BYTES).toBe(32);
  });
});
