//! Multi-connection transfers, tested against a local server that serves each
//! connection on its own thread -- so connections really do run at once, and
//! the server can count them, cap them, or change the file underneath them.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use universal_downloader_lib::downloader::control::TaskControl;
use universal_downloader_lib::downloader::{http, segmented};
use universal_downloader_lib::net;
use universal_downloader_lib::settings::Settings;

const BODY_LEN: usize = 12 * 1024 * 1024;
const WRITE_CHUNK: usize = 64 * 1024;

fn body() -> Vec<u8> {
    // Position-dependent, so a piece written at the wrong offset is caught.
    (0..BODY_LEN).map(|index| (index % 251) as u8).collect()
}

/// The same size with different bytes: what a file replaced on the server
/// looks like.
fn other_body() -> Vec<u8> {
    (0..BODY_LEN).map(|index| (index % 239) as u8).collect()
}

#[derive(Clone)]
struct Config {
    /// More simultaneous connections than this are answered 503.
    cap: Option<usize>,
    delay: Duration,
}

struct TestServer {
    port: u16,
    active: Arc<AtomicUsize>,
    peak: Arc<AtomicUsize>,
    payload: Arc<Mutex<(Vec<u8>, String)>>,
}

impl TestServer {
    fn url(&self) -> String {
        format!("http://127.0.0.1:{}/big.bin", self.port)
    }

    fn peak(&self) -> usize {
        self.peak.load(Ordering::SeqCst)
    }

    fn replace(&self, bytes: Vec<u8>, etag: &str) {
        *self.payload.lock().unwrap() = (bytes, etag.to_string());
    }
}

fn start_server(config: Config) -> TestServer {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind a local port");
    let port = listener.local_addr().unwrap().port();
    let active = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let payload = Arc::new(Mutex::new((body(), "\"v1\"".to_string())));

    {
        let (active, peak, payload) = (Arc::clone(&active), Arc::clone(&peak), Arc::clone(&payload));
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { break };
                let (active, peak, payload, config) =
                    (Arc::clone(&active), Arc::clone(&peak), Arc::clone(&payload), config.clone());
                thread::spawn(move || {
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    let _ = serve(stream, &config, &payload, now);
                    active.fetch_sub(1, Ordering::SeqCst);
                });
            }
        });
    }

    TestServer {
        port,
        active,
        peak,
        payload,
    }
}

fn serve(
    mut stream: TcpStream,
    config: &Config,
    payload: &Mutex<(Vec<u8>, String)>,
    concurrent: usize,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut range: Option<(usize, Option<usize>)> = None;
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("range:") {
            if let Some(spec) = value.trim().strip_prefix("bytes=") {
                let mut parts = spec.trim().split('-');
                let start = parts.next().and_then(|v| v.trim().parse().ok()).unwrap_or(0);
                let end = parts.next().and_then(|v| v.trim().parse::<usize>().ok());
                range = Some((start, end));
            }
        }
    }

    if config.cap.is_some_and(|cap| concurrent > cap) {
        stream.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")?;
        return Ok(());
    }

    let (bytes, etag) = payload.lock().unwrap().clone();
    let (start, slice) = match range {
        Some((start, end)) => {
            let stop = end.map_or(bytes.len(), |e| (e + 1).min(bytes.len()));
            (start, &bytes[start..stop])
        }
        None => (0, &bytes[..]),
    };
    let header = if range.is_some() {
        format!(
            "HTTP/1.1 206 Partial Content\r\nAccept-Ranges: bytes\r\nETag: {etag}\r\n\
             Content-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            start,
            start + slice.len() - 1,
            bytes.len(),
            slice.len()
        )
    } else {
        format!(
            "HTTP/1.1 200 OK\r\nAccept-Ranges: bytes\r\nETag: {etag}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            slice.len()
        )
    };
    stream.write_all(header.as_bytes())?;
    for chunk in slice.chunks(WRITE_CHUNK) {
        if stream.write_all(chunk).is_err() {
            return Ok(());
        }
        stream.flush()?;
        thread::sleep(config.delay);
    }
    Ok(())
}

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = universal_downloader_lib::paths::temp_dir().expect("temp dir");
    let path = dir.join(name);
    let _ = std::fs::remove_file(&path);
    http::discard_partial(&path);
    path
}

async fn fetch<F>(
    url: &str,
    target: &std::path::Path,
    connections: u32,
    control: Arc<TaskControl>,
    mut sink: F,
) -> Result<u64, universal_downloader_lib::error::AppError>
where
    F: FnMut(http::ProgressSample) + Send,
{
    let client = net::client(&Settings::default()).unwrap();
    http::fetch(
        &client,
        http::FetchOptions {
            url,
            headers: &[],
            target,
            low_resource: false,
            connections,
        },
        control,
        &mut sink,
    )
    .await
}

fn cancel_after(control: &Arc<TaskControl>, delay: Duration) {
    let control = Arc::clone(control);
    tokio::spawn(async move {
        tokio::time::sleep(delay).await;
        control.cancel();
    });
}

fn quick() -> Config {
    Config {
        cap: None,
        delay: Duration::from_millis(2),
    }
}

