use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(test)]
use std::sync::Mutex;

pub const SESSION_ENV_VAR: &str = "HERDR_SESSION";
const DEFAULT_SESSION_NAME: &str = "default";

static EXPLICIT_SESSION_REQUESTED: AtomicBool = AtomicBool::new(false);
#[cfg(test)]
pub(crate) static TEST_ENV_LOCK: Mutex<()> = Mutex::new(());

pub fn explicit_session_requested() -> bool {
    EXPLICIT_SESSION_REQUESTED.load(Ordering::Relaxed)
}

pub fn configure_explicit_session(name: &str) -> Result<(), String> {
    validate_session_name(name)?;
    if name == DEFAULT_SESSION_NAME {
        std::env::remove_var(SESSION_ENV_VAR);
    } else {
        std::env::set_var(SESSION_ENV_VAR, name);
    }
    EXPLICIT_SESSION_REQUESTED.store(true, Ordering::Relaxed);
    Ok(())
}

pub fn active_name() -> Option<String> {
    std::env::var(SESSION_ENV_VAR)
        .ok()
        .filter(|name| name != DEFAULT_SESSION_NAME)
        .filter(|name| is_valid_session_name(name))
}

pub fn data_dir() -> PathBuf {
    data_dir_for(active_name().as_deref())
}

pub fn data_dir_for(name: Option<&str>) -> PathBuf {
    let config_dir = herdr_compat::config::config_dir();
    match name {
        Some(name) => config_dir.join("sessions").join(name),
        None => config_dir,
    }
}

pub fn api_socket_path_for(name: Option<&str>) -> PathBuf {
    data_dir_for(name).join("herdr.sock")
}

pub fn active_api_socket_path() -> PathBuf {
    if explicit_session_requested() {
        return api_socket_path_for(active_name().as_deref());
    }
    if let Some(path) = non_empty_env(herdr_compat::api::SOCKET_PATH_ENV_VAR) {
        return PathBuf::from(path);
    }
    api_socket_path_for(active_name().as_deref())
}

pub fn client_socket_path_for(name: Option<&str>) -> PathBuf {
    data_dir_for(name).join("herdr-client.sock")
}

pub fn active_client_socket_path() -> PathBuf {
    if explicit_session_requested() {
        return client_socket_path_for(active_name().as_deref());
    }
    herdr_compat::server::socket_paths::client_socket_path_from_overrides(
        non_empty_env(herdr_compat::api::SOCKET_PATH_ENV_VAR).as_deref(),
        non_empty_env(herdr_compat::server::socket_paths::CLIENT_SOCKET_PATH_ENV_VAR).as_deref(),
        client_socket_path_for(active_name().as_deref()),
    )
}

fn is_valid_session_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}

pub fn validate_session_name(name: &str) -> Result<(), String> {
    if is_valid_session_name(name) {
        Ok(())
    } else {
        Err("session name must be 1-64 ASCII letters, digits, '.', '_', or '-'".to_string())
    }
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

#[cfg(test)]
pub(crate) fn clear_explicit_session_for_test() {
    EXPLICIT_SESSION_REQUESTED.store(false, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_session_ignores_socket_override() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        let previous_session = std::env::var(SESSION_ENV_VAR).ok();
        let previous_socket = std::env::var(herdr_compat::api::SOCKET_PATH_ENV_VAR).ok();

        std::env::set_var(
            herdr_compat::api::SOCKET_PATH_ENV_VAR,
            "/tmp/ignored-herdr.sock",
        );
        configure_explicit_session("work").unwrap();

        assert_eq!(active_name().as_deref(), Some("work"));
        assert!(active_api_socket_path().ends_with("sessions/work/herdr.sock"));
        assert!(active_client_socket_path().ends_with("sessions/work/herdr-client.sock"));

        restore_env(SESSION_ENV_VAR, previous_session);
        restore_env(herdr_compat::api::SOCKET_PATH_ENV_VAR, previous_socket);
        clear_explicit_session_for_test();
    }

    #[test]
    fn invalid_session_names_are_rejected() {
        assert!(validate_session_name("").is_err());
        assert!(validate_session_name("not allowed").is_err());
        assert!(validate_session_name("../work").is_err());
        assert!(validate_session_name(&"a".repeat(65)).is_err());
        assert!(validate_session_name("work_1.2-3").is_ok());
    }

    #[test]
    fn empty_socket_overrides_fall_back_to_default_session_paths() {
        let _guard = TEST_ENV_LOCK.lock().unwrap();
        let previous_session = std::env::var(SESSION_ENV_VAR).ok();
        let previous_socket = std::env::var(herdr_compat::api::SOCKET_PATH_ENV_VAR).ok();
        let previous_client_socket =
            std::env::var(herdr_compat::server::socket_paths::CLIENT_SOCKET_PATH_ENV_VAR).ok();

        clear_explicit_session_for_test();
        std::env::remove_var(SESSION_ENV_VAR);
        std::env::set_var(herdr_compat::api::SOCKET_PATH_ENV_VAR, "");
        std::env::set_var(
            herdr_compat::server::socket_paths::CLIENT_SOCKET_PATH_ENV_VAR,
            "",
        );

        assert_eq!(active_api_socket_path(), api_socket_path_for(None));
        assert_eq!(active_client_socket_path(), client_socket_path_for(None));

        restore_env(SESSION_ENV_VAR, previous_session);
        restore_env(herdr_compat::api::SOCKET_PATH_ENV_VAR, previous_socket);
        restore_env(
            herdr_compat::server::socket_paths::CLIENT_SOCKET_PATH_ENV_VAR,
            previous_client_socket,
        );
        clear_explicit_session_for_test();
    }

    fn restore_env(name: &str, value: Option<String>) {
        match value {
            Some(value) => std::env::set_var(name, value),
            None => std::env::remove_var(name),
        }
    }
}
