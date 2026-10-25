//! Plain-file downloads, end to end against a local server: the name the
//! server gives, the bytes, and the page a server sends instead of a file.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::Arc;
use std::thread;

use universal_downloader_lib::downloader::control::TaskControl;
use universal_downloader_lib::downloader::{self, file};
use universal_downloader_lib::model::{
    DownloadMode, DownloadProgress, DownloadRequest, DownloadStage, FileDownload, QualityPreference,
    SourceContext, WatermarkPreference,
};
use universal_downloader_lib::net;
use universal_downloader_lib::settings::Settings;

const BODY_LEN: usize = 9 * 1024 * 1024 + 123;

fn body() -> Vec<u8> {
    (0..BODY_LEN).map(|index| (index % 253) as u8).collect()
}

/// `/report` is a PDF named by its `Content-Disposition`; `/login` is the page
/// a server sends when it wants a sign-in first. Every request's `Referer` is
/// kept, so a test can see what the app sent.
fn start_server() -> (u16, Arc<std::sync::Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let referers = Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen = Arc::clone(&referers);
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let seen = Arc::clone(&seen);
            thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut path = String::new();
                let mut range: Option<(usize, usize)> = None;
                let mut line = String::new();
                loop {
                    line.clear();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line.trim().is_empty() {
                        break;
                    }
                    let lower = line.to_ascii_lowercase();
                    if path.is_empty() {
                        path = line.split_whitespace().nth(1).unwrap_or("").to_string();
                    } else if let Some(spec) = lower.strip_prefix("range: bytes=") {
                        let mut parts = spec.trim().split('-');
                        let start = parts.next().unwrap().parse().unwrap();
                        let end = parts.next().unwrap().parse::<usize>().unwrap().min(BODY_LEN - 1);
                        range = Some((start, end));
                    } else if lower.starts_with("referer:") {
                        seen.lock().unwrap().push(line[8..].trim().to_string());
                    }
                }

                if path.starts_with("/login") {
                    let page = b"<html><body>Sign in</body></html>";
                    let header = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        page.len()
                    );
                    let _ = stream.write_all(header.as_bytes());
                    let _ = stream.write_all(page);
                    return;
                }

                let payload = body();
                let (start, end) = range.unwrap_or((0, BODY_LEN - 1));
                let slice = &payload[start..=end];
                let status = if range.is_some() { "206 Partial Content" } else { "200 OK" };
                let header = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/pdf\r\n\
                     Content-Disposition: attachment; filename=\"fallback.pdf\"; filename*=UTF-8''Quarterly%20R%C3%A9port.pdf\r\n\
                     Accept-Ranges: bytes\r\nContent-Range: bytes {start}-{end}/{BODY_LEN}\r\n\
                     Content-Length: {}\r\nConnection: close\r\n\r\n",
                    slice.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(slice);
            });
        }
    });
    (port, referers)
}

