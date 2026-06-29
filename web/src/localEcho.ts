/**
 * Predictive local echo: shows typed printable characters immediately
 * in the terminal before the server echo arrives.
 *
 * Strategy:
 * - When user types a printable character, write it to the terminal immediately
 * - Track "speculative" bytes that haven't been confirmed by the server
 * - When server data arrives, check if it matches our speculation
 * - If it matches: consume the speculation (no visual change needed)
 * - If it doesn't match: clear predictions and let server be authoritative
 *
 * Simplified approach (VS Code style):
 * - Only echo single printable ASCII/Unicode characters (not control sequences)
 * - Disable echo when we detect the terminal is in raw/no-echo mode
 * - Use a prediction buffer; when server output arrives, if it starts with
 *   our predicted characters, we skip re-writing them (they're already displayed)
 * - If server output doesn't match, clear predictions and let server be authoritative
 */

export type LocalEchoController = {
  /** Call when user sends input. Returns true if the character was locally echoed. */
  onInput(data: string): boolean;

  /** Call with server output before writing to terminal. Returns filtered output. */
  onServerOutput(data: Uint8Array): Uint8Array;

  /** Reset state (on reconnect, mode change, etc.) */
  reset(): void;

  /** Disable/enable (e.g., during password prompts) */
  setEnabled(enabled: boolean): void;
};

export function createLocalEchoController(
  writeToTerminal: (data: Uint8Array) => void,
): LocalEchoController {
  let enabled = true;
  let predictions: number[] = []; // predicted bytes awaiting server confirmation
  const encoder = new TextEncoder();
  const MAX_PREDICTIONS = 128; // don't let speculation grow unbounded
  const PREDICTION_TIMEOUT_MS = 1000; // clear stale predictions
  let lastPredictionTime = 0;

  function isPrintable(data: string): boolean {
    if (data.length !== 1) return false;
    const code = data.charCodeAt(0);
    // Printable ASCII and basic Unicode (not control chars)
    return code >= 0x20 && code !== 0x7f;
  }

  function clearPredictions() {
    predictions = [];
  }

  function onInput(data: string): boolean {
    if (!enabled) return false;
    if (!isPrintable(data)) {
      // Non-printable input (Enter, Tab, Ctrl+C, escape sequences) — clear predictions
      // because the server response will be unpredictable
      clearPredictions();
      return false;
    }
    if (predictions.length >= MAX_PREDICTIONS) {
      return false; // too many unconfirmed predictions, stop speculating
    }

    const bytes = encoder.encode(data);
    for (const byte of bytes) {
      predictions.push(byte);
    }
    lastPredictionTime = performance.now();

    // Write the character directly to the terminal
    writeToTerminal(bytes);
    return true;
  }

  function onServerOutput(data: Uint8Array): Uint8Array {
    // Clear stale predictions
    if (
      predictions.length > 0 &&
      performance.now() - lastPredictionTime > PREDICTION_TIMEOUT_MS
    ) {
      clearPredictions();
    }

    if (predictions.length === 0) {
      return data; // nothing to reconcile
    }

    // Try to match server output against predictions
    let matchLen = 0;
    for (let i = 0; i < data.length && matchLen < predictions.length; i++) {
      if (data[i] === predictions[matchLen]) {
        matchLen++;
      } else {
        // Mismatch — server sent something we didn't predict
        // Clear all predictions and return full server output
        // The terminal will show a brief "jump" but this is correct behavior
        clearPredictions();
        return data;
      }
    }

    // Remove matched predictions
    predictions.splice(0, matchLen);

    // Return the portion of server output that wasn't predicted
    // (since predicted bytes are already displayed)
    if (matchLen >= data.length) {
      return new Uint8Array(0); // entire output was predicted, nothing new to write
    }
    return data.slice(matchLen);
  }

  function reset() {
    clearPredictions();
  }

  function setEnabled(value: boolean) {
    enabled = value;
    if (!value) clearPredictions();
  }

  return { onInput, onServerOutput, reset, setEnabled };
}
