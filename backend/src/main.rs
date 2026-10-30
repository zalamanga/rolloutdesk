use rolloutdesk::{api, auth::AppState, config::Settings};
use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    time::Duration,
};

fn main() {
    if std::env::args().nth(1).as_deref() == Some("health") {
        std::process::exit(if health_probe() { 0 } else { 1 });
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build();
    if runtime
        .map_err(|_| ())
        .and_then(|runtime| runtime.block_on(run()))
        .is_err()
    {
        eprintln!(
            "RolloutDesk could not start or serve. Check local service configuration and database availability."
        );
        std::process::exit(1);
    }
}

async fn run() -> Result<(), ()> {
    let settings = Settings::from_env().map_err(|_| ())?;
    let state = AppState::initialize(settings).await.map_err(|_| ())?;
    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080")
        .await
        .map_err(|_| ())?;
    println!("RolloutDesk API listening on internal port 8080.");
    axum::serve(
        listener,
        api::router(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await
    .map_err(|_| ())
}

fn health_probe() -> bool {
    let address: SocketAddr = match "127.0.0.1:8080".parse() {
        Ok(address) => address,
        Err(_) => return false,
    };
    let mut stream = match TcpStream::connect_timeout(&address, Duration::from_secs(2)) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(6)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    if stream
        .write_all(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut prefix = [0u8; 12];
    stream.read_exact(&mut prefix).is_ok() && &prefix == b"HTTP/1.1 200"
}
