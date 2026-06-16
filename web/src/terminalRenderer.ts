import { FitAddon, init, Terminal } from "ghostty-web";

const TERMINAL_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "DejaVu Sans Mono", monospace';
const TERMINAL_TEXT_INPUT_TAP_GRACE_MS = 4000;

const ghosttyReady = init();

export type TerminalSize = {
  cols: number;
  rows: number;
};

export type TerminalRenderer = {
  mount(container: HTMLElement): Promise<TerminalSize>;
  write(data: string | Uint8Array): void;
  onInput(callback: (data: string) => void): () => void;
  onScroll(callback: (lines: number) => void): () => void;
  setTapFocusHandler(callback: (() => boolean | "terminal") | null): void;
  fit(): TerminalSize;
  refreshMetrics(): TerminalSize;
  focus(): void;
  focusTextInput(): void;
  setScrollSensitivity(value: number): void;
  dispose(): void;
};

export class GhosttyRenderer implements TerminalRenderer {
  #terminal: Terminal | null = null;
  #fitAddon: FitAddon | null = null;
  #container: HTMLElement | null = null;
  #scrollSensitivity = 1;
  #scrollCallback: ((lines: number) => void) | null = null;
  #touchCleanup: (() => void) | null = null;
  #mobileInputCleanup: (() => void) | null = null;
  #tapFocusHandler: (() => boolean | "terminal") | null = null;
  #textInputTapGraceUntil = 0;

  async mount(container: HTMLElement) {
    await ghosttyReady;

    this.#container = container;
    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: 13,
      scrollback: 8000,
      smoothScrollDuration: 0,
      theme: {
        background: "#11111b",
        foreground: "#cdd6f4",
        cursor: "#f5e0dc",
        selectionBackground: "#45475a",
        black: "#45475a",
        red: "#f38ba8",
        green: "#a6e3a1",
        yellow: "#f9e2af",
        blue: "#89b4fa",
        magenta: "#f5c2e7",
        cyan: "#94e2d5",
        white: "#bac2de",
        brightBlack: "#585b70",
        brightRed: "#f38ba8",
        brightGreen: "#a6e3a1",
        brightYellow: "#f9e2af",
        brightBlue: "#89b4fa",
        brightMagenta: "#f5c2e7",
        brightCyan: "#94e2d5",
        brightWhite: "#a6adc8",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminal.attachCustomKeyEventHandler((event) => {
      const output = customKeyboardEventOutput(event);
      if (!output) {
        return false;
      }
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") {
        event.stopImmediatePropagation();
      }
      terminal.input(output, true);
      return true;
    });
    terminal.textarea?.blur();
    container.blur();
    container.removeAttribute("contenteditable");
    terminal.renderer?.getCanvas().style.setProperty("background-color", "#11111b");
    terminal.renderer?.getCanvas().style.setProperty("image-rendering", "auto");
    this.#terminal = terminal;
    this.#fitAddon = fitAddon;
    this.#installScrollHandlers();
    this.#installMobileInputBridge();
    return this.fit();
  }

  write(data: string | Uint8Array) {
    this.#terminal?.write(data);
  }

  onInput(callback: (data: string) => void) {
    const disposable = this.#requireTerminal().onData(callback);
    return () => disposable.dispose();
  }

  onScroll(callback: (lines: number) => void) {
    this.#scrollCallback = callback;
    return () => {
      if (this.#scrollCallback === callback) {
        this.#scrollCallback = null;
      }
    };
  }

  setTapFocusHandler(callback: (() => boolean | "terminal") | null) {
    this.#tapFocusHandler = callback;
  }

  fit() {
    const terminal = this.#requireTerminal();
    this.#fitAddon?.fit();
    return {
      cols: terminal.cols,
      rows: terminal.rows,
    };
  }

  refreshMetrics() {
    const terminal = this.#requireTerminal();
    terminal.options.fontFamily = TERMINAL_FONT_FAMILY;
    terminal.renderer?.remeasureFont();
    return this.fit();
  }

