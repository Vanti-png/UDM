//! Plain files, fetched as they are.
//!
//! Everything else in this module reads a link as media: it asks a provider
//! what the link holds, picks streams, merges and converts. An archive, an
//! installer or a document has none of that. It is one resource, named by its
//! server, and the only right thing to do with it is to fetch its bytes and
//! save them under that name -- which is what a download manager does with
//! everything, and what this does with a download the browser extension
//! captured or a file link copied to the clipboard.
//!
//! The transfer itself is [`super::http::fetch`], so a file gets the same
//! multi-connection split, resume and speed cap as any other native download.

use std::path::PathBuf;
use std::sync::Arc;

use reqwest::header::{CONTENT_DISPOSITION, CONTENT_RANGE, CONTENT_TYPE, RANGE};
use reqwest::StatusCode;
use serde::Serialize;

use crate::downloader::control::TaskControl;
use crate::downloader::http::{self, ProgressSample};
use crate::downloader::{limiter, DownloadOutcome, UpdateSink};
use crate::error::{AppError, AppResult};
use crate::model::{
    DownloadProgress, DownloadRequest, DownloadStage, MediaKind, MediaMetadata, PlatformId,
    SourceContext, WatermarkSupport,
};
use crate::settings::Settings;
use crate::{ffmpeg, filename, log_info, net, paths};

/// The longest stem a saved file keeps, as for media.
const MAX_STEM_CHARS: usize = 120;

/// What a server says about a file before any of it is fetched.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    /// The name to save it under: the server's own, else the address's last
    /// part, made safe for a file system and given an extension when the
    /// type says what one is.
    pub file_name: String,
    pub size: Option<u64>,
    /// `Content-Type` without its parameters, lowercase.
    pub mime: Option<String>,
    /// The server answers ranged requests, so a pause or a lost connection
    /// costs nothing and the file can be split.
    pub resumable: bool,
    /// Where the address led after redirects.
    pub final_url: String,
}

impl FileInfo {
    /// A web page rather than a file: what a server that wants a sign-in, a
    /// captcha or a click first sends instead of the file.
    pub fn is_page(&self) -> bool {
        self.mime
            .as_deref()
            .is_some_and(|mime| mime == "text/html" || mime == "application/xhtml+xml")
    }
}

/// Whether what the app is served is the download the browser started.
///
/// A server that wants a sign-in or a cookie the app does not have answers
/// with a page where the browser got a file, or with a body of another size.
/// Either way taking the download from the browser would turn a working one
/// into a broken one, so the browser keeps it. A type or a size the browser
/// was not told proves nothing and is not held against the app.
pub fn same_as_captured(info: &FileInfo, browser_mime: Option<&str>, browser_size: Option<u64>) -> bool {
    let browser_page = browser_mime
        .map(|mime| mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase())
        .is_some_and(|mime| mime == "text/html" || mime == "application/xhtml+xml");
    if info.is_page() && !browser_page {
        return false;
    }
    match (browser_size, info.size) {
        (Some(expected), Some(served)) => expected == served,
        _ => true,
    }
}

/// Ask the server about `url` with one ranged request for its first byte.
///
/// Some servers refuse HEAD, and every one that serves files answers a ranged
/// GET -- with the size in `Content-Range` when it honours the range, or with
/// the whole body when it does not, which is dropped unread.
pub async fn probe(client: &reqwest::Client, url: &str, headers: &[(String, String)]) -> AppResult<FileInfo> {
    let response = client
        .get(url)
        .headers(net::header_map(headers))
        .header(RANGE, "bytes=0-0")
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        return Err(AppError::from_status(
            status.as_u16(),
            status.canonical_reason().unwrap_or("the file could not be read"),
        ));
    }

    let partial = status == StatusCode::PARTIAL_CONTENT;
    let headers = response.headers();
    let mime = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    let size = if partial {
        headers
            .get(CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.rsplit('/').next()?.trim().parse::<u64>().ok())
    } else {
        response.content_length()
    };
    let disposition = headers
        .get(CONTENT_DISPOSITION)
        .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned());
    let final_url = response.url().to_string();
    let file_name = resolve_name(disposition.as_deref(), &final_url, url, mime.as_deref());

    if partial {
        // One byte: reading it lets the connection go back to the pool.
        let _ = response.bytes().await;
    }

    Ok(FileInfo {
        file_name,
        size,
        mime,
        resumable: partial,
        final_url,
    })
}