fn request(url: String, output_dir: &std::path::Path, file_name: Option<&str>) -> DownloadRequest {
    DownloadRequest {
        url,
        mode: DownloadMode::Video,
        quality: QualityPreference::Best,
        video_format_id: None,
        audio_format_id: None,
        container: None,
        watermark: WatermarkPreference::Any,
        output_dir: Some(output_dir.to_string_lossy().into_owned()),
        title: None,
        thumbnail_url: None,
        platform: None,
        entry: None,
        audio_language: None,
        source: Some(SourceContext {
            page_url: Some("https://downloads.example/reports".into()),
            ..SourceContext::default()
        }),
        file: Some(FileDownload {
            file_name: file_name.map(str::to_string),
        }),
    }
}

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("ud-file-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_probe_reads_the_name_the_size_and_the_type() {
    let (port, _) = start_server();
    let client = net::client(&Settings::default()).unwrap();

    let info = file::probe(&client, &format!("http://127.0.0.1:{port}/report?id=7"), &[])
        .await
        .unwrap();
    assert_eq!(info.file_name, "Quarterly Réport.pdf");
    assert_eq!(info.size, Some(BODY_LEN as u64));
    assert_eq!(info.mime.as_deref(), Some("application/pdf"));
    assert!(info.resumable);
    assert!(file::same_as_captured(&info, Some("application/pdf"), Some(BODY_LEN as u64)));

    let page = file::probe(&client, &format!("http://127.0.0.1:{port}/login"), &[])
        .await
        .unwrap();
    assert!(page.is_page());
    assert!(
        !file::same_as_captured(&page, Some("application/pdf"), Some(BODY_LEN as u64)),
        "a sign-in page is not the file the browser was getting"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_file_is_saved_byte_for_byte_under_the_server_name() {
    let (port, referers) = start_server();
    let dir = scratch("server-name");
    let settings = Settings {
        connections_per_download: 4,
        download_dir: dir.to_string_lossy().into_owned(),
        ..Settings::default()
    };

    let mut stages = Vec::new();
    let mut sink = |progress: DownloadProgress| stages.push(progress.stage);
    let outcome = downloader::execute(
        "test-file-1",
        &request(format!("http://127.0.0.1:{port}/report?id=7"), &dir, None),
        &settings,
        TaskControl::shared(),
        &mut sink,
    )
    .await
    .expect("the file should download");

    assert_eq!(outcome.output_path, dir.join("Quarterly Réport.pdf"));
    assert_eq!(std::fs::read(&outcome.output_path).unwrap(), body());
    assert_eq!(outcome.file_size as usize, BODY_LEN);
    assert_eq!(outcome.label, "PDF");
    assert_eq!(outcome.metadata.title, "Quarterly Réport.pdf");
    assert!(stages.contains(&DownloadStage::File));
    assert_eq!(stages.last(), Some(&DownloadStage::Done));
    // The page it came from went along with every request.
    let sent = referers.lock().unwrap().clone();
    assert!(!sent.is_empty() && sent.iter().all(|referer| referer == "https://downloads.example/reports"));

    // A second download of the same file does not overwrite the first.
    let mut quiet = |_: DownloadProgress| {};
    let again = downloader::execute(
        "test-file-2",
        &request(format!("http://127.0.0.1:{port}/report?id=7"), &dir, None),
        &settings,
        TaskControl::shared(),
        &mut quiet,
    )
    .await
    .unwrap();
    assert_eq!(again.output_path, dir.join("Quarterly Réport (2).pdf"));
    let _ = std::fs::remove_dir_all(&dir);
}

/// A real release asset from GitHub: a redirect to a signed address, a name
/// given by `Content-Disposition`, and a published checksum to hold the bytes
/// to. Fetched over eight connections and over one, to compare.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "downloads a 17 MB file from github.com twice"]
async fn a_live_release_asset_is_byte_exact_over_many_connections() {
    use sha2::{Digest, Sha256};

    const RELEASE: &str = "https://github.com/yt-dlp/yt-dlp/releases/download/2024.08.06";
    let client = net::client(&Settings::default()).unwrap();
    let sums = client
        .get(format!("{RELEASE}/SHA2-256SUMS"))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let expected = sums
        .lines()
        .find_map(|line| line.strip_suffix("  yt-dlp.exe"))
        .expect("the release lists yt-dlp.exe")
        .to_string();

    for connections in [8, 1] {
        let dir = scratch(&format!("live-{connections}"));
        let settings = Settings {
            connections_per_download: connections,
            download_dir: dir.to_string_lossy().into_owned(),
            ..Settings::default()
        };
        let started = std::time::Instant::now();
        let mut quiet = |_: DownloadProgress| {};
        let outcome = downloader::execute(
            &format!("live-{connections}"),
            &request(format!("{RELEASE}/yt-dlp.exe"), &dir, None),
            &settings,
            TaskControl::shared(),
            &mut quiet,
        )
        .await
        .expect("the release asset should download");
        let elapsed = started.elapsed();

        let bytes = std::fs::read(&outcome.output_path).unwrap();
        let digest = hex::encode(Sha256::digest(&bytes));
        eprintln!(
            "{connections} connection(s): {} bytes in {:.2?} ({:.1} MB/s) -> {}",
            bytes.len(),
            elapsed,
            bytes.len() as f64 / elapsed.as_secs_f64() / 1_000_000.0,
            outcome.output_path.display()
        );
        assert_eq!(outcome.output_path.file_name().unwrap(), "yt-dlp.exe");
        assert_eq!(digest, expected, "the file does not match the published checksum");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_name_chosen_in_the_dialog_wins_and_is_made_safe() {
    let (port, _) = start_server();
    let dir = scratch("chosen-name");
    let settings = Settings {
        download_dir: dir.to_string_lossy().into_owned(),
        ..Settings::default()
    };
    let mut quiet = |_: DownloadProgress| {};
    let outcome = downloader::execute(
        "test-file-3",
        &request(format!("http://127.0.0.1:{port}/report"), &dir, Some("my: report?.pdf")),
        &settings,
        TaskControl::shared(),
        &mut quiet,
    )
    .await
    .unwrap();
    assert_eq!(outcome.output_path, dir.join("my- report-.pdf"));
    assert_eq!(std::fs::read(&outcome.output_path).unwrap().len(), BODY_LEN);
    let _ = std::fs::remove_dir_all(&dir);
}