  focus() {
    this.#terminal?.focus();
  }

  focusTextInput() {
    const textarea = this.#terminal?.textarea;
    if (!textarea) {
      this.#terminal?.focus();
      return;
    }
    this.#textInputTapGraceUntil = performance.now() + TERMINAL_TEXT_INPUT_TAP_GRACE_MS;
    textarea.classList.add("ghostty-keyboard-input");
    textarea.focus({ preventScroll: true });
    window.setTimeout(() => {
      if (textarea.isConnected) {
        textarea.classList.add("ghostty-keyboard-input");
        textarea.focus({ preventScroll: true });
      }
    }, 0);
  }

  setScrollSensitivity(value: number) {
    this.#scrollSensitivity = value;
  }

  dispose() {
    this.#touchCleanup?.();
    this.#touchCleanup = null;
    this.#mobileInputCleanup?.();
    this.#mobileInputCleanup = null;
    this.#fitAddon?.dispose();
    this.#fitAddon = null;
    this.#terminal?.dispose();
    this.#terminal = null;
    this.#container = null;
  }

  #requireTerminal() {
    if (!this.#terminal) {
      throw new Error("terminal renderer is not mounted");
    }
    return this.#terminal;
  }

  #installScrollHandlers() {
    const terminal = this.#requireTerminal();
    const container = this.#container;
    if (!container) {
      return;
    }

    terminal.attachCustomWheelEventHandler((event) => {
      if (terminal.hasMouseTracking()) {
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      const lines = normalizeWheelLines(event, terminal.rows, this.#scrollSensitivity);
      if (lines === 0) {
        return true;
      }
      if (this.#scrollCallback) {
        this.#scrollCallback(lines);
      } else {
        terminal.scrollLines(lines);
      }
      return true;
    });

    let lastTouchY: number | null = null;
    let touchStartX: number | null = null;
    let touchStartY: number | null = null;
    let touchMoved = false;
    let touchScrolled = false;
    let pendingTouchLines = 0;
    const redirectTapFocus = (event: TouchEvent | MouseEvent) => {
      if (
        document.activeElement === terminal.textarea ||
        performance.now() < this.#textInputTapGraceUntil
      ) {
        return false;
      }
      const tapFocusResult = this.#tapFocusHandler?.();
      if (!tapFocusResult) {
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") {
        event.stopImmediatePropagation();
      }
      if (tapFocusResult !== "terminal") {
        terminal.textarea?.blur();
      }
      return true;
    };
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 1) {
        const touch = event.touches[0];
        touchStartX = touch.clientX;
        touchStartY = touch.clientY;
        lastTouchY = touch.clientY;
        touchMoved = false;
        touchScrolled = false;
      }
    };
    const onTouchMove = (event: TouchEvent) => {
      if (terminal.hasMouseTracking() || event.touches.length !== 1 || lastTouchY === null) {
        return;
      }
      const currentY = event.touches[0].clientY;
      const deltaY = currentY - lastTouchY;
      lastTouchY = currentY;
      if (touchStartX !== null && touchStartY !== null) {
        const deltaX = event.touches[0].clientX - touchStartX;
        const totalDeltaY = currentY - touchStartY;
        if (Math.hypot(deltaX, totalDeltaY) > 2) {
          touchMoved = true;
        }
      }
      const cellHeight = terminal.renderer?.getMetrics().height ?? 16;
      pendingTouchLines += (-deltaY / cellHeight) * this.#scrollSensitivity;
      const lines = pendingTouchLines < 0 ? Math.ceil(pendingTouchLines) : Math.floor(pendingTouchLines);
      if (lines !== 0) {
        if (this.#scrollCallback) {
          this.#scrollCallback(lines);
        } else {
          terminal.scrollLines(lines);
        }
        pendingTouchLines -= lines;
        touchScrolled = true;
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") {
          event.stopImmediatePropagation();
        }
      }
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (touchMoved || touchScrolled) {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") {
          event.stopImmediatePropagation();
        }
        terminal.textarea?.blur();
      } else {
        redirectTapFocus(event);
      }
      lastTouchY = null;
      touchStartX = null;
      touchStartY = null;
      touchMoved = false;
      touchScrolled = false;
      pendingTouchLines = 0;
    };
    const onMouseDown = (event: MouseEvent) => {
      if (event.button === 0) {
        redirectTapFocus(event);
      }
    };

    container.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    container.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
    container.addEventListener("touchend", onTouchEnd, { capture: true });
    container.addEventListener("touchcancel", onTouchEnd, { capture: true });
    container.addEventListener("mousedown", onMouseDown, { capture: true });
    this.#touchCleanup = () => {
      container.removeEventListener("touchstart", onTouchStart, { capture: true });
      container.removeEventListener("touchmove", onTouchMove, { capture: true });
      container.removeEventListener("touchend", onTouchEnd, { capture: true });
      container.removeEventListener("touchcancel", onTouchEnd, { capture: true });
      container.removeEventListener("mousedown", onMouseDown, { capture: true });
    };
  }

  #installMobileInputBridge() {
    const terminal = this.#requireTerminal();
    const textarea = terminal.textarea;
    if (!textarea) {
      return;
    }
    textarea.classList.add("ghostty-hidden-input");
    hideGhosttyTextarea(textarea);
    cleanupEditableArtifacts(this.#container);

    let lastKeydown: { data: string; time: number } | null = null;
    let processedTextareaValue = "";
    const onKeydown = (event: KeyboardEvent) => {
      const customOutput = textareaKeyboardEventOutput(event);
      if (customOutput) {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") {
          event.stopImmediatePropagation();
        }
        textarea.value = "";
        processedTextareaValue = "";
        terminal.input(customOutput, true);
        cleanupEditableArtifacts(this.#container);
        return;
      }
      const output = keyboardEventOutput(event);
      if (output) {
        lastKeydown = { data: output, time: performance.now() };
      }
    };
    const onBeforeInput = (event: InputEvent) => {
      const output = beforeInputOutput(event);
      if (!output) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") {
        event.stopImmediatePropagation();
      }

      const now = performance.now();
      if (lastKeydown && lastKeydown.data === output && now - lastKeydown.time < 100) {
        textarea.value = "";
        processedTextareaValue = "";
        cleanupEditableArtifacts(this.#container);
        return;
      }

      textarea.value = "";
      processedTextareaValue = "";
      terminal.input(output, true);
      cleanupEditableArtifacts(this.#container);
    };
    const sendTextareaDelta = () => {
      const value = textarea.value;
      if (value === processedTextareaValue) {
        return;
      }

      const output = textareaDelta(processedTextareaValue, value);
      processedTextareaValue = value;
      if (output) {
        terminal.input(output, true);
      }
      cleanupEditableArtifacts(this.#container);
    };
    const onInput = () => {
      sendTextareaDelta();
    };
    const onCompositionStart = (event: CompositionEvent) => {
      processedTextareaValue = textarea.value;
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") {
        event.stopImmediatePropagation();
      }
      cleanupEditableArtifacts(this.#container);
    };
    const onCompositionUpdate = (event: CompositionEvent) => {
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") {
        event.stopImmediatePropagation();
      }
    };
    const onCompositionEnd = (event: CompositionEvent) => {
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") {
        event.stopImmediatePropagation();
      }
      sendTextareaDelta();
      textarea.value = "";
      processedTextareaValue = "";
      cleanupEditableArtifacts(this.#container);
    };
    const onBlur = () => {
      textarea.classList.remove("ghostty-keyboard-input");
      this.#textInputTapGraceUntil = 0;
    };

    textarea.addEventListener("keydown", onKeydown, { capture: true });
    textarea.addEventListener("beforeinput", onBeforeInput, { capture: true });
    textarea.addEventListener("input", onInput);
    textarea.addEventListener("compositionstart", onCompositionStart, { capture: true });
    textarea.addEventListener("compositionupdate", onCompositionUpdate, { capture: true });
    textarea.addEventListener("compositionend", onCompositionEnd, { capture: true });
    textarea.addEventListener("blur", onBlur);
    this.#mobileInputCleanup = () => {
      textarea.removeEventListener("keydown", onKeydown, { capture: true });
      textarea.removeEventListener("beforeinput", onBeforeInput, { capture: true });
      textarea.removeEventListener("input", onInput);
      textarea.removeEventListener("compositionstart", onCompositionStart, { capture: true });
      textarea.removeEventListener("compositionupdate", onCompositionUpdate, { capture: true });
      textarea.removeEventListener("compositionend", onCompositionEnd, { capture: true });
      textarea.removeEventListener("blur", onBlur);
    };
  }
}

