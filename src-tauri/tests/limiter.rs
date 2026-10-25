//! The speed cap, measured end to end. In a file of its own because the cap is
//! one for the whole process: set here, it would slow every other test running
//! beside it.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::thread;
use std::time::{Duration, Instant};

use universal_downloader_lib::downloader::control::TaskControl;
use universal_downloader_lib::downloader::{http, limiter};
use universal_downloader_lib::net;
use universal_downloader_lib::settings::Settings;

const BODY_LEN: usize = 6 * 1024 * 1024;

/// Serves ranges as fast as the loopback allows, one thread per connection.
fn start_server() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut range = (0usize, BODY_LEN - 1);
                let mut line = String::new();
                loop {
                    line.clear();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line.trim().is_empty() {
                        break;
                    }
                    if let Some(spec) = line.to_ascii_lowercase().strip_prefix("range: bytes=") {
                        let mut parts = spec.trim().split('-');
                        range.0 = parts.next().unwrap().parse().unwrap();
                        range.1 = parts.next().unwrap().parse::<usize>().unwrap().min(BODY_LEN - 1);
                    }
                }
                let slice = vec![7u8; range.1 - range.0 + 1];
                let header = format!(
                    "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    range.0,
                    range.1,
                    BODY_LEN,
                    slice.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&slice);
            });
        }
    });
    port
}

async fn timed_fetch(port: u16, name: &str, connections: u32) -> Duration {
    let target = universal_downloader_lib::paths::temp_dir().unwrap().join(name);
    let _ = std::fs::remove_file(&target);
    http::discard_partial(&target);

    let client = net::client(&Settings::default()).unwrap();
    let url = format!("http://127.0.0.1:{port}/x.bin");
    let started = Instant::now();
    http::fetch(
        &client,
        http::FetchOptions {
            url: &url,
            headers: &[],
            target: &target,
            low_resource: false,
            connections,
        },
        TaskControl::shared(),
        &mut |_| {},
    )
    .await
    .expect("download should succeed");
    let elapsed = started.elapsed();
    assert_eq!(std::fs::metadata(&target).unwrap().len() as usize, BODY_LEN);
    std::fs::remove_file(&target).unwrap();
    elapsed
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_cap_holds_for_one_connection_and_for_many() {
    let port = start_server();

    // 6 MiB at 3 MiB/s is two seconds, less the half second of burst the
    // bucket allows -- however many connections share the cap.
    limiter::global().set_kbps(3 * 1024);
    for connections in [1, 6] {
        let elapsed = timed_fetch(port, &format!("limit-{connections}.bin"), connections).await;
        assert!(
            elapsed >= Duration::from_millis(1300),
            "{connections} connection(s) finished in {elapsed:?}, faster than the cap allows"
        );
        assert!(
            elapsed <= Duration::from_secs(6),
            "{connections} connection(s) took {elapsed:?}, far slower than the cap"
        );
    }

    limiter::global().set_kbps(0);
    let elapsed = timed_fetch(port, "limit-off.bin", 6).await;
    assert!(elapsed < Duration::from_millis(1300), "uncapped took {elapsed:?}");
}
