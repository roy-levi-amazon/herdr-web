pub mod client;
pub mod schema;
mod status;

pub use status::RuntimeStatus;

pub const SOCKET_PATH_ENV_VAR: &str = "HERDR_SOCKET_PATH";
