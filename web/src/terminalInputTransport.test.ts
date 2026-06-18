import { describe, expect, it } from "vitest";
import {
  appendTerminalInputBatch,
  DEFAULT_TERMINAL_INPUT_BATCH_DELAY_MS,
  DEFAULT_TERMINAL_INPUT_TRANSPORT,
  drainTerminalInputBatch,
  emptyTerminalInputBatch,
  parseTerminalInputBatchDelayMs,
  parseTerminalInputTransport,
  shouldSendTerminalInputImmediately,
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

  it("coalesces input below the fixed batch size", () => {
    const first = appendTerminalInputBatch(emptyTerminalInputBatch(), "abc", 3);
    expect(first).toEqual({
      batch: { parts: ["abc"], bytes: 3 },
      shouldFlush: false,
    });
    const second = appendTerminalInputBatch(first.batch, "def", 3);
    expect(second).toEqual({
      batch: { parts: ["abc", "def"], bytes: 6 },
      shouldFlush: false,
    });
  });

  it("flushes accumulated input at the fixed batch size", () => {
    const result = appendTerminalInputBatch({ parts: ["a".repeat(20)], bytes: 20 }, "b".repeat(12), 12);
    expect(result.shouldFlush).toBe(true);
    expect(result.batch.bytes).toBe(32);
  });

  it("sends large single input chunks immediately when batching is enabled", () => {
    expect(shouldSendTerminalInputImmediately(31, 64)).toBe(false);
    expect(shouldSendTerminalInputImmediately(32, 64)).toBe(true);
    expect(shouldSendTerminalInputImmediately(1, 0)).toBe(true);
  });

  it("drains batched input in order", () => {
    const drained = drainTerminalInputBatch({ parts: ["ab", "cd"], bytes: 4 });
    expect(drained).toEqual({
      data: "abcd",
      batch: { parts: [], bytes: 0 },
    });
    expect(drainTerminalInputBatch(emptyTerminalInputBatch()).data).toBeNull();
  });
});
