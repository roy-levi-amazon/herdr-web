//! Herdr runtime status compatibility surface.
//!
//! Source reference: `vendor/herdr/src/api/status.rs` at the vendored Herdr
//! snapshot tracked by this repository. This bridge-owned copy keeps only the
//! status shape consumed by startup and terminal-attach protocol checks.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeStatus {
    pub version: Option<String>,
    pub protocol: Option<u32>,
    pub capabilities: Option<crate::api::schema::ServerCapabilities>,
}
