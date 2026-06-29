use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;

use herdr_compat::api::client::ApiClient;
use herdr_compat::api::schema::{
    EmptyParams, Method, PaneInfo, PaneListParams, Request, ResponseResult, TabInfo, TabListParams,
    WorkspaceInfo,
};
use crate::web_bridge::BridgeError;

/// In-memory materialized view of workspace/tab/pane state.
///
/// Seeded on startup and refreshed whenever a structural daemon event arrives.
/// Snapshot requests read from memory instead of making IPC calls.
pub struct SnapshotCache {
    state: RwLock<CachedSnapshot>,
    api: ApiClient,
    version: AtomicU64,
}

#[derive(Clone)]
pub struct CachedSnapshot {
    pub workspaces: Vec<WorkspaceInfo>,
    pub tabs: Vec<TabInfo>,
    pub panes: Vec<PaneInfo>,
}

impl CachedSnapshot {
    fn empty() -> Self {
        Self {
            workspaces: Vec::new(),
            tabs: Vec::new(),
            panes: Vec::new(),
        }
    }
}

fn api_request(api: &ApiClient, id: &str, method: Method) -> Result<ResponseResult, BridgeError> {
    Ok(api
        .request(Request {
            id: id.to_string(),
            method,
        })?
        .result)
}

impl SnapshotCache {
    pub fn new(api: ApiClient) -> Self {
        Self {
            state: RwLock::new(CachedSnapshot::empty()),
            api,
            version: AtomicU64::new(0),
        }
    }

    /// Seed or refresh from daemon. Called on startup and on structural events.
    pub async fn refresh(&self) -> Result<(), BridgeError> {
        let api_w = self.api.clone();
        let api_t = self.api.clone();
        let api_p = self.api.clone();

        let (workspaces_result, tabs_result, panes_result) = tokio::join!(
            tokio::task::spawn_blocking(move || -> Result<Vec<WorkspaceInfo>, BridgeError> {
                match api_request(
                    &api_w,
                    "herdr-web:snapshot-cache:workspace-list",
                    Method::WorkspaceList(EmptyParams::default()),
                )? {
                    ResponseResult::WorkspaceList { workspaces } => Ok(workspaces),
                    other => Err(BridgeError::Protocol(format!(
                        "unexpected response: {other:?}"
                    ))),
                }
            }),
            tokio::task::spawn_blocking(move || -> Result<Vec<TabInfo>, BridgeError> {
                match api_request(
                    &api_t,
                    "herdr-web:snapshot-cache:tab-list",
                    Method::TabList(TabListParams::default()),
                )? {
                    ResponseResult::TabList { tabs } => Ok(tabs),
                    other => Err(BridgeError::Protocol(format!(
                        "unexpected response: {other:?}"
                    ))),
                }
            }),
            tokio::task::spawn_blocking(move || -> Result<Vec<PaneInfo>, BridgeError> {
                match api_request(
                    &api_p,
                    "herdr-web:snapshot-cache:pane-list",
                    Method::PaneList(PaneListParams::default()),
                )? {
                    ResponseResult::PaneList { panes } => Ok(panes),
                    other => Err(BridgeError::Protocol(format!(
                        "unexpected response: {other:?}"
                    ))),
                }
            }),
        );

        let workspaces: Vec<WorkspaceInfo> = workspaces_result
            .map_err(|err| BridgeError::Protocol(err.to_string()))??;
        let tabs: Vec<TabInfo> = tabs_result
            .map_err(|err| BridgeError::Protocol(err.to_string()))??;
        let panes: Vec<PaneInfo> = panes_result
            .map_err(|err| BridgeError::Protocol(err.to_string()))??;

        {
            let mut state = self.state.write().unwrap_or_else(|e| e.into_inner());
            *state = CachedSnapshot {
                workspaces,
                tabs,
                panes,
            };
        }
        self.version.fetch_add(1, Ordering::Release);
        Ok(())
    }

    /// Get current cached state. Returns empty snapshot if never seeded.
    pub fn snapshot(&self) -> CachedSnapshot {
        self.state.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Get cached panes (used by activity, pins, notes handlers).
    pub fn panes(&self) -> Vec<PaneInfo> {
        self.state
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .panes
            .clone()
    }

    /// Current version (for ETags / change detection).
    #[allow(dead_code)]
    pub fn version(&self) -> u64 {
        self.version.load(Ordering::Acquire)
    }

    /// Call when a structural event arrives. For now, triggers a refresh.
    pub async fn on_structural_event(&self) {
        if let Err(err) = self.refresh().await {
            tracing::warn!(error = %err, "snapshot cache refresh failed on structural event");
        }
    }
}
