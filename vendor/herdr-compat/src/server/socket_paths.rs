//! Herdr daemon/client socket path compatibility helpers.
//!
//! Source reference: upstream Herdr `src/server/socket_paths.rs`.
//!
//! This compatibility copy keeps only client socket derivation used by terminal
//! attach. The bridge executable owns session and environment resolution.

use std::path::{Path, PathBuf};

/// Legacy environment variable for overriding the client socket path.
///
/// Contractual override behavior for auto-detect uses `HERDR_SOCKET_PATH`.
/// This variable is kept as a fallback for callers that explicitly need a
/// client-only override when `HERDR_SOCKET_PATH` is not set.
pub const CLIENT_SOCKET_PATH_ENV_VAR: &str = "HERDR_CLIENT_SOCKET_PATH";

pub fn client_socket_path_from_overrides(
    api_socket_override: Option<&str>,
    client_socket_override: Option<&str>,
    default_client_socket_path: PathBuf,
) -> PathBuf {
    if let Some(api_socket_override) = api_socket_override {
        return derive_client_socket_from_api_socket(Path::new(api_socket_override));
    }

    if let Some(client_socket_override) = client_socket_override {
        return PathBuf::from(client_socket_override);
    }

    default_client_socket_path
}

pub(crate) fn derive_client_socket_from_api_socket(api_socket_path: &Path) -> PathBuf {
    let stem = api_socket_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("herdr");
    let parent = api_socket_path.parent().unwrap_or_else(|| Path::new(""));
    parent.join(format!("{stem}-client.sock"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_socket_path_derived_from_api_socket_override() {
        let path = client_socket_path_from_overrides(
            Some("/tmp/test-herdr.sock"),
            None,
            PathBuf::from("/tmp/default-client.sock"),
        );
        assert_eq!(path, PathBuf::from("/tmp/test-herdr-client.sock"));
    }

    #[test]
    fn client_socket_path_api_override_takes_precedence_over_legacy_client_override() {
        let path = client_socket_path_from_overrides(
            Some("/tmp/test-herdr.sock"),
            Some("/tmp/legacy-client.sock"),
            PathBuf::from("/tmp/default-client.sock"),
        );
        assert_eq!(path, PathBuf::from("/tmp/test-herdr-client.sock"));
    }

    #[test]
    fn client_socket_path_respects_legacy_client_override_without_api_override() {
        let path = client_socket_path_from_overrides(
            None,
            Some("/tmp/test-herdr-client.sock"),
            PathBuf::from("/tmp/default-client.sock"),
        );
        assert_eq!(path, PathBuf::from("/tmp/test-herdr-client.sock"));
    }

    #[test]
    fn client_socket_path_uses_supplied_default() {
        let default = PathBuf::from("/tmp/default-client.sock");
        let path = client_socket_path_from_overrides(None, None, default.clone());
        assert_eq!(path, default);
    }

    #[test]
    fn derive_client_socket_from_api_socket_without_sock_extension() {
        let derived = derive_client_socket_from_api_socket(Path::new("/tmp/custom-api"));
        assert_eq!(derived, PathBuf::from("/tmp/custom-api-client.sock"));
    }
}