function hideGhosttyTextarea(textarea: HTMLTextAreaElement) {
  textarea.style.position = "fixed";
  textarea.style.left = "-10000px";
  textarea.style.top = "0";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.opacity = "0";
  textarea.style.color = "transparent";
  textarea.style.background = "transparent";
  textarea.style.caretColor = "transparent";
  textarea.style.overflow = "hidden";
}

function cleanupEditableArtifacts(container: HTMLElement | null) {
  if (!container) {
    return;
  }
  for (const node of Array.from(container.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      node.remove();
    }
  }
}

function beforeInputOutput(event: InputEvent) {
  switch (event.inputType) {
    case "insertText":
    case "insertReplacementText":
      return event.data ? event.data.replace(/\n/g, "\r") : null;
    case "insertLineBreak":
    case "insertParagraph":
      return "\r";
    case "deleteContentBackward":
      return "\x7F";
    case "deleteContentForward":
      return "\x1B[3~";
    default:
      return null;
  }
}

function textareaDelta(previousValue: string, nextValue: string) {
  if (nextValue.startsWith(previousValue)) {
    return nextValue.slice(previousValue.length).replace(/\n/g, "\r");
  }

  const previousChars = Array.from(previousValue);
  const nextChars = Array.from(nextValue);
  let commonPrefixLength = 0;
  while (
    commonPrefixLength < previousChars.length &&
    commonPrefixLength < nextChars.length &&
    previousChars[commonPrefixLength] === nextChars[commonPrefixLength]
  ) {
    commonPrefixLength += 1;
  }

  const deletes = "\x7F".repeat(previousChars.length - commonPrefixLength);
  const inserts = nextChars.slice(commonPrefixLength).join("").replace(/\n/g, "\r");
  return `${deletes}${inserts}`;
}

