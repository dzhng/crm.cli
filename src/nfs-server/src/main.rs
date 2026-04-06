mod daemon_client;
mod fs;
mod handle_map;

use daemon_client::DaemonClient;
use fs::CrmNfs;
use nfsserve::tcp::{NFSTcp, NFSTcpListener};
use std::path::PathBuf;

/// Bind to port 0, read the OS-assigned port, close the socket.
/// The port is briefly free — nfsserve re-binds it immediately after.
fn pick_free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind :0");
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    port
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: crm-nfs <socket-path> [port]");
        std::process::exit(1);
    }

    let socket_path = PathBuf::from(&args[1]);
    let port: u16 = if args.len() > 2 {
        args[2].parse().unwrap_or(0)
    } else {
        0
    };

    let port = if port == 0 { pick_free_port() } else { port };

    let daemon = DaemonClient::new(socket_path);
    let nfs = CrmNfs::new(daemon);

    // Print port so the TypeScript caller can read it.
    use std::io::Write;
    println!("{}", port);
    std::io::stdout().flush().unwrap();

    let listener = NFSTcpListener::bind(&format!("127.0.0.1:{}", port), nfs)
        .await
        .expect("Failed to bind NFS server");

    listener.handle_forever().await.unwrap();
}
