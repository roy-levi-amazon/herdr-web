export type MobileTerminalTapTarget = "command-input" | "terminal";

export const DEFAULT_MOBILE_TERMINAL_TAP_TARGET: MobileTerminalTapTarget = "command-input";

export function parseMobileTerminalTapTarget(value: unknown): MobileTerminalTapTarget {
  return value === "terminal" || value === "command-input"
    ? value
    : DEFAULT_MOBILE_TERMINAL_TAP_TARGET;
}
