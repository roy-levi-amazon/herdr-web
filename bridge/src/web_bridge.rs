use std::collections::{HashMap, HashSet};
use std::env;
use std::fmt;
use std::io::{self, ErrorKind};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path as AxumPath, Query, State};
use axum::http::header::{
    ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_ALLOW_ORIGIN,
    ACCESS_CONTROL_MAX_AGE, ACCESS_CONTROL_REQUEST_HEADERS, HOST, ORIGIN, VARY,
};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::serve::ListenerExt;
use axum::{extract::Request as AxumRequest, Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::time::Instant;
use tower::ServiceBuilder;
use tower_http::compression::CompressionLayer;
use tower_http::services::ServeDir;
use tracing::{debug, info, warn};

use herdr_compat::api::client::{ApiClient, ApiClientError};
use herdr_compat::api::schema::{
    AgentStatus, EventsSubscribeParams, Method, PaneInfo, PaneLayoutParams, PaneLayoutSnapshot,
    PaneListParams, PaneMoveDestination, Request, ResponseResult, SplitDirection, Subscription,
    TabInfo, TabListParams, WorkspaceInfo,
};
use herdr_compat::protocol::{
    AttachScrollDirection, AttachScrollSource, ClientKeybindings, ClientLaunchMode, ClientMessage,
    RenderEncoding, ServerMessage, MAX_FRAME_SIZE, MAX_GRAPHICS_FRAME_SIZE, PROTOCOL_VERSION,
};

use crate::agent_activity::{AgentActivityListResponse, AgentActivityManager};
use crate::agent_pins::{AgentPinsError, AgentPinsListResponse, AgentPinsManager};
use crate::notes::{
    AttachNoteRequest, CreateNoteRequest, NoteResponse, NotesError, NotesListQuery,
    NotesListResponse, NotesManager, RevisionRequest, UpdateNoteRequest,
};
use crate::snapshot_cache::SnapshotCache;

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 8787;
const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;
const DEFAULT_STATIC_DIR: &str = "web/dist";
const MIN_TERMINAL_ATTACH_PROTOCOL: u32 = 13;
const MAX_UPLOAD_BYTES: usize = 25 * 1024 * 1024;
const MAX_NOTES_REQUEST_BYTES: usize = 512 * 1024;
const MAX_TERMINAL_INPUT_CHUNK_BYTES: usize = 768 * 1024;
const DEFAULT_TERMINAL_OUTPUT_COALESCE_MS: u64 = 16;
const MAX_TERMINAL_OUTPUT_COALESCE_MS: u64 = 256;
const TERMINAL_OUTPUT_COALESCE_MAX_BYTES: usize = 32 * 1024;
const TERMINAL_OUTPUT_COALESCE_MAX_CHUNKS: usize = 256;
const DAEMON_STATUS_TIMEOUT: Duration = Duration::from_secs(5);
const ACTIVITY_WATCHER_INITIAL_BACKOFF: Duration = Duration::from_secs(1);
const ACTIVITY_WATCHER_MAX_BACKOFF: Duration = Duration::from_secs(30);
const ACTIVITY_RESUBSCRIBE_DEBOUNCE: Duration = Duration::from_millis(100);
const ACTIVITY_POLL_INTERVAL: Duration = Duration::from_secs(5);
const PANE_CACHE_TTL: Duration = Duration::from_millis(500);
static UPLOAD_TEMP_COUNTER: AtomicUsize = AtomicUsize::new(0);

struct CachedPanes {
    panes: Vec<PaneInfo>,
    fetched_at: std::time::Instant,
}

#[derive(Debug, Clone)]
struct BridgeOptions {
    host: String,
    port: u16,
    static_dir: PathBuf,
    upload_dir: PathBuf,
    allowed_hosts: Vec<String>,
    allowed_origins: Vec<String>,
    allowed_connect_sources: Vec<String>,
}

#[derive(Clone)]
struct BridgeState {
    api: ApiClient,
    client_socket_path: PathBuf,
    request_policy: RequestPolicy,
    terminal_sessions: Arc<Mutex<HashMap<String, SharedTerminalSession>>>,
    selected_pane_id: Arc<Mutex<Option<String>>>,
    ws_client_count: Arc<AtomicUsize>,
    agent_activity: Arc<AgentActivityManager>,
    agent_pins: Arc<AgentPinsManager>,
    notes: Arc<NotesManager>,
    ui_event_tx: tokio::sync::broadcast::Sender<String>,
    activity_tx: tokio::sync::broadcast::Sender<ActivityMessage>,
    pane_cache: Arc<Mutex<Option<CachedPanes>>>,
    snapshot_cache: Arc<SnapshotCache>,
    upload_dir: PathBuf,
}

#[derive(Debug, Clone)]
struct RequestPolicy {
    bind_host: String,
    bind_port: u16,
    allowed_hosts: Vec<String>,
    allowed_origins: Vec<String>,
    allowed_connect_sources: Vec<String>,
}

#[derive(Debug, Serialize)]
struct Snapshot {
    workspaces: Vec<SnapshotWorkspaceInfo>,
    tabs: Vec<SnapshotTabInfo>,
    panes: Vec<PaneInfo>,
    layouts: Vec<PaneLayoutSnapshot>,
    selected_pane_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct SnapshotWorkspaceInfo {
    #[serde(flatten)]
    info: WorkspaceInfo,
    can_clear_name: bool,
}

#[derive(Debug, Serialize)]
struct SnapshotTabInfo {
    #[serde(flatten)]
    info: TabInfo,
    can_clear_name: bool,
}

#[derive(Debug, Serialize)]
struct Capabilities {
    commands: &'static [&'static str],
    agent_activity: AgentActivityCapability,
    agent_pins: AgentPinsCapability,
    notes: NotesCapability,
}

#[derive(Debug, Serialize)]
struct AgentActivityCapability {
    version: u32,
}

#[derive(Debug, Serialize)]
struct AgentPinsCapability {
    version: u32,
}

#[derive(Debug, Serialize)]
struct NotesCapability {
    version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
enum ActivityMessage {
    #[serde(rename = "pane.agent_status_changed")]
    PaneAgentStatusChanged {
        pane_id: String,
        workspace_id: String,
        agent_status: AgentStatus,
        agent: Option<String>,
        title: Option<String>,
        display_agent: Option<String>,
        custom_status: Option<String>,
        state_labels: HashMap<String, String>,
    },
    #[serde(rename = "resync_required")]
    ResyncRequired { reason: String },
}

#[derive(Debug, Deserialize)]
struct TerminalQuery {
    terminal_id: String,
    cols: Option<u16>,
    rows: Option<u16>,
    coalesce_ms: Option<u64>,
    #[serde(default)]
    takeover: bool,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TerminalClientFrame {
    Input {
        data: String,
    },
    Resize {
        cols: u16,
        rows: u16,
        #[serde(default)]
        cell_width_px: u32,
        #[serde(default)]
        cell_height_px: u32,
    },
    Scroll {
        direction: ScrollDirection,
        #[serde(default = "default_scroll_lines")]
        lines: u16,
    },
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ScrollDirection {
    Up,
    Down,
}

fn default_scroll_lines() -> u16 {
    3
}

#[derive(Debug, Clone)]
enum TerminalOutput {
    Bytes(Bytes),
    Close(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TerminalOutputFlushReason {
    Timer,
    ByteThreshold,
    ChunkThreshold,
    Close,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TerminalOutputCoalescingDecision {
    SendNow(Bytes),
    Pending,
    FlushPending(TerminalOutputFlushReason),
}

#[cfg(test)]
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct TerminalOutputCoalescingStats {
    source_frames: u64,
    source_bytes: u64,
    sent_frames: u64,
    sent_bytes: u64,
    immediate_frames: u64,
    coalesced_source_frames: u64,
    coalesced_sent_frames: u64,
    timer_flushes: u64,
    byte_flushes: u64,
    chunk_flushes: u64,
    single_chunk_flushes: u64,
    merged_flushes: u64,
    lagged_events: u64,
    lagged_frames: u64,
    max_pending_bytes: usize,
    max_pending_chunks: usize,
    total_flush_latency_us: u128,
    max_flush_latency_us: u128,
}

#[cfg(test)]
impl TerminalOutputCoalescingStats {
    fn record_source(&mut self, bytes: usize) {
        self.source_frames += 1;
        self.source_bytes += bytes as u64;
    }

    fn record_immediate_send(&mut self, bytes: usize) {
        self.sent_frames += 1;
        self.sent_bytes += bytes as u64;
        self.immediate_frames += 1;
    }

    fn record_pending(&mut self, bytes: usize, chunks: usize) {
        self.max_pending_bytes = self.max_pending_bytes.max(bytes);
        self.max_pending_chunks = self.max_pending_chunks.max(chunks);
    }

    fn record_flush_reason(&mut self, reason: TerminalOutputFlushReason) {
        match reason {
            TerminalOutputFlushReason::Timer => self.timer_flushes += 1,
            TerminalOutputFlushReason::ByteThreshold => self.byte_flushes += 1,
            TerminalOutputFlushReason::ChunkThreshold => self.chunk_flushes += 1,
            TerminalOutputFlushReason::Close => {}
        }
    }

    fn record_coalesced_send(&mut self, source_chunks: usize, bytes: usize, latency: Duration) {
        self.sent_frames += 1;
        self.sent_bytes += bytes as u64;
        self.coalesced_source_frames += source_chunks as u64;
        self.coalesced_sent_frames += 1;
        if source_chunks <= 1 {
            self.single_chunk_flushes += 1;
        } else {
            self.merged_flushes += 1;
        }

        let latency_us = latency.as_micros();
        self.total_flush_latency_us += latency_us;
        self.max_flush_latency_us = self.max_flush_latency_us.max(latency_us);
    }

    fn record_lagged(&mut self, frames: u64) {
        self.lagged_events += 1;
        self.lagged_frames += frames;
    }

    #[cfg(test)]
    fn frames_saved(&self) -> u64 {
        self.source_frames.saturating_sub(self.sent_frames)
    }

    #[cfg(test)]
    fn coalescing_ratio(&self) -> f64 {
        if self.sent_frames == 0 {
            return 0.0;
        }
        self.source_frames as f64 / self.sent_frames as f64
    }

    #[cfg(test)]
    fn avg_source_frame_bytes(&self) -> f64 {
        if self.source_frames == 0 {
            return 0.0;
        }
        self.source_bytes as f64 / self.source_frames as f64
    }

    #[cfg(test)]
    fn avg_sent_frame_bytes(&self) -> f64 {
        if self.sent_frames == 0 {
            return 0.0;
        }
        self.sent_bytes as f64 / self.sent_frames as f64
    }

    #[cfg(test)]
    fn avg_flush_latency_us(&self) -> f64 {
        if self.coalesced_sent_frames == 0 {
            return 0.0;
        }
        self.total_flush_latency_us as f64 / self.coalesced_sent_frames as f64
    }
}

struct TerminalOutputCoalescer {
    window: Duration,
    pending: Vec<Bytes>,
    pending_bytes: usize,
    pending_started_at: Option<Instant>,
    deadline: Option<Instant>,
    #[cfg(test)]
    lifetime_stats: TerminalOutputCoalescingStats,
}

impl TerminalOutputCoalescer {
    fn new(window: Duration) -> Self {
        Self {
            window,
            pending: Vec::new(),
            pending_bytes: 0,
            pending_started_at: None,
            deadline: None,
            #[cfg(test)]
            lifetime_stats: TerminalOutputCoalescingStats::default(),
        }
    }

    fn deadline(&self) -> Option<Instant> {
        self.deadline
    }

    fn push_bytes(&mut self, bytes: Bytes, now: Instant) -> TerminalOutputCoalescingDecision {
        let byte_count = bytes.len();
        self.record_source(byte_count);

        if self.window.is_zero() {
            self.record_immediate_send(byte_count);
            return TerminalOutputCoalescingDecision::SendNow(bytes);
        }

        if self.deadline.is_none() {
            self.deadline = Some(now + self.window);
            self.record_immediate_send(byte_count);
            return TerminalOutputCoalescingDecision::SendNow(bytes);
        }

        if self.pending.is_empty() {
            self.pending_started_at = Some(now);
        }
        self.pending_bytes += byte_count;
        self.pending.push(bytes);
        self.record_pending();

        if self.pending_bytes >= TERMINAL_OUTPUT_COALESCE_MAX_BYTES {
            TerminalOutputCoalescingDecision::FlushPending(TerminalOutputFlushReason::ByteThreshold)
        } else if self.pending.len() >= TERMINAL_OUTPUT_COALESCE_MAX_CHUNKS {
            TerminalOutputCoalescingDecision::FlushPending(
                TerminalOutputFlushReason::ChunkThreshold,
            )
        } else {
            TerminalOutputCoalescingDecision::Pending
        }
    }

    fn handle_deadline(&mut self) -> Option<TerminalOutputFlushReason> {
        self.deadline?;
        if self.pending.is_empty() {
            self.deadline = None;
            return None;
        }
        Some(TerminalOutputFlushReason::Timer)
    }

    fn reset_deadline_for_input(&mut self) {
        if self.pending.is_empty() {
            self.deadline = None;
        }
    }

    fn flush_pending(&mut self, reason: TerminalOutputFlushReason, now: Instant) -> Option<Bytes> {
        if self.pending.is_empty() {
            self.pending_bytes = 0;
            self.pending_started_at = None;
            if matches!(reason, TerminalOutputFlushReason::Close) {
                self.deadline = None;
            }
            return None;
        }

        self.record_flush_reason(reason);
        let source_chunks = self.pending.len();
        let latency = self
            .pending_started_at
            .map(|started_at| now.saturating_duration_since(started_at))
            .unwrap_or_default();
        let Some(bytes) = drain_terminal_output_pending(&mut self.pending, &mut self.pending_bytes)
        else {
            self.pending_started_at = None;
            return None;
        };

        self.pending_started_at = None;
        if matches!(reason, TerminalOutputFlushReason::Close) {
            self.deadline = None;
        } else {
            // Keep a trailing window warm so sustained redraws continue batching between flushes.
            self.deadline = Some(now + self.window);
        }
        self.record_coalesced_send(source_chunks, bytes.len(), latency);
        Some(bytes)
    }

    #[cfg(test)]
    fn record_lagged(&mut self, frames: u64) {
        self.lifetime_stats.record_lagged(frames);
    }

    #[cfg(not(test))]
    fn record_lagged(&mut self, _frames: u64) {}

    #[cfg(test)]
    fn record_source(&mut self, bytes: usize) {
        self.lifetime_stats.record_source(bytes);
    }

    #[cfg(not(test))]
    fn record_source(&mut self, _bytes: usize) {}

    #[cfg(test)]
    fn record_immediate_send(&mut self, bytes: usize) {
        self.lifetime_stats.record_immediate_send(bytes);
    }

    #[cfg(not(test))]
    fn record_immediate_send(&mut self, _bytes: usize) {}

    #[cfg(test)]
    fn record_pending(&mut self) {
        self.lifetime_stats
            .record_pending(self.pending_bytes, self.pending.len());
    }

    #[cfg(not(test))]
    fn record_pending(&mut self) {}

    #[cfg(test)]
    fn record_flush_reason(&mut self, reason: TerminalOutputFlushReason) {
        self.lifetime_stats.record_flush_reason(reason);
    }

    #[cfg(not(test))]
    fn record_flush_reason(&mut self, _reason: TerminalOutputFlushReason) {}

    #[cfg(test)]
    fn record_coalesced_send(&mut self, chunks: usize, bytes: usize, latency: Duration) {
        self.lifetime_stats
            .record_coalesced_send(chunks, bytes, latency);
    }

    #[cfg(not(test))]
    fn record_coalesced_send(&mut self, _chunks: usize, _bytes: usize, _latency: Duration) {}
}

fn drain_terminal_output_pending(
    pending: &mut Vec<Bytes>,
    pending_bytes: &mut usize,
) -> Option<Bytes> {
    if pending.is_empty() {
        *pending_bytes = 0;
        return None;
    }

    let byte_count = *pending_bytes;
    *pending_bytes = 0;
    if pending.len() == 1 {
        return pending.pop();
    }

    let mut output = Vec::with_capacity(byte_count);
    for chunk in pending.drain(..) {
        output.extend_from_slice(&chunk);
    }
    Some(Bytes::from(output))
}

fn terminal_output_coalesce_window(coalesce_ms: Option<u64>) -> Duration {
    Duration::from_millis(
        coalesce_ms
            .unwrap_or(DEFAULT_TERMINAL_OUTPUT_COALESCE_MS)
            .min(MAX_TERMINAL_OUTPUT_COALESCE_MS),
    )
}

#[derive(Clone)]
struct SharedTerminalSession {
    write_tx: tokio::sync::mpsc::UnboundedSender<ClientMessage>,
    output_tx: tokio::sync::broadcast::Sender<TerminalOutput>,
    client_count: Arc<AtomicUsize>,
}

#[derive(Debug)]
pub(crate) enum BridgeError {
    Api(ApiClientError),
    Io(io::Error),
    BadRequest(String),
    Conflict(String),
    Forbidden(String),
    Protocol(String),
}

#[derive(Debug)]
enum UploadError {
    BadRequest(String),
    Conflict { name: String, path: String },
    Forbidden(String),
    TooLarge,
    Io(io::Error),
}

impl fmt::Display for BridgeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Api(err) => write!(f, "{err}"),
            Self::Io(err) => write!(f, "{err}"),
            Self::BadRequest(message) => write!(f, "{message}"),
            Self::Conflict(message) => write!(f, "{message}"),
            Self::Forbidden(message) => write!(f, "{message}"),
            Self::Protocol(message) => write!(f, "{message}"),
        }
    }
}

impl IntoResponse for BridgeError {
    fn into_response(self) -> Response {
        let status = match self {
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::Forbidden(_) => StatusCode::FORBIDDEN,
            Self::Api(_) | Self::Io(_) | Self::Protocol(_) => StatusCode::BAD_GATEWAY,
        };
        let body = Json(serde_json::json!({
            "error": self.to_string(),
        }));
        (status, body).into_response()
    }
}

impl From<ApiClientError> for BridgeError {
    fn from(err: ApiClientError) -> Self {
        Self::Api(err)
    }
}

impl From<io::Error> for BridgeError {
    fn from(err: io::Error) -> Self {
        Self::Io(err)
    }
}

impl From<NotesError> for BridgeError {
    fn from(err: NotesError) -> Self {
        match err {
            NotesError::BadRequest(message) => Self::BadRequest(message),
            NotesError::Conflict(message) => Self::Conflict(message),
            NotesError::Io(err) => Self::Io(err),
            NotesError::Store(message) => Self::Protocol(message),
        }
    }
}

impl From<AgentPinsError> for BridgeError {
    fn from(err: AgentPinsError) -> Self {
        match err {
            AgentPinsError::BadRequest(message) => Self::BadRequest(message),
            AgentPinsError::Io(err) => Self::Io(err),
            AgentPinsError::Store(message) => Self::Protocol(message),
        }
    }
}

impl IntoResponse for UploadError {
    fn into_response(self) -> Response {
        let (status, body) = match self {
            Self::BadRequest(message) => (
                StatusCode::BAD_REQUEST,
                serde_json::json!({ "error": message }),
            ),
            Self::Conflict { name, path } => (
                StatusCode::CONFLICT,
                serde_json::json!({
                    "error": "file exists",
                    "name": name,
                    "path": path,
                }),
            ),
            Self::Forbidden(message) => (
                StatusCode::FORBIDDEN,
                serde_json::json!({ "error": message }),
            ),
            Self::TooLarge => (
                StatusCode::PAYLOAD_TOO_LARGE,
                serde_json::json!({ "error": "upload exceeds 25 MB limit" }),
            ),
            Self::Io(err) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                serde_json::json!({ "error": err.to_string() }),
            ),
        };
        (status, Json(body)).into_response()
    }
}

impl From<io::Error> for UploadError {
    fn from(err: io::Error) -> Self {
        Self::Io(err)
    }
}

pub(crate) fn run_command(args: &[String]) -> io::Result<i32> {
    let options = match parse_options(args) {
        Ok(Some(options)) => options,
        Ok(None) => return Ok(0),
        Err(message) => {
            eprintln!("{message}");
            eprintln!(
                "usage: herdr-web-bridge [--session NAME] [--host HOST] [--port PORT] [--static-dir DIR] [--allow-origin ORIGIN] [--allow-host HOSTNAME] [--allow-connect-origin ORIGIN]"
            );
            return Ok(2);
        }
    };

    herdr_compat::logging::init_file_logging(crate::session::data_dir(), "herdr-web.log");
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("failed to create tokio runtime");

    match runtime.block_on(run_server(options)) {
        Ok(()) => Ok(0),
        Err(err) => {
            eprintln!("{err}");
            Ok(1)
        }
    }
}

fn parse_options(args: &[String]) -> Result<Option<BridgeOptions>, String> {
    let mut host = DEFAULT_HOST.to_string();
    let mut port = DEFAULT_PORT;
    let mut static_dir = PathBuf::from(DEFAULT_STATIC_DIR);
    let mut upload_dir = default_upload_dir();
    let mut allowed_hosts = Vec::new();
    let mut allowed_origins = Vec::new();
    let mut allowed_connect_sources = Vec::new();
    let mut explicit_session = None;
    let mut index = 0;

    while index < args.len() {
        match args[index].as_str() {
            "help" | "--help" | "-h" => {
                print_help();
                return Ok(None);
            }
            "--host" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("missing value for --host".into());
                };
                host = value.clone();
                index += 2;
            }
            "--session" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("missing value for --session".into());
                };
                crate::session::validate_session_name(value)?;
                explicit_session = Some(value.clone());
                index += 2;
            }
            "--port" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("missing value for --port".into());
                };
                port = value
                    .parse::<u16>()
                    .map_err(|_| "port must be between 0 and 65535".to_string())?;
                index += 2;
            }
            "--static-dir" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("missing value for --static-dir".into());
                };
                static_dir = PathBuf::from(value);
                index += 2;
            }
            "--upload-dir" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("missing value for --upload-dir".into());
                };
                upload_dir = expand_home(value);
                index += 2;
            }
            "--allow-host" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("missing value for --allow-host".into());
                };
                allowed_hosts.push(normalize_allowed_host(value)?);
                index += 2;
            }
            "--allow-origin" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("missing value for --allow-origin".into());
                };
                allowed_origins.push(normalize_allowed_origin(value)?);
                index += 2;
            }
            "--allow-connect-origin" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("missing value for --allow-connect-origin".into());
                };
                allowed_connect_sources.extend(connect_sources_for_origin(value)?);
                index += 2;
            }
            arg => return Err(format!("unknown herdr-web option: {arg}")),
        }
    }

    allowed_connect_sources.sort();
    allowed_connect_sources.dedup();

    if let Some(name) = explicit_session {
        crate::session::configure_explicit_session(&name)?;
    }

    Ok(Some(BridgeOptions {
        host,
        port,
        static_dir,
        upload_dir,
        allowed_hosts,
        allowed_origins,
        allowed_connect_sources,
    }))
}

