//! Herdr JSON API client compatibility surface.
//!
//! Source reference: upstream Herdr `src/api/client.rs`.

use std::fmt;
use std::io::{self, BufRead, BufReader, Write};
use std::path::PathBuf;
use std::time::Duration;

use interprocess::local_socket::traits::Stream as _;
use serde::de::DeserializeOwned;

use crate::api::schema::{
    ErrorResponse, EventsSubscribeParams, Method, PingParams, Request, ResponseResult,
    SuccessResponse,
};
use crate::ipc::LocalStream;

/// API connection target resolved by clients at the process edge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionTarget {
    SocketPath(PathBuf),
}

impl ConnectionTarget {
    fn socket_path(&self) -> PathBuf {
        match self {
            Self::SocketPath(path) => path.clone(),
        }
    }
}

/// Reusable client for Herdr's newline-delimited JSON API.
#[derive(Debug, Clone)]
pub struct ApiClient {
    target: ConnectionTarget,
}

impl ApiClient {
    pub fn for_socket_path(socket_path: PathBuf) -> Self {
        Self::for_target(ConnectionTarget::SocketPath(socket_path))
    }

    pub fn for_target(target: ConnectionTarget) -> Self {
        Self { target }
    }

    pub fn socket_path(&self) -> PathBuf {
        self.target.socket_path()
    }

    pub fn request(&self, request: Request) -> Result<SuccessResponse, ApiClientError> {
        let value = self.request_value(&request)?;
        parse_response_value(value)
    }

    pub fn request_value(&self, request: &Request) -> Result<serde_json::Value, ApiClientError> {
        let mut stream = self.connect()?;
        write_request(&mut stream, request)?;

        let mut reader = BufReader::new(stream);
        read_json_line(&mut reader)
    }

    pub fn request_value_with_timeout(
        &self,
        request: &Request,
        timeout: Duration,
    ) -> Result<serde_json::Value, ApiClientError> {
        let mut stream = self.connect()?;
        set_timeout_best_effort(&stream, TimeoutKind::Send, timeout)?;
        set_timeout_best_effort(&stream, TimeoutKind::Recv, timeout)?;
        write_request(&mut stream, request)?;

        let mut reader = BufReader::new(stream);
        read_json_line(&mut reader)
    }

    #[allow(dead_code)] // Kept as the typed subscription API; CLI wait paths use subscribe_value to preserve raw ack errors.
    pub fn subscribe(
        &self,
        id: impl Into<String>,
        params: EventsSubscribeParams,
        read_timeout: Option<Duration>,
    ) -> Result<(SuccessResponse, EventStream), ApiClientError> {
        let request = Request {
            id: id.into(),
            method: Method::EventsSubscribe(params),
        };
        let (ack, stream) = self.subscribe_value(&request, read_timeout)?;
        Ok((parse_response_value(ack)?, stream))
    }

    pub fn subscribe_value(
        &self,
        request: &Request,
        read_timeout: Option<Duration>,
    ) -> Result<(serde_json::Value, EventStream), ApiClientError> {
        let mut stream = self.connect()?;
        write_request(&mut stream, request)?;
        if let Some(timeout) = read_timeout {
            set_timeout_best_effort(&stream, TimeoutKind::Recv, timeout)?;
        }

        let mut reader = BufReader::new(stream);
        let ack = read_json_line(&mut reader)?;
        Ok((
            ack,
            EventStream {
                reader,
                pending_line: Vec::new(),
            },
        ))
    }

    pub fn status_with_timeout(
        &self,
        timeout: Duration,
    ) -> Result<crate::api::RuntimeStatus, ApiClientError> {
        self.status_with_request(|client, request| {
            let value = client.request_value_with_timeout(&request, timeout)?;
            parse_response_value(value)
        })
    }

    fn status_with_request(
        &self,
        request: impl FnOnce(&Self, Request) -> Result<SuccessResponse, ApiClientError>,
    ) -> Result<crate::api::RuntimeStatus, ApiClientError> {
        let response = request(
            self,
            Request {
                id: "api-client:status".into(),
                method: Method::Ping(PingParams::default()),
            },
        )?;
        match response.result {
            ResponseResult::Pong {
                version,
                protocol,
                capabilities,
            } => Ok(crate::api::RuntimeStatus {
                version: Some(version),
                protocol: Some(protocol),
                capabilities,
            }),
            result => Err(ApiClientError::UnexpectedResult(format!("{result:?}"))),
        }
    }

    fn connect(&self) -> io::Result<LocalStream> {
        crate::ipc::connect_local_stream(&self.socket_path())
    }
}

enum TimeoutKind {
    Send,
    Recv,
}

fn set_timeout_best_effort(
    stream: &LocalStream,
    kind: TimeoutKind,
    timeout: Duration,
) -> io::Result<()> {
    let result = match kind {
        TimeoutKind::Send => stream.set_send_timeout(Some(timeout)),
        TimeoutKind::Recv => stream.set_recv_timeout(Some(timeout)),
    };
    match result {
        Ok(()) => Ok(()),
        #[cfg(windows)]
        Err(err) if err.kind() == io::ErrorKind::Unsupported => Ok(()),
        Err(err) => Err(err),
    }
}

pub struct EventStream {
    reader: BufReader<LocalStream>,
    pending_line: Vec<u8>,
}