/// Slow enough that a cancel 400 ms in lands mid-transfer: each connection's
/// share of the file takes over a second.
fn slow() -> Config {
    Config {
        cap: None,
        delay: Duration::from_millis(40),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_split_download_is_byte_exact_and_really_runs_in_parallel() {
    let server = start_server(quick());
    let target = scratch("seg-plain.bin");

    let mut last_percent = 0.0f64;
    let written = fetch(&server.url(), &target, 8, TaskControl::shared(), |sample| {
        if let Some(percent) = sample.percent {
            assert!(percent + 0.001 >= last_percent, "{last_percent} -> {percent}");
            last_percent = percent;
        }
    })
    .await
    .expect("download should succeed");

    assert_eq!(written as usize, BODY_LEN);
    assert_eq!(std::fs::read(&target).unwrap(), body());
    assert!(!http::part_path(&target).exists());
    assert!(!segmented::state_path(&target).exists(), "the sidecar goes with the part file");
    assert!(server.peak() >= 4, "only {} connections ever ran at once", server.peak());
    assert_eq!(server.active.load(Ordering::SeqCst), 0);
    std::fs::remove_file(&target).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_interrupted_split_download_resumes_where_each_piece_stopped() {
    let server = start_server(slow());
    let target = scratch("seg-resume.bin");

    let control = TaskControl::shared();
    cancel_after(&control, Duration::from_millis(400));
    let result = fetch(&server.url(), &target, 6, Arc::clone(&control), |_| {}).await;
    assert!(result.is_err(), "an interrupted fetch must not report success");
    assert!(!target.exists());
    assert!(segmented::state_path(&target).exists(), "progress must be kept for the resume");

    let mut first = None;
    let mut last = 0;
    let written = fetch(&server.url(), &target, 6, TaskControl::shared(), |sample| {
        first.get_or_insert(sample.received);
        last = sample.received;
    })
    .await
    .expect("the resumed download should succeed");

    assert_eq!(written as usize, BODY_LEN);
    let first = first.unwrap();
    assert!(first > 0 && (first as usize) < BODY_LEN, "the resume started from {first}");
    assert_eq!(last as usize, BODY_LEN);
    assert_eq!(std::fs::read(&target).unwrap(), body(), "the stitched file is corrupt");
    std::fs::remove_file(&target).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_host_that_refuses_extra_connections_still_gets_the_file_finished() {
    let server = start_server(Config {
        cap: Some(2),
        delay: Duration::from_millis(2),
    });
    let target = scratch("seg-capped.bin");

    let written = fetch(&server.url(), &target, 8, TaskControl::shared(), |_| {})
        .await
        .expect("the connections that were let in should finish the job");

    assert_eq!(written as usize, BODY_LEN);
    assert_eq!(std::fs::read(&target).unwrap(), body());
    std::fs::remove_file(&target).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_single_connection_partial_is_carried_on_by_several() {
    let server = start_server(quick());
    let target = scratch("seg-from-single.bin");

    // What a run with one connection leaves: a correct prefix and no sidecar.
    let prefix = 3 * 1024 * 1024 + 17;
    std::fs::write(http::part_path(&target), &body()[..prefix]).unwrap();

    let mut first = None;
    fetch(&server.url(), &target, 4, TaskControl::shared(), |sample| {
        first.get_or_insert(sample.received);
    })
    .await
    .expect("download should succeed");

    assert_eq!(first, Some(prefix as u64), "the prefix counts as already fetched");
    assert_eq!(std::fs::read(&target).unwrap(), body());
    std::fs::remove_file(&target).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_file_changed_on_the_server_is_fetched_again_rather_than_stitched() {
    let server = start_server(slow());
    let target = scratch("seg-changed.bin");

    let control = TaskControl::shared();
    cancel_after(&control, Duration::from_millis(400));
    let _ = fetch(&server.url(), &target, 4, Arc::clone(&control), |_| {}).await;
    assert!(segmented::state_path(&target).exists());

    server.replace(other_body(), "\"v2\"");
    fetch(&server.url(), &target, 4, TaskControl::shared(), |_| {})
        .await
        .expect("download should succeed");

    assert_eq!(
        std::fs::read(&target).unwrap(),
        other_body(),
        "pieces of the old file must not survive into the new one"
    );
    std::fs::remove_file(&target).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_connection_continues_a_split_file_instead_of_misreading_it() {
    let server = start_server(slow());
    let target = scratch("seg-then-single.bin");

    let control = TaskControl::shared();
    cancel_after(&control, Duration::from_millis(400));
    let _ = fetch(&server.url(), &target, 4, Arc::clone(&control), |_| {}).await;
    // The partial file is full-length already; read as a single-connection
    // prefix it would look finished.
    assert_eq!(
        std::fs::metadata(http::part_path(&target)).unwrap().len() as usize,
        BODY_LEN
    );

    fetch(&server.url(), &target, 1, TaskControl::shared(), |_| {})
        .await
        .expect("download should succeed");
    assert_eq!(std::fs::read(&target).unwrap(), body());
    std::fs::remove_file(&target).unwrap();
}
