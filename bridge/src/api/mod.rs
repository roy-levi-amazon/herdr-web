pub mod client;
pub mod schema;
mod status;

pub use status::RuntimeStatus;

use std::path::PathBuf;

pub const SOCKET_PATH_ENV_VAR: &str = "HERDR_SOCKET_PATH";

pub fn socket_path() -> PathBuf {
    crate::session::active_api_socket_path()
}