/// Fetch `request.url` as a plain file into the download folder.
pub async fn execute(
    task_id: &str,
    request: &DownloadRequest,
    settings: &Settings,
    control: Arc<TaskControl>,
    on_update: UpdateSink<'_>,
) -> AppResult<DownloadOutcome> {
    on_update(DownloadProgress {
        stage: DownloadStage::Resolving,
        ..Default::default()
    });

    let headers = request
        .source
        .as_ref()
        .map(SourceContext::headers)
        .unwrap_or_default();
    let client = net::client(settings)?;
    let info = probe(&client, &request.url, &headers).await?;
    if control.interrupted() {
        return Err(AppError::Canceled);
    }

    let chosen = request
        .file
        .as_ref()
        .and_then(|file| file.file_name.as_deref())
        .map(clean_name)
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| info.file_name.clone());
    let extension = extension_of(&chosen).unwrap_or_default();

    let output_dir = PathBuf::from(
        request
            .output_dir
            .clone()
            .unwrap_or_else(|| settings.download_dir.clone()),
    );
    std::fs::create_dir_all(&output_dir)?;

    let temp_dir = paths::temp_dir()?;
    let staged = ffmpeg::intermediate_path(
        &temp_dir,
        task_id,
        "f",
        if extension.is_empty() { "bin" } else { &extension },
    );

    limiter::global().set_kbps(settings.speed_limit_kbps);
    let known_size = info.size;
    let mut sink = |sample: ProgressSample| {
        on_update(DownloadProgress {
            received_bytes: sample.received,
            total_bytes: sample.total.or(known_size),
            percent: sample.percent,
            speed_bps: sample.speed_bps,
            eta_sec: sample.eta_sec,
            stage: DownloadStage::File,
            stage_index: 1,
            stage_count: 1,
            resumable: sample.resumable,
            segments: sample.segments,
        });
    };
    http::fetch(
        &client,
        http::FetchOptions {
            url: &request.url,
            headers: &headers,
            target: &staged,
            low_resource: settings.low_resource_mode,
            connections: settings.connections_per_download,
        },
        Arc::clone(&control),
        &mut sink,
    )
    .await?;

    on_update(DownloadProgress {
        stage: DownloadStage::Finalizing,
        percent: Some(99.0),
        ..Default::default()
    });
    let final_path = super::finalize(&staged, &output_dir.join(&chosen))?;
    let file_size = std::fs::metadata(&final_path).map(|meta| meta.len()).unwrap_or(0);
    on_update(DownloadProgress {
        received_bytes: file_size,
        total_bytes: Some(file_size),
        percent: Some(100.0),
        stage: DownloadStage::Done,
        ..Default::default()
    });
    log_info!(
        "downloader",
        "task {task_id} completed: {} ({file_size} bytes)",
        final_path.display()
    );

    let saved_name = final_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or(chosen);
    Ok(DownloadOutcome {
        output_path: final_path,
        file_size,
        label: label_for(&extension),
        quality_label: FILE_QUALITY.to_string(),
        container: extension,
        metadata: metadata_for(request, &saved_name),
    })
}

/// What a file's row says where a media row says its quality.
pub const FILE_QUALITY: &str = "File";

/// The queue card's label for a file: its type, as people name one.
pub fn label_for(extension: &str) -> String {
    if extension.is_empty() {
        FILE_QUALITY.to_string()
    } else {
        extension.to_ascii_uppercase()
    }
}

/// The label a file request shows before it has been probed.
pub fn provisional_label(request: &DownloadRequest) -> String {
    let named = request
        .file
        .as_ref()
        .and_then(|file| file.file_name.as_deref())
        .and_then(extension_of)
        .or_else(|| extension_in_url(&request.url));
    label_for(&named.unwrap_or_default())
}