function keyboardEventOutput(event: KeyboardEvent) {
  if (event.ctrlKey || event.altKey || event.metaKey) {
    return null;
  }
  if (event.key.length === 1) {
    return event.key;
  }
  switch (event.key) {
    case "Enter":
      return "\r";
    case "Backspace":
      return "\x7F";
    case "Delete":
      return "\x1B[3~";
    default:
      return null;
  }
}

function customKeyboardEventOutput(event: KeyboardEvent) {
  if (event.key === "Tab" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
    return "\x1B[Z";
  }
  return null;
}

function textareaKeyboardEventOutput(event: KeyboardEvent) {
  if (event.key !== "Tab" || event.ctrlKey || event.altKey || event.metaKey) {
    return customKeyboardEventOutput(event);
  }
  return event.shiftKey ? "\x1B[Z" : "\t";
}

function normalizeWheelLines(event: WheelEvent, rows: number, sensitivity: number) {
  const unit =
    event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? rows
      : event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 1
        : 1 / 16;
  const rawLines = event.deltaY * unit * sensitivity;
  if (Math.abs(rawLines) < 1) {
    return rawLines < 0 ? -1 : rawLines > 0 ? 1 : 0;
  }
  return rawLines < 0 ? Math.ceil(rawLines) : Math.floor(rawLines);
}
