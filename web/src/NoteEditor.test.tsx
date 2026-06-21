/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoteEditor, noteDraftStorageKey } from "./App";
import type { ScopedNoteEntry } from "./App";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
  document.body.innerHTML = "";
  localStorage.clear();
  vi.useRealTimers();
});

describe("NoteEditor autosave conflicts", () => {
  it("keeps continued typing pending when the user's in-flight save appears in a refetch", async () => {
    const saves: Array<{
      title: string;
      body: string;
      expectedRevision: number;
      deferred: Deferred<number>;
    }> = [];
    const onSave = vi.fn((_entry: ScopedNoteEntry, title: string, body: string, expectedRevision: number) => {
      const deferred = createDeferred<number>();
      saves.push({ title, body, expectedRevision, deferred });
      return deferred.promise;
    });
    const { container, render } = createEditorHarness(onSave);

    await render(noteEntry({ revision: 5, body: "" }));
    await changeTextarea(container, "abc");
    await advanceAutosaveTimer();

    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ body: "abc", expectedRevision: 5 });

    await changeTextarea(container, "abcd");
    await render(noteEntry({ revision: 6, body: "abc" }));

    expect(editorStatus(container)).not.toBe("conflict");
    expect(noteBodyInput(container).value).toBe("abcd");

    await act(async () => {
      saves[0].deferred.resolve(6);
      await Promise.resolve();
    });
    await advanceAutosaveTimer();

    expect(editorStatus(container)).not.toBe("conflict");
    expect(saves).toHaveLength(2);
    expect(saves[1]).toMatchObject({ body: "abcd", expectedRevision: 6 });
  });

  it("enters conflict when a divergent server revision arrives under a dirty draft", async () => {
    const saves: Array<{ body: string; expectedRevision: number; deferred: Deferred<number> }> = [];
    const onSave = vi.fn((_entry: ScopedNoteEntry, _title: string, body: string, expectedRevision: number) => {
      const deferred = createDeferred<number>();
      saves.push({ body, expectedRevision, deferred });
      return deferred.promise;
    });
    const { container, render } = createEditorHarness(onSave);

    await render(noteEntry({ revision: 5, body: "" }));
    await changeTextarea(container, "local draft");
    await advanceAutosaveTimer();
    await render(noteEntry({ revision: 6, body: "remote edit" }));

    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ body: "local draft", expectedRevision: 5 });
    expect(editorStatus(container)).toBe("conflict");
    expect(noteBodyInput(container).value).toBe("local draft");
  });

  it("reloads persisted dirty drafts as conflict only when the server revision advanced", async () => {
    const onSave = vi.fn(() => Promise.resolve(7));
    const { container, render } = createEditorHarness(onSave);
    const advancedEntry = noteEntry({ revision: 6, body: "remote edit" });

    localStorage.setItem(
      noteDraftStorageKey(advancedEntry),
      JSON.stringify({
        title: "Local title",
        body: "local draft",
        baseRevision: 5,
        updatedAt: 100,
      }),
    );
    await render(advancedEntry);

    expect(editorStatus(container)).toBe("conflict");
    expect(noteBodyInput(container).value).toBe("local draft");

    const matchingBaseEntry = noteEntry({ noteId: "note-2", revision: 6, body: "remote edit" });
    localStorage.setItem(
      noteDraftStorageKey(matchingBaseEntry),
      JSON.stringify({
        title: "Local title",
        body: "local draft",
        baseRevision: 6,
        updatedAt: 200,
      }),
    );
    await render(matchingBaseEntry);

    expect(editorStatus(container)).toBe("pending");
    expect(noteBodyInput(container).value).toBe("local draft");
  });
});

function createEditorHarness(
  onSave: (entry: ScopedNoteEntry, title: string, body: string, expectedRevision: number) => Promise<number>,
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);

  const render = async (entry: ScopedNoteEntry) => {
    await act(async () => {
      root.render(
        <NoteEditor
          entry={entry}
          canAttachToCurrentPane
          onSave={onSave}
          onAttachToCurrentPane={vi.fn()}
          onDetach={vi.fn()}
          onArchive={vi.fn()}
          onRestore={vi.fn()}
          onDelete={vi.fn()}
          onViewPane={vi.fn()}
        />,
      );
    });
  };

  return { container, render };
}

function noteEntry({
  noteId = "note-1",
  revision,
  title = "Server title",
  body,
}: {
  noteId?: string;
  revision: number;
  title?: string;
  body: string;
}): ScopedNoteEntry {
  return {
    bridgeId: "bridge-a",
    connectionKey: "http://bridge-a",
    storeId: "store-a",
    sessionKey: "session-a",
    bridgeIndex: 0,
    bridgeLabel: "Bridge A",
    bridgeColor: "#89b4fa",
    snapshot: null,
    note: {
      note_id: noteId,
      title,
      body,
      created_at: "1",
      updated_at: String(revision),
      session_key: "session-a",
      attachment_history: [],
      revision,
      link_state: "detached",
    },
  };
}

async function changeTextarea(container: HTMLElement, value: string) {
  const input = noteBodyInput(container);
  await act(async () => {
    setNativeValue(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function advanceAutosaveTimer() {
  await act(async () => {
    vi.advanceTimersByTime(700);
    await Promise.resolve();
  });
}

function editorStatus(container: HTMLElement) {
  return container.querySelector(".note-editor-status")?.textContent ?? "";
}

function noteBodyInput(container: HTMLElement) {
  const input = container.querySelector<HTMLTextAreaElement>(".note-body-input");
  if (!input) {
    throw new Error("missing note body input");
  }
  return input;
}

function setNativeValue(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(element, value);
}

function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