/// The history row of a finished file. A file has no media to describe, so
/// this is the few fields a row shows: its name, where it came from and the
/// site that served it.
fn metadata_for(request: &DownloadRequest, saved_name: &str) -> MediaMetadata {
    let host = reqwest::Url::parse(&request.url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string));
    MediaMetadata {
        url: request.url.clone(),
        canonical_url: request.url.clone(),
        platform: PlatformId::Direct,
        platform_label: PlatformId::Direct.label().to_string(),
        provider_id: "file".to_string(),
        // Not read for a file: nothing but the fields above reaches its row.
        media_kind: MediaKind::Video,
        title: saved_name.to_string(),
        creator: host,
        description: None,
        thumbnail_url: None,
        duration_sec: None,
        view_count: None,
        like_count: None,
        upload_date: None,
        is_live: false,
        formats: Vec::new(),
        entry_count: None,
        watermark_support: WatermarkSupport::NotApplicable,
        range_fetchable: false,
        warnings: Vec::new(),
        entries: Vec::new(),
        tracks: Vec::new(),
        items: Vec::new(),
        music: None,
    }
}

/// The name a file is saved under, from what the server and the address say.
///
/// The server's `Content-Disposition` wins: an address like
/// `download.php?id=7` says nothing about the file. Then the last part of the
/// address after redirects, which is where a short link ends up, then the one
/// asked for. A name that ends in a script's extension, or has none, takes
/// the extension its type implies.
pub fn resolve_name(disposition: Option<&str>, final_url: &str, asked_url: &str, mime: Option<&str>) -> String {
    let from_server = disposition.and_then(disposition_name).map(|name| clean_name(&name));
    let from_address = || {
        [final_url, asked_url]
            .into_iter()
            .filter_map(last_segment)
            .map(|name| clean_name(&name))
            .find(|name| !name.is_empty())
    };
    let mut name = from_server
        .filter(|name| !name.is_empty())
        .or_else(from_address)
        .unwrap_or_else(|| "download".to_string());

    let implied = mime.and_then(extension_for_mime);
    match (extension_of(&name), implied) {
        (Some(current), Some(implied)) if SCRIPT_EXTENSIONS.contains(&current.as_str()) => {
            let stem = name[..name.len() - current.len() - 1].to_string();
            name = format!("{stem}.{implied}");
        }
        (None, Some(implied)) => name = format!("{name}.{implied}"),
        _ => {}
    }
    name
}

/// The file name a `Content-Disposition` value gives, if any.
///
/// RFC 6266: `filename*` (RFC 5987, `charset'lang'percent-encoded`) is
/// preferred over `filename`, which may be quoted with backslash escapes.
pub fn disposition_name(value: &str) -> Option<String> {
    let mut plain = None;
    let mut extended = None;
    for part in split_params(value) {
        let Some((key, raw)) = part.split_once('=') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        let raw = raw.trim();
        if key == "filename*" {
            extended = decode_extended(raw);
        } else if key == "filename" {
            plain = Some(unquote(raw));
        }
    }
    extended.or(plain).map(|name| {
        // Only the last part of a path: a name is not a place to save to.
        name.rsplit(['/', '\\']).next().unwrap_or("").to_string()
    })
    .filter(|name| !name.trim().is_empty())
}

/// `;`-separated parameters, with a `;` inside quotes left alone.
fn split_params(value: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut escaped = false;
    for ch in value.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        match ch {
            '\\' if quoted => {
                current.push(ch);
                escaped = true;
            }
            '"' => {
                quoted = !quoted;
                current.push(ch);
            }
            ';' if !quoted => parts.push(std::mem::take(&mut current)),
            _ => current.push(ch),
        }
    }
    parts.push(current);
    parts
}

fn unquote(raw: &str) -> String {
    let Some(inner) = raw.strip_prefix('"').and_then(|rest| rest.strip_suffix('"')) else {
        return raw.to_string();
    };
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            if let Some(next) = chars.next() {
                out.push(next);
            }
        } else {
            out.push(ch);
        }
    }
    out
}

/// `UTF-8''na%C3%AFve.txt` -> `naïve.txt`. ISO-8859-1 is read byte for byte,
/// which is what it is.
fn decode_extended(raw: &str) -> Option<String> {
    let mut pieces = raw.trim_matches('"').splitn(3, '\'');
    let charset = pieces.next()?.to_ascii_lowercase();
    let _language = pieces.next()?;
    let encoded = pieces.next()?;
    let bytes = percent_bytes(encoded);
    match charset.as_str() {
        "utf-8" | "utf8" | "" => String::from_utf8(bytes).ok(),
        "iso-8859-1" | "latin1" => Some(bytes.into_iter().map(char::from).collect()),
        _ => None,
    }
}