impl EventStream {
    pub fn set_read_timeout(&self, timeout: Duration) -> Result<(), ApiClientError> {
        set_timeout_best_effort(self.reader.get_ref(), TimeoutKind::Recv, timeout)
            .map_err(ApiClientError::Io)
    }

    pub fn next_value(&mut self) -> Result<Option<serde_json::Value>, ApiClientError> {
        read_optional_json_line(&mut self.reader, &mut self.pending_line)
    }
}

#[derive(Debug)]
pub enum ApiClientError {
    Io(io::Error),
    Json(serde_json::Error),
    ErrorResponse(ErrorResponse),
    EmptyResponse,
    UnexpectedResult(String),
}

impl fmt::Display for ApiClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(err) => write!(f, "{err}"),
            Self::Json(err) => write!(f, "{err}"),
            Self::ErrorResponse(response) => write!(f, "{}", response.error.message),
            Self::EmptyResponse => write!(f, "empty api response"),
            Self::UnexpectedResult(result) => write!(f, "unexpected api result: {result}"),
        }
    }
}

impl std::error::Error for ApiClientError {}

impl From<io::Error> for ApiClientError {
    fn from(err: io::Error) -> Self {
        Self::Io(err)
    }
}

impl From<serde_json::Error> for ApiClientError {
    fn from(err: serde_json::Error) -> Self {
        Self::Json(err)
    }
}

fn write_request(stream: &mut LocalStream, request: &Request) -> Result<(), ApiClientError> {
    stream.write_all(serde_json::to_string(request)?.as_bytes())?;
    stream.write_all(b"\n")?;
    stream.flush()?;
    Ok(())
}

fn read_json_line<T: DeserializeOwned>(
    reader: &mut BufReader<LocalStream>,
) -> Result<T, ApiClientError> {
    let mut line = String::new();
    let read = reader.read_line(&mut line)?;
    if read == 0 || line.trim().is_empty() {
        return Err(ApiClientError::EmptyResponse);
    }
    serde_json::from_str(&line).map_err(ApiClientError::Json)
}

fn read_optional_json_line<T: DeserializeOwned>(
    reader: &mut impl BufRead,
    pending_line: &mut Vec<u8>,
) -> Result<Option<T>, ApiClientError> {
    let mut line = std::mem::take(pending_line);
    let read = match reader.read_until(b'\n', &mut line) {
        Ok(read) => read,
        Err(err) if is_timeout_error(&err) => {
            *pending_line = line;
            return Err(ApiClientError::Io(err));
        }
        Err(err) => return Err(ApiClientError::Io(err)),
    };
    if read == 0 {
        return Ok(None);
    }
    if line.iter().all(|byte| byte.is_ascii_whitespace()) {
        return Err(ApiClientError::EmptyResponse);
    }
    serde_json::from_slice(&line)
        .map(Some)
        .map_err(ApiClientError::Json)
}

fn is_timeout_error(err: &io::Error) -> bool {
    matches!(
        err.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
    )
}

#[derive(serde::Deserialize)]
#[serde(untagged)]
enum WireResponse {
    Success(Box<SuccessResponse>),
    Error(ErrorResponse),
}

pub fn parse_response_value(value: serde_json::Value) -> Result<SuccessResponse, ApiClientError> {
    match serde_json::from_value(value)? {
        WireResponse::Success(response) => Ok(*response),
        WireResponse::Error(response) => Err(ApiClientError::ErrorResponse(response)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::io::Read;

    #[test]
    fn socket_path_target_uses_explicit_path() {
        let path = PathBuf::from("/tmp/herdr-test.sock");
        let client = ApiClient::for_socket_path(path.clone());
        assert_eq!(client.socket_path(), path);
    }

    #[test]
    fn optional_json_line_preserves_split_utf8_across_timeout() {
        let mut reader = BufReader::new(ScriptedRead::new(vec![
            ReadStep::Bytes(b"{\"value\":\"caf\xc3"),
            ReadStep::Error(io::ErrorKind::WouldBlock),
            ReadStep::Bytes(b"\xa9\"}\n"),
        ]));
        let mut pending_line = Vec::new();

        let first = read_optional_json_line::<serde_json::Value>(&mut reader, &mut pending_line);
        assert!(matches!(
            first,
            Err(ApiClientError::Io(err)) if err.kind() == io::ErrorKind::WouldBlock
        ));
        assert_eq!(pending_line, b"{\"value\":\"caf\xc3");

        let second =
            read_optional_json_line::<serde_json::Value>(&mut reader, &mut pending_line).unwrap();
        assert_eq!(second, Some(serde_json::json!({ "value": "café" })));
        assert!(pending_line.is_empty());
    }

    enum ReadStep {
        Bytes(&'static [u8]),
        Error(io::ErrorKind),
    }

    struct ScriptedRead {
        steps: VecDeque<ReadStep>,
    }

    impl ScriptedRead {
        fn new(steps: Vec<ReadStep>) -> Self {
            Self {
                steps: steps.into(),
            }
        }
    }

    impl Read for ScriptedRead {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            match self.steps.pop_front() {
                Some(ReadStep::Bytes(bytes)) => {
                    assert!(buf.len() >= bytes.len());
                    buf[..bytes.len()].copy_from_slice(bytes);
                    Ok(bytes.len())
                }
                Some(ReadStep::Error(kind)) => Err(io::Error::new(kind, "scripted read error")),
                None => Ok(0),
            }
        }
    }
}
