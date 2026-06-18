import type { TerminalSelectionPoint } from "./terminalSelection";

export type TerminalTouchClientPoint = {
  clientX: number;
  clientY: number;
};

export type TerminalTouchSelectionState =
  | { phase: "idle" }
  | {
      phase: "placing-start";
      start: TerminalSelectionPoint;
      endpoint: TerminalSelectionPoint;
      client: TerminalTouchClientPoint;
    }
  | {
      phase: "waiting-endpoint";
      start: TerminalSelectionPoint;
      endpoint: TerminalSelectionPoint;
      client: TerminalTouchClientPoint;
    }
  | {
      phase: "dragging-endpoint";
      start: TerminalSelectionPoint;
      endpoint: TerminalSelectionPoint;
      client: TerminalTouchClientPoint;
    };

export const idleTouchSelectionState: TerminalTouchSelectionState = { phase: "idle" };

export function startTouchSelectionPlacement(
  point: TerminalSelectionPoint,
  client: TerminalTouchClientPoint,
): TerminalTouchSelectionState {
  return { phase: "placing-start", start: point, endpoint: point, client };
}

export function moveTouchSelectionPlacement(
  state: TerminalTouchSelectionState,
  point: TerminalSelectionPoint,
  client: TerminalTouchClientPoint,
): TerminalTouchSelectionState {
  if (state.phase !== "placing-start") {
    return state;
  }
  return { ...state, start: point, endpoint: point, client };
}

export function commitTouchSelectionStart(
  state: TerminalTouchSelectionState,
): TerminalTouchSelectionState {
  if (state.phase !== "placing-start") {
    return state;
  }
  return {
    phase: "waiting-endpoint",
    start: state.start,
    endpoint: state.start,
    client: state.client,
  };
}

export function beginTouchSelectionEndpointDrag(
  state: TerminalTouchSelectionState,
  point: TerminalSelectionPoint,
  client: TerminalTouchClientPoint,
): TerminalTouchSelectionState {
  if (state.phase !== "waiting-endpoint") {
    return state;
  }
  return { phase: "dragging-endpoint", start: state.start, endpoint: point, client };
}

export function moveTouchSelectionEndpoint(
  state: TerminalTouchSelectionState,
  point: TerminalSelectionPoint,
  client: TerminalTouchClientPoint,
): TerminalTouchSelectionState {
  if (state.phase !== "dragging-endpoint") {
    return state;
  }
  return { ...state, endpoint: point, client };
}

export function completeTouchSelection(state: TerminalTouchSelectionState) {
  if (state.phase !== "dragging-endpoint") {
    return null;
  }
  return { start: state.start, end: state.endpoint };
}
