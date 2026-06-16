//! Herdr runtime status compatibility surface.
//!
//! Source reference: upstream Herdr `src/api/status.rs`.
//!
//! This compatibility copy keeps only the status shape consumed by startup and
//! terminal-attach protocol checks.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeStatus {
    pub version: Option<String>,
    pub protocol: Option<u32>,
    pub capabilities: Option<crate::api::schema::ServerCapabilities>,
}
