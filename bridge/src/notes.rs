use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use herdr_compat::api::schema::PaneInfo;
use serde::{Deserialize, Serialize};

const NOTES_STORE_VERSION: u32 = 1;
const OBSERVATION_STORE_VERSION: u32 = 1;
const MAX_TITLE_CHARS: usize = 200;
const MAX_BODY_BYTES: usize = 256 * 1024;
const MAX_ATTACHMENT_HISTORY: usize = 20;
const MAX_OBSERVATIONS_PER_SESSION: usize = 5_000;
const MISSING_OBSERVATION_RETENTION_MS: u128 = 30 * 24 * 60 * 60 * 1000;

#[derive(Clone)]
pub struct NotesManager {
    notes_path: PathBuf,
    notes_lock_path: PathBuf,
    observations_path: PathBuf,
    observations_lock_path: PathBuf,
    session_key: String,
}

#[derive(Debug)]
pub enum NotesError {
    BadRequest(String),
    Conflict(String),
    Io(io::Error),
    Store(String),
}

impl std::fmt::Display for NotesError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadRequest(message) => write!(f, "{message}"),
            Self::Conflict(message) => write!(f, "{message}"),
            Self::Io(err) => write!(f, "{err}"),
            Self::Store(message) => write!(f, "{message}"),
        }
    }
}

