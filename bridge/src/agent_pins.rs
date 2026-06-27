use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use herdr_compat::api::schema::PaneInfo;
use serde::{Deserialize, Serialize};

const AGENT_PINS_STORE_VERSION: u32 = 1;
const MAX_AGENT_PIN_RECORDS: usize = 1_000;

#[derive(Clone)]
pub struct AgentPinsManager {
    pins_path: PathBuf,
    pins_lock_path: PathBuf,
    session_key: String,
}

#[derive(Debug)]
pub enum AgentPinsError {
    BadRequest(String),
    Io(io::Error),
    Store(String),
}

impl std::fmt::Display for AgentPinsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadRequest(message) => write!(f, "{message}"),
            Self::Io(err) => write!(f, "{err}"),
            Self::Store(message) => write!(f, "{message}"),
        }
    }
}

impl From<io::Error> for AgentPinsError {
    fn from(err: io::Error) -> Self {
        Self::Io(err)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentPinsListResponse {
    pub session_key: String,
    pub pins: Vec<AgentPinResponse>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentPinResponse {
    pub pane_id: String,
    pub terminal_id: String,
    pub workspace_id: String,
    pub tab_id: String,
    pub created_at: String,
    pub context: AgentPinContext,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AgentPinsStore {
    version: u32,
    created_at: String,
    updated_at: String,
    pins: Vec<AgentPinRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AgentPinRecord {
    session_key: String,
    pane_id: String,
    terminal_id: String,
    workspace_id: String,
    tab_id: String,
    created_at: String,
    context: AgentPinContext,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentPinContext {
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

impl AgentPinsManager {
    pub fn new() -> io::Result<Self> {
        let pins_dir = default_agent_pins_dir();
        ensure_private_dir(&pins_dir)?;
        Ok(Self {
            pins_path: pins_dir.join("agent-pins.json"),
            pins_lock_path: pins_dir.join("agent-pins.lock"),
            session_key: session_key(),
        })
    }

    #[cfg(test)]
    fn for_test(dir: PathBuf, session_key: &str) -> io::Result<Self> {
        ensure_private_dir(&dir)?;
        Ok(Self {
            pins_path: dir.join("agent-pins.json"),
            pins_lock_path: dir.join("agent-pins.lock"),
            session_key: session_key.to_string(),
        })
    }

    pub fn list(&self, panes: &[PaneInfo]) -> Result<AgentPinsListResponse, AgentPinsError> {
        let _lock = LockFile::exclusive(&self.pins_lock_path)?;
        let store = self.load_or_create_store()?;
        Ok(AgentPinsListResponse {
            session_key: self.session_key.clone(),
            pins: visible_pin_responses(store.pins, &self.session_key, panes),
        })
    }

    pub fn pin(
        &self,
        pane_id: &str,
        panes: &[PaneInfo],
    ) -> Result<AgentPinsListResponse, AgentPinsError> {
        let pane = find_pane(pane_id, panes)?;
        let record = pin_record_for_pane(&self.session_key, pane);
        let pins = self.with_store(|store, now| {
            store.pins.retain(|pin| {
                !(pin.session_key == self.session_key && pin.pane_id == pane.pane_id)
            });
            store.pins.push(record);
            prune_session_pins_for_missing_panes(store, &self.session_key, panes);
            store.updated_at = now;
            Ok(store.pins.clone())
        })?;
        Ok(AgentPinsListResponse {
            session_key: self.session_key.clone(),
            pins: visible_pin_responses(pins, &self.session_key, panes),
        })
    }

    pub fn unpin(
        &self,
        pane_id: &str,
        panes: &[PaneInfo],
    ) -> Result<AgentPinsListResponse, AgentPinsError> {
        let pane_id = normalize_pane_id(pane_id)?;
        let pins = self.with_store(|store, now| {
            store
                .pins
                .retain(|pin| !(pin.session_key == self.session_key && pin.pane_id == pane_id));
            prune_session_pins_for_missing_panes(store, &self.session_key, panes);
            store.updated_at = now;
            Ok(store.pins.clone())
        })?;
        Ok(AgentPinsListResponse {
            session_key: self.session_key.clone(),
            pins: visible_pin_responses(pins, &self.session_key, panes),
        })
    }

    fn with_store<F, T>(&self, mutate: F) -> Result<T, AgentPinsError>
    where
        F: FnOnce(&mut AgentPinsStore, String) -> Result<T, AgentPinsError>,
    {
        let _lock = LockFile::exclusive(&self.pins_lock_path)?;
        let mut store = self.load_or_create_store()?;
        let result = mutate(&mut store, now_ms_string())?;
        write_json_atomic(&self.pins_path, &store)?;
        Ok(result)
    }

    fn load_or_create_store(&self) -> Result<AgentPinsStore, AgentPinsError> {
        match fs::read(&self.pins_path) {
            Ok(bytes) => match parse_store(&bytes) {
                Ok(store) => Ok(store),
                Err(err) => {
                    copy_corrupt_once(&self.pins_path);
                    Err(err)
                }
            },
            Err(err) if err.kind() == ErrorKind::NotFound => {
                let now = now_ms_string();
                Ok(AgentPinsStore {
                    version: AGENT_PINS_STORE_VERSION,
                    created_at: now.clone(),
                    updated_at: now,
                    pins: Vec::new(),
                })
            }
            Err(err) => Err(AgentPinsError::Io(err)),
        }
    }
}

fn visible_pin_responses(
    pins: Vec<AgentPinRecord>,
    session_key: &str,
    panes: &[PaneInfo],
) -> Vec<AgentPinResponse> {
    pins.into_iter()
        .filter(|pin| pin.session_key == session_key)
        .filter_map(|pin| {
            panes
                .iter()
                .find(|pane| pin_matches_pane(&pin, pane))
                .map(|pane| AgentPinResponse {
                    pane_id: pane.pane_id.clone(),
                    terminal_id: pane.terminal_id.clone(),
                    workspace_id: pane.workspace_id.clone(),
                    tab_id: pane.tab_id.clone(),
                    created_at: pin.created_at,
                    context: pin.context,
                })
        })
        .collect()
}

fn pin_matches_pane(pin: &AgentPinRecord, pane: &PaneInfo) -> bool {
    pin.pane_id == pane.pane_id && pin.terminal_id == pane.terminal_id
}

fn prune_session_pins_for_missing_panes(
    store: &mut AgentPinsStore,
    session_key: &str,
    panes: &[PaneInfo],
) {
    let open_pane_ids: HashSet<&str> = panes.iter().map(|pane| pane.pane_id.as_str()).collect();
    store.pins.retain(|pin| {
        pin.session_key != session_key || open_pane_ids.contains(pin.pane_id.as_str())
    });
    prune_oldest_pin_records(store);
}

fn prune_oldest_pin_records(store: &mut AgentPinsStore) {
    if store.pins.len() <= MAX_AGENT_PIN_RECORDS {
        return;
    }
    store.pins.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    store.pins.truncate(MAX_AGENT_PIN_RECORDS);
}

fn find_pane<'a>(pane_id: &str, panes: &'a [PaneInfo]) -> Result<&'a PaneInfo, AgentPinsError> {
    let pane_id = normalize_pane_id(pane_id)?;
    panes
        .iter()
        .find(|pane| pane.pane_id == pane_id)
        .ok_or_else(|| AgentPinsError::BadRequest(format!("pane not found: {pane_id}")))
}

fn normalize_pane_id(pane_id: &str) -> Result<String, AgentPinsError> {
    let pane_id = pane_id.trim();
    if pane_id.is_empty() {
        return Err(AgentPinsError::BadRequest(
            "pane_id is required".to_string(),
        ));
    }
    Ok(pane_id.to_string())
}

fn pin_record_for_pane(session_key: &str, pane: &PaneInfo) -> AgentPinRecord {
    AgentPinRecord {
        session_key: session_key.to_string(),
        pane_id: pane.pane_id.clone(),
        terminal_id: pane.terminal_id.clone(),
        workspace_id: pane.workspace_id.clone(),
        tab_id: pane.tab_id.clone(),
        created_at: now_ms_string(),
        context: AgentPinContext {
            pane_label: pane.label.clone(),
            pane_title: pane.title.clone(),
            agent: pane.agent.clone(),
            display_agent: pane.display_agent.clone(),
            cwd: pane.cwd.clone(),
            foreground_cwd: pane.foreground_cwd.clone(),
        },
    }
}

fn parse_store(bytes: &[u8]) -> Result<AgentPinsStore, AgentPinsError> {
    let store: AgentPinsStore = serde_json::from_slice(bytes)
        .map_err(|err| AgentPinsError::Store(format!("agent pins store is unreadable: {err}")))?;
    if store.version != AGENT_PINS_STORE_VERSION {
        return Err(AgentPinsError::Store(format!(
            "unsupported agent pins store version: {}",
            store.version
        )));
    }
    Ok(store)
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), AgentPinsError> {
    if let Some(parent) = path.parent() {
        ensure_private_dir(parent)?;
    }
    let temp_path = path.with_extension(format!("{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|err| AgentPinsError::Store(format!("failed to serialize agent pins: {err}")))?;
    let mut file = File::create(&temp_path)?;
    set_private_file_permissions(&temp_path)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temp_path, path)?;
    set_private_file_permissions(path)?;
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
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
            .path()
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|name| name.starts_with(&prefix) && name.ends_with(".corrupt"))
    })
}

fn default_agent_pins_dir() -> PathBuf {
    if let Some(path) = non_empty_env_path("HERDR_WEB_AGENT_PINS_DIR") {
        return path;
    }
    if let Some(data_home) = non_empty_env_path("XDG_DATA_HOME") {
        return data_home.join("herdr-web").join("agent-pins");
    }
    if let Some(home) = non_empty_env_path("HOME") {
        return home
            .join(".local")
            .join("share")
            .join("herdr-web")
            .join("agent-pins");
    }
    PathBuf::from("herdr-web-agent-pins")
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
    use std::os::fd::AsRawFd;
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
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

#[cfg(unix)]
fn unlock_file(file: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(unix))]
fn unlock_file(_file: &File) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    use herdr_compat::api::schema::AgentStatus;

    #[test]
    fn list_returns_current_session_matching_open_pins() {
        let dir = test_dir("list-current");
        let manager = AgentPinsManager::for_test(dir, "session:a").unwrap();
        let panes = vec![pane("pane-1", "terminal-1")];

        manager.pin("pane-1", &panes).unwrap();
        let pins = manager.list(&panes).unwrap();

        assert_eq!(pins.session_key, "session:a");
        assert_eq!(pins.pins.len(), 1);
        assert_eq!(pins.pins[0].pane_id, "pane-1");
    }

    #[test]
    fn stale_terminal_identity_is_not_visible() {
        let dir = test_dir("stale-terminal");
        let manager = AgentPinsManager::for_test(dir, "session:a").unwrap();

        manager
            .pin("pane-1", &[pane("pane-1", "terminal-1")])
            .unwrap();
        let pins = manager.list(&[pane("pane-1", "terminal-2")]).unwrap();

        assert!(pins.pins.is_empty());
    }

    #[test]
    fn pin_follows_pane_moves() {
        let dir = test_dir("pane-move");
        let manager = AgentPinsManager::for_test(dir, "session:a").unwrap();

        manager
            .pin("pane-1", &[pane("pane-1", "terminal-1")])
            .unwrap();
        let moved_pane = pane_in_location("pane-1", "terminal-1", "workspace-b", "tab-b");
        let pins = manager.list(&[moved_pane]).unwrap();

        assert_eq!(pins.pins.len(), 1);
        assert_eq!(pins.pins[0].workspace_id, "workspace-b");
        assert_eq!(pins.pins[0].tab_id, "tab-b");
    }

    #[test]
    fn unpin_removes_visible_pin() {
        let dir = test_dir("unpin");
        let manager = AgentPinsManager::for_test(dir, "session:a").unwrap();
        let panes = vec![pane("pane-1", "terminal-1")];

        manager.pin("pane-1", &panes).unwrap();
        let pins = manager.unpin("pane-1", &panes).unwrap();

        assert!(pins.pins.is_empty());
    }

    #[test]
    fn corrupt_store_is_copied_aside_before_error() {
        let dir = test_dir("corrupt-store");
        ensure_private_dir(&dir).unwrap();
        let path = dir.join("agent-pins.json");
        fs::write(&path, b"{not json").unwrap();
        let manager = AgentPinsManager::for_test(dir.clone(), "session:a").unwrap();

        assert!(manager.list(&[]).is_err());
        assert!(corrupt_copy_exists(&path));
    }

    fn pane(pane_id: &str, terminal_id: &str) -> PaneInfo {
        pane_in_location(pane_id, terminal_id, "workspace-a", "tab-a")
    }

    fn pane_in_location(
        pane_id: &str,
        terminal_id: &str,
        workspace_id: &str,
        tab_id: &str,
    ) -> PaneInfo {
        PaneInfo {
            pane_id: pane_id.to_string(),
            terminal_id: terminal_id.to_string(),
            workspace_id: workspace_id.to_string(),
            tab_id: tab_id.to_string(),
            focused: false,
            cwd: None,
            foreground_cwd: None,
            label: None,
            agent: Some("codex".to_string()),
            agent_session: None,
            title: None,
            display_agent: Some("Codex".to_string()),
            agent_status: AgentStatus::Idle,
            custom_status: None,
            state_labels: HashMap::new(),
            revision: 1,
        }
    }

    fn test_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "herdr-web-agent-pins-test-{name}-{}",
            now_ms_string()
        ))
    }
}
