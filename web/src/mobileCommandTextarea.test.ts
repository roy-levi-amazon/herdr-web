import { describe, expect, it } from "vitest";

import { autosizeMobileCommandTextarea } from "./mobileCommandTextarea";

describe("autosizeMobileCommandTextarea", () => {
  it("sizes the command textarea to its wrapped content height", () => {
    const textarea = {
      scrollHeight: 84,
      style: { height: "34px" },
    };

    autosizeMobileCommandTextarea(textarea);

    expect(textarea.style.height).toBe("84px");
  });

  it("includes the border height for border-box textareas", () => {
    const textarea = {
      scrollHeight: 84,
      clientHeight: 80,
      offsetHeight: 82,
      style: { height: "34px" },
    };

    autosizeMobileCommandTextarea(textarea);

    expect(textarea.style.height).toBe("86px");
  });

  it("ignores missing textarea refs while controls mount", () => {
    expect(() => autosizeMobileCommandTextarea(null)).not.toThrow();
  });
});