fn print_help() {
    println!("{}", help_text());
}

fn help_text() -> &'static str {
    "herdr-web-bridge\n\
\n\
Usage: herdr-web-bridge [--session NAME] [--host HOST] [--port PORT] [--static-dir DIR] [--upload-dir DIR] [--allow-origin ORIGIN] [--allow-host HOSTNAME] [--allow-connect-origin ORIGIN]\n\
\n\
Runs the local HTTP/WebSocket bridge for herdr-web.\n\
Defaults to the active Herdr daemon sockets and 127.0.0.1:8787.\n\
Use --session NAME to target a named Herdr session and ignore HERDR_SOCKET_PATH.\n\
Use --host 0.0.0.0 to listen on non-loopback interfaces.\n\
Use --allow-origin http://localhost for bundled Android app access.\n\
Use --allow-host HOSTNAME to accept that exact DNS hostname in Host headers.\n\
Use --allow-connect-origin ORIGIN to let the served web app connect to another bridge origin.\n\
Uploads default to HERDR_WEB_UPLOAD_DIR, XDG_DATA_HOME/herdr-web/uploads, or ~/.local/share/herdr-web/uploads."
}

async fn run_server(options: BridgeOptions) -> io::Result<()> {
    if !is_loopback_bind_host(&options.host) {
        warn!(
            host = %options.host,
            port = options.port,
            "herdr-web-bridge has no browser authentication yet; bind only on trusted networks"
        );
    }
    ensure_upload_dir(&options.upload_dir)?;
    let agent_activity = Arc::new(AgentActivityManager::new());
    let agent_pins = Arc::new(AgentPinsManager::new()?);
    let notes = Arc::new(NotesManager::new()?);
    let request_policy = RequestPolicy {
        bind_host: options.host.clone(),
        bind_port: options.port,
        allowed_hosts: options.allowed_hosts.clone(),
        allowed_origins: options.allowed_origins.clone(),
        allowed_connect_sources: options.allowed_connect_sources.clone(),
    };
    let api = ApiClient::for_socket_path(crate::session::active_api_socket_path());
    let daemon_protocol = startup_daemon_protocol(&api)?;
    info!(
        protocol = daemon_protocol,
        "herdr-web bridge connected to compatible Herdr daemon"
    );
    let snapshot_cache = Arc::new(SnapshotCache::new(api.clone()));
    let state = BridgeState {
        api,
        client_socket_path: crate::session::active_client_socket_path(),
        request_policy: request_policy.clone(),
        terminal_sessions: Arc::new(Mutex::new(HashMap::new())),
        selected_pane_id: Arc::new(Mutex::new(None)),
        ws_client_count: Arc::new(AtomicUsize::new(0)),
        agent_activity,
        agent_pins,
        notes,
        ui_event_tx: tokio::sync::broadcast::channel(256).0,
        activity_tx: tokio::sync::broadcast::channel(512).0,
        pane_cache: Arc::new(Mutex::new(None)),
        snapshot_cache,
        upload_dir: options.upload_dir.clone(),
    };
    spawn_agent_activity_watcher(state.clone());
    // Seed snapshot cache in background — non-blocking so server starts quickly.
    {
        let cache = state.snapshot_cache.clone();
        tokio::spawn(async move {
            if let Err(err) = cache.refresh().await {
                tracing::warn!(error = %err, "initial snapshot cache seed failed");
            }
        });
    }
    let agent_activity_routes = Router::new().route(
        "/api/agent-activity",
        get(agent_activity_list_handler).options(preflight_handler),
    );
    let agent_pins_routes = Router::new()
        .route(
            "/api/agent-pins",
            get(agent_pins_list_handler).options(preflight_handler),
        )
        .route(
            "/api/agent-pins/{pane_id}/pin",
            post(agent_pins_pin_handler).options(preflight_handler),
        )
        .route(
            "/api/agent-pins/{pane_id}/unpin",
            post(agent_pins_unpin_handler).options(preflight_handler),
        );
    let notes_routes = Router::new()
        .route(
            "/api/notes",
            get(notes_list_handler)
                .post(notes_create_handler)
                .options(preflight_handler),
        )
        .route(
            "/api/notes/{note_id}/update",
            post(notes_update_handler).options(preflight_handler),
        )
        .route(
            "/api/notes/{note_id}/attach",
            post(notes_attach_handler).options(preflight_handler),
        )
        .route(
            "/api/notes/{note_id}/detach",
            post(notes_detach_handler).options(preflight_handler),
        )
        .route(
            "/api/notes/{note_id}/archive",
            post(notes_archive_handler).options(preflight_handler),
        )
        .route(
            "/api/notes/{note_id}/restore",
            post(notes_restore_handler).options(preflight_handler),
        )
        .route(
            "/api/notes/{note_id}/delete",
            post(notes_delete_handler).options(preflight_handler),
        )
        .layer(DefaultBodyLimit::max(MAX_NOTES_REQUEST_BYTES));
    let app = Router::new()
        .merge(agent_activity_routes)
        .merge(agent_pins_routes)
        .merge(notes_routes)
        .route(
            "/api/snapshot",
            get(snapshot_handler).options(preflight_handler),
        )
        .route(
            "/api/capabilities",
            get(capabilities_handler).options(preflight_handler),
        )
        .route(
            "/api/command",
            post(command_handler).options(preflight_handler),
        )
        .route(
            "/api/selection",
            post(selection_handler).options(preflight_handler),
        )
        .route(
            "/api/uploads",
            post(upload_handler).options(preflight_handler),
        )
        .route("/ws/events", get(events_ws_handler))
        .route("/ws/activity", get(activity_ws_handler))
        .route("/ws/ui-events", get(ui_events_ws_handler))
        .route("/ws/terminal", get(terminal_ws_handler))
        .fallback_service(
            ServiceBuilder::new()
                .layer(CompressionLayer::new())
                .service(ServeDir::new(options.static_dir)),
        )
        .layer(middleware::from_fn_with_state(
            request_policy.clone(),
            add_security_headers,
        ))
        .layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES))
        .with_state(state);
    let bind = format!("{}:{}", options.host, options.port);
    let listener = tokio::net::TcpListener::bind(&bind)
        .await?
        .tap_io(|tcp_stream| {
            if let Err(err) = tcp_stream.set_nodelay(true) {
                tracing::trace!("failed to set TCP_NODELAY on incoming connection: {err:#}");
            }
        });
    info!(url = %format!("http://{bind}"), "herdr-web-bridge listening");
    axum::serve(listener, app).await
}

async fn add_security_headers(
    State(policy): State<RequestPolicy>,
    request: AxumRequest,
    next: Next,
) -> Response {
    let cors_origin = cors_origin_header(request.headers(), &policy);
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    );
    headers.insert(
        HeaderName::from_static("content-security-policy"),
        content_security_policy(&policy),
    );
    if let Some(origin) = cors_origin {
        insert_cors_headers(headers, origin);
    }
    response
}

async fn preflight_handler(
    State(state): State<BridgeState>,
    headers: HeaderMap,
) -> Result<Response, BridgeError> {
    ensure_allowed_request(&headers, &state.request_policy)?;
    let Some(origin) = cors_origin_header(&headers, &state.request_policy) else {
        return Err(BridgeError::Forbidden(
            "cross-origin requests are not allowed".to_string(),
        ));
    };
    let mut response = StatusCode::NO_CONTENT.into_response();
    insert_cors_headers(response.headers_mut(), origin);
    if let Some(request_headers) = headers.get(ACCESS_CONTROL_REQUEST_HEADERS) {
        response
            .headers_mut()
            .insert(ACCESS_CONTROL_ALLOW_HEADERS, request_headers.clone());
    }
    Ok(response)
}

fn cors_origin_header(headers: &HeaderMap, policy: &RequestPolicy) -> Option<HeaderValue> {
    let origin = headers.get(ORIGIN)?;
    if request_allowed(headers, policy) {
        return Some(origin.clone());
    }
    // Always echo the Origin for same-origin requests so that browser fetches of
    // static assets (e.g. manifest.json fetched in CORS mode) receive the required
    // Access-Control-Allow-Origin header even when the full host/origin policy
    // check fails (e.g. the browser manifest parser may omit expected headers).
    let origin_str = origin.to_str().ok()?;
    let origin_auth = origin_authority(origin_str)?;
    let host = headers.get(HOST)?.to_str().ok()?;
    if same_authority(origin_auth, host)
        || (is_loopback_authority(origin_auth) && is_loopback_authority(host))
    {
        return Some(origin.clone());
    }
    None
}

fn insert_cors_headers(headers: &mut HeaderMap, origin: HeaderValue) {
    headers.insert(ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    headers.insert(
        ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    if !headers.contains_key(ACCESS_CONTROL_ALLOW_HEADERS) {
        headers.insert(
            ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("content-type"),
        );
    }
    headers.insert(ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("600"));
    headers.insert(VARY, HeaderValue::from_static("Origin"));
}

fn is_loopback_bind_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

fn default_upload_dir() -> PathBuf {
    if let Some(path) = non_empty_env_path("HERDR_WEB_UPLOAD_DIR") {
        return path;
    }
    if let Some(data_home) = non_empty_env_path("XDG_DATA_HOME") {
        return data_home.join("herdr-web").join("uploads");
    }
    if let Some(home) = non_empty_env_path("HOME") {
        return home
            .join(".local")
            .join("share")
            .join("herdr-web")
            .join("uploads");
    }
    PathBuf::from("herdr-web-uploads")
}

fn non_empty_env_path(name: &str) -> Option<PathBuf> {
    let value = env::var(name).ok()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(expand_home(trimmed))
    }
}

fn expand_home(value: &str) -> PathBuf {
    if value == "~" {
        if let Ok(home) = env::var("HOME") {
            return PathBuf::from(home);
        }
    }
    if let Some(rest) = value.strip_prefix("~/") {
        if let Ok(home) = env::var("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(value)
}

fn ensure_upload_dir(path: &Path) -> io::Result<()> {
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn sanitize_upload_file_name(input: &str) -> Option<String> {
    let normalized = input.replace('\\', "/");
    let file_name = Path::new(&normalized).file_name()?.to_string_lossy();
    let mut output = String::new();
    for ch in file_name.trim().chars() {
        if ch == '/' || ch == '\\' || ch.is_control() {
            continue;
        }
        output.push(ch);
    }
    let output = output.trim_matches('.').trim().to_string();
    if output.is_empty() || output == "." || output == ".." {
        return None;
    }
    if output.len() > 180 {
        let mut truncated = String::new();
        for ch in output.chars() {
            if truncated.len() + ch.len_utf8() > 180 {
                break;
            }
            truncated.push(ch);
        }
        return finalize_upload_file_name(truncated);
    }
    finalize_upload_file_name(output)
}

fn finalize_upload_file_name(name: String) -> Option<String> {
    let name = name.trim_matches('.').trim().to_string();
    if name.is_empty() || name == "." || name == ".." {
        None
    } else {
        Some(name)
    }
}

fn generated_upload_name(mime: Option<&str>) -> String {
    let extension = upload_extension_for_mime(mime).unwrap_or("bin");
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let suffix = UPLOAD_TEMP_COUNTER.fetch_add(1, Ordering::AcqRel);
    format!("pasted-file-{millis}-{suffix}.{extension}")
}

fn upload_extension_for_mime(mime: Option<&str>) -> Option<&'static str> {
    match mime?
        .split(';')
        .next()?
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/svg+xml" => Some("svg"),
        "text/plain" => Some("txt"),
        "application/pdf" => Some("pdf"),
        _ => None,
    }
}

fn is_direct_child(parent: &Path, child: &Path) -> bool {
    child
        .parent()
        .is_some_and(|child_parent| child_parent == parent)
}

/// Mutating methods the browser client is allowed to invoke. Anything outside
/// this list (e.g. `server.stop`, `pane.send_keys`) is rejected so the bridge
/// only exposes the workspace/tab/pane lifecycle the UI needs.
const ALLOWED_COMMANDS: &[&str] = &[
    "workspace.create",
    "workspace.rename",
    "workspace.close",
    "workspace.focus",
    "tab.create",
    "tab.rename",
    "tab.close",
    "tab.focus",
    "pane.rename",
    "pane.close",
    // Narrow input path used to run a selected launch command in a just-created tab.
    "pane.send_input",
    // Layout-mutating: the web client builds splits directly.
    "pane.split",
    // Directional pane focus: explicit pane_id only, matching the web selection.
    "pane.focus_direction",
    // Narrow live pane moves: new tab or new workspace destinations only.
    "pane.move",
    // Agent creation: exposes Herdr's native agent.start placement and argv path.
    "agent.start",
];

fn ensure_allowed_request(headers: &HeaderMap, policy: &RequestPolicy) -> Result<(), BridgeError> {
    if request_allowed(headers, policy) {
        return Ok(());
    }
    Err(BridgeError::Forbidden(
        "cross-origin requests are not allowed".to_string(),
    ))
}

fn request_allowed(headers: &HeaderMap, policy: &RequestPolicy) -> bool {
    request_host_allowed(headers, policy) && request_origin_allowed(headers, policy)
}

fn request_host_allowed(headers: &HeaderMap, policy: &RequestPolicy) -> bool {
    let Some(host) = headers.get(HOST).and_then(|host| host.to_str().ok()) else {
        return false;
    };
    host_authority_allowed(host, policy)
}

fn host_authority_allowed(authority: &str, policy: &RequestPolicy) -> bool {
    let host = host_part(authority);
    if host.is_empty() {
        return false;
    }

    if is_loopback_host(host) {
        return true;
    }

    if !authority_port_matches(authority, policy.bind_port) {
        return false;
    }

    if policy
        .allowed_hosts
        .iter()
        .any(|allowed| host.eq_ignore_ascii_case(allowed))
    {
        return true;
    }

    if is_unspecified_bind_host(&policy.bind_host) {
        return host.parse::<IpAddr>().is_ok();
    }

    host.eq_ignore_ascii_case(&policy.bind_host)
}

fn request_origin_allowed(headers: &HeaderMap, policy: &RequestPolicy) -> bool {
    let Some(origin) = headers.get(ORIGIN) else {
        return true;
    };
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    let Some(origin_authority) = origin_authority(origin) else {
        return false;
    };
    let Some(host) = headers.get(HOST).and_then(|host| host.to_str().ok()) else {
        return false;
    };

    same_authority(origin_authority, host)
        || (is_loopback_authority(origin_authority) && is_loopback_authority(host))
        || policy
            .allowed_origins
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(origin))
}

fn origin_authority(origin: &str) -> Option<&str> {
    let rest = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))?;
    if rest.is_empty() || rest.contains('/') {
        return None;
    }
    Some(rest)
}

