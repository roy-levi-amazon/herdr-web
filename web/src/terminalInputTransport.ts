export type TerminalInputTransport = "json" | "binary";

export const DEFAULT_TERMINAL_INPUT_TRANSPORT: TerminalInputTransport = "json";
export const DEFAULT_TERMINAL_INPUT_BATCH_DELAY_MS = 0;
export const TERMINAL_INPUT_BATCH_MAX_BYTES = 32;
export const TERMINAL_INPUT_BATCH_DELAY_OPTIONS_MS = [0, 32, 64, 128, 256] as const;

export function parseTerminalInputTransport(value: unknown): TerminalInputTransport {
  return value === "binary" || value === "json" ? value : DEFAULT_TERMINAL_INPUT_TRANSPORT;
}

export function parseTerminalInputBatchDelayMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TERMINAL_INPUT_BATCH_DELAY_MS;
  }
  return TERMINAL_INPUT_BATCH_DELAY_OPTIONS_MS.includes(
    value as (typeof TERMINAL_INPUT_BATCH_DELAY_OPTIONS_MS)[number],
  )
    ? value
    : DEFAULT_TERMINAL_INPUT_BATCH_DELAY_MS;
}
