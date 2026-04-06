use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;

/// Client that speaks the fuse-daemon.ts JSON protocol over a Unix socket.
/// Each request opens a new connection (matching the C helper's pattern).
/// All I/O runs on a blocking thread via spawn_blocking so the tokio
/// runtime is never blocked.
pub struct DaemonClient {
    socket_path: PathBuf,
}

impl DaemonClient {
    pub fn new(socket_path: PathBuf) -> Self {
        Self { socket_path }
    }

    /// Send a JSON request and receive a JSON response (blocking).
    fn request_sync(socket_path: &std::path::Path, req: &Value) -> Result<Value, String> {
        let mut stream = UnixStream::connect(socket_path)
            .map_err(|e| format!("connect: {}", e))?;

        let mut line = serde_json::to_string(req).map_err(|e| format!("serialize: {}", e))?;
        line.push('\n');
        stream
            .write_all(line.as_bytes())
            .map_err(|e| format!("write: {}", e))?;

        let mut reader = BufReader::new(stream);
        let mut resp_line = String::new();
        reader
            .read_line(&mut resp_line)
            .map_err(|e| format!("read: {}", e))?;

        serde_json::from_str(resp_line.trim())
            .map_err(|e| format!("parse: {}", e))
    }

    /// Async convenience: send an op+path request.
    pub async fn op(&self, op: &str, path: &str) -> Result<Value, String> {
        let socket_path = self.socket_path.clone();
        let req = serde_json::json!({"op": op, "path": format!("/{}", path)});
        tokio::task::spawn_blocking(move || Self::request_sync(&socket_path, &req))
            .await
            .map_err(|e| format!("spawn_blocking: {}", e))?
    }

    /// Async convenience: send a write request with data.
    pub async fn write_op(&self, path: &str, data: &str) -> Result<Value, String> {
        let socket_path = self.socket_path.clone();
        let req = serde_json::json!({
            "op": "write",
            "path": format!("/{}", path),
            "data": data
        });
        tokio::task::spawn_blocking(move || Self::request_sync(&socket_path, &req))
            .await
            .map_err(|e| format!("spawn_blocking: {}", e))?
    }
}