fn normalize_allowed_origin(origin: &str) -> Result<String, String> {
    let origin = origin.trim().to_ascii_lowercase();
    let Some(authority) = origin_authority(&origin) else {
        return Err("allowed origin must be an http or https origin without a path".into());
    };
    if authority.is_empty() {
        return Err("allowed origin must include a host".into());
    }
    Ok(origin)
}

fn connect_sources_for_origin(origin: &str) -> Result<Vec<String>, String> {
    let origin = normalize_allowed_origin(origin)?;
    let websocket_origin = if let Some(authority) = origin.strip_prefix("http://") {
        format!("ws://{authority}")
    } else if let Some(authority) = origin.strip_prefix("https://") {
        format!("wss://{authority}")
    } else {
        unreachable!("normalize_allowed_origin only accepts http and https origins")
    };
    Ok(vec![origin, websocket_origin])
}

fn content_security_policy(policy: &RequestPolicy) -> HeaderValue {
    let mut connect_src = vec!["'self'".to_string(), "data:".to_string()];
    connect_src.extend(policy.allowed_connect_sources.iter().cloned());
    let value = format!(
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src {}; \
         img-src 'self' data: blob:; \
         style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; base-uri 'none'; \
         frame-ancestors 'none'",
        connect_src.join(" ")
    );
    HeaderValue::from_str(&value).expect("connect-src sources are validated origins")
}

fn normalize_allowed_host(host: &str) -> Result<String, String> {
    let host = host.trim().trim_matches('.');
    if host.is_empty() {
        return Err("allowed host must not be empty".into());
    }
    if host.contains(':') || host.contains('/') || host.contains('\\') {
        return Err("allowed host must be a hostname without scheme, port, or path".into());
    }
    if !is_valid_dns_hostname(host) {
        return Err("allowed host is not a valid hostname".into());
    }
    Ok(host.to_ascii_lowercase())
}

fn is_valid_dns_hostname(host: &str) -> bool {
    if host.len() > 253 {
        return false;
    }
    host.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    })
}

fn same_authority(left: &str, right: &str) -> bool {
    left.eq_ignore_ascii_case(right)
}

fn is_loopback_authority(authority: &str) -> bool {
    let host = host_part(authority);
    is_loopback_host(host)
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1"
}

fn is_unspecified_bind_host(host: &str) -> bool {
    matches!(host, "0.0.0.0" | "::" | "[::]")
}

fn authority_port_matches(authority: &str, expected_port: u16) -> bool {
    match authority_port(authority) {
        Some(port) => port == expected_port,
        None => expected_port == 80,
    }
}

fn authority_port(authority: &str) -> Option<u16> {
    if authority.parse::<IpAddr>().is_ok() {
        return None;
    }
    if let Some(rest) = authority.strip_prefix('[') {
        let end = rest.find(']')?;
        return rest[end + 1..]
            .strip_prefix(':')
            .and_then(|port| port.parse().ok());
    }
    let (_, port) = authority.rsplit_once(':')?;
    if port.contains(':') {
        return None;
    }
    port.parse().ok()
}

fn host_part(authority: &str) -> &str {
    if let Some(rest) = authority.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            return &rest[..end];
        }
    }
    if authority.parse::<IpAddr>().is_ok() {
        return authority;
    }
    authority.split(':').next().unwrap_or(authority)
}

