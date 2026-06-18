import { describe, expect, it } from "vitest";
import {
  beginTouchSelectionEndpointDrag,
  commitTouchSelectionStart,
  completeTouchSelection,
  moveTouchSelectionEndpoint,
  moveTouchSelectionPlacement,
  startTouchSelectionPlacement,
} from "./terminalTouchSelection";

describe("terminal touch selection flow", () => {
  it("commits a refined long-press point as the selection start", () => {
    const placing = startTouchSelectionPlacement(
      { col: 1, row: 2 },
      { clientX: 20, clientY: 40 },
    );
    const refined = moveTouchSelectionPlacement(placing, { col: 3, row: 2 }, { clientX: 42, clientY: 40 });
    const waiting = commitTouchSelectionStart(refined);

    expect(waiting).toMatchObject({
      phase: "waiting-endpoint",
      start: { col: 3, row: 2 },
      endpoint: { col: 3, row: 2 },
    });
  });

  it("completes forward endpoint drags", () => {
    const waiting = commitTouchSelectionStart(
      startTouchSelectionPlacement({ col: 2, row: 1 }, { clientX: 18, clientY: 30 }),
    );
    const dragging = beginTouchSelectionEndpointDrag(waiting, { col: 7, row: 1 }, { clientX: 63, clientY: 30 });

    expect(completeTouchSelection(dragging)).toEqual({
      start: { col: 2, row: 1 },
      end: { col: 7, row: 1 },
    });
  });

  it("completes backward endpoint drags without reordering the anchor", () => {
    const waiting = commitTouchSelectionStart(
      startTouchSelectionPlacement({ col: 8, row: 3 }, { clientX: 72, clientY: 58 }),
    );
    const dragging = beginTouchSelectionEndpointDrag(waiting, { col: 4, row: 2 }, { clientX: 36, clientY: 42 });
    const moved = moveTouchSelectionEndpoint(dragging, { col: 1, row: 2 }, { clientX: 9, clientY: 42 });

    expect(completeTouchSelection(moved)).toEqual({
      start: { col: 8, row: 3 },
      end: { col: 1, row: 2 },
    });
  });
});
