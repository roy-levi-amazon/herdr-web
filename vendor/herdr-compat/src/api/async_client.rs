//! Async variant of the Herdr JSON API client.

use std::io;
use std::path::PathBuf;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

use crate::api::schema::{Method, PingParams, Request, ResponseResult, SuccessResponse};

use super::client::{parse_response_value, ApiClientError};

#[derive(Debug, Clone)]
pub struct AsyncApiClient {
    socket_path: PathBuf,
}

impl AsyncApiClient {
    pub fn new(socket_path: PathBuf) -> Self {
        Self { socket_path }
    }

    pub fn socket_path(&self) -> &PathBuf {
        &self.socket_path
    }

    pub async fn request(&self, request: Request) -> Result<SuccessResponse, ApiClientError> {
        let value = self.request_value(&request).await?;
        parse_response_value(value)
    }

    pub async fn request_value(
        &self,
        request: &Request,
    ) -> Result<serde_json::Value, ApiClientError> {
        let mut stream = self.connect().await?;
        async_write_request(&mut stream, request).await?;
        async_read_json_line(&mut stream).await
    }

    pub async fn request_with_timeout(
        &self,
        request: &Request,
        timeout: Duration,
    ) -> Result<SuccessResponse, ApiClientError> {
        let value = tokio::time::timeout(timeout, self.request_value(request))
            .await
            .map_err(|_| {
                ApiClientError::Io(io::Error::new(io::ErrorKind::TimedOut, "request timed out"))
            })??;
        parse_response_value(value)
    }

    pub async fn subscribe_value(
        &self,
        request: &Request,
    ) -> Result<(serde_json::Value, AsyncEventStream), ApiClientError> {
        let mut stream = self.connect().await?;
        async_write_request(&mut stream, request).await?;
        let mut reader = BufReader::new(stream);
        let ack = async_read_json_line_from_reader(&mut reader).await?;
        Ok((ack, AsyncEventStream { reader }))
    }

    pub async fn status_with_timeout(
        &self,
        timeout: Duration,
    ) -> Result<crate::api::RuntimeStatus, ApiClientError> {
        let request = Request {
            id: "async-api-client:status".into(),
            method: Method::Ping(PingParams::default()),
        };
        let response = self.request_with_timeout(&request, timeout).await?;
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

    async fn connect(&self) -> io::Result<UnixStream> {
        UnixStream::connect(&self.socket_path).await
    }
}

pub struct AsyncEventStream {
    reader: BufReader<UnixStream>,
}

impl AsyncEventStream {
    pub async fn next_value(&mut self) -> Result<Option<serde_json::Value>, ApiClientError> {
        let mut line = String::new();
        let read = self.reader.read_line(&mut line).await?;
        if read == 0 {
            return Ok(None);
        }
        if line.trim().is_empty() {
            return Err(ApiClientError::EmptyResponse);
        }
        serde_json::from_str(&line)
            .map(Some)
            .map_err(ApiClientError::Json)
    }
}

async fn async_write_request(
    stream: &mut UnixStream,
    request: &Request,
) -> Result<(), ApiClientError> {
    let json = serde_json::to_string(request)?;
    stream.write_all(json.as_bytes()).await?;
    stream.write_all(b"\n").await?;
    stream.flush().await?;
    Ok(())
}

async fn async_read_json_line(
    stream: &mut UnixStream,
) -> Result<serde_json::Value, ApiClientError> {
    let mut reader = BufReader::new(stream);
    async_read_json_line_from_reader(&mut reader).await
}

async fn async_read_json_line_from_reader<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
) -> Result<serde_json::Value, ApiClientError> {
    let mut line = String::new();
    let read = reader.read_line(&mut line).await?;
    if read == 0 || line.trim().is_empty() {
        return Err(ApiClientError::EmptyResponse);
    }
    serde_json::from_str(&line).map_err(ApiClientError::Json)
}