fn validate_web_command(method: &Method) -> Result<(), BridgeError> {
    match method {
        Method::WorkspaceCreate(params) => {
            if params.cwd.is_some() || !params.env.is_empty() || !params.focus {
                return Err(BridgeError::BadRequest(
                    "workspace.create is limited to focused default workspaces through herdr-web"
                        .to_string(),
                ));
            }
            if params
                .label
                .as_deref()
                .is_some_and(|label| label.trim().is_empty() || label.len() > 120)
            {
                return Err(BridgeError::BadRequest(
                    "workspace.create label must be non-empty and up to 120 bytes".to_string(),
                ));
            }
        }
        Method::TabCreate(params) => {
            if params
                .workspace_id
                .as_deref()
                .is_none_or(|workspace_id| workspace_id.trim().is_empty())
                || params.cwd.is_some()
                || !params.env.is_empty()
                || !params.focus
            {
                return Err(BridgeError::BadRequest(
                    "tab.create is limited to focused tabs in an existing workspace through herdr-web"
                        .to_string(),
                ));
            }
            if params
                .label
                .as_deref()
                .is_some_and(|label| label.trim().is_empty() || label.len() > 120)
            {
                return Err(BridgeError::BadRequest(
                    "tab.create label must be non-empty and up to 120 bytes".to_string(),
                ));
            }
        }
        Method::WorkspaceRename(params) => {
            if params.workspace_id.trim().is_empty() {
                return Err(BridgeError::BadRequest(
                    "workspace_id is required".to_string(),
                ));
            }
            validate_optional_label(&params.label, "workspace.rename label")?;
        }
        Method::TabRename(params) => {
            if params.tab_id.trim().is_empty() {
                return Err(BridgeError::BadRequest("tab_id is required".to_string()));
            }
            validate_optional_label(&params.label, "tab.rename label")?;
        }
        Method::PaneSendInput(params) => {
            if params.pane_id.trim().is_empty() {
                return Err(BridgeError::BadRequest("pane_id is required".to_string()));
            }
            if params.keys.len() != 1 || params.keys[0] != "Enter" {
                return Err(BridgeError::BadRequest(
                    "pane.send_input is limited to Enter-submitted launch commands".to_string(),
                ));
            }
            if !is_allowed_agent_command(&params.text) {
                return Err(BridgeError::BadRequest(
                    "pane.send_input launch command is not allowed".to_string(),
                ));
            }
        }
        Method::PaneSplit(params) => {
            if params
                .target_pane_id
                .as_deref()
                .is_none_or(|pane_id| pane_id.trim().is_empty())
            {
                return Err(BridgeError::BadRequest(
                    "pane.split requires target_pane_id".to_string(),
                ));
            }
            if params.workspace_id.is_some()
                || params.ratio.is_some()
                || params.cwd.is_some()
                || !params.env.is_empty()
            {
                return Err(BridgeError::BadRequest(
                    "pane.split supports only target pane, direction, and focus through herdr-web"
                        .to_string(),
                ));
            }
        }
        Method::PaneFocusDirection(params) => {
            if params
                .pane_id
                .as_deref()
                .is_none_or(|pane_id| pane_id.trim().is_empty())
            {
                return Err(BridgeError::BadRequest(
                    "pane.focus_direction requires pane_id".to_string(),
                ));
            }
        }
        Method::PaneMove(params) => {
            if params.pane_id.trim().is_empty() {
                return Err(BridgeError::BadRequest("pane_id is required".to_string()));
            }
            if !params.focus {
                return Err(BridgeError::BadRequest(
                    "pane.move must focus the moved pane through herdr-web".to_string(),
                ));
            }
            match &params.destination {
                PaneMoveDestination::NewTab {
                    workspace_id,
                    label,
                } => {
                    if workspace_id
                        .as_deref()
                        .is_none_or(|workspace_id| workspace_id.trim().is_empty())
                    {
                        return Err(BridgeError::BadRequest(
                            "pane.move new_tab requires workspace_id through herdr-web".to_string(),
                        ));
                    }
                    validate_optional_label(label, "pane.move new_tab label")?;
                }
                PaneMoveDestination::NewWorkspace { label, tab_label } => {
                    validate_optional_label(label, "pane.move new_workspace label")?;
                    validate_optional_label(tab_label, "pane.move new_workspace tab_label")?;
                }
                PaneMoveDestination::Tab { .. } => {
                    return Err(BridgeError::BadRequest(
                        "pane.move to existing tabs is not exposed through herdr-web".to_string(),
                    ));
                }
            }
        }
        Method::AgentStart(params) => {
            if params.name.trim().is_empty() || params.name.len() > 120 {
                return Err(BridgeError::BadRequest(
                    "agent.start requires a non-empty launch name up to 120 bytes".to_string(),
                ));
            }
            if params
                .tab_id
                .as_deref()
                .is_none_or(|tab_id| tab_id.trim().is_empty())
                || params.workspace_id.is_some()
                || params.cwd.is_some()
                || !params.env.is_empty()
                || !params.focus
                || !matches!(
                    params.split.as_ref(),
                    Some(SplitDirection::Right) | Some(SplitDirection::Down)
                )
                || !is_allowed_agent_argv(&params.argv)
            {
                return Err(BridgeError::BadRequest(
                    "agent.start is limited to focused Codex, Claude, or pi splits in an existing tab"
                        .to_string(),
                ));
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_optional_label(label: &Option<String>, field: &str) -> Result<(), BridgeError> {
    if label
        .as_deref()
        .is_some_and(|label| label.trim().is_empty() || label.len() > 120)
    {
        return Err(BridgeError::BadRequest(format!(
            "{field} must be non-empty and up to 120 bytes"
        )));
    }
    Ok(())
}

fn is_allowed_agent_command(text: &str) -> bool {
    matches!(text, "codex" | "claude" | "pi")
}

fn is_allowed_agent_argv(argv: &[String]) -> bool {
    matches!(argv, [command] if is_allowed_agent_command(command))
}

#[derive(Debug, Deserialize)]
struct CommandRequest {
    method: String,
    #[serde(default)]
    params: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct SelectionRequest {
    pane_id: String,
}

#[derive(Debug, Deserialize)]
struct UploadQuery {
    name: Option<String>,
    #[serde(default)]
    overwrite: bool,
}

#[derive(Debug, Serialize)]
struct UploadEntry {
    name: String,
    path: String,
    size: usize,
    mime: Option<String>,
}

#[derive(Debug, Serialize)]
struct UploadResponse {
    file: UploadEntry,
}

async fn command_handler(
    State(state): State<BridgeState>,
    headers: HeaderMap,
    Json(body): Json<CommandRequest>,
) -> Result<Json<serde_json::Value>, BridgeError> {
    ensure_allowed_request(&headers, &state.request_policy)?;
    if !ALLOWED_COMMANDS.contains(&body.method.as_str()) {
        return Err(BridgeError::Forbidden(format!(
            "command not allowed: {}",
            body.method
        )));
    }

    let params = if body.params.is_null() {
        serde_json::json!({})
    } else {
        body.params
    };
    let request_value = serde_json::json!({
        "id": format!("herdr-web:cmd:{}", body.method),
        "method": body.method,
        "params": params,
    });
    let mut request: Request = serde_json::from_value(request_value)
        .map_err(|err| BridgeError::BadRequest(format!("invalid command: {err}")))?;
    validate_web_command(&request.method)?;
    fill_clear_rename_labels(&state.api, &mut request.method)?;
    let should_prune_terminal_sessions = command_may_close_terminal_session(&request.method);

    let api = state.api.clone();
    let response = tokio::task::spawn_blocking(move || api.request(request))
        .await
        .map_err(|err| BridgeError::Protocol(err.to_string()))??;
    if let ResponseResult::PaneMove { move_result } = &response.result {
        if move_result.changed {
            let notes = state.notes.clone();
            let previous_pane_id = move_result.previous_pane_id.clone();
            let moved_pane = (*move_result.pane).clone();
            match tokio::task::spawn_blocking(move || {
                notes.update_for_pane_move(&previous_pane_id, &moved_pane)
            })
            .await
            .map_err(|err| BridgeError::Protocol(err.to_string()))?
            {
                Ok(true) => broadcast_notes_changed(&state, None, None),
                Ok(false) => {}
                Err(err) => warn!(error = %err, "failed to update note attachment after pane move"),
            }
        }
    }
    let value = serde_json::to_value(response.result)
        .map_err(|err| BridgeError::Protocol(err.to_string()))?;
    if should_prune_terminal_sessions {
        let prune_state = state.clone();
        tokio::task::spawn_blocking(move || prune_detached_terminal_sessions(&prune_state));
    }
    Ok(Json(value))
}

fn command_may_close_terminal_session(method: &Method) -> bool {
    matches!(
        method,
        Method::WorkspaceClose(_)
            | Method::TabClose(_)
            | Method::PaneClose(_)
            | Method::PaneMove(_)
    )
}

fn fill_clear_rename_labels(api: &ApiClient, method: &mut Method) -> Result<(), BridgeError> {
    match method {
        Method::WorkspaceRename(params) if params.label.is_none() => {
            params.label = Some(default_workspace_label(api, &params.workspace_id)?);
        }
        Method::TabRename(params) if params.label.is_none() => {
            params.label = Some(default_tab_label(api, &params.tab_id)?);
        }
        _ => {}
    }
    Ok(())
}

fn default_tab_label(api: &ApiClient, tab_id: &str) -> Result<String, BridgeError> {
    match api_request(
        api,
        "herdr-web:clear-tab-label",
        Method::TabList(TabListParams::default()),
    )? {
        ResponseResult::TabList { tabs } => tabs
            .into_iter()
            .find(|tab| tab.tab_id == tab_id)
            .map(|tab| tab.number.to_string())
            .ok_or_else(|| BridgeError::BadRequest(format!("tab not found: {tab_id}"))),
        other => Err(BridgeError::Protocol(format!(
            "unexpected response: {other:?}"
        ))),
    }
}

fn default_workspace_label(api: &ApiClient, workspace_id: &str) -> Result<String, BridgeError> {
    Ok(default_workspace_label_from_panes(
        workspace_id,
        current_panes(api)?.iter(),
    ))
}

fn default_workspace_label_from_panes<'a>(
    workspace_id: &str,
    panes: impl Iterator<Item = &'a PaneInfo>,
) -> String {
    panes
        .filter(|pane| pane.workspace_id == workspace_id)
        .filter_map(|pane| pane.foreground_cwd.as_ref().or(pane.cwd.as_ref()))
        .min()
        .map(|cwd| crate::workspace::derive_label_from_cwd(Path::new(cwd)))
        .filter(|label| !label.trim().is_empty())
        .unwrap_or_else(|| "workspace".to_string())
}

async fn selection_handler(
    State(state): State<BridgeState>,
    headers: HeaderMap,
    Json(body): Json<SelectionRequest>,
) -> Result<Json<serde_json::Value>, BridgeError> {
    ensure_allowed_request(&headers, &state.request_policy)?;
    let pane_id = body.pane_id.trim();
    if pane_id.is_empty() {
        return Err(BridgeError::BadRequest("missing pane_id".to_string()));
    }
    let panes = current_panes(&state.api)?;
    if !panes.iter().any(|pane| pane.pane_id == pane_id) {
        return Err(BridgeError::Protocol(format!("pane not found: {pane_id}")));
    }
    {
        let mut selected = state
            .selected_pane_id
            .lock()
            .map_err(|_| BridgeError::Protocol("selection lock poisoned".to_string()))?;
        *selected = Some(pane_id.to_string());
    }
    let _ = state.ui_event_tx.send(
        serde_json::json!({
            "type": "herdr_web.selection_changed",
            "pane_id": pane_id,
        })
        .to_string(),
    );
    Ok(Json(serde_json::json!({ "selected_pane_id": pane_id })))
}

async fn upload_handler(
    State(state): State<BridgeState>,
    Query(query): Query<UploadQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<UploadResponse>, UploadError> {
    ensure_allowed_request(&headers, &state.request_policy)
        .map_err(|err| UploadError::Forbidden(err.to_string()))?;
    if body.len() > MAX_UPLOAD_BYTES {
        return Err(UploadError::TooLarge);
    }

    let mime = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    debug!(
        bytes = body.len(),
        mime = ?mime,
        overwrite = query.overwrite,
        "herdr-web-bridge upload request"
    );
    let name = match query.name.as_deref().and_then(sanitize_upload_file_name) {
        Some(name) => name,
        None => generated_upload_name(mime.as_deref()),
    };
    let destination = state.upload_dir.join(&name);
    if !is_direct_child(&state.upload_dir, &destination) {
        return Err(UploadError::BadRequest("invalid file name".to_string()));
    }

    tokio::fs::create_dir_all(&state.upload_dir).await?;
    let existing = tokio::fs::symlink_metadata(&destination).await.ok();
    if let Some(existing) = existing {
        if !query.overwrite {
            info!(
                name = %name,
                "herdr-web-bridge upload conflict"
            );
            return Err(UploadError::Conflict {
                name,
                path: destination.display().to_string(),
            });
        }
        if existing.file_type().is_symlink() || existing.is_dir() {
            return Err(UploadError::BadRequest(
                "refusing to overwrite non-file path".to_string(),
            ));
        }
    }

    if !query.overwrite {
        match tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
            .await
        {
            Ok(mut file) => {
                tokio::io::AsyncWriteExt::write_all(&mut file, &body).await?;
                tokio::io::AsyncWriteExt::flush(&mut file).await?;
            }
            Err(err) if err.kind() == ErrorKind::AlreadyExists => {
                return Err(UploadError::Conflict {
                    name,
                    path: destination.display().to_string(),
                });
            }
            Err(err) => return Err(UploadError::Io(err)),
        }
    } else {
        let temp_path = state.upload_dir.join(format!(
            ".herdr-web-upload-{}-{}.tmp",
            std::process::id(),
            UPLOAD_TEMP_COUNTER.fetch_add(1, Ordering::AcqRel)
        ));
        tokio::fs::write(&temp_path, &body).await?;
        if destination.exists() {
            tokio::fs::remove_file(&destination).await?;
        }
        match tokio::fs::rename(&temp_path, &destination).await {
            Ok(()) => {}
            Err(err) => {
                let _ = tokio::fs::remove_file(&temp_path).await;
                return Err(UploadError::Io(err));
            }
        }
    }

    let response = UploadResponse {
        file: UploadEntry {
            name,
            path: destination.display().to_string(),
            size: body.len(),
            mime,
        },
    };
    info!(bytes = body.len(), "herdr-web-bridge upload saved");
    Ok(Json(response))
}

async fn snapshot_handler(
    State(state): State<BridgeState>,
    headers: HeaderMap,
) -> Result<Json<Snapshot>, BridgeError> {
    ensure_allowed_request(&headers, &state.request_policy)?;
    // Read from the materialized snapshot cache (no IPC calls).
    let cached = state.snapshot_cache.snapshot();
    let workspaces = cached.workspaces;
    let tabs = cached.tabs;
    let panes = cached.panes;
    // Keep legacy pane_cache in sync for callers that still use it.
    {
        let mut cache = state.pane_cache.lock().unwrap_or_else(|e| e.into_inner());
        *cache = Some(CachedPanes {
            panes: panes.clone(),
            fetched_at: std::time::Instant::now(),
        });
    }
    let state_clone = state.clone();
    let layout_panes = panes.clone();
    let layout_tabs = tabs.clone();
    let (selected_pane_id, layouts) = tokio::task::spawn_blocking(move || {
        let selected_pane_id = shared_selected_pane(&state_clone, &layout_panes)?;
        let layouts = if let Some(ref sel_id) = selected_pane_id {
            if let Some(sel_pane) = layout_panes.iter().find(|p| p.pane_id == *sel_id) {
                collect_tab_layouts(&state_clone.api, &layout_tabs.iter().filter(|t| t.tab_id == sel_pane.tab_id).cloned().collect::<Vec<_>>(), &layout_panes)
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        };
        Ok::<_, BridgeError>((selected_pane_id, layouts))
    })
    .await
    .map_err(|err| BridgeError::Protocol(err.to_string()))??;
    observe_agent_activity_snapshot(&state, &panes);
    let notes = state.notes.clone();
    let note_panes = panes.clone();
    match tokio::task::spawn_blocking(move || notes.observe_panes(&note_panes))
        .await
        .map_err(|err| BridgeError::Protocol(err.to_string()))?
    {
        Ok(true) => broadcast_notes_changed(&state, None, None),
        Ok(false) => {}
        Err(err) => warn!(error = %err, "failed to update pane note observations"),
    }
    let selected_pane_id = selected_pane_id;
    let workspaces = workspaces
        .into_iter()
        .map(|workspace| {
            let can_clear_name = workspace.label
                != default_workspace_label_from_panes(&workspace.workspace_id, panes.iter());
            SnapshotWorkspaceInfo {
                info: workspace,
                can_clear_name,
            }
        })
        .collect();
    let tabs = tabs
        .into_iter()
        .map(|tab| {
            let can_clear_name = !is_default_tab_label(&tab.label);
            SnapshotTabInfo {
                info: tab,
                can_clear_name,
            }
        })
        .collect();

    Ok(Json(Snapshot {
        workspaces,
        tabs,
        panes,
        layouts,
        selected_pane_id,
    }))
}

fn is_default_tab_label(label: &str) -> bool {
    let label = label.trim();
    !label.is_empty() && label.chars().all(|ch| ch.is_ascii_digit())
}

async fn capabilities_handler(
    State(state): State<BridgeState>,
    headers: HeaderMap,
) -> Result<Json<Capabilities>, BridgeError> {
    ensure_allowed_request(&headers, &state.request_policy)?;
    Ok(Json(Capabilities {
        commands: ALLOWED_COMMANDS,
        agent_activity: AgentActivityCapability { version: 1 },
        agent_pins: AgentPinsCapability { version: 1 },
        notes: NotesCapability { version: 1 },
    }))
}

async fn agent_activity_list_handler(
    State(state): State<BridgeState>,
    headers: HeaderMap,
) -> Result<Json<AgentActivityListResponse>, BridgeError> {
    ensure_allowed_request(&headers, &state.request_policy)?;
    let panes = cached_panes(&state)?;
    observe_agent_activity_snapshot(&state, &panes);
    Ok(Json(state.agent_activity.list(&panes)))
}

async fn agent_pins_list_handler(
    State(state): State<BridgeState>,
    headers: HeaderMap,
) -> Result<Json<AgentPinsListResponse>, BridgeError> {
    ensure_allowed_request(&headers, &state.request_policy)?;
    Ok(Json(
        run_agent_pins_task(state, move |state| {
            let panes = cached_panes(&state)?;
            Ok(state.agent_pins.list(&panes)?)
        })
        .await?,
    ))
}

async fn agent_pins_pin_handler(
    State(state): State<BridgeState>,
    AxumPath(pane_id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Json<AgentPinsListResponse>, BridgeError> {
    ensure_allowed_request(&headers, &state.request_policy)?;
    let event_pane_id = pane_id.clone();
    let response = run_agent_pins_task(state.clone(), move |state| {
        let panes = cached_panes(&state)?;
        Ok(state.agent_pins.pin(&pane_id, &panes)?)
    })
    .await?;
    broadcast_agent_pins_changed(&state, Some(&event_pane_id));
    Ok(Json(response))
}

async fn agent_pins_unpin_handler(
    State(state): State<BridgeState>,
    AxumPath(pane_id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Json<AgentPinsListResponse>, BridgeError> {
    ensure_allowed_request(&headers, &state.request_policy)?;
    let event_pane_id = pane_id.clone();
    let response = run_agent_pins_task(state.clone(), move |state| {
        let panes = cached_panes(&state)?;
        Ok(state.agent_pins.unpin(&pane_id, &panes)?)
    })
    .await?;
    broadcast_agent_pins_changed(&state, Some(&event_pane_id));
    Ok(Json(response))
}

async fn notes_list_handler(
    State(state): State<BridgeState>,
    Query(query): Query<NotesListQuery>,
    headers: HeaderMap,
) -> Result<Json<NotesListResponse>, BridgeError> {
    ensure_allowed_request(&headers, &state.request_policy)?;
    Ok(Json(
        run_notes_task(state, move |state| {
            let panes = cached_panes(&state)?;
            Ok(state.notes.list(query, &panes)?)
        })
        .await?,
    ))
}

async fn notes_create_handler(
    State(state): State<BridgeState>,
    headers: HeaderMap,
    Json(body): Json<CreateNoteRequest>,
) -> Result<Json<NoteResponse>, BridgeError> {
    ensure_allowed_request(&headers, &state.request_policy)?;
    let note = run_notes_task(state.clone(), move |state| {
        let panes = cached_panes(&state)?;
        Ok(state.notes.create(body, &panes)?)
    })
    .await?;
    broadcast_notes_changed(&state, Some(&note.note.note_id), Some(note.note.revision));
    Ok(Json(note))
}

async fn notes_update_handler(
    State(state): State<BridgeState>,
    AxumPath(note_id): AxumPath<String>,
    headers: HeaderMap,
    Json(body): Json<UpdateNoteRequest>,
) -> Result<Json<NoteResponse>, BridgeError> {
    ensure_allowed_request(&headers, &state.request_policy)?;
    let note = run_notes_task(state.clone(), move |state| {
        let panes = cached_panes(&state)?;
        Ok(state.notes.update(&note_id, body, &panes)?)
    })
    .await?;
    broadcast_notes_changed(&state, Some(&note.note.note_id), Some(note.note.revision));
    Ok(Json(note))
}

async fn notes_attach_handler(
    State(state): State<BridgeState>,
    AxumPath(note_id): AxumPath<String>,
    headers: HeaderMap,
    Json(body): Json<AttachNoteRequest>,
) -> Result<Json<NoteResponse>, BridgeError> {
    ensure_allowed_request(&headers, &state.request_policy)?;
    let note = run_notes_task(state.clone(), move |state| {
        let panes = cached_panes(&state)?;
        Ok(state.notes.attach(&note_id, body, &panes)?)
    })
    .await?;
    broadcast_notes_changed(&state, Some(&note.note.note_id), Some(note.note.revision));
    Ok(Json(note))
}

async fn notes_detach_handler(
    State(state): State<BridgeState>,
    AxumPath(note_id): AxumPath<String>,
    headers: HeaderMap,
    Json(body): Json<RevisionRequest>,
) -> Result<Json<NoteResponse>, BridgeError> {
    ensure_allowed_request(&headers, &state.request_policy)?;
    let note = run_notes_task(state.clone(), move |state| {
        let panes = cached_panes(&state)?;
        Ok(state.notes.detach(&note_id, body, &panes)?)
    })
    .await?;
    broadcast_notes_changed(&state, Some(&note.note.note_id), Some(note.note.revision));
    Ok(Json(note))
}

async fn notes_archive_handler(
    State(state): State<BridgeState>,
    AxumPath(note_id): AxumPath<String>,
    headers: HeaderMap,
    Json(body): Json<RevisionRequest>,
) -> Result<Json<NoteResponse>, BridgeError> {
    ensure_allowed_request(&headers, &state.request_policy)?;
    let note = run_notes_task(state.clone(), move |state| {
        let panes = cached_panes(&state)?;
        Ok(state.notes.archive(&note_id, body, &panes)?)
    })
    .await?;
    broadcast_notes_changed(&state, Some(&note.note.note_id), Some(note.note.revision));
    Ok(Json(note))
}

async fn notes_restore_handler(
    State(state): State<BridgeState>,
    AxumPath(note_id): AxumPath<String>,
    headers: HeaderMap,
    Json(body): Json<RevisionRequest>,
) -> Result<Json<NoteResponse>, BridgeError> {
    ensure_allowed_request(&headers, &state.request_policy)?;
    let note = run_notes_task(state.clone(), move |state| {
        let panes = cached_panes(&state)?;
        Ok(state.notes.restore(&note_id, body, &panes)?)
    })
    .await?;
    broadcast_notes_changed(&state, Some(&note.note.note_id), Some(note.note.revision));
    Ok(Json(note))
}

async fn notes_delete_handler(
    State(state): State<BridgeState>,
    AxumPath(note_id): AxumPath<String>,
    headers: HeaderMap,
    Json(body): Json<RevisionRequest>,
) -> Result<Json<NoteResponse>, BridgeError> {
    ensure_allowed_request(&headers, &state.request_policy)?;
    let note = run_notes_task(state.clone(), move |state| {
        let panes = cached_panes(&state)?;
        Ok(state.notes.delete(&note_id, body, &panes)?)
    })
    .await?;
    broadcast_notes_changed(&state, Some(&note.note.note_id), Some(note.note.revision));
    Ok(Json(note))
}

async fn run_agent_pins_task<T, F>(state: BridgeState, task: F) -> Result<T, BridgeError>
where
    T: Send + 'static,
    F: FnOnce(BridgeState) -> Result<T, BridgeError> + Send + 'static,
{
    tokio::task::spawn_blocking(move || task(state))
        .await
        .map_err(|err| BridgeError::Protocol(err.to_string()))?
}

async fn run_notes_task<T, F>(state: BridgeState, task: F) -> Result<T, BridgeError>
where
    T: Send + 'static,
    F: FnOnce(BridgeState) -> Result<T, BridgeError> + Send + 'static,
{
    tokio::task::spawn_blocking(move || task(state))
        .await
        .map_err(|err| BridgeError::Protocol(err.to_string()))?
}

fn broadcast_agent_pins_changed(state: &BridgeState, pane_id: Option<&str>) {
    let mut payload = serde_json::json!({
        "type": "herdr_web.agent_pins_changed",
    });
    if let Some(pane_id) = pane_id {
        payload["pane_id"] = serde_json::json!(pane_id);
    }
    let _ = state.ui_event_tx.send(payload.to_string());
}

fn broadcast_agent_activity_changed(state: &BridgeState) {
    let payload = serde_json::json!({
        "type": "herdr_web.agent_activity_changed",
    });
    let _ = state.ui_event_tx.send(payload.to_string());
}

fn broadcast_notes_changed(state: &BridgeState, note_id: Option<&str>, revision: Option<u64>) {
    let mut payload = serde_json::json!({
        "type": "herdr_web.notes_changed",
    });
    if let Some(note_id) = note_id {
        payload["note_id"] = serde_json::json!(note_id);
    }
    if let Some(revision) = revision {
        payload["revision"] = serde_json::json!(revision);
    }
    let _ = state.ui_event_tx.send(payload.to_string());
}

fn observe_agent_activity_snapshot(state: &BridgeState, panes: &[PaneInfo]) {
    if state.agent_activity.observe_snapshot(panes) {
        broadcast_agent_activity_changed(state);
    }
}

fn current_panes(api: &ApiClient) -> Result<Vec<PaneInfo>, BridgeError> {
    match api_request(
        api,
        "herdr-web:pane-list",
        Method::PaneList(PaneListParams::default()),
    )? {
        ResponseResult::PaneList { panes } => Ok(panes),
        other => Err(BridgeError::Protocol(format!(
            "unexpected response: {other:?}"
        ))),
    }
}

fn cached_panes(state: &BridgeState) -> Result<Vec<PaneInfo>, BridgeError> {
    // Read from the snapshot cache — no IPC calls needed.
    let panes = state.snapshot_cache.panes();
    if !panes.is_empty() {
        return Ok(panes);
    }
    // Fallback: snapshot cache not yet seeded, use legacy pane_cache or IPC.
    {
        let cache = state.pane_cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(ref cached) = *cache {
            if cached.fetched_at.elapsed() < PANE_CACHE_TTL {
                return Ok(cached.panes.clone());
            }
        }
    }
    let panes = current_panes(&state.api)?;
    {
        let mut cache = state.pane_cache.lock().unwrap_or_else(|e| e.into_inner());
        *cache = Some(CachedPanes {
            panes: panes.clone(),
            fetched_at: std::time::Instant::now(),
        });
    }
    Ok(panes)
}

fn shared_selected_pane(
    state: &BridgeState,
    panes: &[PaneInfo],
) -> Result<Option<String>, BridgeError> {
    let mut selected = state
        .selected_pane_id
        .lock()
        .map_err(|_| BridgeError::Protocol("selection lock poisoned".to_string()))?;
    if selected
        .as_ref()
        .is_some_and(|pane_id| panes.iter().any(|pane| pane.pane_id == pane_id.as_str()))
    {
        return Ok(selected.clone());
    }
    *selected = None;
    Ok(None)
}

fn api_request(api: &ApiClient, id: &str, method: Method) -> Result<ResponseResult, BridgeError> {
    Ok(api
        .request(Request {
            id: id.to_string(),
            method,
        })?
        .result)
}

fn collect_tab_layouts(
    api: &ApiClient,
    tabs: &[TabInfo],
    panes: &[PaneInfo],
) -> Vec<PaneLayoutSnapshot> {
    tabs.iter()
        .filter_map(|tab| {
            let pane = panes.iter().find(|pane| pane.tab_id == tab.tab_id)?;
            match api_request(
                api,
                &format!("herdr-web:layout:{}", tab.tab_id),
                Method::PaneLayout(PaneLayoutParams {
                    pane_id: Some(pane.pane_id.clone()),
                }),
            ) {
                Ok(ResponseResult::PaneLayout { layout }) => Some(layout),
                Ok(_) | Err(_) => None,
            }
        })
        .collect()
}

async fn terminal_ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<BridgeState>,
    Query(query): Query<TerminalQuery>,
    headers: HeaderMap,
) -> Response {
    if let Err(err) = ensure_allowed_request(&headers, &state.request_policy) {
        return err.into_response();
    }
    ws.on_upgrade(move |socket| handle_terminal_socket(socket, state, query))
        .into_response()
}

async fn events_ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<BridgeState>,
    headers: HeaderMap,
) -> Response {
    if let Err(err) = ensure_allowed_request(&headers, &state.request_policy) {
        return err.into_response();
    }
    ws.on_upgrade(move |socket| handle_events_socket(socket, state))
        .into_response()
}

async fn activity_ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<BridgeState>,
    headers: HeaderMap,
) -> Response {
    if let Err(err) = ensure_allowed_request(&headers, &state.request_policy) {
        return err.into_response();
    }
    ws.on_upgrade(move |socket| handle_activity_socket(socket, state))
        .into_response()
}

async fn ui_events_ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<BridgeState>,
    headers: HeaderMap,
) -> Response {
    if let Err(err) = ensure_allowed_request(&headers, &state.request_policy) {
        return err.into_response();
    }
    ws.on_upgrade(move |socket| handle_ui_events_socket(socket, state))
        .into_response()
}

async fn handle_events_socket(socket: WebSocket, state: BridgeState) {
    state.ws_client_count.fetch_add(1, Ordering::Relaxed);
    let api = state.api.clone();
    let mut ui_event_rx = state.ui_event_tx.subscribe();
    let subscribed = tokio::task::spawn_blocking(move || open_event_subscription(api)).await;
    let Ok(Ok(mut event_rx)) = subscribed else {
        state.ws_client_count.fetch_sub(1, Ordering::Relaxed);
        return;
    };

    let (mut ws_sender, mut ws_receiver) = socket.split();
    loop {
        tokio::select! {
            Some(event) = event_rx.recv() => {
                if event_may_close_terminal_session(&event) {
                    let prune_state = state.clone();
                    tokio::task::spawn_blocking(move || prune_detached_terminal_sessions(&prune_state));
                }
                if ws_sender.send(Message::Text(event.into())).await.is_err() {
                    break;
                }
            }
            event = ui_event_rx.recv() => {
                match event {
                    Ok(event) => {
                        if ws_sender.send(Message::Text(event.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            Some(message) = ws_receiver.next() => {
                match message {
                    Ok(Message::Close(_)) | Err(_) => break,
                    Ok(Message::Text(_))
                    | Ok(Message::Binary(_))
                    | Ok(Message::Ping(_))
                    | Ok(Message::Pong(_)) => {}
                }
            }
            else => break,
        }
    }
    state.ws_client_count.fetch_sub(1, Ordering::Relaxed);
}

async fn handle_activity_socket(socket: WebSocket, state: BridgeState) {
    let mut activity_rx = state.activity_tx.subscribe();
    let (mut ws_sender, mut ws_receiver) = socket.split();
    loop {
        tokio::select! {
            event = activity_rx.recv() => {
                match event {
                    Ok(event) => {
                        if send_activity_message(&mut ws_sender, &event).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let event = ActivityMessage::ResyncRequired {
                            reason: "activity receiver lagged".to_string(),
                        };
                        let _ = send_activity_message(&mut ws_sender, &event).await;
                        break;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            Some(message) = ws_receiver.next() => {
                match message {
                    Ok(Message::Close(_)) | Err(_) => break,
                    Ok(Message::Text(_))
                    | Ok(Message::Binary(_))
                    | Ok(Message::Ping(_))
                    | Ok(Message::Pong(_)) => {}
                }
            }
            else => break,
        }
    }
}

async fn send_activity_message(
    ws_sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    event: &ActivityMessage,
) -> Result<(), axum::Error> {
    let text = serde_json::to_string(event).unwrap_or_else(|_| {
        r#"{"type":"resync_required","reason":"activity serialization failed"}"#.to_string()
    });
    ws_sender.send(Message::Text(text.into())).await
}

async fn handle_ui_events_socket(socket: WebSocket, state: BridgeState) {
    let mut ui_event_rx = state.ui_event_tx.subscribe();
    let (mut ws_sender, mut ws_receiver) = socket.split();
    loop {
        tokio::select! {
            event = ui_event_rx.recv() => {
                match event {
                    Ok(event) => {
                        if ws_sender.send(Message::Text(event.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            Some(message) = ws_receiver.next() => {
                match message {
                    Ok(Message::Close(_)) | Err(_) => break,
                    Ok(Message::Text(_))
                    | Ok(Message::Binary(_))
                    | Ok(Message::Ping(_))
                    | Ok(Message::Pong(_)) => {}
                }
            }
            else => break,
        }
    }
}

async fn handle_terminal_socket(socket: WebSocket, state: BridgeState, query: TerminalQuery) {
    if query.terminal_id.trim().is_empty() {
        return;
    }

    let terminal_id = query.terminal_id.clone();
    let cols = query.cols.unwrap_or(DEFAULT_COLS);
    let rows = query.rows.unwrap_or(DEFAULT_ROWS);
    let coalesce_window = terminal_output_coalesce_window(query.coalesce_ms);
    let (mut ws_sender, mut ws_receiver) = socket.split();
    let session = match acquire_terminal_session(
        state.clone(),
        terminal_id.clone(),
        cols,
        rows,
        query.takeover,
    )
    .await
    {
        Ok(session) => session,
        Err(err) => {
            let _ = ws_sender
                .send(Message::Text(close_message(&err.to_string()).into()))
                .await;
            return;
        }
    };
    session.client_count.fetch_add(1, Ordering::AcqRel);

    let write_tx = session.write_tx.clone();
    let mut terminal_rx = session.output_tx.subscribe();
    let mut output_coalescer = TerminalOutputCoalescer::new(coalesce_window);
    let _ = write_tx.send(ClientMessage::Resize {
        cols,
        rows,
        cell_width_px: 0,
        cell_height_px: 0,
    });

    loop {
        if let Some(deadline) = output_coalescer.deadline() {
            tokio::select! {
                biased;
                Some(message) = ws_receiver.next() => {
                    if !handle_terminal_client_message(&write_tx, message) {
                        break;
                    }
                    output_coalescer.reset_deadline_for_input();
                }
                _ = tokio::time::sleep_until(deadline) => {
                    if !handle_terminal_output_deadline(
                        &mut ws_sender,
                        &mut output_coalescer,
                    )
                    .await
                    {
                        break;
                    }
                }
                output = terminal_rx.recv() => {
                    if !handle_terminal_output_message(
                        output,
                        &mut ws_sender,
                        &mut output_coalescer,
                    )
                    .await
                    {
                        break;
                    }
                }
                else => break,
            }
        } else {
            tokio::select! {
                biased;
                Some(message) = ws_receiver.next() => {
                    if !handle_terminal_client_message(&write_tx, message) {
                        break;
                    }
                    output_coalescer.reset_deadline_for_input();
                }
                output = terminal_rx.recv() => {
                    if !handle_terminal_output_message(
                        output,
                        &mut ws_sender,
                        &mut output_coalescer,
                    )
                    .await
                    {
                        break;
                    }
                }
                else => break,
            }
        }
    }

    release_terminal_session(&state, &terminal_id, &session);
}

async fn handle_terminal_output_deadline(
    ws_sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    output_coalescer: &mut TerminalOutputCoalescer,
) -> bool {
    let Some(reason) = output_coalescer.handle_deadline() else {
        return true;
    };
    let Some(bytes) = output_coalescer.flush_pending(reason, Instant::now()) else {
        return true;
    };
    if ws_sender.send(Message::Binary(bytes)).await.is_err() {
        return false;
    }
    true
}

async fn handle_terminal_output_message(
    output: Result<TerminalOutput, tokio::sync::broadcast::error::RecvError>,
    ws_sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    output_coalescer: &mut TerminalOutputCoalescer,
) -> bool {
    match output {
        Ok(TerminalOutput::Bytes(bytes)) => {
            let decision = output_coalescer.push_bytes(bytes, Instant::now());
            match decision {
                TerminalOutputCoalescingDecision::SendNow(bytes) => {
                    if ws_sender.send(Message::Binary(bytes)).await.is_err() {
                        return false;
                    }
                }
                TerminalOutputCoalescingDecision::Pending => {}
                TerminalOutputCoalescingDecision::FlushPending(reason) => {
                    let Some(bytes) = output_coalescer.flush_pending(reason, Instant::now()) else {
                        return true;
                    };
                    if ws_sender.send(Message::Binary(bytes)).await.is_err() {
                        return false;
                    }
                }
            }
            true
        }
        Ok(TerminalOutput::Close(reason)) => {
            if let Some(bytes) =
                output_coalescer.flush_pending(TerminalOutputFlushReason::Close, Instant::now())
            {
                if ws_sender.send(Message::Binary(bytes)).await.is_err() {
                    return false;
                }
            }
            let _ = ws_sender
                .send(Message::Text(close_message(&reason).into()))
                .await;
            false
        }
        Err(tokio::sync::broadcast::error::RecvError::Lagged(frames)) => {
            output_coalescer.record_lagged(frames);
            true
        }
        Err(tokio::sync::broadcast::error::RecvError::Closed) => false,
    }
}

fn handle_terminal_client_message(
    write_tx: &tokio::sync::mpsc::UnboundedSender<ClientMessage>,
    message: Result<Message, axum::Error>,
) -> bool {
    match message {
        Ok(Message::Text(text)) => handle_terminal_text_frame(write_tx, text.as_str()).is_ok(),
        Ok(Message::Binary(bytes)) => send_terminal_input_chunks(write_tx, &bytes).is_ok(),
        Ok(Message::Close(_)) => false,
        Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => true,
        Err(_) => false,
    }
}

async fn acquire_terminal_session(
    state: BridgeState,
    terminal_id: String,
    cols: u16,
    rows: u16,
    takeover: bool,
) -> Result<SharedTerminalSession, BridgeError> {
    // Check existing sessions under the lock (brief, non-blocking).
    {
        let sessions = state
            .terminal_sessions
            .lock()
            .map_err(|_| BridgeError::Protocol("terminal session lock poisoned".to_string()))?;
        if let Some(session) = sessions.get(&terminal_id) {
            return Ok(session.clone());
        }
    }

    // Resolve protocol version synchronously (fast local call).
    let protocol_version = tokio::task::spawn_blocking({
        let api = state.api.clone();
        move || terminal_attach_protocol(&api)
    })
    .await
    .map_err(|err| BridgeError::Protocol(err.to_string()))??;

    let (output_tx, _) = tokio::sync::broadcast::channel(256);
    let attach = open_terminal_attach(
        state.client_socket_path.clone(),
        terminal_id.clone(),
        cols,
        rows,
        takeover,
        protocol_version,
        output_tx.clone(),
    )
    .await?;
    let session = SharedTerminalSession {
        write_tx: attach.write_tx,
        output_tx,
        client_count: Arc::new(AtomicUsize::new(0)),
    };
    let mut sessions = state
        .terminal_sessions
        .lock()
        .map_err(|_| BridgeError::Protocol("terminal session lock poisoned".to_string()))?;
    // Double-check: another task may have raced and inserted one while we connected.
    if let Some(existing) = sessions.get(&terminal_id) {
        return Ok(existing.clone());
    }
    sessions.insert(terminal_id, session.clone());
    Ok(session)
}

fn release_terminal_session(
    state: &BridgeState,
    terminal_id: &str,
    session: &SharedTerminalSession,
) {
    if session.client_count.fetch_sub(1, Ordering::AcqRel) != 1 {
        return;
    }

    let _ = session.write_tx.send(ClientMessage::Detach);
    let Ok(mut sessions) = state.terminal_sessions.lock() else {
        return;
    };
    if sessions
        .get(terminal_id)
        .is_some_and(|current| Arc::ptr_eq(&current.client_count, &session.client_count))
    {
        sessions.remove(terminal_id);
    }
}

fn prune_detached_terminal_sessions(state: &BridgeState) {
    let Ok(panes) = current_panes(&state.api) else {
        warn!("failed to prune herdr web terminal sessions");
        return;
    };
    let active_terminal_ids = panes
        .iter()
        .map(|pane| pane.terminal_id.as_str())
        .collect::<HashSet<_>>();
    let stale_sessions = {
        let Ok(sessions) = state.terminal_sessions.lock() else {
            warn!("failed to lock herdr web terminal sessions for pruning");
            return;
        };
        sessions
            .iter()
            .filter(|(terminal_id, _)| !active_terminal_ids.contains(terminal_id.as_str()))
            .map(|(terminal_id, session)| (terminal_id.clone(), session.clone()))
            .collect::<Vec<_>>()
    };

    for (terminal_id, session) in stale_sessions {
        close_terminal_session(state, &terminal_id, &session, "terminal closed by Herdr");
    }
}

fn close_terminal_session(
    state: &BridgeState,
    terminal_id: &str,
    session: &SharedTerminalSession,
    reason: &str,
) {
    let _ = session
        .output_tx
        .send(TerminalOutput::Close(reason.to_string()));
    let _ = session.write_tx.send(ClientMessage::Detach);
    let Ok(mut sessions) = state.terminal_sessions.lock() else {
        return;
    };
    if sessions
        .get(terminal_id)
        .is_some_and(|current| Arc::ptr_eq(&current.client_count, &session.client_count))
    {
        sessions.remove(terminal_id);
    }
}

fn event_may_close_terminal_session(event: &str) -> bool {
    event.contains("workspace.closed")
        || event.contains("tab.closed")
        || event.contains("pane.closed")
}

fn close_message(reason: &str) -> String {
    format!(
        r#"{{"type":"closed","reason":{}}}"#,
        serde_json::to_string(reason).unwrap_or_else(|_| "\"closed\"".into())
    )
}

fn spawn_agent_activity_watcher(state: BridgeState) {
    let (resubscribe_tx, resubscribe_rx) = mpsc::channel();
    let structural_state = state.clone();
    if let Err(err) = thread::Builder::new()
        .name("herdr-web-activity-structural".to_string())
        .spawn(move || agent_activity_structural_watcher_loop(structural_state, resubscribe_tx))
    {
        warn!(error = %err, "failed to start herdr-web activity structural watcher");
    }
    if let Err(err) = thread::Builder::new()
        .name("herdr-web-activity".to_string())
        .spawn(move || agent_activity_watcher_loop(state, resubscribe_rx))
    {
        warn!(error = %err, "failed to start herdr-web activity watcher");
    }
}

fn agent_activity_structural_watcher_loop(state: BridgeState, resubscribe_tx: mpsc::Sender<()>) {
    let mut backoff = ACTIVITY_WATCHER_INITIAL_BACKOFF;
    loop {
        while state.ws_client_count.load(Ordering::Relaxed) == 0 {
            thread::sleep(Duration::from_secs(1));
        }
        match run_agent_activity_structural_subscription(&state, &resubscribe_tx) {
            Ok(()) => {
                backoff = ACTIVITY_WATCHER_INITIAL_BACKOFF;
            }
            Err(err) => {
                warn!(error = %err, "herdr-web activity structural watcher will retry");
                thread::sleep(backoff);
                backoff = (backoff * 2).min(ACTIVITY_WATCHER_MAX_BACKOFF);
            }
        }
    }
}

fn agent_activity_watcher_loop(state: BridgeState, resubscribe_rx: mpsc::Receiver<()>) {
    let mut backoff = ACTIVITY_WATCHER_INITIAL_BACKOFF;
    loop {
        while state.ws_client_count.load(Ordering::Relaxed) == 0 {
            thread::sleep(Duration::from_secs(1));
            drain_resubscribe_signals(&resubscribe_rx);
        }
        match run_agent_activity_poll(&state, &resubscribe_rx) {
            Ok(()) => {
                backoff = ACTIVITY_WATCHER_INITIAL_BACKOFF;
                thread::sleep(ACTIVITY_RESUBSCRIBE_DEBOUNCE);
            }
            Err(err) => {
                warn!(error = %err, "herdr-web activity watcher will retry");
                thread::sleep(backoff);
                backoff = (backoff * 2).min(ACTIVITY_WATCHER_MAX_BACKOFF);
            }
        }
    }
}

fn run_agent_activity_structural_subscription(
    state: &BridgeState,
    resubscribe_tx: &mpsc::Sender<()>,
) -> Result<(), BridgeError> {
    let request = Request {
        id: "herdr-web:activity-structural".to_string(),
        method: Method::EventsSubscribe(EventsSubscribeParams {
            subscriptions: structural_event_subscriptions(),
        }),
    };
    let (ack, mut stream) = state.api.subscribe_value(&request, None)?;
    let response = herdr_compat::api::client::parse_response_value(ack)?;
    if !matches!(response.result, ResponseResult::SubscriptionStarted {}) {
        return Err(BridgeError::Protocol(format!(
            "unexpected subscription response: {:?}",
            response.result
        )));
    }

    while let Some(value) = stream.next_value()? {
        if is_structural_event_value(&value) {
            // Refresh the snapshot cache in the background.
            let cache = state.snapshot_cache.clone();
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                handle.spawn(async move { cache.on_structural_event().await });
            }
            if resubscribe_tx.send(()).is_err() {
                return Ok(());
            }
        }
    }
    Err(BridgeError::Protocol(
        "activity structural subscription ended".to_string(),
    ))
}

/// Poll-based activity watcher: instead of subscribing to per-pane agent status
/// events (which forces the daemon to synchronously write to subscription streams
/// and causes IPC contention during pane switches), we periodically poll the pane
/// list and diff agent_status fields. The structural watcher still signals us on
/// pane set changes so we re-poll immediately when panes are created or closed.
fn run_agent_activity_poll(
    state: &BridgeState,
    resubscribe_rx: &mpsc::Receiver<()>,
) -> Result<(), BridgeError> {
    drain_resubscribe_signals(resubscribe_rx);
    let mut prev_panes = current_panes(&state.api)?;
    observe_agent_activity_snapshot(state, &prev_panes);
    let mut prev_pane_ids = sorted_pane_ids(&prev_panes);
    if prev_pane_ids.is_empty() {
        wait_for_resubscribe_signal(resubscribe_rx)?;
        return Ok(());
    }

    loop {
        // Wait for either the poll interval to elapse or a structural change signal.
        match resubscribe_rx.recv_timeout(ACTIVITY_POLL_INTERVAL) {
            Ok(()) => {
                // Structural change — drain any additional signals and re-poll.
                drain_resubscribe_signals(resubscribe_rx);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // Normal poll interval elapsed.
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(BridgeError::Protocol(
                    "activity resubscribe channel closed".to_string(),
                ));
            }
        }

        if state.ws_client_count.load(Ordering::Relaxed) == 0 {
            return Ok(());
        }

        let next_panes = current_panes(&state.api)?;
        let next_pane_ids = sorted_pane_ids(&next_panes);

        // If the pane set changed, return Ok(()) so the outer loop re-enters and
        // we start fresh with the new set.
        if next_pane_ids != prev_pane_ids {
            observe_agent_activity_snapshot(state, &next_panes);
            return Ok(());
        }

        // Diff agent status for each pane and emit activity messages for changes.
        diff_and_emit_activity(state, &prev_panes, &next_panes);
        observe_agent_activity_snapshot(state, &next_panes);

        prev_panes = next_panes;
        prev_pane_ids = next_pane_ids;
    }
}

/// Compare previous and current pane snapshots and emit ActivityMessages for any
/// panes whose agent_status (or related fields) changed.
fn diff_and_emit_activity(state: &BridgeState, prev: &[PaneInfo], next: &[PaneInfo]) {
    let prev_map: HashMap<&str, &PaneInfo> =
        prev.iter().map(|p| (p.pane_id.as_str(), p)).collect();
    for pane in next {
        let changed = match prev_map.get(pane.pane_id.as_str()) {
            Some(prev_pane) => {
                pane.agent_status != prev_pane.agent_status
                    || pane.agent != prev_pane.agent
                    || pane.title != prev_pane.title
                    || pane.display_agent != prev_pane.display_agent
                    || pane.custom_status != prev_pane.custom_status
                    || pane.state_labels != prev_pane.state_labels
            }
            None => true, // new pane, treat as changed
        };
        if changed {
            if state
                .agent_activity
                .observe_status_event(&pane.pane_id, pane.agent_status)
            {
                broadcast_agent_activity_changed(state);
            }
            let message = ActivityMessage::PaneAgentStatusChanged {
                pane_id: pane.pane_id.clone(),
                workspace_id: pane.workspace_id.clone(),
                agent_status: pane.agent_status,
                agent: pane.agent.clone(),
                title: pane.title.clone(),
                display_agent: pane.display_agent.clone(),
                custom_status: pane.custom_status.clone(),
                state_labels: pane.state_labels.clone(),
            };
            let _ = state.activity_tx.send(message);
        }
    }
}

fn sorted_pane_ids(panes: &[PaneInfo]) -> Vec<String> {
    let mut pane_ids = panes
        .iter()
        .map(|pane| pane.pane_id.clone())
        .collect::<Vec<_>>();
    pane_ids.sort();
    pane_ids.dedup();
    pane_ids
}

#[cfg(test)]
fn activity_resubscribe_needed(current_pane_ids: &[String], next_panes: &[PaneInfo]) -> bool {
    sorted_pane_ids(next_panes) != current_pane_ids
}

fn wait_for_resubscribe_signal(resubscribe_rx: &mpsc::Receiver<()>) -> Result<(), BridgeError> {
    resubscribe_rx
        .recv()
        .map(|_| ())
        .map_err(|_| BridgeError::Protocol("activity resubscribe channel closed".to_string()))
}

#[cfg(test)]
fn activity_subscriptions(pane_ids: &[String]) -> Vec<Subscription> {
    let mut pane_ids = pane_ids.to_vec();
    pane_ids.sort();
    pane_ids.dedup();
    pane_ids
        .into_iter()
        .map(|pane_id| Subscription::PaneAgentStatusChanged {
            pane_id,
            agent_status: None,
        })
        .collect()
}

fn structural_event_subscriptions() -> Vec<Subscription> {
    vec![
        Subscription::WorkspaceCreated {},
        Subscription::WorkspaceUpdated {},
        Subscription::WorkspaceRenamed {},
        Subscription::WorkspaceClosed {},
        Subscription::WorkspaceFocused {},
        Subscription::WorktreeCreated {},
        Subscription::WorktreeOpened {},
        Subscription::WorktreeRemoved {},
        Subscription::TabCreated {},
        Subscription::TabClosed {},
        Subscription::TabFocused {},
        Subscription::TabRenamed {},
        Subscription::PaneCreated {},
        Subscription::PaneClosed {},
        Subscription::PaneFocused {},
        Subscription::PaneMoved {},
        Subscription::PaneExited {},
        Subscription::PaneAgentDetected {},
    ]
}

#[cfg(test)]
fn activity_message_from_subscription_value(value: serde_json::Value) -> Option<ActivityMessage> {
    use herdr_compat::api::schema::{
        SubscriptionEventData, SubscriptionEventEnvelope, SubscriptionEventKind,
    };
    let envelope: SubscriptionEventEnvelope = serde_json::from_value(value).ok()?;
    if envelope.event != SubscriptionEventKind::PaneAgentStatusChanged {
        return None;
    }
    let SubscriptionEventData::PaneAgentStatusChanged(event) = envelope.data else {
        return None;
    };
    Some(ActivityMessage::PaneAgentStatusChanged {
        pane_id: event.pane_id,
        workspace_id: event.workspace_id,
        agent_status: event.agent_status,
        agent: event.agent,
        title: event.title,
        display_agent: event.display_agent,
        custom_status: event.custom_status,
        state_labels: event.state_labels,
    })
}

fn is_structural_event_value(value: &serde_json::Value) -> bool {
    value
        .get("event")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|event| event != "pane.agent_status_changed")
}

fn drain_resubscribe_signals(resubscribe_rx: &mpsc::Receiver<()>) -> bool {
    let mut received = false;
    while resubscribe_rx.try_recv().is_ok() {
        received = true;
    }
    received
}

fn open_event_subscription(
    api: ApiClient,
) -> Result<tokio::sync::mpsc::UnboundedReceiver<String>, BridgeError> {
    let request = Request {
        id: "herdr-web:events".to_string(),
        method: Method::EventsSubscribe(EventsSubscribeParams {
            subscriptions: structural_event_subscriptions(),
        }),
    };
    let (ack, mut stream) = api.subscribe_value(&request, None)?;
    let response = herdr_compat::api::client::parse_response_value(ack)?;
    if !matches!(response.result, ResponseResult::SubscriptionStarted {}) {
        return Err(BridgeError::Protocol(format!(
            "unexpected subscription response: {:?}",
            response.result
        )));
    }

    let (event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
    thread::spawn(move || loop {
        match stream.next_value() {
            Ok(Some(event)) => {
                if event_tx.send(event.to_string()).is_err() {
                    break;
                }
            }
            Ok(None) => break,
            Err(err) => {
                let _ = event_tx.send(
                    serde_json::json!({
                        "type": "error",
                        "error": err.to_string(),
                    })
                    .to_string(),
                );
                break;
            }
        }
    });

    Ok(event_rx)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TerminalInputChunkStats {
    chunks: usize,
    max_chunk_bytes: usize,
}

fn send_terminal_input_chunks(
    write_tx: &tokio::sync::mpsc::UnboundedSender<ClientMessage>,
    data: &[u8],
) -> Result<TerminalInputChunkStats, String> {
    if data.is_empty() {
        write_tx
            .send(ClientMessage::Input { data: Vec::new() })
            .map_err(|_| "terminal writer closed".to_string())?;
        return Ok(TerminalInputChunkStats {
            chunks: 1,
            max_chunk_bytes: 0,
        });
    }

    let mut stats = TerminalInputChunkStats {
        chunks: 0,
        max_chunk_bytes: 0,
    };
    for chunk in data.chunks(MAX_TERMINAL_INPUT_CHUNK_BYTES) {
        stats.chunks += 1;
        stats.max_chunk_bytes = stats.max_chunk_bytes.max(chunk.len());
        write_tx
            .send(ClientMessage::Input {
                data: chunk.to_vec(),
            })
            .map_err(|_| "terminal writer closed".to_string())?;
    }
    Ok(stats)
}

fn handle_terminal_text_frame(
    write_tx: &tokio::sync::mpsc::UnboundedSender<ClientMessage>,
    text: &str,
) -> Result<(), String> {
    let frame = parse_terminal_client_frame(text)?;
    match frame {
        TerminalClientFrame::Input { data } => {
            send_terminal_input_chunks(write_tx, data.as_bytes())?;
            Ok(())
        }
        TerminalClientFrame::Resize {
            cols,
            rows,
            cell_width_px,
            cell_height_px,
        } => write_tx
            .send(ClientMessage::Resize {
                cols,
                rows,
                cell_width_px,
                cell_height_px,
            })
            .map(|_| ())
            .map_err(|_| "terminal writer closed".to_string()),
        TerminalClientFrame::Scroll { direction, lines } => write_tx
            .send(ClientMessage::AttachScroll {
                source: AttachScrollSource::Wheel,
                direction: match direction {
                    ScrollDirection::Up => AttachScrollDirection::Up,
                    ScrollDirection::Down => AttachScrollDirection::Down,
                },
                lines: lines.max(1),
                column: None,
                row: None,
                modifiers: 0,
            })
            .map(|_| ())
            .map_err(|_| "terminal writer closed".to_string()),
    }
}

fn parse_terminal_client_frame(text: &str) -> Result<TerminalClientFrame, String> {
    serde_json::from_str(text).map_err(|err| format!("invalid terminal frame: {err}"))
}

struct TerminalAttach {
    write_tx: tokio::sync::mpsc::UnboundedSender<ClientMessage>,
}

async fn open_terminal_attach(
    client_socket_path: PathBuf,
    terminal_id: String,
    cols: u16,
    rows: u16,
    takeover: bool,
    protocol_version: u32,
    output_tx: tokio::sync::broadcast::Sender<TerminalOutput>,
) -> Result<TerminalAttach, BridgeError> {
    use herdr_compat::protocol::async_wire::{async_read_message, async_write_message};

    let mut stream = tokio::net::UnixStream::connect(&client_socket_path)
        .await
        .map_err(BridgeError::Io)?;

    async_write_message(
        &mut stream,
        &ClientMessage::Hello {
            version: protocol_version,
            cols,
            rows,
            cell_width_px: 0,
            cell_height_px: 0,
            requested_encoding: RenderEncoding::TerminalAnsi,
            keybindings: ClientKeybindings::Server,
            launch_mode: ClientLaunchMode::TerminalAttach,
        },
    )
    .await
    .map_err(|err| BridgeError::Protocol(err.to_string()))?;

    let welcome: ServerMessage = async_read_message(&mut stream, MAX_FRAME_SIZE)
        .await
        .map_err(|err| BridgeError::Protocol(err.to_string()))?;
    match welcome {
        ServerMessage::Welcome { error: None, .. } => {}
        ServerMessage::Welcome {
            error: Some(error), ..
        } => return Err(BridgeError::Protocol(error)),
        other => {
            return Err(BridgeError::Protocol(format!(
                "expected welcome, got {other:?}"
            )))
        }
    }

    async_write_message(
        &mut stream,
        &ClientMessage::AttachTerminal {
            terminal_id,
            takeover,
        },
    )
    .await
    .map_err(|err| BridgeError::Protocol(err.to_string()))?;

    let (mut read_half, mut write_half) = stream.into_split();
    let (write_tx, mut write_rx) = tokio::sync::mpsc::unbounded_channel::<ClientMessage>();

    tokio::spawn(async move {
        while let Some(message) = write_rx.recv().await {
            if async_write_message(&mut write_half, &message).await.is_err() {
                break;
            }
        }
    });

    tokio::spawn(async move {
        loop {
            let message: ServerMessage =
                match async_read_message(&mut read_half, MAX_GRAPHICS_FRAME_SIZE).await {
                    Ok(message) => message,
                    Err(err) => {
                        let _ = output_tx.send(TerminalOutput::Close(err.to_string()));
                        break;
                    }
                };
            match message {
                ServerMessage::Terminal(frame) => {
                    let _ = output_tx.send(TerminalOutput::Bytes(Bytes::from(frame.bytes)));
                }
                ServerMessage::ServerShutdown { reason } => {
                    let _ = output_tx.send(TerminalOutput::Close(
                        reason.unwrap_or_else(|| "server shutdown".to_string()),
                    ));
                    break;
                }
                ServerMessage::Welcome { .. } => {}
                ServerMessage::Notify { .. }
                | ServerMessage::Clipboard { .. }
                | ServerMessage::WindowTitle { .. }
                | ServerMessage::ReloadSoundConfig
                | ServerMessage::MouseCapture { .. }
                | ServerMessage::Frame(_)
                | ServerMessage::Graphics { .. } => {}
            }
        }
    });

    Ok(TerminalAttach { write_tx })
}

fn terminal_attach_protocol(api: &ApiClient) -> Result<u32, BridgeError> {
    daemon_protocol_from_status(api.status_with_timeout(DAEMON_STATUS_TIMEOUT)?)
}

fn daemon_protocol_from_status(
    status: herdr_compat::api::RuntimeStatus,
) -> Result<u32, BridgeError> {
    let protocol = status.protocol.ok_or_else(|| {
        BridgeError::Protocol("Herdr daemon status did not include a protocol".to_string())
    })?;
    if supported_terminal_attach_protocol(protocol) {
        Ok(protocol)
    } else {
        Err(BridgeError::Protocol(unsupported_daemon_protocol_message(
            protocol,
        )))
    }
}

fn startup_daemon_protocol(api: &ApiClient) -> io::Result<u32> {
    terminal_attach_protocol(api).map_err(startup_daemon_error)
}

fn startup_daemon_error(err: BridgeError) -> io::Error {
    io::Error::new(
        ErrorKind::ConnectionRefused,
        format!(
            "unable to start herdr-web bridge: {err}. Start or update Herdr, then restart herdr-web-bridge."
        ),
    )
}

fn supported_terminal_attach_protocol(protocol: u32) -> bool {
    (MIN_TERMINAL_ATTACH_PROTOCOL..=PROTOCOL_VERSION).contains(&protocol)
}

fn unsupported_daemon_protocol_message(protocol: u32) -> String {
    if protocol < MIN_TERMINAL_ATTACH_PROTOCOL {
        format!(
            "Herdr daemon protocol {protocol} is too old for herdr-web; need protocol {MIN_TERMINAL_ATTACH_PROTOCOL} or newer"
        )
    } else {
        format!(
            "Herdr daemon protocol {protocol} is newer than this herdr-web bridge supports; need protocol {PROTOCOL_VERSION} or older"
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coalescer_sends_first_output_immediately() {
        let now = Instant::now();
        let mut coalescer = TerminalOutputCoalescer::new(terminal_output_coalesce_window(None));

        assert_eq!(
            coalescer.push_bytes(Bytes::from_static(b"first"), now),
            TerminalOutputCoalescingDecision::SendNow(Bytes::from_static(b"first"))
        );
        assert_eq!(
            coalescer.deadline(),
            Some(now + terminal_output_coalesce_window(None))
        );
        assert_eq!(coalescer.lifetime_stats.source_frames, 1);
        assert_eq!(coalescer.lifetime_stats.sent_frames, 1);
        assert_eq!(coalescer.lifetime_stats.immediate_frames, 1);
    }

    #[test]
    fn coalescer_can_disable_output_coalescing() {
        let now = Instant::now();
        let mut coalescer = TerminalOutputCoalescer::new(Duration::ZERO);

        assert_eq!(
            coalescer.push_bytes(Bytes::from_static(b"first"), now),
            TerminalOutputCoalescingDecision::SendNow(Bytes::from_static(b"first"))
        );
        assert_eq!(
            coalescer.push_bytes(Bytes::from_static(b"second"), now),
            TerminalOutputCoalescingDecision::SendNow(Bytes::from_static(b"second"))
        );
        assert_eq!(coalescer.deadline(), None);
        assert_eq!(coalescer.lifetime_stats.source_frames, 2);
        assert_eq!(coalescer.lifetime_stats.sent_frames, 2);
        assert_eq!(coalescer.lifetime_stats.coalesced_sent_frames, 0);
    }

    #[test]
    fn terminal_output_coalesce_window_defaults_and_clamps() {
        assert_eq!(
            terminal_output_coalesce_window(None),
            Duration::from_millis(DEFAULT_TERMINAL_OUTPUT_COALESCE_MS)
        );
        assert_eq!(terminal_output_coalesce_window(Some(0)), Duration::ZERO);
        assert_eq!(
            terminal_output_coalesce_window(Some(128)),
            Duration::from_millis(128)
        );
        assert_eq!(
            terminal_output_coalesce_window(Some(999)),
            Duration::from_millis(MAX_TERMINAL_OUTPUT_COALESCE_MS)
        );
    }

    #[test]
    fn coalescer_pends_output_inside_active_window() {
        let now = Instant::now();
        let mut coalescer = TerminalOutputCoalescer::new(terminal_output_coalesce_window(None));
        let _ = coalescer.push_bytes(Bytes::from_static(b"first"), now);

        assert_eq!(
            coalescer.push_bytes(Bytes::from_static(b"second"), now),
            TerminalOutputCoalescingDecision::Pending
        );
        assert_eq!(coalescer.pending_bytes, 6);
        assert_eq!(coalescer.pending.len(), 1);
        assert_eq!(coalescer.lifetime_stats.max_pending_bytes, 6);
        assert_eq!(coalescer.lifetime_stats.max_pending_chunks, 1);
    }

    #[test]
    fn coalescer_flushes_when_byte_threshold_is_reached() {
        let now = Instant::now();
        let mut coalescer = TerminalOutputCoalescer::new(terminal_output_coalesce_window(None));
        let _ = coalescer.push_bytes(Bytes::from_static(b"first"), now);

        let decision = coalescer.push_bytes(
            Bytes::from(vec![b'x'; TERMINAL_OUTPUT_COALESCE_MAX_BYTES]),
            now,
        );

        assert_eq!(
            decision,
            TerminalOutputCoalescingDecision::FlushPending(
                TerminalOutputFlushReason::ByteThreshold
            )
        );
        let flushed = coalescer
            .flush_pending(TerminalOutputFlushReason::ByteThreshold, now)
            .unwrap();
        assert_eq!(flushed.len(), TERMINAL_OUTPUT_COALESCE_MAX_BYTES);
        assert_eq!(coalescer.pending_bytes, 0);
        assert_eq!(coalescer.pending.len(), 0);
        assert_eq!(coalescer.lifetime_stats.byte_flushes, 1);
        assert_eq!(coalescer.lifetime_stats.coalesced_sent_frames, 1);
    }

    #[test]
    fn coalescer_deadline_returns_to_idle_when_nothing_pending() {
        let now = Instant::now();
        let mut coalescer = TerminalOutputCoalescer::new(terminal_output_coalesce_window(None));
        let _ = coalescer.push_bytes(Bytes::from_static(b"first"), now);

        assert_eq!(coalescer.handle_deadline(), None);
        assert_eq!(coalescer.deadline(), None);
    }

    #[test]
    fn coalescer_deadline_flushes_pending_and_rearms_window() {
        let now = Instant::now();
        let flush_at = now + terminal_output_coalesce_window(None);
        let mut coalescer = TerminalOutputCoalescer::new(terminal_output_coalesce_window(None));
        let _ = coalescer.push_bytes(Bytes::from_static(b"first"), now);
        let _ = coalescer.push_bytes(Bytes::from_static(b"second"), now);

        assert_eq!(
            coalescer.handle_deadline(),
            Some(TerminalOutputFlushReason::Timer)
        );
        assert_eq!(
            coalescer.flush_pending(TerminalOutputFlushReason::Timer, flush_at),
            Some(Bytes::from_static(b"second"))
        );
        assert_eq!(
            coalescer.deadline(),
            Some(flush_at + terminal_output_coalesce_window(None))
        );
        assert_eq!(coalescer.lifetime_stats.timer_flushes, 1);
    }

    #[test]
    fn coalescer_keeps_spaced_output_immediate() {
        let now = Instant::now();
        let mut coalescer = TerminalOutputCoalescer::new(terminal_output_coalesce_window(None));

        assert_eq!(
            coalescer.push_bytes(Bytes::from_static(b"one"), now),
            TerminalOutputCoalescingDecision::SendNow(Bytes::from_static(b"one"))
        );
        assert_eq!(coalescer.handle_deadline(), None);
        assert_eq!(
            coalescer.push_bytes(
                Bytes::from_static(b"two"),
                now + terminal_output_coalesce_window(None) + Duration::from_millis(1),
            ),
            TerminalOutputCoalescingDecision::SendNow(Bytes::from_static(b"two"))
        );
        assert_eq!(coalescer.handle_deadline(), None);
        assert_eq!(
            coalescer.push_bytes(
                Bytes::from_static(b"three"),
                now + terminal_output_coalesce_window(None) * 2 + Duration::from_millis(2),
            ),
            TerminalOutputCoalescingDecision::SendNow(Bytes::from_static(b"three"))
        );

        assert_eq!(coalescer.lifetime_stats.source_frames, 3);
        assert_eq!(coalescer.lifetime_stats.sent_frames, 3);
        assert_eq!(coalescer.lifetime_stats.immediate_frames, 3);
        assert_eq!(coalescer.lifetime_stats.coalesced_source_frames, 0);
        assert_eq!(coalescer.lifetime_stats.coalesced_sent_frames, 0);
        assert_eq!(coalescer.lifetime_stats.merged_flushes, 0);
    }

    #[test]
    fn coalescer_keeps_continuous_stream_in_active_window() {
        let now = Instant::now();
        let first_flush = now + terminal_output_coalesce_window(None);
        let second_flush = first_flush + terminal_output_coalesce_window(None);
        let mut coalescer = TerminalOutputCoalescer::new(terminal_output_coalesce_window(None));

        let _ = coalescer.push_bytes(Bytes::from_static(b"one"), now);
        let _ = coalescer.push_bytes(Bytes::from_static(b"two"), now + Duration::from_millis(1));
        let _ = coalescer.push_bytes(Bytes::from_static(b"three"), now + Duration::from_millis(2));
        assert_eq!(
            coalescer.handle_deadline(),
            Some(TerminalOutputFlushReason::Timer)
        );
        assert_eq!(
            coalescer.flush_pending(TerminalOutputFlushReason::Timer, first_flush),
            Some(Bytes::from_static(b"twothree"))
        );

        let _ = coalescer.push_bytes(
            Bytes::from_static(b"four"),
            first_flush + Duration::from_millis(1),
        );
        let _ = coalescer.push_bytes(
            Bytes::from_static(b"five"),
            first_flush + Duration::from_millis(2),
        );
        assert_eq!(
            coalescer.handle_deadline(),
            Some(TerminalOutputFlushReason::Timer)
        );
        assert_eq!(
            coalescer.flush_pending(TerminalOutputFlushReason::Timer, second_flush),
            Some(Bytes::from_static(b"fourfive"))
        );

        assert_eq!(coalescer.lifetime_stats.source_frames, 5);
        assert_eq!(coalescer.lifetime_stats.sent_frames, 3);
        assert_eq!(coalescer.lifetime_stats.immediate_frames, 1);
        assert_eq!(coalescer.lifetime_stats.coalesced_source_frames, 4);
        assert_eq!(coalescer.lifetime_stats.coalesced_sent_frames, 2);
        assert_eq!(coalescer.lifetime_stats.merged_flushes, 2);
    }

    #[test]
    fn draining_terminal_output_pending_preserves_order() {
        let mut pending = vec![
            Bytes::from_static(b"abc"),
            Bytes::from_static(b"def"),
            Bytes::from_static(b"ghi"),
        ];
        let mut pending_bytes = 9;

        assert_eq!(
            drain_terminal_output_pending(&mut pending, &mut pending_bytes),
            Some(Bytes::from_static(b"abcdefghi"))
        );
        assert!(pending.is_empty());
        assert_eq!(pending_bytes, 0);
    }

    #[test]
    fn coalescing_stats_derived_values_are_zero_safe() {
        let stats = TerminalOutputCoalescingStats::default();

        assert_eq!(stats.frames_saved(), 0);
        assert_eq!(stats.coalescing_ratio(), 0.0);
        assert_eq!(stats.avg_source_frame_bytes(), 0.0);
        assert_eq!(stats.avg_sent_frame_bytes(), 0.0);
        assert_eq!(stats.avg_flush_latency_us(), 0.0);
    }

    #[test]
    fn coalescing_stats_track_saved_frames_and_latency() {
        let mut stats = TerminalOutputCoalescingStats::default();

        stats.record_source(4);
        stats.record_source(6);
        stats.record_source(10);
        stats.record_immediate_send(4);
        stats.record_flush_reason(TerminalOutputFlushReason::Timer);
        stats.record_coalesced_send(2, 16, Duration::from_micros(800));

        assert_eq!(stats.sent_frames, 2);
        assert_eq!(stats.frames_saved(), 1);
        assert_eq!(stats.coalesced_source_frames, 2);
        assert_eq!(stats.merged_flushes, 1);
        assert_eq!(
            stats.sent_frames,
            stats.immediate_frames + stats.coalesced_sent_frames
        );
        assert_eq!(
            stats.source_frames,
            stats.immediate_frames + stats.coalesced_source_frames
        );
        assert_eq!(stats.coalescing_ratio(), 1.5);
        assert_eq!(stats.avg_flush_latency_us(), 800.0);
        assert_eq!(stats.avg_source_frame_bytes(), 20.0 / 3.0);
        assert_eq!(stats.avg_sent_frame_bytes(), 10.0);
    }

    #[test]
    fn parses_input_frame() {
        assert_eq!(
            parse_terminal_client_frame(r#"{"type":"input","data":"ls\n"}"#).unwrap(),
            TerminalClientFrame::Input {
                data: "ls\n".to_string()
            }
        );
    }

    #[test]
    fn chunks_terminal_input_below_daemon_limit() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let data = vec![b'x'; MAX_TERMINAL_INPUT_CHUNK_BYTES * 2 + 17];

        let stats = send_terminal_input_chunks(&tx, &data).unwrap();

        assert_eq!(
            stats,
            TerminalInputChunkStats {
                chunks: 3,
                max_chunk_bytes: MAX_TERMINAL_INPUT_CHUNK_BYTES
            }
        );
        let mut chunks: Vec<Vec<u8>> = Vec::new();
        while let Ok(message) = rx.try_recv() {
            match message {
                ClientMessage::Input { data } => chunks.push(data),
                other => panic!("unexpected terminal message: {other:?}"),
            }
        }
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].len(), MAX_TERMINAL_INPUT_CHUNK_BYTES);
        assert_eq!(chunks[1].len(), MAX_TERMINAL_INPUT_CHUNK_BYTES);
        assert_eq!(chunks[2].len(), 17);
        assert_eq!(chunks.concat(), data);
    }

    #[test]
    fn forwards_empty_terminal_input_as_one_message() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();

        let stats = send_terminal_input_chunks(&tx, &[]).unwrap();

        assert_eq!(
            stats,
            TerminalInputChunkStats {
                chunks: 1,
                max_chunk_bytes: 0
            }
        );
        assert_eq!(
            rx.try_recv().unwrap(),
            ClientMessage::Input { data: Vec::new() }
        );
    }

    #[test]
    fn parses_resize_frame_with_default_cell_size() {
        assert_eq!(
            parse_terminal_client_frame(r#"{"type":"resize","cols":100,"rows":40}"#).unwrap(),
            TerminalClientFrame::Resize {
                cols: 100,
                rows: 40,
                cell_width_px: 0,
                cell_height_px: 0
            }
        );
    }

    #[test]
    fn rejects_unknown_frame_type() {
        assert!(parse_terminal_client_frame(r#"{"type":"zoom"}"#).is_err());
    }

    #[test]
    fn parses_scroll_frame() {
        assert_eq!(
            parse_terminal_client_frame(r#"{"type":"scroll","direction":"up","lines":5}"#).unwrap(),
            TerminalClientFrame::Scroll {
                direction: ScrollDirection::Up,
                lines: 5
            }
        );
    }

    #[test]
    fn scroll_frame_defaults_lines() {
        assert_eq!(
            parse_terminal_client_frame(r#"{"type":"scroll","direction":"down"}"#).unwrap(),
            TerminalClientFrame::Scroll {
                direction: ScrollDirection::Down,
                lines: 3
            }
        );
    }

    #[test]
    fn command_allow_list_excludes_dangerous_methods() {
        assert!(ALLOWED_COMMANDS.contains(&"workspace.create"));
        assert!(ALLOWED_COMMANDS.contains(&"tab.close"));
        assert!(ALLOWED_COMMANDS.contains(&"pane.rename"));
        assert!(!ALLOWED_COMMANDS.contains(&"server.stop"));
        assert!(!ALLOWED_COMMANDS.contains(&"pane.send_keys"));
        assert!(ALLOWED_COMMANDS.contains(&"pane.send_input"));
        // pane.split is intentionally allowed so the web client can create splits.
        assert!(ALLOWED_COMMANDS.contains(&"pane.split"));
        assert!(ALLOWED_COMMANDS.contains(&"pane.focus_direction"));
        assert!(ALLOWED_COMMANDS.contains(&"pane.move"));
        assert!(ALLOWED_COMMANDS.contains(&"agent.start"));
    }

    #[test]
    fn activity_subscriptions_include_only_deduped_pane_activity() {
        let subscriptions = activity_subscriptions(&[
            "pane-2".to_string(),
            "pane-1".to_string(),
            "pane-2".to_string(),
        ]);

        let pane_subscriptions = subscriptions
            .iter()
            .filter_map(|subscription| match subscription {
                Subscription::PaneAgentStatusChanged {
                    pane_id,
                    agent_status,
                } => {
                    assert_eq!(*agent_status, None);
                    Some(pane_id.as_str())
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(pane_subscriptions, vec!["pane-1", "pane-2"]);
        assert_eq!(subscriptions.len(), pane_subscriptions.len());
    }

    #[test]
    fn activity_resubscribe_needed_compares_sorted_pane_sets() {
        let current = vec!["pane-1".to_string(), "pane-2".to_string()];

        assert!(!activity_resubscribe_needed(
            &current,
            &[test_pane("pane-2"), test_pane("pane-1")]
        ));
        assert!(activity_resubscribe_needed(
            &current,
            &[test_pane("pane-1"), test_pane("pane-3")]
        ));
        assert!(activity_resubscribe_needed(&current, &[]));
    }

    #[test]
    fn structural_subscriptions_are_separate_from_activity_subscriptions() {
        let subscriptions = structural_event_subscriptions();

        assert!(subscriptions
            .iter()
            .any(|subscription| matches!(subscription, Subscription::WorkspaceCreated {})));
        assert!(subscriptions
            .iter()
            .any(|subscription| matches!(subscription, Subscription::PaneMoved {})));
        assert!(!subscriptions.iter().any(|subscription| matches!(
            subscription,
            Subscription::PaneAgentStatusChanged { .. }
        )));
    }

    #[test]
    fn activity_message_decodes_and_serializes_explicit_nulls() {
        let message = activity_message_from_subscription_value(serde_json::json!({
            "event": "pane.agent_status_changed",
            "data": {
                "pane_id": "pane-1",
                "workspace_id": "workspace-1",
                "agent_status": "working",
                "agent": "codex",
                "state_labels": {}
            }
        }))
        .unwrap();

        assert_eq!(
            message,
            ActivityMessage::PaneAgentStatusChanged {
                pane_id: "pane-1".to_string(),
                workspace_id: "workspace-1".to_string(),
                agent_status: AgentStatus::Working,
                agent: Some("codex".to_string()),
                title: None,
                display_agent: None,
                custom_status: None,
                state_labels: HashMap::new(),
            }
        );

        let json = serde_json::to_value(&message).unwrap();
        assert_eq!(json["title"], serde_json::Value::Null);
        assert_eq!(json["display_agent"], serde_json::Value::Null);
        assert_eq!(json["custom_status"], serde_json::Value::Null);
        assert_eq!(json["state_labels"], serde_json::json!({}));
    }

    #[test]
    fn structural_event_values_trigger_activity_resubscribe() {
        assert!(is_structural_event_value(&serde_json::json!({
            "event": "pane.created",
            "data": { "pane_id": "pane-1" }
        })));
        assert!(!is_structural_event_value(&serde_json::json!({
            "event": "pane.agent_status_changed",
            "data": { "pane_id": "pane-1" }
        })));
    }

    fn test_pane(pane_id: &str) -> PaneInfo {
        PaneInfo {
            pane_id: pane_id.to_string(),
            terminal_id: format!("terminal-{pane_id}"),
            workspace_id: "workspace-1".to_string(),
            tab_id: "tab-1".to_string(),
            focused: false,
            cwd: None,
            foreground_cwd: None,
            label: None,
            agent: None,
            title: None,
            display_agent: None,
            agent_status: AgentStatus::Idle,
            custom_status: None,
            state_labels: HashMap::new(),
            agent_session: None,
            revision: 1,
        }
    }

    #[test]
    fn request_gate_allows_same_origin_and_loopback_dev_proxy() {
        let policy = test_policy("127.0.0.1", 8787);
        assert!(request_allowed(
            &origin_headers("127.0.0.1:8787", None),
            &policy
        ));
        assert!(request_allowed(
            &origin_headers("127.0.0.1:8787", Some("http://127.0.0.1:8787")),
            &policy
        ));
        assert!(request_allowed(
            &origin_headers("127.0.0.1:5173", Some("http://127.0.0.1:5173")),
            &policy
        ));
    }

    #[test]
    fn request_gate_rejects_dns_rebinding_hosts() {
        let policy = test_policy("0.0.0.0", 4000);
        assert!(!request_allowed(
            &origin_headers("evil.example:4000", Some("http://evil.example:4000")),
            &policy
        ));
        assert!(request_allowed(
            &origin_headers("192.168.1.10:4000", Some("http://192.168.1.10:4000")),
            &policy
        ));
        assert!(!request_allowed(
            &origin_headers("192.168.1.10:8787", Some("http://192.168.1.10:8787")),
            &policy
        ));
    }

    #[test]
    fn request_gate_rejects_cross_site_browser_origins() {
        let policy = test_policy("127.0.0.1", 8787);
        assert!(!request_allowed(
            &origin_headers("127.0.0.1:8787", Some("https://example.com")),
            &policy
        ));
        assert!(!request_allowed(
            &origin_headers("192.168.1.10:8787", Some("http://127.0.0.1:5173")),
            &policy
        ));
        assert!(!request_allowed(
            &origin_headers("127.0.0.1:8787", Some("null")),
            &policy
        ));
    }

    #[test]
    fn request_gate_allows_configured_android_origin() {
        let policy = RequestPolicy {
            bind_host: "0.0.0.0".to_string(),
            bind_port: 4000,
            allowed_hosts: Vec::new(),
            allowed_origins: vec!["http://localhost".to_string()],
            allowed_connect_sources: Vec::new(),
        };
        assert!(request_allowed(
            &origin_headers("192.168.1.10:4000", Some("http://localhost")),
            &policy
        ));
        assert!(!request_allowed(
            &origin_headers("192.168.1.10:4000", Some("https://example.com")),
            &policy
        ));
    }

    #[test]
    fn origin_gate_allows_same_origin_and_loopback_dev_proxy() {
        let policy = test_policy("127.0.0.1", 8787);
        assert!(request_origin_allowed(
            &origin_headers("127.0.0.1:8787", None),
            &policy
        ));
        assert!(request_origin_allowed(
            &origin_headers("127.0.0.1:8787", Some("http://127.0.0.1:8787")),
            &policy
        ));
        assert!(request_origin_allowed(
            &origin_headers("127.0.0.1:8787", Some("http://127.0.0.1:5173")),
            &policy
        ));
    }

    #[test]
    fn origin_gate_rejects_cross_site_browser_origins() {
        let policy = test_policy("127.0.0.1", 8787);
        assert!(!request_origin_allowed(
            &origin_headers("127.0.0.1:8787", Some("https://example.com")),
            &policy
        ));
        assert!(!request_origin_allowed(
            &origin_headers("192.168.1.10:8787", Some("http://127.0.0.1:5173")),
            &policy
        ));
        assert!(!request_origin_allowed(
            &origin_headers("127.0.0.1:8787", Some("null")),
            &policy
        ));
    }

    #[test]
    fn host_gate_accepts_exact_loopback_and_ip_literal_binds() {
        let loopback = test_policy("127.0.0.1", 8787);
        assert!(host_authority_allowed("localhost:5173", &loopback));
        assert!(host_authority_allowed("127.0.0.1:8787", &loopback));
        assert!(!host_authority_allowed("127.0.0.2:8787", &loopback));

        let lan = test_policy("0.0.0.0", 4000);
        assert!(host_authority_allowed("192.168.1.10:4000", &lan));
        assert!(host_authority_allowed("[::1]:5173", &lan));
        assert!(!host_authority_allowed("evil.example:4000", &lan));
    }

    #[test]
    fn host_gate_accepts_configured_hostname_only_on_bridge_port() {
        let policy = RequestPolicy {
            bind_host: "0.0.0.0".to_string(),
            bind_port: 4000,
            allowed_hosts: vec!["herdr-host.local".to_string()],
            allowed_origins: Vec::new(),
            allowed_connect_sources: Vec::new(),
        };
        assert!(host_authority_allowed("herdr-host.local:4000", &policy));
        assert!(host_authority_allowed("HERDR-HOST.LOCAL:4000", &policy));
        assert!(!host_authority_allowed("herdr-host.local:8787", &policy));
        assert!(!host_authority_allowed("evil.example:4000", &policy));
    }

    #[test]
    fn cors_headers_reflect_only_allowed_origins() {
        let policy = RequestPolicy {
            bind_host: "0.0.0.0".to_string(),
            bind_port: 4000,
            allowed_hosts: Vec::new(),
            allowed_origins: vec!["http://localhost".to_string()],
            allowed_connect_sources: Vec::new(),
        };
        assert_eq!(
            cors_origin_header(
                &origin_headers("192.168.1.10:4000", Some("http://localhost")),
                &policy
            )
            .and_then(|value| value.to_str().ok().map(str::to_string)),
            Some("http://localhost".to_string())
        );
        assert!(cors_origin_header(
            &origin_headers("192.168.1.10:4000", Some("https://example.com")),
            &policy
        )
        .is_none());
    }

    #[test]
    fn cors_headers_preserve_preflight_requested_headers() {
        let mut headers = HeaderMap::new();
        headers.insert(
            ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("content-type, authorization"),
        );

        insert_cors_headers(&mut headers, HeaderValue::from_static("http://localhost"));

        assert_eq!(
            headers
                .get(ACCESS_CONTROL_ALLOW_HEADERS)
                .and_then(|value| value.to_str().ok()),
            Some("content-type, authorization")
        );
    }

    #[test]
    fn connect_origins_expand_to_http_and_websocket_csp_sources() {
        assert_eq!(
            connect_sources_for_origin("HTTP://SRV:8787").unwrap(),
            vec!["http://srv:8787".to_string(), "ws://srv:8787".to_string()]
        );
        assert_eq!(
            connect_sources_for_origin("https://srv.example:9443").unwrap(),
            vec![
                "https://srv.example:9443".to_string(),
                "wss://srv.example:9443".to_string()
            ]
        );
        assert!(connect_sources_for_origin("ws://srv:8787").is_err());
        assert!(connect_sources_for_origin("http://srv:8787/path").is_err());
    }

    #[test]
    fn content_security_policy_includes_configured_connect_sources() {
        let mut policy = test_policy("0.0.0.0", 8787);
        policy.allowed_connect_sources = connect_sources_for_origin("http://srv:8787").unwrap();

        let header = content_security_policy(&policy);
        let value = header.to_str().unwrap();

        assert!(value.contains("connect-src 'self' data: http://srv:8787 ws://srv:8787;"));
        assert!(value.contains("frame-ancestors 'none'"));
    }

    #[test]
    fn validates_narrow_agent_start_commands() {
        let request: Request = serde_json::from_value(serde_json::json!({
            "id": "test",
            "method": "agent.start",
            "params": {
                "name": "Codex 2",
                "tab_id": "1-1",
                "split": "right",
                "focus": true,
                "argv": ["codex"]
            }
        }))
        .unwrap();
        assert!(validate_web_command(&request.method).is_ok());

        let request: Request = serde_json::from_value(serde_json::json!({
            "id": "test",
            "method": "agent.start",
            "params": {
                "name": "server",
                "tab_id": "1-1",
                "split": "right",
                "focus": true,
                "argv": ["sh", "-c", "date"],
                "env": { "X": "1" }
            }
        }))
        .unwrap();
        assert!(validate_web_command(&request.method).is_err());
    }

    #[test]
    fn validates_narrow_workspace_and_tab_create_commands() {
        let request: Request = serde_json::from_value(serde_json::json!({
            "id": "test",
            "method": "workspace.create",
            "params": {
                "focus": true
            }
        }))
        .unwrap();
        assert!(validate_web_command(&request.method).is_ok());

        let request: Request = serde_json::from_value(serde_json::json!({
            "id": "test",
            "method": "workspace.create",
            "params": {
                "focus": true,
                "cwd": "/tmp",
                "env": { "X": "1" }
            }
        }))
        .unwrap();
        assert!(validate_web_command(&request.method).is_err());

        let request: Request = serde_json::from_value(serde_json::json!({
            "id": "test",
            "method": "tab.create",
            "params": {
                "workspace_id": "w1",
                "focus": true,
                "label": "Codex"
            }
        }))
        .unwrap();
        assert!(validate_web_command(&request.method).is_ok());

        let request: Request = serde_json::from_value(serde_json::json!({
            "id": "test",
            "method": "tab.create",
            "params": {
                "workspace_id": "w1",
                "focus": true,
                "cwd": "/tmp",
                "env": { "X": "1" }
            }
        }))
        .unwrap();
        assert!(validate_web_command(&request.method).is_err());
    }

    #[test]
    fn validates_narrow_workspace_and_tab_rename_commands() {
        let request: Request = serde_json::from_value(serde_json::json!({
            "id": "test",
            "method": "workspace.rename",
            "params": {
                "workspace_id": "w1",
                "label": null
            }
        }))
        .unwrap();
        assert!(validate_web_command(&request.method).is_ok());

        let request: Request = serde_json::from_value(serde_json::json!({
            "id": "test",
            "method": "tab.rename",
            "params": {
                "tab_id": "w1:t1",
                "label": "Review"
            }
        }))
        .unwrap();
        assert!(validate_web_command(&request.method).is_ok());

        let request: Request = serde_json::from_value(serde_json::json!({
            "id": "test",
            "method": "tab.rename",
            "params": {
                "tab_id": "w1:t1",
                "label": "   "
            }
        }))
        .unwrap();
        assert!(validate_web_command(&request.method).is_err());
    }

    #[test]
    fn validates_narrow_pane_launch_commands() {
        let request: Request = serde_json::from_value(serde_json::json!({
            "id": "test",
            "method": "pane.send_input",
            "params": {
                "pane_id": "1-1",
                "text": "claude",
                "keys": ["Enter"]
            }
        }))
        .unwrap();
        assert!(validate_web_command(&request.method).is_ok());

        let request: Request = serde_json::from_value(serde_json::json!({
            "id": "test",
            "method": "pane.send_input",
            "params": {
                "pane_id": "1-1",
                "text": "rm -rf /tmp/nope",
                "keys": ["Enter"]
            }
        }))
        .unwrap();
        assert!(validate_web_command(&request.method).is_err());
    }

    #[test]
    fn validates_narrow_pane_splits() {
        let request: Request = serde_json::from_value(serde_json::json!({
            "id": "test",
            "method": "pane.split",
            "params": {
                "target_pane_id": "1-1",
                "direction": "down",
                "focus": true
            }
        }))
        .unwrap();
        assert!(validate_web_command(&request.method).is_ok());

        let request: Request = serde_json::from_value(serde_json::json!({
            "id": "test",
            "method": "pane.split",
            "params": {
                "target_pane_id": "1-1",
                "direction": "down",
                "cwd": "/tmp",
                "env": { "X": "1" }
            }
        }))
        .unwrap();
        assert!(validate_web_command(&request.method).is_err());
    }

    #[test]
    fn validates_narrow_pane_moves() {
        let request: Request = serde_json::from_value(serde_json::json!({
            "id": "test",
            "method": "pane.move",
            "params": {
                "pane_id": "w1:p1",
                "destination": {
                    "type": "new_tab",
                    "workspace_id": "w1",
                    "label": "Moved"
                },
                "focus": true
            }
        }))
        .unwrap();
        assert!(validate_web_command(&request.method).is_ok());

        let request: Request = serde_json::from_value(serde_json::json!({
            "id": "test",
            "method": "pane.move",
            "params": {
                "pane_id": "w1:p1",
                "destination": {
                    "type": "new_workspace",
                    "label": "Moved",
                    "tab_label": "Pane"
                },
                "focus": true
            }
        }))
        .unwrap();
        assert!(validate_web_command(&request.method).is_ok());

        let request: Request = serde_json::from_value(serde_json::json!({
            "id": "test",
            "method": "pane.move",
            "params": {
                "pane_id": "w1:p1",
                "destination": {
                    "type": "tab",
                    "tab_id": "w1:t2",
                    "target_pane_id": "w1:p2",
                    "split": "right"
                },
                "focus": true
            }
        }))
        .unwrap();
        assert!(validate_web_command(&request.method).is_err());

        let request: Request = serde_json::from_value(serde_json::json!({
            "id": "test",
            "method": "pane.move",
            "params": {
                "pane_id": "w1:p1",
                "destination": {
                    "type": "new_tab",
                    "workspace_id": "w1"
                },
                "focus": false
            }
        }))
        .unwrap();
        assert!(validate_web_command(&request.method).is_err());
    }

    #[test]
    fn command_request_parses_into_wire_request() {
        let body: CommandRequest = serde_json::from_str(
            r#"{"method":"workspace.rename","params":{"workspace_id":"w1","label":"api"}}"#,
        )
        .unwrap();
        let request_value = serde_json::json!({
            "id": "test",
            "method": body.method,
            "params": body.params,
        });
        let request: Request = serde_json::from_value(request_value).unwrap();
        assert!(matches!(request.method, Method::WorkspaceRename(_)));
    }

    #[test]
    fn loopback_host_detection_warns_for_network_binds() {
        assert!(is_loopback_bind_host("127.0.0.1"));
        assert!(is_loopback_bind_host("localhost"));
        assert!(!is_loopback_bind_host("0.0.0.0"));
        assert!(!is_loopback_bind_host("192.168.1.10"));
    }

    #[test]
    fn terminal_attach_protocol_supports_current_and_latest_release_protocols() {
        assert!(supported_terminal_attach_protocol(PROTOCOL_VERSION));
        assert!(supported_terminal_attach_protocol(13));
        assert!(!supported_terminal_attach_protocol(12));
        assert!(!supported_terminal_attach_protocol(PROTOCOL_VERSION + 1));
    }

    #[test]
    fn daemon_status_protocol_accepts_supported_range() {
        assert_eq!(daemon_protocol_from_status(runtime_status(13)).unwrap(), 13);
        assert_eq!(
            daemon_protocol_from_status(runtime_status(PROTOCOL_VERSION)).unwrap(),
            PROTOCOL_VERSION
        );
    }

    #[test]
    fn daemon_status_protocol_rejects_defensive_missing_protocol() {
        let missing = herdr_compat::api::RuntimeStatus {
            version: Some("0.7.0".to_string()),
            protocol: None,
            capabilities: None,
        };
        assert!(daemon_protocol_from_status(missing)
            .unwrap_err()
            .to_string()
            .contains("did not include a protocol"));
    }

    #[test]
    fn daemon_status_protocol_rejects_unsupported_protocols() {
        assert!(
            daemon_protocol_from_status(runtime_status(MIN_TERMINAL_ATTACH_PROTOCOL - 1))
                .unwrap_err()
                .to_string()
                .contains("too old")
        );

        assert!(
            daemon_protocol_from_status(runtime_status(PROTOCOL_VERSION + 1))
                .unwrap_err()
                .to_string()
                .contains("newer")
        );
    }

    #[test]
    fn startup_daemon_error_maps_reachable_status_failures_to_actionable_io_error() {
        let err = BridgeError::from(ApiClientError::UnexpectedResult(
            "WorkspaceList".to_string(),
        ));
        let io_err = startup_daemon_error(err);

        assert_eq!(io_err.kind(), ErrorKind::ConnectionRefused);
        let message = io_err.to_string();
        assert!(message.contains("unable to start herdr-web bridge"));
        assert!(message.contains("unexpected api result"));
        assert!(message.contains("Start or update Herdr"));
        assert!(message.contains("restart herdr-web-bridge"));
    }

    #[test]
    fn help_text_is_bridge_specific() {
        let help = help_text();

        assert!(help.contains("herdr-web-bridge"));
        assert!(help.contains("Usage: herdr-web-bridge"));
        assert!(help.contains("--session NAME"));
        assert!(!help.contains("herdr web-bridge"));
    }

    #[test]
    fn parse_options_configures_explicit_session() {
        let _guard = crate::session::TEST_ENV_LOCK.lock().unwrap();
        let previous_session = std::env::var(crate::session::SESSION_ENV_VAR).ok();
        let previous_socket = std::env::var(herdr_compat::api::SOCKET_PATH_ENV_VAR).ok();

        std::env::set_var(
            herdr_compat::api::SOCKET_PATH_ENV_VAR,
            "/tmp/ignored-herdr.sock",
        );
        let args = vec!["--session".to_string(), "work".to_string()];
        let options = parse_options(&args).unwrap().unwrap();

        assert_eq!(options.port, DEFAULT_PORT);
        assert!(crate::session::explicit_session_requested());
        assert!(crate::session::active_api_socket_path().ends_with("sessions/work/herdr.sock"));

        restore_env(crate::session::SESSION_ENV_VAR, previous_session);
        restore_env(herdr_compat::api::SOCKET_PATH_ENV_VAR, previous_socket);
        crate::session::clear_explicit_session_for_test();
    }

    fn restore_env(name: &str, value: Option<String>) {
        match value {
            Some(value) => std::env::set_var(name, value),
            None => std::env::remove_var(name),
        }
    }

    fn runtime_status(protocol: u32) -> herdr_compat::api::RuntimeStatus {
        herdr_compat::api::RuntimeStatus {
            version: Some("0.7.0".to_string()),
            protocol: Some(protocol),
            capabilities: None,
        }
    }

    #[test]
    fn upload_file_name_sanitization_uses_basename() {
        assert_eq!(
            sanitize_upload_file_name("../../screen shot.png").as_deref(),
            Some("screen shot.png")
        );
        assert_eq!(
            sanitize_upload_file_name(r"..\notes.txt").as_deref(),
            Some("notes.txt")
        );
        assert_eq!(sanitize_upload_file_name(".."), None);
        assert_eq!(sanitize_upload_file_name(""), None);
    }

    #[test]
    fn upload_file_name_sanitization_rechecks_truncated_name() {
        let name = format!("{}.", "a".repeat(180));
        let expected = "a".repeat(180);
        assert_eq!(
            sanitize_upload_file_name(&name).as_deref(),
            Some(expected.as_str())
        );
        let dots = ".".repeat(181);
        assert_eq!(sanitize_upload_file_name(&dots), None);
    }

    #[test]
    fn upload_extension_comes_from_mime() {
        assert_eq!(upload_extension_for_mime(Some("image/png")), Some("png"));
        assert_eq!(
            upload_extension_for_mime(Some("image/jpeg; charset=binary")),
            Some("jpg")
        );
        assert_eq!(
            upload_extension_for_mime(Some("application/octet-stream")),
            None
        );
    }

    #[test]
    fn upload_child_check_rejects_nested_paths() {
        let parent = PathBuf::from("/tmp/herdr-web/uploads");
        assert!(is_direct_child(&parent, &parent.join("file.png")));
        assert!(!is_direct_child(&parent, &parent.join("nested/file.png")));
    }

    fn origin_headers(host: &str, origin: Option<&str>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(HOST, host.parse().unwrap());
        if let Some(origin) = origin {
            headers.insert(ORIGIN, origin.parse().unwrap());
        }
        headers
    }

    fn test_policy(bind_host: &str, bind_port: u16) -> RequestPolicy {
        RequestPolicy {
            bind_host: bind_host.to_string(),
            bind_port,
            allowed_hosts: Vec::new(),
            allowed_origins: Vec::new(),
            allowed_connect_sources: Vec::new(),
        }
    }
}
