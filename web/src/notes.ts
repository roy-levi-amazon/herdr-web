import { fetchWithTimeout } from "./fetchWithTimeout";
import type { PaneInfo } from "./types";
import type { BridgeCapabilities } from "./bridge";

export type NoteLinkState = "linked" | "unresolved" | "detached";

export type NotePaneContext = {
  pane_label?: string;
  pane_title?: string;
  agent?: string;
  display_agent?: string;
  cwd?: string;
  foreground_cwd?: string;
};

export type NoteAttachment = {
  type: "pane";
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  terminal_id?: string;
  pane_revision?: number;
  observed_generation?: string;
  captured_at: string;
  context: NotePaneContext;
};

export type PaneNote = {
  note_id: string;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
  archived_at?: string;
  deleted_at?: string;
  session_key: string;
  attachment?: NoteAttachment | null;
  attachment_history: NoteAttachment[];
  revision: number;
  link_state: NoteLinkState;
  resolved_pane?: PaneInfo;
};

export type NotesListResponse = {
  store_id: string;
  session_key: string;
  notes: PaneNote[];
};

export type NotesListOptions = {
  includeArchived?: boolean;
  includeDeleted?: boolean;
  includeOtherSessions?: boolean;
  paneId?: string;
};

export type NoteCreateInput = {
  title?: string;
  body?: string;
  paneId?: string;
};

export type NoteUpdateInput = {
  title?: string;
  body?: string;
  expectedRevision: number;
};

export type NoteAttachInput = {
  paneId: string;
  expectedRevision: number;
};

export type NoteRevisionInput = {
  expectedRevision: number;
};

export type BridgeHttpUrl = (path: string, query?: URLSearchParams) => string;

export class NotesApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "NotesApiError";
    this.status = status;
  }
}

export function isNotesConflictError(error: unknown): error is NotesApiError {
  return error instanceof NotesApiError && error.status === 409;
}

export function supportsNotes(capabilities: BridgeCapabilities | null | undefined) {
  return capabilities?.notes?.version === 1;
}

export async function fetchNotes(
  httpUrl: BridgeHttpUrl,
  options: NotesListOptions = {},
): Promise<NotesListResponse> {
  const query = new URLSearchParams();
  if (options.includeArchived) {
    query.set("include_archived", "true");
  }
  if (options.includeDeleted) {
    query.set("include_deleted", "true");
  }
  if (options.includeOtherSessions) {
    query.set("include_other_sessions", "true");
  }
  if (options.paneId) {
    query.set("pane_id", options.paneId);
  }
  const response = await fetchWithTimeout(httpUrl("/api/notes", query));
  return parseNotesResponse(response);
}

export function createNote(httpUrl: BridgeHttpUrl, input: NoteCreateInput) {
  return sendNoteMutation(httpUrl, "/api/notes", {
    title: input.title,
    body: input.body,
    pane_id: input.paneId,
  });
}

export function updateNote(httpUrl: BridgeHttpUrl, noteId: string, input: NoteUpdateInput) {
  return sendNoteMutation(httpUrl, notePath(noteId, "update"), {
    title: input.title,
    body: input.body,
    expected_revision: input.expectedRevision,
  });
}

export function attachNote(httpUrl: BridgeHttpUrl, noteId: string, input: NoteAttachInput) {
  return sendNoteMutation(httpUrl, notePath(noteId, "attach"), {
    pane_id: input.paneId,
    expected_revision: input.expectedRevision,
  });
}

export function detachNote(httpUrl: BridgeHttpUrl, noteId: string, input: NoteRevisionInput) {
  return sendNoteMutation(httpUrl, notePath(noteId, "detach"), {
    expected_revision: input.expectedRevision,
  });
}

export function archiveNote(httpUrl: BridgeHttpUrl, noteId: string, input: NoteRevisionInput) {
  return sendNoteMutation(httpUrl, notePath(noteId, "archive"), {
    expected_revision: input.expectedRevision,
  });
}

export function restoreNote(httpUrl: BridgeHttpUrl, noteId: string, input: NoteRevisionInput) {
  return sendNoteMutation(httpUrl, notePath(noteId, "restore"), {
    expected_revision: input.expectedRevision,
  });
}

export function deleteNote(httpUrl: BridgeHttpUrl, noteId: string, input: NoteRevisionInput) {
  return sendNoteMutation(httpUrl, notePath(noteId, "delete"), {
    expected_revision: input.expectedRevision,
  });
}

export function notesForPane(notes: readonly PaneNote[], paneId: string | null | undefined) {
  if (!paneId) {
    return [];
  }
  return notes
    .filter((note) => !note.archived_at && !note.deleted_at)
    .filter(
      (note) =>
        note.link_state === "linked" &&
        note.resolved_pane?.pane_id === paneId &&
        note.attachment?.pane_id === paneId,
    )
    .sort(compareNotes);
}

export function compareNotes(a: PaneNote, b: PaneNote) {
  const updated = Number(b.updated_at || 0) - Number(a.updated_at || 0);
  if (updated !== 0) {
    return updated;
  }
  return a.note_id.localeCompare(b.note_id, undefined, { numeric: true });
}

async function sendNoteMutation(
  httpUrl: BridgeHttpUrl,
  path: string,
  body: Record<string, unknown>,
) {
  const response = await fetchWithTimeout(httpUrl(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseNoteResponse(response);
}

async function parseNotesResponse(response: Response) {
  if (!response.ok) {
    throw await notesApiError(response, "notes");
  }
  return (await response.json()) as NotesListResponse;
}

async function parseNoteResponse(response: Response) {
  if (!response.ok) {
    throw await notesApiError(response, "note mutation");
  }
  return (await response.json()) as PaneNote;
}

async function notesApiError(response: Response, fallback: string) {
  try {
    const parsed = (await response.json()) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return new NotesApiError(parsed.error, response.status);
    }
  } catch {
    // Fall through to the status-based error.
  }
  return new NotesApiError(`${fallback} failed: ${response.status}`, response.status);
}

function notePath(noteId: string, action: string) {
  return `/api/notes/${encodeURIComponent(noteId)}/${action}`;
}