impl From<io::Error> for NotesError {
    fn from(err: io::Error) -> Self {
        Self::Io(err)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotesListResponse {
    pub store_id: String,
    pub session_key: String,
    pub notes: Vec<NoteResponse>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct NotesListQuery {
    #[serde(default)]
    pub include_archived: bool,
    #[serde(default)]
    pub include_deleted: bool,
    #[serde(default)]
    pub include_other_sessions: bool,
    pub pane_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateNoteRequest {
    pub title: Option<String>,
    pub body: Option<String>,
    pub pane_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateNoteRequest {
    pub title: Option<String>,
    pub body: Option<String>,
    pub expected_revision: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AttachNoteRequest {
    pub pane_id: String,
    pub expected_revision: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RevisionRequest {
    pub expected_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct NotesStore {
    version: u32,
    store_id: String,
    next_note_number: u64,
    created_at: String,
    updated_at: String,
    notes: Vec<NoteRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ObservationStore {
    version: u32,
    next_generation_number: u64,
    observations: Vec<PaneObservation>,
}

struct LoadedObservationStore {
    store: ObservationStore,
    recovered: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteRecord {
    pub note_id: String,
    pub title: String,
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
    pub session_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment: Option<NoteAttachment>,
    #[serde(default)]
    pub attachment_history: Vec<NoteAttachment>,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteAttachment {
    #[serde(rename = "type")]
    pub kind: String,
    pub pane_id: String,
    pub workspace_id: String,
    pub tab_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_generation: Option<String>,
    pub captured_at: String,
    pub context: NotePaneContext,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct NotePaneContext {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreground_cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteResponse {
    #[serde(flatten)]
    pub note: NoteRecord,
    pub link_state: NoteLinkState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_pane: Option<PaneInfo>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoteLinkState {
    Linked,
    Unresolved,
    Detached,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PaneObservation {
    session_key: String,
    pane_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    terminal_id: Option<String>,
    workspace_id: String,
    tab_id: String,
    observed_generation: String,
    generation_confidence: GenerationConfidence,
    first_seen_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    missing_since: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum GenerationConfidence {
    Known,
    RecoveredUnknown,
}

impl NotesManager {
    pub fn new() -> io::Result<Self> {
        let notes_dir = default_notes_dir();
        ensure_private_dir(&notes_dir)?;
        Ok(Self {
            notes_path: notes_dir.join("notes.json"),
            notes_lock_path: notes_dir.join("notes.lock"),
            observations_path: notes_dir.join("pane-observations.json"),
            observations_lock_path: notes_dir.join("pane-observations.lock"),
            session_key: session_key(),
        })
    }

    #[cfg(test)]
    fn for_test(dir: PathBuf, session_key: &str) -> io::Result<Self> {
        ensure_private_dir(&dir)?;
        Ok(Self {
            notes_path: dir.join("notes.json"),
            notes_lock_path: dir.join("notes.lock"),
            observations_path: dir.join("pane-observations.json"),
            observations_lock_path: dir.join("pane-observations.lock"),
            session_key: session_key.to_string(),
        })
    }

    pub fn list(
        &self,
        query: NotesListQuery,
        panes: &[PaneInfo],
    ) -> Result<NotesListResponse, NotesError> {
        let _lock = LockFile::exclusive(&self.notes_lock_path)?;
        let store = self.load_or_create_notes_store()?;
        let observations = self.load_observation_store_best_effort().observations;
        let pane_filter = query
            .pane_id
            .as_deref()
            .map(str::trim)
            .filter(|pane_id| !pane_id.is_empty());
        let pane_filter_exists =
            pane_filter.is_none_or(|pane_id| panes.iter().any(|pane| pane.pane_id == pane_id));
        let notes = if !pane_filter_exists {
            Vec::new()
        } else {
            store
                .notes
                .into_iter()
                .filter(|note| query.include_other_sessions || note.session_key == self.session_key)
                .filter(|note| query.include_archived || note.archived_at.is_none())
                .filter(|note| query.include_deleted || note.deleted_at.is_none())
                .filter(|note| {
                    pane_filter.is_none_or(|pane_id| {
                        note.session_key == self.session_key
                            && note
                                .attachment
                                .as_ref()
                                .is_some_and(|attachment| attachment.pane_id == pane_id)
                    })
                })
                .map(|note| note_response(note, panes, &observations, &self.session_key))
                .collect()
        };
        Ok(NotesListResponse {
            store_id: store.store_id,
            session_key: self.session_key.clone(),
            notes,
        })
    }

    pub fn create(
        &self,
        request: CreateNoteRequest,
        panes: &[PaneInfo],
    ) -> Result<NoteResponse, NotesError> {
        let attachment = match request
            .pane_id
            .as_deref()
            .map(str::trim)
            .filter(|pane| !pane.is_empty())
        {
            Some(pane_id) => Some(self.capture_attachment_for_pane_id(pane_id, panes)?),
            None => None,
        };
        let title = normalize_title(request.title.as_deref(), request.body.as_deref())?;
        let body = normalize_body(request.body.as_deref())?;
        self.with_notes_store(|store, now| {
            let note_id = format!("note_{}", store.next_note_number);
            store.next_note_number += 1;
            let note = NoteRecord {
                note_id,
                title,
                body,
                created_at: now.clone(),
                updated_at: now,
                archived_at: None,
                deleted_at: None,
                session_key: self.session_key.clone(),
                attachment,
                attachment_history: Vec::new(),
                revision: 1,
            };
            store.notes.push(note.clone());
            Ok(note)
        })
        .map(|note| {
            let observations = self.load_observation_store_best_effort().observations;
            note_response(note, panes, &observations, &self.session_key)
        })
    }

    pub fn update(
        &self,
        note_id: &str,
        request: UpdateNoteRequest,
        panes: &[PaneInfo],
    ) -> Result<NoteResponse, NotesError> {
        let title = match request.title {
            Some(title) => Some(normalize_title(Some(&title), None)?),
            None => None,
        };
        let body = match request.body {
            Some(body) => Some(normalize_body(Some(&body))?),
            None => None,
        };
        self.with_note_mutation(note_id, request.expected_revision, |note, now| {
            if let Some(title) = title {
                note.title = title;
            }
            if let Some(body) = body {
                note.body = body;
            }
            note.updated_at = now;
            note.revision += 1;
        })
        .map(|note| {
            let observations = self.load_observation_store_best_effort().observations;
            note_response(note, panes, &observations, &self.session_key)
        })
    }

    pub fn attach(
        &self,
        note_id: &str,
        request: AttachNoteRequest,
        panes: &[PaneInfo],
    ) -> Result<NoteResponse, NotesError> {
        let attachment = self.capture_attachment_for_pane_id(request.pane_id.trim(), panes)?;
        self.with_note_mutation(note_id, request.expected_revision, |note, now| {
            push_attachment_history(note, now.clone());
            note.attachment = Some(attachment);
            note.updated_at = now;
            note.revision += 1;
        })
        .map(|note| {
            let observations = self.load_observation_store_best_effort().observations;
            note_response(note, panes, &observations, &self.session_key)
        })
    }

    pub fn detach(
        &self,
        note_id: &str,
        request: RevisionRequest,
        panes: &[PaneInfo],
    ) -> Result<NoteResponse, NotesError> {
        self.with_note_mutation(note_id, request.expected_revision, |note, now| {
            push_attachment_history(note, now.clone());
            note.attachment = None;
            note.updated_at = now;
            note.revision += 1;
        })
        .map(|note| {
            let observations = self.load_observation_store_best_effort().observations;
            note_response(note, panes, &observations, &self.session_key)
        })
    }

    pub fn archive(
        &self,
        note_id: &str,
        request: RevisionRequest,
        panes: &[PaneInfo],
    ) -> Result<NoteResponse, NotesError> {
        self.with_note_mutation(note_id, request.expected_revision, |note, now| {
            note.archived_at = Some(now.clone());
            note.updated_at = now;
            note.revision += 1;
        })
        .map(|note| {
            let observations = self.load_observation_store_best_effort().observations;
            note_response(note, panes, &observations, &self.session_key)
        })
    }

    pub fn restore(
        &self,
        note_id: &str,
        request: RevisionRequest,
        panes: &[PaneInfo],
    ) -> Result<NoteResponse, NotesError> {
        self.with_note_mutation(note_id, request.expected_revision, |note, now| {
            note.archived_at = None;
            note.deleted_at = None;
            note.updated_at = now;
            note.revision += 1;
        })
        .map(|note| {
            let observations = self.load_observation_store_best_effort().observations;
            note_response(note, panes, &observations, &self.session_key)
        })
    }

    pub fn delete(
        &self,
        note_id: &str,
        request: RevisionRequest,
        panes: &[PaneInfo],
    ) -> Result<NoteResponse, NotesError> {
        self.with_note_mutation(note_id, request.expected_revision, |note, now| {
            note.deleted_at = Some(now.clone());
            note.updated_at = now;
            note.revision += 1;
        })
        .map(|note| {
            let observations = self.load_observation_store_best_effort().observations;
            note_response(note, panes, &observations, &self.session_key)
        })
    }

    pub fn observe_panes(&self, panes: &[PaneInfo]) -> Result<bool, NotesError> {
        let observed_ids: HashSet<&str> = panes.iter().map(|pane| pane.pane_id.as_str()).collect();
        self.with_observation_store(|store, now, recovered| {
            let mut changed = false;
            let new_confidence = if recovered {
                GenerationConfidence::RecoveredUnknown
            } else {
                GenerationConfidence::Known
            };
            for pane in panes {
                changed |= ensure_observation_for_pane(
                    store,
                    &self.session_key,
                    pane,
                    &now,
                    new_confidence,
                );
            }
            for observation in store
                .observations
                .iter_mut()
                .filter(|item| item.session_key == self.session_key)
            {
                if !observed_ids.contains(observation.pane_id.as_str())
                    && observation.missing_since.is_none()
                {
                    observation.missing_since = Some(now.clone());
                    changed = true;
                }
            }
            changed |= prune_observations(store, &now);
            Ok(changed)
        })
    }

    pub fn update_for_pane_move(
        &self,
        previous_pane_id: &str,
        moved_pane: &PaneInfo,
    ) -> Result<bool, NotesError> {
        let attachment = self.capture_attachment_for_pane(moved_pane);
        let changed = self.with_notes_store(|store, now| {
            let mut changed = false;
            for note in store
                .notes
                .iter_mut()
                .filter(|note| note.session_key == self.session_key)
            {
                let matches = note
                    .attachment
                    .as_ref()
                    .is_some_and(|attachment| attachment.pane_id == previous_pane_id);
                if matches {
                    push_attachment_history(note, now.clone());
                    note.attachment = Some(attachment.clone());
                    note.updated_at = now.clone();
                    note.revision += 1;
                    changed = true;
                }
            }
            Ok(changed)
        })?;
        Ok(changed)
    }

    fn capture_attachment_for_pane_id(
        &self,
        pane_id: &str,
        panes: &[PaneInfo],
    ) -> Result<NoteAttachment, NotesError> {
        if pane_id.is_empty() {
            return Err(NotesError::BadRequest("pane_id is required".to_string()));
        }
        let pane = panes
            .iter()
            .find(|pane| pane.pane_id == pane_id)
            .ok_or_else(|| NotesError::BadRequest(format!("pane not found: {pane_id}")))?;
        Ok(self.capture_attachment_for_pane(pane))
    }

    fn capture_attachment_for_pane(&self, pane: &PaneInfo) -> NoteAttachment {
        let observed_generation = self
            .with_observation_store(|store, now, recovered| {
                ensure_observation_for_pane(
                    store,
                    &self.session_key,
                    pane,
                    &now,
                    if recovered {
                        GenerationConfidence::RecoveredUnknown
                    } else {
                        GenerationConfidence::Known
                    },
                );
                Ok(observation_generation_for_pane(
                    store,
                    &self.session_key,
                    &pane.pane_id,
                ))
            })
            .ok()
            .flatten();
        NoteAttachment {
            kind: "pane".to_string(),
            pane_id: pane.pane_id.clone(),
            workspace_id: pane.workspace_id.clone(),
            tab_id: pane.tab_id.clone(),
            terminal_id: Some(pane.terminal_id.clone()),
            pane_revision: Some(pane.revision),
            observed_generation,
            captured_at: now_ms_string(),
            context: NotePaneContext {
                pane_label: pane.label.clone(),
                pane_title: pane.title.clone(),
                agent: pane.agent.clone(),
                display_agent: pane.display_agent.clone(),
                cwd: pane.cwd.clone(),
                foreground_cwd: pane.foreground_cwd.clone(),
            },
        }
    }

    fn with_note_mutation<F>(
        &self,
        note_id: &str,
        expected_revision: u64,
        mutate: F,
    ) -> Result<NoteRecord, NotesError>
    where
        F: FnOnce(&mut NoteRecord, String),
    {
        let note_id = normalized_note_id(note_id)?;
        self.with_notes_store(|store, now| {
            let note = store
                .notes
                .iter_mut()
                .find(|note| note.note_id == note_id)
                .ok_or_else(|| NotesError::BadRequest(format!("note not found: {note_id}")))?;
            if note.revision != expected_revision {
                return Err(NotesError::Conflict("note has changed".to_string()));
            }
            mutate(note, now);
            Ok(note.clone())
        })
    }

    fn with_notes_store<F, T>(&self, mutate: F) -> Result<T, NotesError>
    where
        F: FnOnce(&mut NotesStore, String) -> Result<T, NotesError>,
    {
        let _lock = LockFile::exclusive(&self.notes_lock_path)?;
        let mut store = self.load_or_create_notes_store()?;
        let result = mutate(&mut store, now_ms_string())?;
        store.updated_at = now_ms_string();
        write_json_atomic(&self.notes_path, &store)?;
        Ok(result)
    }

    fn with_observation_store<F, T>(&self, mutate: F) -> Result<T, NotesError>
    where
        F: FnOnce(&mut ObservationStore, String, bool) -> Result<T, NotesError>,
    {
        let _lock = LockFile::exclusive(&self.observations_lock_path)?;
        let loaded = self.load_observation_store_for_update();
        let mut store = loaded.store;
        let before = serde_json::to_vec(&store).unwrap_or_default();
        let result = mutate(&mut store, now_ms_string(), loaded.recovered)?;
        let changed = result_changed(&before, &store);
        if changed || loaded.recovered {
            write_json_atomic(&self.observations_path, &store)?;
        }
        Ok(result)
    }

    fn load_or_create_notes_store(&self) -> Result<NotesStore, NotesError> {
        match fs::read(&self.notes_path) {
            Ok(bytes) => parse_notes_store(&bytes),
            Err(err) if err.kind() == ErrorKind::NotFound => {
                let now = now_ms_string();
                Ok(NotesStore {
                    version: NOTES_STORE_VERSION,
                    store_id: format!("store_{}_{}", now, std::process::id()),
                    next_note_number: 1,
                    created_at: now.clone(),
                    updated_at: now,
                    notes: Vec::new(),
                })
            }
            Err(err) => Err(NotesError::Io(err)),
        }
    }

    fn load_observation_store_best_effort(&self) -> ObservationStore {
        match fs::read(&self.observations_path) {
            Ok(bytes) => {
                parse_observation_store(&bytes).unwrap_or_else(|_| default_observation_store())
            }
            Err(_) => default_observation_store(),
        }
    }

    fn load_observation_store_for_update(&self) -> LoadedObservationStore {
        match fs::read(&self.observations_path) {
            Ok(bytes) => match parse_observation_store(&bytes) {
                Ok(store) => LoadedObservationStore {
                    store,
                    recovered: false,
                },
                Err(_) => {
                    copy_corrupt_once(&self.observations_path);
                    LoadedObservationStore {
                        store: default_observation_store(),
                        recovered: true,
                    }
                }
            },
            Err(err) if err.kind() == ErrorKind::NotFound => LoadedObservationStore {
                store: default_observation_store(),
                recovered: self.notes_path.exists(),
            },
            Err(_) => LoadedObservationStore {
                store: default_observation_store(),
                recovered: true,
            },
        }
    }
}

fn result_changed<T: Serialize>(before: &[u8], value: &T) -> bool {
    serde_json::to_vec(value).map_or(true, |after| before != after)
}

fn parse_notes_store(bytes: &[u8]) -> Result<NotesStore, NotesError> {
    let store: NotesStore = serde_json::from_slice(bytes)
        .map_err(|err| NotesError::Store(format!("notes store is unreadable: {err}")))?;
    if store.version != NOTES_STORE_VERSION {
        return Err(NotesError::Store(format!(
            "unsupported notes store version: {}",
            store.version
        )));
    }
    Ok(store)
}

fn parse_observation_store(bytes: &[u8]) -> Result<ObservationStore, NotesError> {
    let store: ObservationStore = serde_json::from_slice(bytes)
        .map_err(|err| NotesError::Store(format!("observation store is unreadable: {err}")))?;
    if store.version != OBSERVATION_STORE_VERSION {
        return Err(NotesError::Store(format!(
            "unsupported observation store version: {}",
            store.version
        )));
    }
    Ok(store)
}

fn default_observation_store() -> ObservationStore {
    ObservationStore {
        version: OBSERVATION_STORE_VERSION,
        next_generation_number: 1,
        observations: Vec::new(),
    }
}

fn ensure_observation_for_pane(
    store: &mut ObservationStore,
    session_key: &str,
    pane: &PaneInfo,
    now: &str,
    confidence_for_new: GenerationConfidence,
) -> bool {
    let index = store
        .observations
        .iter()
        .position(|item| item.session_key == session_key && item.pane_id == pane.pane_id);
    match index {
        Some(index) => {
            let conflict = {
                let existing = &store.observations[index];
                existing.terminal_id.as_deref() != Some(pane.terminal_id.as_str())
                    || existing.workspace_id != pane.workspace_id
                    || existing.tab_id != pane.tab_id
                    || existing.missing_since.is_some()
            };
            if conflict {
                let generation = next_generation(store);
                let existing = &mut store.observations[index];
                existing.terminal_id = Some(pane.terminal_id.clone());
                existing.workspace_id = pane.workspace_id.clone();
                existing.tab_id = pane.tab_id.clone();
                existing.observed_generation = generation;
                existing.generation_confidence = GenerationConfidence::Known;
                existing.first_seen_at = now.to_string();
                existing.missing_since = None;
                true
            } else {
                false
            }
        }
        None => {
            let generation = next_generation(store);
            store.observations.push(PaneObservation {
                session_key: session_key.to_string(),
                pane_id: pane.pane_id.clone(),
                terminal_id: Some(pane.terminal_id.clone()),
                workspace_id: pane.workspace_id.clone(),
                tab_id: pane.tab_id.clone(),
                observed_generation: generation,
                generation_confidence: confidence_for_new,
                first_seen_at: now.to_string(),
                missing_since: None,
            });
            true
        }
    }
}

fn observation_generation_for_pane(
    store: &ObservationStore,
    session_key: &str,
    pane_id: &str,
) -> Option<String> {
    store
        .observations
        .iter()
        .find(|item| item.session_key == session_key && item.pane_id == pane_id)
        .map(|item| item.observed_generation.clone())
}

fn next_generation(store: &mut ObservationStore) -> String {
    let generation = format!("gen_{}", store.next_generation_number);
    store.next_generation_number += 1;
    generation
}

fn prune_observations(store: &mut ObservationStore, now: &str) -> bool {
    let now_ms = now.parse::<u128>().unwrap_or(0);
    let before = store.observations.len();
    store.observations.retain(|item| {
        let Some(missing_since) = item.missing_since.as_deref() else {
            return true;
        };
        let missing_ms = missing_since.parse::<u128>().unwrap_or(now_ms);
        now_ms.saturating_sub(missing_ms) <= MISSING_OBSERVATION_RETENTION_MS
    });
    let sessions: HashSet<String> = store
        .observations
        .iter()
        .map(|item| item.session_key.clone())
        .collect();
    for session in sessions {
        let session_count = store
            .observations
            .iter()
            .filter(|item| item.session_key == session)
            .count();
        if session_count <= MAX_OBSERVATIONS_PER_SESSION {
            continue;
        }
        let mut missing_indexes: Vec<(usize, u128)> = store
            .observations
            .iter()
            .enumerate()
            .filter(|(_, item)| item.session_key == session && item.missing_since.is_some())
            .map(|(index, item)| {
                (
                    index,
                    item.missing_since
                        .as_deref()
                        .and_then(|value| value.parse().ok())
                        .unwrap_or(0),
                )
            })
            .collect();
        missing_indexes.sort_by_key(|(_, missing)| *missing);
        let remove_count = session_count.saturating_sub(MAX_OBSERVATIONS_PER_SESSION);
        let remove_indexes: HashSet<usize> = missing_indexes
            .into_iter()
            .take(remove_count)
            .map(|(index, _)| index)
            .collect();
        store
            .observations
            .retain_with_index(|index, _| !remove_indexes.contains(&index));
    }
    before != store.observations.len()
}

trait RetainWithIndex<T> {
    fn retain_with_index<F>(&mut self, f: F)
    where
        F: FnMut(usize, &T) -> bool;
}

impl<T> RetainWithIndex<T> for Vec<T> {
    fn retain_with_index<F>(&mut self, mut f: F)
    where
        F: FnMut(usize, &T) -> bool,
    {
        let mut index = 0;
        self.retain(|item| {
            let keep = f(index, item);
            index += 1;
            keep
        });
    }
}

fn note_response(
    note: NoteRecord,
    panes: &[PaneInfo],
    observations: &[PaneObservation],
    session_key: &str,
) -> NoteResponse {
    let (link_state, resolved_pane) = resolve_note_link(&note, panes, observations, session_key);
    NoteResponse {
        note,
        link_state,
        resolved_pane,
    }
}

fn resolve_note_link(
    note: &NoteRecord,
    panes: &[PaneInfo],
    observations: &[PaneObservation],
    session_key: &str,
) -> (NoteLinkState, Option<PaneInfo>) {
    let Some(attachment) = &note.attachment else {
        return (NoteLinkState::Detached, None);
    };
    if note.session_key != session_key {
        return (NoteLinkState::Unresolved, None);
    }
    let Some(pane) = panes.iter().find(|pane| pane.pane_id == attachment.pane_id) else {
        return (NoteLinkState::Unresolved, None);
    };
    let identity_conflicts = attachment
        .terminal_id
        .as_deref()
        .is_some_and(|terminal_id| terminal_id != pane.terminal_id)
        || attachment.workspace_id != pane.workspace_id
        || attachment.tab_id != pane.tab_id;
    if identity_conflicts {
        return (NoteLinkState::Unresolved, None);
    }
    if attachment
        .pane_revision
        .is_some_and(|revision| pane.revision < revision)
    {
        return (NoteLinkState::Unresolved, None);
    }
    if let Some(captured_generation) = attachment.observed_generation.as_deref() {
        let observation = observations.iter().find(|item| {
            item.session_key == note.session_key && item.pane_id == attachment.pane_id
        });
        if let Some(observation) = observation {
            if observation.generation_confidence == GenerationConfidence::Known
                && observation.observed_generation != captured_generation
            {
                return (NoteLinkState::Unresolved, None);
            }
        }
    }
    (NoteLinkState::Linked, Some(pane.clone()))
}

fn normalize_title(title: Option<&str>, body: Option<&str>) -> Result<String, NotesError> {
    let fallback = body
        .and_then(|body| body.lines().find(|line| !line.trim().is_empty()))
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .unwrap_or("Untitled note");
    let title = title
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .unwrap_or(fallback);
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(NotesError::BadRequest(format!(
            "title must be at most {MAX_TITLE_CHARS} characters"
        )));
    }
    Ok(title.to_string())
}

fn normalize_body(body: Option<&str>) -> Result<String, NotesError> {
    let body = body.unwrap_or("").to_string();
    if body.len() > MAX_BODY_BYTES {
        return Err(NotesError::BadRequest("body exceeds 256 KiB".to_string()));
    }
    Ok(body)
}

fn normalized_note_id(note_id: &str) -> Result<String, NotesError> {
    let note_id = note_id.trim();
    if note_id.is_empty() {
        return Err(NotesError::BadRequest("note_id is required".to_string()));
    }
    Ok(note_id.to_string())
}

fn push_attachment_history(note: &mut NoteRecord, now: String) {
    if let Some(attachment) = note.attachment.clone() {
        let mut attachment = attachment;
        attachment.captured_at = now;
        note.attachment_history.push(attachment);
        if note.attachment_history.len() > MAX_ATTACHMENT_HISTORY {
            let extra = note.attachment_history.len() - MAX_ATTACHMENT_HISTORY;
            note.attachment_history.drain(0..extra);
        }
    }
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), NotesError> {
    if let Some(parent) = path.parent() {
        ensure_private_dir(parent)?;
    }
    let temp_path = path.with_extension(format!("{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|err| NotesError::Store(format!("failed to serialize notes: {err}")))?;
    fs::write(&temp_path, bytes)?;
    set_private_file_permissions(&temp_path)?;
    backup_existing_file(path);
    fs::rename(&temp_path, path)?;
    set_private_file_permissions(path)?;
    Ok(())
}

fn backup_existing_file(path: &Path) {
    if !path.exists() {
        return;
    }
    let backup_path = path.with_extension("bak");
    if fs::copy(path, &backup_path).is_ok() {
        let _ = set_private_file_permissions(&backup_path);
    }
}

fn copy_corrupt_once(path: &Path) {
    if corrupt_copy_exists(path) {
        return;
    }
    let Ok(bytes) = fs::read(path) else {
        return;
    };
    let corrupt_path = path.with_extension(format!("{}.corrupt", now_ms_string()));
    if fs::write(&corrupt_path, bytes).is_ok() {
        let _ = set_private_file_permissions(&corrupt_path);
    }
}

fn corrupt_copy_exists(path: &Path) -> bool {
    let Some(parent) = path.parent() else {
        return false;
    };
    let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
        return false;
    };
    let Ok(entries) = fs::read_dir(parent) else {
        return false;
    };
    let prefix = format!("{stem}.");
    entries.flatten().any(|entry| {
        entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with(&prefix) && name.ends_with(".corrupt"))
    })
}

fn default_notes_dir() -> PathBuf {
    if let Some(path) = non_empty_env_path("HERDR_WEB_NOTES_DIR") {
        return path;
    }
    if let Some(data_home) = non_empty_env_path("XDG_DATA_HOME") {
        return data_home.join("herdr-web").join("notes");
    }
    if let Some(home) = non_empty_env_path("HOME") {
        return home
            .join(".local")
            .join("share")
            .join("herdr-web")
            .join("notes");
    }
    PathBuf::from("herdr-web-notes")
}

fn non_empty_env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn session_key() -> String {
    if let Some(name) = crate::session::active_name() {
        return format!("session:{name}");
    }
    if let Ok(path) = std::env::var(herdr_compat::api::SOCKET_PATH_ENV_VAR) {
        if !path.is_empty() && !crate::session::explicit_session_requested() {
            let canonical = fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(path));
            return format!(
                "socket:{:016x}",
                stable_hash(canonical.to_string_lossy().as_ref())
            );
        }
    }
    "session:default".to_string()
}

fn stable_hash(value: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn now_ms_string() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

fn ensure_private_dir(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    set_private_dir_permissions(path)
}

#[cfg(unix)]
fn set_private_dir_permissions(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn set_private_dir_permissions(_path: &Path) -> io::Result<()> {
    Ok(())
}

fn set_private_file_permissions(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

struct LockFile {
    file: File,
}

impl LockFile {
    fn exclusive(path: &Path) -> io::Result<Self> {
        if let Some(parent) = path.parent() {
            ensure_private_dir(parent)?;
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(path)?;
        set_private_file_permissions(path)?;
        lock_file(&file)?;
        Ok(Self { file })
    }
}

impl Drop for LockFile {
    fn drop(&mut self) {
        let _ = unlock_file(&self.file);
    }
}

#[cfg(unix)]
fn lock_file(file: &File) -> io::Result<()> {
    use std::os::unix::io::AsRawFd;
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(unix)]
fn unlock_file(file: &File) -> io::Result<()> {
    use std::os::unix::io::AsRawFd;
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(unix))]
fn lock_file(_file: &File) -> io::Result<()> {
    Ok(())
}

#[cfg(not(unix))]
fn unlock_file(_file: &File) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use herdr_compat::api::schema::AgentStatus;

    #[test]
    fn creates_and_lists_linked_note() {
        let dir = test_dir("creates_and_lists_linked_note");
        let manager = NotesManager::for_test(dir, "session:default").unwrap();
        let panes = vec![pane("p1", "t1", "w1", "tab1", 1)];

        let note = manager
            .create(
                CreateNoteRequest {
                    title: Some("Plan".to_string()),
                    body: Some("hello".to_string()),
                    pane_id: Some("p1".to_string()),
                },
                &panes,
            )
            .unwrap();

        assert_eq!(note.link_state, NoteLinkState::Linked);
        let listed = manager.list(NotesListQuery::default(), &panes).unwrap();
        assert_eq!(listed.notes.len(), 1);
        assert_eq!(listed.notes[0].note.note_id, note.note.note_id);
    }

    #[test]
    fn unresolved_note_remains_listed_when_pane_missing() {
        let dir = test_dir("unresolved_note_remains_listed_when_pane_missing");
        let manager = NotesManager::for_test(dir, "session:default").unwrap();
        let panes = vec![pane("p1", "t1", "w1", "tab1", 1)];
        manager
            .create(
                CreateNoteRequest {
                    title: Some("Plan".to_string()),
                    body: None,
                    pane_id: Some("p1".to_string()),
                },
                &panes,
            )
            .unwrap();

        let listed = manager.list(NotesListQuery::default(), &[]).unwrap();
        assert_eq!(listed.notes.len(), 1);
        assert_eq!(listed.notes[0].link_state, NoteLinkState::Unresolved);
    }

    #[test]
    fn stale_revision_is_conflict() {
        let dir = test_dir("stale_revision_is_conflict");
        let manager = NotesManager::for_test(dir, "session:default").unwrap();
        let panes = vec![pane("p1", "t1", "w1", "tab1", 1)];
        let note = manager
            .create(
                CreateNoteRequest {
                    title: Some("Plan".to_string()),
                    body: None,
                    pane_id: Some("p1".to_string()),
                },
                &panes,
            )
            .unwrap();

        let err = manager
            .update(
                &note.note.note_id,
                UpdateNoteRequest {
                    title: Some("Later".to_string()),
                    body: None,
                    expected_revision: note.note.revision + 1,
                },
                &panes,
            )
            .unwrap_err();
        assert!(matches!(err, NotesError::Conflict(_)));
    }

    #[test]
    fn move_updates_attachment_and_stays_linked() {
        let dir = test_dir("move_updates_attachment_and_stays_linked");
        let manager = NotesManager::for_test(dir, "session:default").unwrap();
        let old = pane("p1", "t1", "w1", "tab1", 1);
        let note = manager
            .create(
                CreateNoteRequest {
                    title: Some("Move me".to_string()),
                    body: None,
                    pane_id: Some("p1".to_string()),
                },
                &[old],
            )
            .unwrap();
        let moved = pane("p2", "t1", "w2", "tab2", 2);
        manager.update_for_pane_move("p1", &moved).unwrap();

        let listed = manager.list(NotesListQuery::default(), &[moved]).unwrap();
        assert_eq!(listed.notes[0].note.note_id, note.note.note_id);
        assert_eq!(listed.notes[0].link_state, NoteLinkState::Linked);
        assert_eq!(
            listed.notes[0].note.attachment.as_ref().unwrap().pane_id,
            "p2"
        );
    }

    #[test]
    fn corrupt_observations_do_not_block_notes() {
        let dir = test_dir("corrupt_observations_do_not_block_notes");
        let manager = NotesManager::for_test(dir, "session:default").unwrap();
        let panes = vec![pane("p1", "t1", "w1", "tab1", 1)];
        let note = manager
            .create(
                CreateNoteRequest {
                    title: Some("Plan".to_string()),
                    body: None,
                    pane_id: Some("p1".to_string()),
                },
                &panes,
            )
            .unwrap();
        fs::write(&manager.observations_path, b"not json").unwrap();

        let listed = manager.list(NotesListQuery::default(), &panes).unwrap();
        assert_eq!(listed.notes[0].note.note_id, note.note.note_id);
        assert_eq!(listed.notes[0].link_state, NoteLinkState::Linked);
    }

    #[test]
    fn note_mutations_keep_backup_copy() {
        let dir = test_dir("note_mutations_keep_backup_copy");
        let manager = NotesManager::for_test(dir, "session:default").unwrap();
        let panes = vec![pane("p1", "t1", "w1", "tab1", 1)];
        let note = manager
            .create(
                CreateNoteRequest {
                    title: Some("Plan".to_string()),
                    body: None,
                    pane_id: Some("p1".to_string()),
                },
                &panes,
            )
            .unwrap();

        manager
            .update(
                &note.note.note_id,
                UpdateNoteRequest {
                    title: Some("Updated".to_string()),
                    body: None,
                    expected_revision: note.note.revision,
                },
                &panes,
            )
            .unwrap();

        assert!(manager.notes_path.with_extension("bak").exists());
    }

    #[test]
    fn corrupt_observation_reads_do_not_create_repeated_copies() {
        let dir = test_dir("corrupt_observation_reads_do_not_create_repeated_copies");
        let manager = NotesManager::for_test(dir.clone(), "session:default").unwrap();
        let panes = vec![pane("p1", "t1", "w1", "tab1", 1)];
        manager
            .create(
                CreateNoteRequest {
                    title: Some("Plan".to_string()),
                    body: None,
                    pane_id: Some("p1".to_string()),
                },
                &panes,
            )
            .unwrap();
        fs::write(&manager.observations_path, b"not json").unwrap();

        manager.list(NotesListQuery::default(), &panes).unwrap();
        manager.list(NotesListQuery::default(), &panes).unwrap();

        assert_eq!(corrupt_copy_count(&dir), 0);
        manager.observe_panes(&panes).unwrap();
        manager.observe_panes(&panes).unwrap();
        assert_eq!(corrupt_copy_count(&dir), 1);
    }

    fn pane(
        id: &str,
        terminal_id: &str,
        workspace_id: &str,
        tab_id: &str,
        revision: u64,
    ) -> PaneInfo {
        PaneInfo {
            pane_id: id.to_string(),
            terminal_id: terminal_id.to_string(),
            workspace_id: workspace_id.to_string(),
            tab_id: tab_id.to_string(),
            focused: false,
            cwd: None,
            foreground_cwd: None,
            label: None,
            agent: None,
            title: None,
            display_agent: None,
            agent_status: AgentStatus::Unknown,
            custom_status: None,
            state_labels: Default::default(),
            agent_session: None,
            revision,
        }
    }

    fn test_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("herdr-web-notes-test-{name}-{}", now_ms_string()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn corrupt_copy_count(dir: &Path) -> usize {
        fs::read_dir(dir)
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.ends_with(".corrupt"))
            })
            .count()
    }
}
