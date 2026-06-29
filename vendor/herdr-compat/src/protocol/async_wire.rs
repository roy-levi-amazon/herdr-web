//! Async wire protocol helpers for terminal attach.
//!
//! Provides async equivalents of `read_message` and `write_message` from `wire.rs`,
//! using `tokio::io` traits instead of `std::io`. The framing format (u32 LE length
//! prefix + bincode payload) is identical to the synchronous version.

use std::io;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use serde::{Serialize, de::DeserializeOwned};

const LENGTH_PREFIX_BYTES: usize = 4;

/// Reads and deserializes a length-prefixed frame from an async reader.
///
/// Rejects frames whose declared length exceeds `max_frame_size`.
pub async fn async_read_message<T: DeserializeOwned>(
    reader: &mut (impl tokio::io::AsyncRead + Unpin),
    max_frame_size: usize,
) -> io::Result<T> {
    let mut len_buf = [0u8; LENGTH_PREFIX_BYTES];
    reader.read_exact(&mut len_buf).await?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > max_frame_size {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame too large: {len} > {max_frame_size}"),
        ));
    }
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf).await?;
    let (value, _) = bincode::serde::decode_from_slice(&buf, bincode::config::standard())
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err.to_string()))?;
    Ok(value)
}

/// Serializes a message and writes it as a length-prefixed frame to an async writer.
pub async fn async_write_message<T: Serialize>(
    writer: &mut (impl tokio::io::AsyncWrite + Unpin),
    message: &T,
) -> io::Result<()> {
    let payload = bincode::serde::encode_to_vec(message, bincode::config::standard())
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err.to_string()))?;
    let len = payload.len() as u32;
    writer.write_all(&len.to_le_bytes()).await?;
    writer.write_all(&payload).await?;
    writer.flush().await?;
    Ok(())
}
