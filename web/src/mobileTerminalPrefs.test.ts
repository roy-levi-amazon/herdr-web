import { describe, expect, it } from "vitest";
import {
  DEFAULT_MOBILE_TERMINAL_TAP_TARGET,
  parseMobileTerminalTapTarget,
} from "./mobileTerminalPrefs";

describe("mobile terminal preferences", () => {
  it("parses supported tap targets", () => {
    expect(parseMobileTerminalTapTarget("command-input")).toBe("command-input");
    expect(parseMobileTerminalTapTarget("terminal")).toBe("terminal");
  });

  it("falls back for unknown tap targets", () => {
    expect(parseMobileTerminalTapTarget("native-input")).toBe(
      DEFAULT_MOBILE_TERMINAL_TAP_TARGET,
    );
    expect(parseMobileTerminalTapTarget(null)).toBe(DEFAULT_MOBILE_TERMINAL_TAP_TARGET);
  });
});