fn percent_bytes(encoded: &str) -> Vec<u8> {
    let hex = |byte: u8| (byte as char).to_digit(16).map(|digit| digit as u8);
    let bytes = encoded.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2])) {
                out.push(high << 4 | low);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    out
}

/// The last part of an address's path, percent-decoded.
fn last_segment(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let segment = parsed.path_segments()?.next_back()?.to_string();
    if segment.is_empty() {
        return None;
    }
    Some(String::from_utf8_lossy(&percent_bytes(&segment)).into_owned())
}

/// A name a file system takes, its stem cut to a sensible length.
pub fn clean_name(raw: &str) -> String {
    let safe = filename::sanitize_component(raw);
    match extension_of(&safe) {
        Some(extension) => {
            let stem = &safe[..safe.len() - extension.len() - 1];
            format!("{}.{extension}", filename::truncate_stem(stem, MAX_STEM_CHARS))
        }
        None => filename::truncate_stem(&safe, MAX_STEM_CHARS),
    }
}

/// The extension of a file name, lowercase: what follows the last dot, when
/// that looks like an extension rather than part of a name.
pub fn extension_of(name: &str) -> Option<String> {
    let (stem, extension) = name.rsplit_once('.')?;
    let usable = !stem.is_empty()
        && (1..=10).contains(&extension.len())
        && extension.chars().all(|ch| ch.is_ascii_alphanumeric());
    usable.then(|| extension.to_ascii_lowercase())
}

fn extension_in_url(url: &str) -> Option<String> {
    last_segment(url).as_deref().and_then(extension_of)
}

/// Server-side scripts, whose names say how a file was served and not what
/// it is.
const SCRIPT_EXTENSIONS: &[&str] = &["php", "asp", "aspx", "jsp", "cgi", "pl", "do", "action"];

/// The extension a `Content-Type` implies, for the types a download manager
/// meets often. `application/octet-stream` implies nothing.
pub fn extension_for_mime(mime: &str) -> Option<&'static str> {
    Some(match mime {
        "application/zip" | "application/x-zip-compressed" => "zip",
        "application/x-7z-compressed" => "7z",
        "application/vnd.rar" | "application/x-rar-compressed" => "rar",
        "application/gzip" | "application/x-gzip" => "gz",
        "application/x-tar" => "tar",
        "application/x-xz" => "xz",
        "application/x-bzip2" => "bz2",
        "application/pdf" => "pdf",
        "application/x-msdownload" | "application/x-dosexec" | "application/vnd.microsoft.portable-executable" => "exe",
        "application/x-msi" | "application/x-ms-installer" => "msi",
        "application/vnd.android.package-archive" => "apk",
        "application/x-iso9660-image" => "iso",
        "application/x-apple-diskimage" => "dmg",
        "application/epub+zip" => "epub",
        "application/msword" => "doc",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => "docx",
        "application/vnd.ms-excel" => "xls",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => "xlsx",
        "application/vnd.ms-powerpoint" => "ppt",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" => "pptx",
        "application/json" => "json",
        "text/plain" => "txt",
        "text/csv" => "csv",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/x-matroska" => "mkv",
        "audio/mpeg" => "mp3",
        "audio/mp4" => "m4a",
        "audio/ogg" => "ogg",
        "audio/flac" => "flac",
        "audio/wav" | "audio/x-wav" => "wav",
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => return None,
    })
}

/// Extensions a copied link is taken for a file download by, as a download
/// manager's default list has them: archives, installers, disk images,
/// documents and media files.
pub const FILE_EXTENSIONS: &[&str] = &[
    // Archives
    "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "tbz2", "xz", "txz", "zst", "lz", "lzh", "arj", "ace",
    "cab", "z",
    // Programs and packages
    "exe", "msi", "msix", "msu", "appx", "appxbundle", "apk", "xapk", "aab", "deb", "rpm", "appimage",
    "jar", "pkg", "run",
    // Disk images
    "iso", "img", "dmg", "bin", "vhd", "vhdx", "vmdk", "ova",
    // Documents
    "pdf", "epub", "mobi", "djvu", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pps", "odt", "ods", "odp",
    "rtf", "csv",
    // Media
    "mp4", "m4v", "mkv", "webm", "mov", "avi", "wmv", "flv", "mpg", "mpeg", "3gp", "ts", "mp3", "m4a",
    "m4b", "aac", "flac", "wav", "ogg", "oga", "opus", "wma",
];

/// Whether a copied link points straight at a file a download manager would
/// take: an http(s) address whose last part ends in one of
/// [`FILE_EXTENSIONS`]. A page that merely mentions a file is not one.
pub fn is_file_link(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none_or(str::is_empty) {
        return false;
    }
    extension_in_url(url).is_some_and(|extension| FILE_EXTENSIONS.contains(&extension.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_server_name_wins_and_the_extended_form_wins_over_the_plain_one() {
        assert_eq!(
            disposition_name(r#"attachment; filename="report 2026.pdf""#).as_deref(),
            Some("report 2026.pdf")
        );
        assert_eq!(disposition_name("attachment; filename=setup.exe").as_deref(), Some("setup.exe"));
        assert_eq!(
            disposition_name(r#"attachment; filename="fallback.txt"; filename*=UTF-8''na%C3%AFve%20file.txt"#)
                .as_deref(),
            Some("naïve file.txt")
        );
        assert_eq!(
            disposition_name("attachment; filename*=iso-8859-1'en'%A3%20rates.txt").as_deref(),
            Some("£ rates.txt")
        );
        // A quoted name may hold an escaped quote and a semicolon.
        assert_eq!(
            disposition_name(r#"attachment; filename="a \"b\"; c.zip""#).as_deref(),
            Some(r#"a "b"; c.zip"#)
        );
        assert_eq!(disposition_name("inline").as_deref(), None);
        assert_eq!(disposition_name(r#"attachment; filename="""#).as_deref(), None);
    }

    #[test]
    fn a_name_never_carries_a_path() {
        assert_eq!(
            disposition_name(r"attachment; filename=..\..\Windows\evil.dll").as_deref(),
            Some("evil.dll")
        );
        // Quoted, a backslash escapes the character after it (RFC 9110), so
        // nothing of the path is left to separate.
        let quoted = disposition_name(r#"attachment; filename="..\..\Windows\evil.dll""#).unwrap();
        assert!(!quoted.contains(['/', '\\']), "{quoted}");
        assert_eq!(
            disposition_name("attachment; filename=/etc/passwd").as_deref(),
            Some("passwd")
        );
    }

    #[test]
    fn without_a_server_name_the_address_names_the_file() {
        assert_eq!(
            resolve_name(None, "https://cdn.example/files/My%20Setup.exe?sig=1", "https://x.example/d", None),
            "My Setup.exe"
        );
        // A short link names nothing; where it led does.
        assert_eq!(
            resolve_name(None, "https://mirror.example/pub/linux.iso", "https://bit.ly/abc", None),
            "linux.iso"
        );
        assert_eq!(resolve_name(None, "https://example.com/", "https://example.com/", None), "download");
    }

    #[test]
    fn a_script_name_or_a_bare_one_takes_the_extension_its_type_implies() {
        assert_eq!(
            resolve_name(None, "https://site.example/download.php?id=7", "https://site.example/download.php?id=7", Some("application/zip")),
            "download.zip"
        );
        assert_eq!(
            resolve_name(None, "https://site.example/get/latest", "https://site.example/get/latest", Some("application/pdf")),
            "latest.pdf"
        );
        // A name that already says what it is keeps it.
        assert_eq!(
            resolve_name(Some("attachment; filename=data.bin"), "https://s.example/x", "https://s.example/x", Some("application/zip")),
            "data.bin"
        );
        // An opaque type implies nothing.
        assert_eq!(
            resolve_name(None, "https://s.example/blob", "https://s.example/blob", Some("application/octet-stream")),
            "blob"
        );
    }

    #[test]
    fn a_name_is_made_safe_for_the_file_system() {
        assert_eq!(clean_name("a<b>c:d.zip"), "a-b-c-d.zip");
        assert_eq!(clean_name("CON.txt"), "_CON.txt");
        let long = format!("{}.zip", "x".repeat(400));
        let cleaned = clean_name(&long);
        assert!(cleaned.ends_with(".zip"));
        assert!(cleaned.chars().count() <= MAX_STEM_CHARS + 4);
    }

    #[test]
    fn extensions_are_read_only_where_they_look_like_one() {
        assert_eq!(extension_of("archive.tar.gz").as_deref(), Some("gz"));
        assert_eq!(extension_of("Setup.EXE").as_deref(), Some("exe"));
        assert_eq!(extension_of("README").as_deref(), None);
        assert_eq!(extension_of(".bashrc").as_deref(), None);
        assert_eq!(extension_of("version 1.2 final").as_deref(), None);
    }

    #[test]
    fn a_copied_link_is_a_file_link_only_when_it_ends_in_a_file() {
        for yes in [
            "https://github.com/x/y/releases/download/v1/app-1.0.0.msi",
            "https://cdn.example/a/b/archive.ZIP?token=abc",
            "http://192.168.1.5/share/movie.mkv",
            "https://example.com/file%20name.pdf#page=2",
        ] {
            assert!(is_file_link(yes), "{yes}");
        }
        for no in [
            "https://www.youtube.com/watch?v=jNQXAC9IVRw",
            "https://example.com/",
            "https://example.com/zip",
            "https://example.com/page.html",
            "ftp://files.example/a.zip",
            "file:///C:/a.zip",
            "not a link.zip",
        ] {
            assert!(!is_file_link(no), "{no}");
        }
    }

    #[test]
    fn a_file_is_labelled_by_its_type() {
        assert_eq!(label_for("zip"), "ZIP");
        assert_eq!(label_for(""), "File");
        let request = |name: Option<&str>, url: &str| DownloadRequest {
            url: url.into(),
            mode: crate::model::DownloadMode::Video,
            quality: crate::model::QualityPreference::Best,
            video_format_id: None,
            audio_format_id: None,
            container: None,
            watermark: crate::model::WatermarkPreference::Any,
            output_dir: None,
            title: None,
            thumbnail_url: None,
            platform: None,
            entry: None,
            audio_language: None,
            source: None,
            file: Some(crate::model::FileDownload {
                file_name: name.map(str::to_string),
            }),
        };
        assert_eq!(provisional_label(&request(None, "https://a.example/x.iso")), "ISO");
        assert_eq!(provisional_label(&request(Some("notes.txt"), "https://a.example/get")), "TXT");
        assert_eq!(provisional_label(&request(None, "https://a.example/get")), "File");
    }

    #[test]
    fn a_capture_is_taken_only_when_the_app_is_served_the_same_file() {
        let served = |mime: &str, size: Option<u64>| FileInfo {
            file_name: "x.zip".into(),
            size,
            mime: Some(mime.into()),
            resumable: true,
            final_url: String::new(),
        };
        // The same file, said the same way or not said at all.
        assert!(same_as_captured(&served("application/zip", Some(10)), Some("application/zip"), Some(10)));
        assert!(same_as_captured(&served("application/zip", Some(10)), None, None));
        assert!(same_as_captured(&served("application/octet-stream", None), Some("application/zip"), Some(10)));
        // A sign-in page where the browser got a file.
        assert!(!same_as_captured(&served("text/html", Some(10)), Some("application/zip"), Some(10)));
        assert!(!same_as_captured(&served("text/html", None), None, None));
        // Something of another size.
        assert!(!same_as_captured(&served("application/zip", Some(9)), Some("application/zip"), Some(10)));
        // A page the browser was itself downloading is a page either way.
        assert!(same_as_captured(&served("text/html", Some(10)), Some("text/html; charset=utf-8"), Some(10)));
    }

    #[test]
    fn a_page_is_told_from_a_file_by_its_type() {
        let info = |mime: Option<&str>| FileInfo {
            file_name: "x".into(),
            size: None,
            mime: mime.map(str::to_string),
            resumable: false,
            final_url: String::new(),
        };
        assert!(info(Some("text/html")).is_page());
        assert!(!info(Some("application/zip")).is_page());
        assert!(!info(None).is_page());
    }
}
