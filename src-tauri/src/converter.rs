//! Converting media files that are already on disk.
//!
//! This is the only part of the app that starts from a local file rather than a
//! URL, but it reuses the same machinery: FFmpeg is driven through
//! [`crate::ffmpeg::run_with_progress`], and a job is interrupted through the
//! same [`TaskControl`] a download uses.
//!
//! Two rules shape everything here:
//!
//!   1. **Repackage before re-encoding.** Moving an H.264 track from MKV into
//!      MP4 is a copy: it takes seconds and loses nothing. Only when the target
//!      container genuinely cannot hold the source codecs -- or the user asked
//!      for a smaller frame or a different bitrate -- is anything re-encoded.
//!   2. **Never write over the source.** The output name is made unique in its
//!      directory at the moment the job runs, so converting `clip.mkv` to MP4
//!      beside itself produces `clip.mp4`, and doing it twice produces
//!      `clip (2).mp4` rather than silently replacing the first one.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use once_cell::sync::Lazy;
use regex::Regex;
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

use crate::downloader::control::TaskControl;
use crate::downloader::plan;
use crate::error::{AppError, AppResult};
use crate::ffmpeg::{self, FfmpegProgress};
use crate::model::{
    ConvertFormatInfo, ConvertJob, ConvertKind, ConvertOptions, ConvertProgressEvent,
    ConvertQuality, ConvertRequest, ConvertStatus, MediaProbe,
};
use crate::settings::Settings;
use crate::{filename, log_info, log_warn, paths, process, tools, util};

pub const EVENT_CHANGED: &str = "convert://changed";
pub const EVENT_PROGRESS: &str = "convert://progress";

/// Formats offered as a target, each list in the order it is shown: the ones
/// people reach for most come first. Anything not on one of these lists is
/// refused: the arguments FFmpeg needs differ per format, and an unchecked
/// extension would reach the command line as an output path.
pub(crate) const VIDEO_FORMATS: [&str; 12] = [
    "mp4", "mov", "mkv", "webm", "avi", "wmv", "flv", "mpg", "m4v", "3gp", "ts", "ogv",
];
pub(crate) const AUDIO_FORMATS: [&str; 12] = [
    "mp3", "wav", "m4a", "flac", "aac", "ogg", "opus", "wma", "aiff", "alac", "ac3", "amr",
];
pub(crate) const GIF_FORMATS: [&str; 1] = ["gif"];
/// HEIC is read but not offered: no FFmpeg build can write one.
pub(crate) const IMAGE_FORMATS: [&str; 9] =
    ["jpg", "png", "webp", "avif", "bmp", "tiff", "ico", "tga", "jp2"];

/// Targets with nothing to tune. They are lossless or uncompressed -- or, for
/// AMR, made at one rate only -- so neither a quality nor a bitrate is offered.
const FIXED_FORMATS: [&str; 10] =
    ["wav", "flac", "aiff", "alac", "amr", "png", "bmp", "tiff", "ico", "tga"];

/// An icon cannot be larger than this on either side.
const ICO_MAX_SIDE: u32 = 256;

/// A GIF counts time in hundredths of a second, and browsers slow a frame
/// shorter than two of them down to ten, so 50 is the fastest rate a GIF
/// actually plays at.
const GIF_MAX_FPS: f64 = 50.0;

pub fn format_kind(target: &str) -> Option<ConvertKind> {
    let target = target.trim().to_ascii_lowercase();
    let target = target.as_str();
    if VIDEO_FORMATS.contains(&target) {
        Some(ConvertKind::Video)
    } else if AUDIO_FORMATS.contains(&target) {
        Some(ConvertKind::Audio)
    } else if GIF_FORMATS.contains(&target) {
        Some(ConvertKind::Gif)
    } else if IMAGE_FORMATS.contains(&target) {
        Some(ConvertKind::Image)
    } else {
        None
    }
}

/// The extension a target is written with. Apple Lossless is the one format
/// named after its codec rather than its file.
pub(crate) fn extension_for(target: &str) -> &str {
    match target {
        "alac" => "m4a",
        other => other,
    }
}

fn is_tunable(target: &str) -> bool {
    !FIXED_FORMATS.contains(&target)
}

/// The list the UI renders. Names live in the translation dictionary; this is
/// only the set of ids, so the two sides cannot offer different formats.
pub fn catalogue() -> Vec<ConvertFormatInfo> {
    let kinds = [
        (&VIDEO_FORMATS[..], ConvertKind::Video),
        (&AUDIO_FORMATS[..], ConvertKind::Audio),
        (&GIF_FORMATS[..], ConvertKind::Gif),
        (&IMAGE_FORMATS[..], ConvertKind::Image),
    ];
    kinds
        .iter()
        .flat_map(|(ids, kind)| ids.iter().map(move |id| (*id, *kind)))
        .map(|(id, kind)| ConvertFormatInfo {
            id: id.to_string(),
            kind,
            tunable: is_tunable(id),
        })
        .collect()
}

// -- probing ---------------------------------------------------------------

pub(crate) fn ffprobe_path() -> Option<PathBuf> {
    // The managed FFmpeg install puts ffprobe next to ffmpeg, and a system
    // install almost always does too.
    if let Some(ffmpeg) = tools::ffmpeg_path() {
        let sibling = ffmpeg.with_file_name(if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" });
        if sibling.is_file() {
            return Some(sibling);
        }
    }
    process::which("ffprobe")
}

/// Read what a local file actually contains.
///
/// ffprobe is asked first because its JSON is unambiguous. When it is not on
/// disk -- a system FFmpeg installed without it -- the same facts are recovered
/// from the banner `ffmpeg -i` prints, which is less precise but enough to show
/// the file and to drive a progress bar.
pub async fn probe(path: &str) -> AppResult<MediaProbe> {
    let file = Path::new(path);
    let meta = std::fs::metadata(file)
        .map_err(|err| AppError::Io(format!("{path} could not be read: {err}")))?;
    if !meta.is_file() {
        return Err(AppError::Io(format!("{path} is not a file")));
    }

    let mut probe = MediaProbe {
        path: path.to_string(),
        file_name: file
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string()),
        container: file
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("")
            .to_ascii_lowercase(),
        size_bytes: meta.len(),
        duration_sec: None,
        width: None,
        height: None,
        fps: None,
        pixel_aspect: None,
        video_duration_sec: None,
        video_codec: None,
        audio_codec: None,
        audio_bitrate_kbps: None,
        has_video: false,
        has_audio: false,
        still: false,
    };

    let mut read = false;
    if let Some(binary) = ffprobe_path() {
        match probe_with_ffprobe(&binary, path, &mut probe).await {
            Ok(()) => read = true,
            Err(err) => log_warn!("convert", "ffprobe could not read {path}: {err}"),
        }
        if read && is_tiled_still(&probe) {
            if let Some(grid) = tile_grid(&binary, path).await {
                probe.width = Some(grid.width);
                probe.height = Some(grid.height);
            }
        }
    }
    if !read {
        probe_with_ffmpeg(path, &mut probe).await?;
    }

    // A picture has no length. FFmpeg gives a JPEG the 0.04 seconds of one
    // frame at 25 a second, which would read as a film that ends at once.
    if probe.still {
        probe.duration_sec = None;
        probe.video_duration_sec = None;
    }
    Ok(probe)
}

/// A HEIC or AVIF photo: a single picture in a codec of the MP4 family.
///
/// Such a photo is usually stored as a grid of tiles, each a stream of its own.
/// FFmpeg 7.1 reads only the first tile -- a 704x976 corner of a 4182x5798
/// photo -- and newer builds put the grid back together with a filter graph
/// of their own that refuses to be followed by any filter of ours,
/// so a photo converted with a size or a format filter fails outright. Either
/// way the photo is first assembled into a whole picture; see [`TileGrid`].
fn is_tiled_still(probe: &MediaProbe) -> bool {
    probe.still && matches!(probe.video_codec.as_deref(), Some("hevc" | "av1"))
}

/// How a photo's tiles fit together, as ffprobe describes the grid.
#[derive(Debug, Clone, PartialEq)]
struct TileGrid {
    /// Each tile's stream and where its corner sits on the grid.
    tiles: Vec<(u64, u64, u64)>,
    /// The picture: a window onto the grid, which is coded a little larger.
    width: u32,
    height: u32,
    left: u64,
    top: u64,
}

impl TileGrid {
    /// Lay the tiles out and cut the picture from them. Measured on a phone
    /// camera's photo: identical, pixel for pixel, to the picture FFmpeg
    /// assembles itself.
    fn filter_graph(&self) -> String {
        let inputs: String = self.tiles.iter().map(|(stream, _, _)| format!("[0:{stream}]")).collect();
        let layout: Vec<String> = self.tiles.iter().map(|(_, x, y)| format!("{x}_{y}")).collect();
        format!(
            "{inputs}xstack=inputs={}:layout={},crop={}:{}:{}:{}[whole]",
            self.tiles.len(),
            layout.join("|"),
            self.width,
            self.height,
            self.left,
            self.top
        )
    }
}

/// The grid in ffprobe's `-show_stream_groups` answer. A photo can carry a
/// second, smaller grid for its thumbnail; the largest is the photo.
fn parse_tile_grid(json: &serde_json::Value) -> Option<TileGrid> {
    let number = |part: &serde_json::Value, key: &str| part.get(key).and_then(|value| value.as_u64());
    json.get("stream_groups")?
        .as_array()?
        .iter()
        .filter(|group| group.get("type").and_then(|value| value.as_str()) == Some("Tile Grid"))
        .filter_map(|group| group.get("components").and_then(|value| value.as_array()))
        .flatten()
        .filter_map(|part| {
            let tiles = part
                .get("subcomponents")?
                .as_array()?
                .iter()
                .map(|tile| {
                    Some((
                        number(tile, "stream_index")?,
                        number(tile, "tile_horizontal_offset")?,
                        number(tile, "tile_vertical_offset")?,
                    ))
                })
                .collect::<Option<Vec<_>>>()?;
            if tiles.is_empty() {
                return None;
            }
            Some(TileGrid {
                tiles,
                width: u32::try_from(number(part, "width")?).ok()?,
                height: u32::try_from(number(part, "height")?).ok()?,
                left: number(part, "horizontal_offset").unwrap_or(0),
                top: number(part, "vertical_offset").unwrap_or(0),
            })
        })
        .max_by_key(|grid| u64::from(grid.width) * u64::from(grid.height))
}

/// Ask ffprobe how a photo's tiles fit. An ffprobe too old to know stream
/// groups answers nothing, which leaves FFmpeg to read the photo its own way.
async fn tile_grid(binary: &Path, path: &str) -> Option<TileGrid> {
    let args: Vec<String> = vec![
        "-v".into(),
        "error".into(),
        "-print_format".into(),
        "json".into(),
        "-show_stream_groups".into(),
        path.to_string(),
    ];
    let output = process::run(binary, &args).await.ok()?;
    if !output.success() {
        return None;
    }
    parse_tile_grid(&serde_json::from_str(&output.stdout).ok()?)
}

/// The demuxers FFmpeg reads a single picture file with: `image2` for JPEG and
/// the like, `ico`, and the `*_pipe` family it names after each codec.
fn is_picture_demuxer(format_name: &str) -> bool {
    format_name == "image2" || format_name == "ico" || format_name.ends_with("_pipe")
}

/// A picture rather than a film. Most pictures come through a demuxer of their
/// own; AVIF and HEIC come through the MP4 one and say so by holding a single
/// frame, as a GIF of one frame does.
fn is_still(format_name: &str, stream: &serde_json::Value) -> bool {
    if is_picture_demuxer(format_name) {
        return true;
    }
    if stream
        .pointer("/disposition/still_image")
        .and_then(|value| value.as_u64())
        == Some(1)
    {
        return true;
    }
    stream
        .get("nb_frames")
        .and_then(|value| value.as_str())
        .and_then(|value| value.parse::<u64>().ok())
        == Some(1)
}

async fn probe_with_ffprobe(binary: &Path, path: &str, out: &mut MediaProbe) -> AppResult<()> {
    let args: Vec<String> = vec![
        "-v".into(),
        "error".into(),
        "-print_format".into(),
        "json".into(),
        "-show_format".into(),
        "-show_streams".into(),
        path.to_string(),
    ];

    let output = process::run(binary, &args).await?;
    if !output.success() {
        return Err(AppError::Other(format!(
            "ffprobe exited with {:?}: {}",
            output.status,
            output.stderr.lines().next().unwrap_or("no detail").trim()
        )));
    }

    let json: serde_json::Value =
        serde_json::from_str(&output.stdout).map_err(|err| AppError::Parse(err.to_string()))?;

    out.duration_sec = json
        .pointer("/format/duration")
        .and_then(|value| value.as_str())
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| *value > 0.0);
    let format_name = json
        .pointer("/format/format_name")
        .and_then(|value| value.as_str())
        .unwrap_or("");

    let Some(streams) = json.get("streams").and_then(|value| value.as_array()) else {
        return Ok(());
    };

    for stream in streams {
        match stream.get("codec_type").and_then(|value| value.as_str()) {
            // Cover art is stored as a video stream with a single frame.
            // Treating it as video would make an MP3 look like a film.
            Some("video") if !is_cover_art(stream) => {
                if out.has_video {
                    continue;
                }
                out.has_video = true;
                out.still = is_still(format_name, stream);
                out.video_codec = stream
                    .get("codec_name")
                    .and_then(|value| value.as_str())
                    .map(str::to_string);
                out.width = stream
                    .get("width")
                    .and_then(|value| value.as_u64())
                    .map(|value| value as u32);
                out.height = stream
                    .get("height")
                    .and_then(|value| value.as_u64())
                    .map(|value| value as u32);
                out.fps = stream
                    .get("r_frame_rate")
                    .and_then(|value| value.as_str())
                    .and_then(parse_rational);
                // ffprobe leaves this out entirely for a stream that never
                // said, and prints "0:1" for one that said nothing useful;
                // both mean square pixels as far as anything downstream cares.
                out.pixel_aspect = stream
                    .get("sample_aspect_ratio")
                    .and_then(|value| value.as_str())
                    .and_then(parse_rational)
                    .filter(|value| *value > 0.0);
                // The container's duration is the longest of its streams. A
                // filmstrip laid out against it on a file whose audio outlasts
                // its picture ends in black cells, so the picture's own length
                // is kept separately rather than assumed to be the same.
                out.video_duration_sec = stream
                    .get("duration")
                    .and_then(|value| value.as_str())
                    .and_then(|value| value.parse::<f64>().ok())
                    .filter(|value| *value > 0.0);
            }
            Some("audio") => {
                if out.has_audio {
                    continue;
                }
                out.has_audio = true;
                out.audio_codec = stream
                    .get("codec_name")
                    .and_then(|value| value.as_str())
                    .map(str::to_string);
                out.audio_bitrate_kbps = stream
                    .get("bit_rate")
                    .and_then(|value| value.as_str())
                    .and_then(|value| value.parse::<f64>().ok())
                    .map(|bits| bits / 1000.0)
                    .filter(|value| *value > 0.0);
            }
            _ => {}
        }
    }

    if !out.has_video && !out.has_audio {
        return Err(AppError::Other("the file contains no media streams".into()));
    }
    Ok(())
}

/// A still image packed into an audio file: one frame, and FFmpeg marks it.
fn is_cover_art(stream: &serde_json::Value) -> bool {
    stream
        .pointer("/disposition/attached_pic")
        .and_then(|value| value.as_u64())
        == Some(1)
}

/// "30000/1001" -> 29.97. Returns None for the "0/0" FFmpeg reports when a
/// stream has no meaningful frame rate.
///
/// Both separators are accepted because ffprobe prints a frame rate with a
/// slash and a sample aspect ratio with a colon, and they are the same kind of
/// number.
fn parse_rational(value: &str) -> Option<f64> {
    let (num, den) = value.split_once(['/', ':'])?;
    let num: f64 = num.parse().ok()?;
    let den: f64 = den.parse().ok()?;
    if den == 0.0 || num == 0.0 {
        return None;
    }
    Some(num / den)
}

static DURATION_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d+)").expect("valid regex"));
static VIDEO_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"Stream #\d+:\d+.*: Video: (\w+).*?, (\d{2,5})x(\d{2,5})").expect("valid regex")
});
static AUDIO_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"Stream #\d+:\d+.*: Audio: (\w+)").expect("valid regex"));
static AUDIO_BITRATE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r": Audio:.*?, (\d+) kb/s").expect("valid regex"));
static INPUT_FORMAT_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"Input #0, ([\w,]+), from").expect("valid regex"));

/// Fallback probe. `ffmpeg -i` with no output file prints what it found and
/// exits non-zero, which is expected here rather than a failure.
async fn probe_with_ffmpeg(path: &str, out: &mut MediaProbe) -> AppResult<()> {
    let binary = tools::require_ffmpeg()?;
    let args: Vec<String> = vec![
        "-hide_banner".into(),
        "-nostdin".into(),
        "-i".into(),
        path.to_string(),
    ];
    let output = process::run(&binary, &args).await?;
    let text = output.stderr;

    if let Some(caps) = DURATION_RE.captures(&text) {
        let hours: f64 = caps[1].parse().unwrap_or(0.0);
        let minutes: f64 = caps[2].parse().unwrap_or(0.0);
        let seconds: f64 = caps[3].parse().unwrap_or(0.0);
        let fraction: f64 = format!("0.{}", &caps[4]).parse().unwrap_or(0.0);
        let total = hours * 3600.0 + minutes * 60.0 + seconds + fraction;
        out.duration_sec = (total > 0.0).then_some(total);
    }

    if let Some(caps) = VIDEO_RE.captures(&text) {
        out.has_video = true;
        out.video_codec = Some(caps[1].to_string());
        out.width = caps[2].parse().ok();
        out.height = caps[3].parse().ok();
    }
    if let Some(caps) = AUDIO_RE.captures(&text) {
        out.has_audio = true;
        out.audio_codec = Some(caps[1].to_string());
    }
    if let Some(caps) = AUDIO_BITRATE_RE.captures(&text) {
        out.audio_bitrate_kbps = caps[1].parse().ok();
    }
    if let Some(caps) = INPUT_FORMAT_RE.captures(&text) {
        out.still = out.has_video && is_picture_demuxer(&caps[1]);
    }

    if !out.has_video && !out.has_audio {
        return Err(AppError::Other(
            "no audio or video stream could be read from this file".into(),
        ));
    }
    Ok(())
}

// -- argument construction -------------------------------------------------

/// Whether a plain repackage is worth attempting at all.
///
/// FFmpeg would reject an impossible copy on its own, but an attempt costs a
/// process launch -- and choosing a quality, a smaller frame, a slower rate or
/// a bitrate is a request to re-encode by definition, which a copy would
/// silently ignore.
fn copy_is_plausible(
    target: &str,
    kind: ConvertKind,
    probe: &MediaProbe,
    options: &ConvertOptions,
) -> bool {
    match kind {
        ConvertKind::Video => {
            options.quality == ConvertQuality::Original
                && !probe.still
                && !shrinks(options.max_height, probe.height)
                && video_rate(probe, options.fps).is_none()
                && video_fits(target, probe.video_codec.as_deref().unwrap_or(""))
                && audio_fits_video(target, probe.audio_codec.as_deref().unwrap_or(""))
        }
        ConvertKind::Audio => {
            if options.audio_bitrate_kbps.is_some() {
                return false;
            }
            probe.has_audio && audio_codec_fits(target, probe.audio_codec.as_deref().unwrap_or(""))
        }
        // A GIF is always drawn anew: the palette is the conversion.
        ConvertKind::Gif => false,
        ConvertKind::Image => {
            probe.still
                && (options.quality == ConvertQuality::Original || !is_tunable(target))
                && !shrinks(side_cap(target, options), probe.width.max(probe.height))
                && image_codec_fits(target, probe.video_codec.as_deref().unwrap_or(""))
        }
    }
}

/// Whether a cap would make the picture smaller. A size the probe could not
/// read is assumed to need it; the scale itself never enlarges either way.
fn shrinks(cap: Option<u32>, size: Option<u32>) -> bool {
    match (cap, size) {
        (None, _) => false,
        (Some(cap), Some(size)) => size > cap,
        (Some(_), None) => true,
    }
}

/// The rate to convert a video to, when that is a change at all. A rate above
/// the source's would be frames invented by repeating others, so the source's
/// own rate stands instead.
fn video_rate(probe: &MediaProbe, requested: Option<f64>) -> Option<f64> {
    let rate = requested.filter(|value| value.is_finite() && *value > 0.0)?;
    match probe.fps {
        Some(source) if rate >= source - 0.5 => None,
        _ => Some(rate),
    }
}

/// The rate for a GIF, which is the video rule held under what a GIF can
/// play. "Same as the source" for a 60 fps clip is therefore 50.
fn gif_rate(probe: &MediaProbe, requested: Option<f64>) -> Option<f64> {
    if probe.still {
        return None;
    }
    let ceiling = probe.fps.map_or(GIF_MAX_FPS, |source| source.min(GIF_MAX_FPS));
    let rate = requested
        .filter(|value| value.is_finite() && *value > 0.0)
        .map_or(ceiling, |value| value.min(ceiling));
    match probe.fps {
        // Already at or under the rate asked for: nothing to drop.
        Some(source) if rate >= source - 0.5 => None,
        // An unread rate is only touched when a rate was asked for.
        None if requested.is_none() => None,
        _ => Some(rate),
    }
}

/// The longest side a picture may have. An icon has a ceiling of its own and
/// never goes without one.
fn side_cap(target: &str, options: &ConvertOptions) -> Option<u32> {
    if target == "ico" {
        return Some(options.max_side.unwrap_or(ICO_MAX_SIDE).min(ICO_MAX_SIDE));
    }
    options.max_side
}

/// Which source codecs each video container can take without re-encoding.
/// Matroska and AVI are let try anything: a copy they refuse falls through to
/// an encode, and one they accept is what the user asked for.
fn video_fits(target: &str, codec: &str) -> bool {
    let codec = codec.trim().to_ascii_lowercase();
    if codec.is_empty() {
        return true;
    }
    // An animation is a stream of pictures no film container plays.
    if codec == "gif" {
        return false;
    }
    let any = |families: &[&str]| families.iter().any(|family| codec.starts_with(family));
    match target {
        "mp4" | "mov" | "m4v" | "webm" => plan::container_holds_video(target, &codec),
        "3gp" => any(&["h264", "avc", "mpeg4", "h263"]),
        "flv" => any(&["h264", "avc", "flv1"]),
        "ts" => any(&["h264", "avc", "hevc", "h265", "mpeg2video", "mpeg1video"]),
        "mpg" => any(&["mpeg2video", "mpeg1video"]),
        "wmv" => any(&["wmv", "vc1"]),
        "ogv" => any(&["theora", "vp8"]),
        _ => true,
    }
}

/// Which source audio codecs each video container can take as they are.
///
/// Stricter than [`video_fits`], because it also decides whether the sound
/// rides along untouched while the picture is re-encoded, and a refusal there
/// fails the encode rather than falling through to another attempt.
fn audio_fits_video(target: &str, codec: &str) -> bool {
    let codec = codec.trim().to_ascii_lowercase();
    if codec.is_empty() {
        return true;
    }
    let any = |families: &[&str]| families.iter().any(|family| codec.starts_with(family));
    match target {
        "mp4" | "mov" | "m4v" | "webm" => plan::container_holds_audio(target, &codec),
        "mkv" => true,
        "avi" => any(&["mp3", "aac", "mp4a", "ac3", "mp2", "pcm"]),
        "3gp" => any(&["aac", "mp4a", "amr"]),
        "flv" => any(&["aac", "mp4a", "mp3"]),
        "ts" => any(&["aac", "mp4a", "mp3", "mp2", "ac3", "eac3", "opus"]),
        "mpg" => any(&["mp2", "mp3", "ac3"]),
        "wmv" => any(&["wma"]),
        "ogv" => any(&["vorbis", "opus", "flac"]),
        _ => false,
    }
}

/// Which source codecs each audio container can take without re-encoding.
fn audio_codec_fits(target: &str, codec: &str) -> bool {
    let codec = codec.trim().to_ascii_lowercase();
    if codec.is_empty() {
        return false;
    }
    match target {
        "mp3" => codec.starts_with("mp3"),
        "m4a" => {
            codec.starts_with("aac") || codec.starts_with("mp4a") || codec.starts_with("alac")
        }
        // A bare ADTS stream has no way to carry Apple Lossless.
        "aac" => codec.starts_with("aac") || codec.starts_with("mp4a"),
        "opus" => codec.starts_with("opus"),
        "ogg" => codec.starts_with("vorbis") || codec.starts_with("opus"),
        "flac" => codec.starts_with("flac"),
        "wav" => codec.starts_with("pcm"),
        "aiff" => codec.starts_with("pcm_s") && codec.ends_with("be"),
        "wma" => codec.starts_with("wma"),
        "alac" => codec.starts_with("alac"),
        "ac3" => codec == "ac3",
        "amr" => codec.starts_with("amr_nb"),
        _ => false,
    }
}

/// Whether a picture is already in the codec its target format stores.
fn image_codec_fits(target: &str, codec: &str) -> bool {
    let codec = codec.trim().to_ascii_lowercase();
    match target {
        "jpg" => codec == "mjpeg",
        "png" | "webp" | "bmp" | "tiff" => codec == target,
        "tga" => codec == "targa",
        "jp2" => codec == "jpeg2000",
        _ => false,
    }
}

/// Round to a standard rate at or below the source, so a 128 kbps file is never
/// "upconverted" into a bigger one carrying no more detail.
fn audio_bitrate(
    target: &str,
    probe: &MediaProbe,
    options: &ConvertOptions,
) -> Option<&'static str> {
    if matches!(target, "wav" | "flac" | "aiff" | "alac") {
        return None;
    }
    // AMR-NB's best mode, and the one every player expects.
    if target == "amr" {
        return Some("12.2k");
    }
    if let Some(requested) = options.audio_bitrate_kbps {
        return Some(match requested {
            value if value >= 320 => "320k",
            value if value >= 256 => "256k",
            value if value >= 192 => "192k",
            value if value >= 160 => "160k",
            value if value >= 128 => "128k",
            _ => "96k",
        });
    }
    Some(
        probe
            .audio_bitrate_kbps
            .map(|value| match value {
                value if value >= 320.0 => "320k",
                value if value >= 256.0 => "256k",
                value if value >= 192.0 => "192k",
                value if value >= 160.0 => "160k",
                _ => "128k",
            })
            .unwrap_or("192k"),
    )
}

/// Constant-quality value for the video encoder. Lower is better looking and
/// larger; these are the usual "visually lossless / good / small" points, with
/// "original" past the first of them. Each family has its own scale: VP9's is
/// not H.264's, MPEG-2 and Windows Media take a fixed quantiser where 2 is the
/// best, and Theora counts the other way, up to 10.
fn crf_for(target: &str, quality: ConvertQuality) -> &'static str {
    use ConvertQuality::{Balanced, High, Original, Small};
    match (target, quality) {
        ("webm", Original) => "20",
        ("webm", High) => "28",
        ("webm", Balanced) => "33",
        ("webm", Small) => "38",
        ("wmv" | "mpg", Original) => "2",
        ("wmv" | "mpg", High) => "3",
        ("wmv" | "mpg", Balanced) => "5",
        ("wmv" | "mpg", Small) => "8",
        ("ogv", Original) => "10",
        ("ogv", High) => "8",
        ("ogv", Balanced) => "6",
        ("ogv", Small) => "4",
        (_, Original) => "14",
        (_, High) => "18",
        (_, Balanced) => "23",
        (_, Small) => "28",
    }
}

/// Whether a video container is filled with H.264, the one family a graphics
/// card is asked to encode.
fn takes_h264(target: &str) -> bool {
    !matches!(target, "webm" | "wmv" | "mpg" | "ogv")
}

/// Which audio encoder belongs in a video container.
fn video_container_audio(target: &str) -> &'static str {
    match target {
        "webm" => "libopus",
        // AVI predates AAC; MP3 is what players expect to find in one.
        "avi" => "libmp3lame",
        "wmv" => "wmav2",
        "mpg" => "mp2",
        "ogv" => "libvorbis",
        _ => "aac",
    }
}

/// Which encoder writes an audio target.
fn audio_encoder(target: &str) -> &'static str {
    match target {
        "mp3" => "libmp3lame",
        "wav" => "pcm_s16le",
        "flac" => "flac",
        "opus" => "libopus",
        "ogg" => "libvorbis",
        "wma" => "wmav2",
        "aiff" => "pcm_s16be",
        "alac" => "alac",
        "ac3" => "ac3",
        "amr" => "libopencore_amrnb",
        _ => "aac",
    }
}

/// Fit inside a square of `side` without ever enlarging, keeping the shape.
fn fit_within(side: u32) -> String {
    format!(
        "scale='min({side},iw)':'min({side},ih)':force_original_aspect_ratio=decrease:flags=lanczos"
    )
}

/// Square the pixels of a source that does not use square ones. A GIF or a
/// picture has nowhere to say its pixels are another shape, so a 720x576 frame
/// meant to be shown 16:9 would come out squeezed.
fn square_pixels(probe: &MediaProbe) -> Option<&'static str> {
    probe
        .pixel_aspect
        .filter(|aspect| (aspect - 1.0).abs() > 0.01)
        .map(|_| "scale='trunc(iw*max(1,sar))':'trunc(ih/min(1,sar))',setsar=1")
}

/// Lay a picture over white. JPEG and AVIF as written here keep no
/// transparency, and FFmpeg left alone turns a transparent PNG's background
/// black; on white it looks the way it did in the viewer it came from.
const OVER_WHITE: &str = "split[bg][fg];[bg]format=rgba,lutrgb=r=255:g=255:b=255:a=255,\
                          format=rgb24[white];[white][fg]overlay=format=auto";

/// Palette size, how the palette is measured, and how its colours are mixed.
/// Error diffusion looks best and compresses worst; an ordered pattern over
/// only what moved between frames is what keeps a GIF small.
fn gif_palette(quality: ConvertQuality) -> (u32, &'static str, &'static str) {
    match quality {
        ConvertQuality::Original | ConvertQuality::High => (256, "full", "sierra2_4a"),
        ConvertQuality::Balanced => (256, "diff", "bayer:bayer_scale=3:diff_mode=rectangle"),
        ConvertQuality::Small => (128, "diff", "bayer:bayer_scale=2:diff_mode=rectangle"),
    }
}

/// The formats written through FFmpeg's `image2` muxer, which wants to be
/// told that one file is the whole of its output.
fn written_as_image2(target: &str) -> bool {
    matches!(target, "jpg" | "png" | "bmp" | "tiff" | "tga" | "jp2")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Pass {
    /// Repackage: no encoder is named at all.
    Copy,
    /// Re-encode on the GPU.
    Hardware,
    /// Re-encode on the CPU.
    Software,
}

fn build_args(
    input: &Path,
    output: &Path,
    target: &str,
    kind: ConvertKind,
    probe: &MediaProbe,
    options: &ConvertOptions,
    pass: Pass,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
        "-i".into(),
        input.to_string_lossy().into_owned(),
    ];

    match kind {
        // Only the first video and audio stream are carried over, and both are
        // optional. Copying a subtitle or data stream the target cannot hold
        // would fail a repackage that would otherwise have worked.
        ConvertKind::Video => {
            args.extend(["-map".into(), "0:v:0?".into(), "-map".into(), "0:a:0?".into()]);
        }
        ConvertKind::Audio => {
            args.extend(["-map".into(), "0:a:0?".into(), "-vn".into()]);
        }
        // FFmpeg is left to choose the picture: a HEIC photo is a grid of
        // tiles, and only its own choice puts them back together.
        ConvertKind::Gif | ConvertKind::Image => args.push("-an".into()),
    }
    args.extend(["-sn".into(), "-dn".into()]);

    if pass == Pass::Copy {
        args.extend(["-c".into(), "copy".into()]);
    } else {
        match kind {
            ConvertKind::Video => video_encode_args(&mut args, target, probe, options, pass),
            ConvertKind::Audio => audio_encode_args(&mut args, target, probe, options),
            ConvertKind::Gif => gif_encode_args(&mut args, probe, options),
            ConvertKind::Image => image_encode_args(&mut args, target, probe, options),
        }
    }

    if kind == ConvertKind::Image {
        args.extend(["-frames:v".into(), "1".into()]);
        if written_as_image2(target) {
            args.extend(["-update".into(), "1".into()]);
        }
    }

    // MP4 and its relatives keep their index at the end unless told otherwise,
    // which leaves a file unseekable until it is completely written.
    if matches!(extension_for(target), "mp4" | "mov" | "m4a" | "m4v" | "3gp") {
        args.extend(["-movflags".into(), "+faststart".into()]);
    }

    args.push(output.to_string_lossy().into_owned());
    args
}

fn video_encode_args(
    args: &mut Vec<String>,
    target: &str,
    probe: &MediaProbe,
    options: &ConvertOptions,
    pass: Pass,
) {
    // Cap the height without ever enlarging a smaller source, and keep both
    // sides even either way: H.264 cannot encode odd dimensions in 4:2:0, and
    // a GIF or a screen recording is often exactly that.
    let mut filters = vec![match options.max_height {
        Some(height) => format!("scale=-2:'trunc(min({height},ih)/2)*2'"),
        None => "scale='trunc(iw/2)*2':'trunc(ih/2)*2'".to_string(),
    }];
    // Exact in both directions with this and only with this; see the editor's
    // filter chain in `ffmpeg.rs`.
    if let Some(rate) = video_rate(probe, options.fps) {
        filters.push(format!("fps={rate}"));
    }
    args.extend(["-vf".into(), filters.join(",")]);

    let quality = crf_for(target, options.quality);
    match (target, pass) {
        ("webm", _) => args.extend([
            "-c:v".into(),
            "libvpx-vp9".into(),
            "-crf".into(),
            quality.into(),
            "-b:v".into(),
            "0".into(),
            // VP9 uses one thread per tile without this, which is the
            // difference between slow and unusable on a long file.
            "-row-mt".into(),
            "1".into(),
        ]),
        ("wmv", _) => args.extend(["-c:v".into(), "wmv2".into(), "-q:v".into(), quality.into()]),
        ("mpg", _) => {
            args.extend(["-c:v".into(), "mpeg2video".into(), "-q:v".into(), quality.into()])
        }
        ("ogv", _) => {
            args.extend(["-c:v".into(), "libtheora".into(), "-q:v".into(), quality.into()])
        }
        (_, Pass::Hardware) => args.extend([
            "-c:v".into(),
            "h264_nvenc".into(),
            "-rc".into(),
            "vbr".into(),
            "-cq".into(),
            quality.into(),
            "-b:v".into(),
            "0".into(),
        ]),
        _ => args.extend([
            "-c:v".into(),
            "libx264".into(),
            "-crf".into(),
            quality.into(),
            "-preset".into(),
            "veryfast".into(),
        ]),
    }
    // Chroma subsampling every player understands. Some sources are 10-bit or
    // 4:4:4, which many hardware decoders refuse.
    args.extend(["-pix_fmt".into(), "yuv420p".into()]);

    // Left as it is when the picture is all that has to change and the sound
    // already suits the container: there is nothing to gain from encoding it
    // again, and something to lose.
    let acodec = probe.audio_codec.as_deref().unwrap_or("");
    if options.quality == ConvertQuality::Original
        && !acodec.is_empty()
        && audio_fits_video(target, acodec)
    {
        args.extend(["-c:a".into(), "copy".into()]);
    } else {
        args.extend(["-c:a".into(), video_container_audio(target).into()]);
        if let Some(bitrate) = audio_bitrate(target, probe, options) {
            args.extend(["-b:a".into(), bitrate.into()]);
        }
    }
}

fn audio_encode_args(
    args: &mut Vec<String>,
    target: &str,
    probe: &MediaProbe,
    options: &ConvertOptions,
) {
    args.extend(["-c:a".into(), audio_encoder(target).into()]);
    // AMR-NB is narrowband speech: one channel at 8 kHz is all it encodes.
    if target == "amr" {
        args.extend(["-ar".into(), "8000".into(), "-ac".into(), "1".into()]);
    }
    if let Some(bitrate) = audio_bitrate(target, probe, options) {
        args.extend(["-b:a".into(), bitrate.into()]);
    }
}

fn gif_encode_args(args: &mut Vec<String>, probe: &MediaProbe, options: &ConvertOptions) {
    let mut chain: Vec<String> = Vec::new();
    if let Some(square) = square_pixels(probe) {
        chain.push(square.into());
    }
    // The rate goes first, so the frames it drops are never scaled.
    if let Some(rate) = gif_rate(probe, options.fps) {
        chain.push(format!("fps={rate}"));
    }
    if let Some(side) = options.max_side {
        chain.push(fit_within(side));
    }
    // One palette for the whole clip, measured from the clip itself rather
    // than the fixed web palette FFmpeg would otherwise fall back on.
    let (colours, stats, dither) = gif_palette(options.quality);
    chain.push(format!(
        "split[frames][measure];[measure]palettegen=max_colors={colours}:stats_mode={stats}[palette];\
         [frames][palette]paletteuse=dither={dither}"
    ));
    args.extend(["-vf".into(), chain.join(","), "-loop".into(), "0".into()]);
}

fn image_encode_args(
    args: &mut Vec<String>,
    target: &str,
    probe: &MediaProbe,
    options: &ConvertOptions,
) {
    use ConvertQuality::{Balanced, High, Original, Small};

    let quality = options.quality;
    let mut chain: Vec<String> = Vec::new();
    if let Some(square) = square_pixels(probe) {
        chain.push(square.into());
    }
    if let Some(side) = side_cap(target, options) {
        chain.push(fit_within(side));
    }
    match target {
        // Full chroma for the original, the usual half for anything smaller.
        "jpg" => {
            chain.push(OVER_WHITE.into());
            let format = if quality == Original { "format=yuvj444p" } else { "format=yuvj420p" };
            chain.push(format.into());
        }
        "avif" => {
            chain.push(OVER_WHITE.into());
            let format = if quality == Original { "format=yuv444p" } else { "format=yuv420p" };
            chain.push(format.into());
        }
        // Both store RGB, with or without transparency. Left to itself FFmpeg
        // writes a JPEG's YUV straight into the TIFF, which few viewers open.
        "tiff" | "jp2" => chain.push("format=rgba|rgb24".into()),
        "ico" => chain.push("format=rgba".into()),
        _ => {}
    }
    if !chain.is_empty() {
        args.extend(["-vf".into(), chain.join(",")]);
    }

    match target {
        "jpg" => {
            let scale = match quality {
                Original => "1",
                High => "2",
                Balanced => "4",
                Small => "7",
            };
            args.extend(["-c:v".into(), "mjpeg".into(), "-q:v".into(), scale.into()]);
            // The encoder will not go below 2 unless allowed to.
            if quality == Original {
                args.extend(["-qmin".into(), "1".into()]);
            }
        }
        "webp" => {
            args.extend(["-c:v".into(), "libwebp".into()]);
            match quality {
                Original => args.extend(["-lossless".into(), "1".into()]),
                High => args.extend(["-quality".into(), "90".into()]),
                Balanced => args.extend(["-quality".into(), "80".into()]),
                Small => args.extend(["-quality".into(), "60".into()]),
            }
        }
        "avif" => {
            // 0 is lossless for libaom, measured: an infinite PSNR against
            // the source.
            let crf = match quality {
                Original => "0",
                High => "18",
                Balanced => "26",
                Small => "36",
            };
            args.extend([
                "-c:v".into(),
                "libaom-av1".into(),
                "-still-picture".into(),
                "1".into(),
                "-crf".into(),
                crf.into(),
                "-b:v".into(),
                "0".into(),
            ]);
            args.extend(crate::ffmpeg::speed_args("libaom-av1"));
        }
        "jp2" => {
            args.extend(["-c:v".into(), "jpeg2000".into()]);
            match quality {
                // The reversible wavelet, which is JPEG 2000's lossless mode.
                Original => args.extend(["-pred".into(), "1".into()]),
                High => args.extend(["-q:v".into(), "2".into()]),
                Balanced => args.extend(["-q:v".into(), "8".into()]),
                Small => args.extend(["-q:v".into(), "20".into()]),
            }
        }
        "png" => args.extend(["-c:v".into(), "png".into()]),
        "bmp" => args.extend(["-c:v".into(), "bmp".into()]),
        "tiff" => args.extend([
            "-c:v".into(),
            "tiff".into(),
            "-compression_algo".into(),
            "lzw".into(),
        ]),
        // PNG inside the icon keeps transparency and is a fraction of the
        // size of the bitmap FFmpeg would otherwise store.
        "ico" => args.extend(["-c:v".into(), "png".into()]),
        "tga" => args.extend(["-c:v".into(), "targa".into()]),
        _ => {}
    }
}

// -- the job list ----------------------------------------------------------

/// Conversions run one at a time. Encoding saturates every core it is given, so
/// a second job running alongside finishes neither any sooner.
const MAX_CONCURRENT: u32 = 1;

pub struct ConvertManager {
    app: AppHandle,
    settings: Arc<Mutex<Settings>>,
    jobs: Mutex<Vec<ConvertJob>>,
    controls: Mutex<HashMap<String, Arc<TaskControl>>>,
    running: AtomicU32,
    wake: Notify,
}

impl ConvertManager {
    pub fn new(app: AppHandle, settings: Arc<Mutex<Settings>>) -> Arc<Self> {
        Arc::new(Self {
            app,
            settings,
            jobs: Mutex::new(Vec::new()),
            controls: Mutex::new(HashMap::new()),
            running: AtomicU32::new(0),
            wake: Notify::new(),
        })
    }

    fn settings(&self) -> Settings {
        self.settings
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    fn with_jobs<T>(&self, f: impl FnOnce(&mut Vec<ConvertJob>) -> T) -> T {
        let mut guard = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut guard)
    }

    pub fn list(&self) -> Vec<ConvertJob> {
        self.with_jobs(|jobs| jobs.clone())
    }

    pub fn active_count(&self) -> u32 {
        self.with_jobs(|jobs| jobs.iter().filter(|job| !job.status.is_terminal()).count() as u32)
    }

    /// Queue one job per input file.
    ///
    /// Every file is probed first: the duration is what turns FFmpeg's output
    /// into a percentage, and a file that cannot be read is worth reporting now
    /// rather than after it reaches the front of the queue.
    pub async fn enqueue(self: &Arc<Self>, request: ConvertRequest) -> AppResult<Vec<ConvertJob>> {
        let target = request.options.target_format.trim().to_ascii_lowercase();
        let Some(kind) = format_kind(&target) else {
            return Err(AppError::Other(format!(
                "{target} is not a format this app can write"
            )));
        };
        if request.input_paths.is_empty() {
            return Err(AppError::Other("no files were given to convert".into()));
        }
        // Fail before queueing anything, rather than filling the list with jobs
        // that will each fail the same way.
        tools::require_ffmpeg()?;

        let mut options = request.options.clone();
        options.target_format = target;

        normalize_output_dir(&mut options)?;

        let mut created = Vec::with_capacity(request.input_paths.len());
        for path in &request.input_paths {
            let probed = probe(path).await?;
            let job = ConvertJob {
                id: util::new_id("cv"),
                input_path: probed.path.clone(),
                input_name: probed.file_name.clone(),
                input_size_bytes: probed.size_bytes,
                output_path: None,
                output_size_bytes: None,
                kind,
                status: ConvertStatus::Queued,
                percent: None,
                duration_sec: probed.duration_sec,
                stream_copied: false,
                error: None,
                created_at: util::now_ms(),
                started_at: None,
                completed_at: None,
                options: options.clone(),
            };
            self.with_jobs(|jobs| jobs.push(job.clone()));
            created.push(job);
        }

        self.emit_changed();
        self.wake.notify_one();
        Ok(created)
    }

    pub fn cancel(self: &Arc<Self>, id: &str) {
        if let Some(control) = self.control_for(id) {
            control.cancel();
        }
        // A job that has not started yet has no control handle, so its status is
        // set directly.
        self.update_job(id, |job| {
            if !job.status.is_terminal() {
                job.status = ConvertStatus::Canceled;
                job.percent = None;
                job.completed_at = Some(util::now_ms());
            }
        });
        self.emit_changed();
        self.wake.notify_one();
    }

    pub fn retry(self: &Arc<Self>, id: &str) {
        self.update_job(id, |job| {
            if job.status.is_terminal() {
                job.status = ConvertStatus::Queued;
                job.error = None;
                job.percent = None;
                job.output_path = None;
                job.output_size_bytes = None;
                job.stream_copied = false;
                job.completed_at = None;
            }
        });
        self.emit_changed();
        self.wake.notify_one();
    }

    pub fn remove(self: &Arc<Self>, id: &str) {
        if let Some(control) = self.control_for(id) {
            control.cancel();
        }
        self.with_jobs(|jobs| jobs.retain(|job| job.id != id));
        self.controls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
        self.emit_changed();
    }

    pub fn clear_finished(self: &Arc<Self>) {
        self.with_jobs(|jobs| jobs.retain(|job| !job.status.is_terminal()));
        self.emit_changed();
    }

    /// Stop everything on the way out, so no encoder outlives the window.
    pub fn shutdown(&self) {
        let controls = self.controls.lock().unwrap_or_else(|e| e.into_inner());
        for control in controls.values() {
            control.cancel();
        }
    }

    // -- scheduling --------------------------------------------------------

    /// Long-lived admission loop, started once at app setup.
    pub fn spawn_scheduler(self: &Arc<Self>) {
        let manager = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            loop {
                if manager.running.load(Ordering::Acquire) < MAX_CONCURRENT {
                    if let Some(job) = manager.take_next_queued() {
                        manager.running.fetch_add(1, Ordering::AcqRel);
                        let worker = Arc::clone(&manager);
                        tauri::async_runtime::spawn(async move {
                            worker.run_job(job).await;
                            worker.running.fetch_sub(1, Ordering::AcqRel);
                            worker.wake.notify_one();
                        });
                        continue;
                    }
                }
                manager.wake.notified().await;
            }
        });
    }

    fn take_next_queued(self: &Arc<Self>) -> Option<ConvertJob> {
        self.with_jobs(|jobs| {
            let job = jobs
                .iter_mut()
                .find(|job| job.status == ConvertStatus::Queued)?;
            job.status = ConvertStatus::Running;
            job.started_at = Some(util::now_ms());
            Some(job.clone())
        })
    }

    async fn run_job(self: &Arc<Self>, job: ConvertJob) {
        let control = TaskControl::shared();
        self.controls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(job.id.clone(), Arc::clone(&control));

        // The job was marked running before this task was spawned, so it can
        // already have been cancelled in between. Checking after the control is
        // registered is what closes that window: a cancel arriving from here on
        // finds the handle and interrupts FFmpeg itself.
        let still_running = self.with_jobs(|jobs| {
            jobs.iter()
                .any(|entry| entry.id == job.id && entry.status == ConvertStatus::Running)
        });
        if !still_running {
            self.controls
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&job.id);
            return;
        }
        self.emit_changed();

        let result = self.execute(&job, Arc::clone(&control)).await;

        self.controls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&job.id);

        match result {
            Ok(outcome) => self.complete(&job.id, outcome),
            Err(AppError::Canceled) => self.settle_cancel(&job.id),
            Err(err) => self.fail(&job.id, err),
        }
    }

    /// Run the passes in order until one produces a file.
    ///
    /// A repackage is tried when the container can hold what the source already
    /// is; the GPU encoder is tried when the user has it enabled, because it is
    /// absent on most machines without an NVIDIA card and refusing to fall back
    /// would turn a preference into a hard failure; the software encoder always
    /// comes last and is what actually guarantees a result.
    async fn execute(
        self: &Arc<Self>,
        job: &ConvertJob,
        control: Arc<TaskControl>,
    ) -> AppResult<Outcome> {
        let input = PathBuf::from(&job.input_path);
        if !input.is_file() {
            return Err(AppError::Io(format!(
                "{} is no longer on disk",
                job.input_name
            )));
        }

        // The file may have been probed minutes ago; re-reading it now keeps the
        // codec decisions honest and costs one short process.
        let probed = probe(&job.input_path).await?;
        let target = job.options.target_format.as_str();
        if matches!(job.kind, ConvertKind::Gif | ConvertKind::Image) && !probed.has_video {
            return Err(AppError::Other(format!(
                "{} has no picture to turn into a .{target}",
                job.input_name
            )));
        }

        let dir = match job.options.output_dir.as_deref() {
            Some(dir) => PathBuf::from(dir),
            None => input
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from(".")),
        };
        std::fs::create_dir_all(&dir).map_err(|err| {
            AppError::Permission(format!("{} could not be created: {err}", dir.display()))
        })?;

        let stem = filename::sanitize_component(
            &input
                .file_stem()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_default(),
        );
        let stem = if stem.is_empty() {
            "converted".to_string()
        } else {
            stem
        };
        let output = filename::unique_path(&dir, &stem, extension_for(target));

        // A tiled photo is converted from a whole copy of itself; see
        // `is_tiled_still`. The copy goes when this function returns.
        let mut probed = probed;
        let mut source = input.clone();
        let _unpacked = if job.kind != ConvertKind::Audio && is_tiled_still(&probed) {
            let dir = paths::cache_dir()?.join("convert");
            std::fs::create_dir_all(&dir)?;
            let whole = ScratchFile(dir.join(format!("{}.png", job.id)));
            let grid = match ffprobe_path() {
                Some(binary) => tile_grid(&binary, &job.input_path).await,
                None => None,
            };
            unpack_picture(&input, &whole.0, grid.as_ref(), Arc::clone(&control)).await?;
            probed = probe(&whole.0.to_string_lossy()).await?;
            source = whole.0.clone();
            Some(whole)
        } else {
            None
        };

        let settings = self.settings();
        let mut passes: Vec<Pass> = Vec::with_capacity(3);
        if copy_is_plausible(target, job.kind, &probed, &job.options) {
            passes.push(Pass::Copy);
        }
        if job.kind == ConvertKind::Video && takes_h264(target) && settings.hardware_acceleration {
            passes.push(Pass::Hardware);
        }
        passes.push(Pass::Software);

        let mut last_error: Option<AppError> = None;
        for pass in passes {
            let args = build_args(&source, &output, target, job.kind, &probed, &job.options, pass);
            let mut sink = {
                let manager = Arc::clone(self);
                let id = job.id.clone();
                move |progress: FfmpegProgress| manager.on_progress(&id, progress)
            };

            match ffmpeg::run_with_progress(
                &args,
                probed.duration_sec,
                Arc::clone(&control),
                &mut sink,
            )
            .await
            {
                Ok(()) => {
                    let size = std::fs::metadata(&output).map(|meta| meta.len()).ok();
                    // FFmpeg can exit cleanly having written nothing when the
                    // mapping matched no stream. That is not a success.
                    if size.unwrap_or(0) == 0 {
                        let _ = std::fs::remove_file(&output);
                        last_error =
                            Some(AppError::Other("the conversion produced an empty file".into()));
                        continue;
                    }
                    return Ok(Outcome {
                        output_path: output,
                        output_size_bytes: size,
                        stream_copied: pass == Pass::Copy,
                    });
                }
                Err(AppError::Canceled) => {
                    let _ = std::fs::remove_file(&output);
                    return Err(AppError::Canceled);
                }
                Err(err) => {
                    log_info!(
                        "convert",
                        "{} as {pass:?} into .{target} failed: {err}",
                        job.input_name
                    );
                    // A half-written file from a rejected pass must not be left
                    // where the next pass is about to write.
                    let _ = std::fs::remove_file(&output);
                    last_error = Some(err);
                }
            }
        }

        Err(last_error
            .unwrap_or_else(|| AppError::Other("the conversion could not be started".into())))
    }

    fn complete(self: &Arc<Self>, id: &str, outcome: Outcome) {
        let path = outcome.output_path.to_string_lossy().into_owned();
        self.update_job(id, |job| {
            job.status = ConvertStatus::Completed;
            job.percent = Some(100.0);
            job.output_path = Some(path.clone());
            job.output_size_bytes = outcome.output_size_bytes;
            job.stream_copied = outcome.stream_copied;
            job.completed_at = Some(util::now_ms());
        });
        log_info!("convert", "wrote {path}");
        self.emit_job(id);
        self.emit_changed();
    }

    fn fail(self: &Arc<Self>, id: &str, err: AppError) {
        let info = err.to_info();
        log_warn!("convert", "job {id} failed: {err}");
        self.update_job(id, |job| {
            job.status = ConvertStatus::Failed;
            job.error = Some(info.clone());
            job.percent = None;
            job.completed_at = Some(util::now_ms());
        });
        self.emit_job(id);
        self.emit_changed();
    }

    fn settle_cancel(self: &Arc<Self>, id: &str) {
        self.update_job(id, |job| {
            job.status = ConvertStatus::Canceled;
            job.percent = None;
            job.completed_at = Some(util::now_ms());
        });
        self.emit_job(id);
        self.emit_changed();
    }

    fn on_progress(self: &Arc<Self>, id: &str, progress: FfmpegProgress) {
        let updated = self.update_job(id, |job| {
            if job.status == ConvertStatus::Running {
                job.percent = progress.percent;
            }
        });

        // Progress is its own lightweight event: a running conversion should not
        // re-render the whole list several times a second.
        match updated {
            Some(job) if job.status == ConvertStatus::Running => {
                let _ = self.app.emit(
                    EVENT_PROGRESS,
                    ConvertProgressEvent {
                        id: job.id,
                        status: job.status,
                        percent: job.percent,
                        output_path: job.output_path,
                        output_size_bytes: job.output_size_bytes,
                        stream_copied: job.stream_copied,
                        error: job.error,
                    },
                );
            }
            _ => {}
        }
    }

    fn update_job(&self, id: &str, f: impl FnOnce(&mut ConvertJob)) -> Option<ConvertJob> {
        self.with_jobs(|jobs| {
            let job = jobs.iter_mut().find(|job| job.id == id)?;
            f(job);
            Some(job.clone())
        })
    }

    fn control_for(&self, id: &str) -> Option<Arc<TaskControl>> {
        self.controls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
    }

    fn emit_changed(&self) {
        let _ = self.app.emit(EVENT_CHANGED, self.list());
    }

    fn emit_job(&self, id: &str) {
        let Some(job) = self.with_jobs(|jobs| jobs.iter().find(|job| job.id == id).cloned()) else {
            return;
        };
        let _ = self.app.emit(
            EVENT_PROGRESS,
            ConvertProgressEvent {
                id: job.id,
                status: job.status,
                percent: job.percent,
                output_path: job.output_path,
                output_size_bytes: job.output_size_bytes,
                stream_copied: job.stream_copied,
                error: job.error,
            },
        );
    }
}

struct Outcome {
    output_path: PathBuf,
    output_size_bytes: Option<u64>,
    stream_copied: bool,
}

/// A file of the job's own that goes when the job does, however it ends.
struct ScratchFile(PathBuf);

impl Drop for ScratchFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Write a tiled photo out whole, as a PNG (see [`is_tiled_still`]). PNG loses
/// nothing, so the conversion that starts from it sees exactly what it would
/// have seen in the photo.
async fn unpack_picture(
    input: &Path,
    output: &Path,
    grid: Option<&TileGrid>,
    control: Arc<TaskControl>,
) -> AppResult<()> {
    let mut ignore = |_: FfmpegProgress| {};
    let args = unpack_args(input, output, grid);
    ffmpeg::run_with_progress(&args, None, control, &mut ignore).await?;
    if std::fs::metadata(output).map(|meta| meta.len()).unwrap_or(0) == 0 {
        return Err(AppError::Other("the photo could not be read whole".into()));
    }
    Ok(())
}

/// Without a grid -- a single-image AVIF, or an ffprobe that could not say --
/// FFmpeg is left to read the picture as it would anyway.
fn unpack_args(input: &Path, output: &Path, grid: Option<&TileGrid>) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
        "-i".into(),
        input.to_string_lossy().into_owned(),
    ];
    match grid {
        Some(grid) => args.extend([
            "-filter_complex".into(),
            grid.filter_graph(),
            "-map".into(),
            "[whole]".into(),
        ]),
        None => args.extend(["-an".into(), "-sn".into(), "-dn".into()]),
    }
    args.extend([
        "-frames:v".into(),
        "1".into(),
        "-c:v".into(),
        "png".into(),
        "-update".into(),
        "1".into(),
        output.to_string_lossy().into_owned(),
    ]);
    args
}

/// An empty or missing folder means "beside the source file"; anything else has
/// to exist and be a directory before a job is accepted.
fn normalize_output_dir(options: &mut ConvertOptions) -> AppResult<()> {
    let Some(dir) = options
        .output_dir
        .as_ref()
        .map(|value| value.trim().to_string())
    else {
        return Ok(());
    };
    if dir.is_empty() {
        options.output_dir = None;
        return Ok(());
    }
    if !Path::new(&dir).is_dir() {
        return Err(AppError::Io(format!("{dir} is not a folder")));
    }
    options.output_dir = Some(dir);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_probe() -> MediaProbe {
        MediaProbe {
            path: "in.mkv".into(),
            file_name: "in.mkv".into(),
            container: "mkv".into(),
            size_bytes: 1024,
            duration_sec: Some(60.0),
            width: Some(1920),
            height: Some(1080),
            fps: Some(30.0),
            pixel_aspect: Some(1.0),
            video_duration_sec: Some(60.0),
            video_codec: Some("h264".into()),
            audio_codec: Some("aac".into()),
            audio_bitrate_kbps: Some(192.0),
            has_video: true,
            has_audio: true,
            still: false,
        }
    }

    fn photo_probe(codec: &str) -> MediaProbe {
        MediaProbe {
            path: "in.jpg".into(),
            file_name: "in.jpg".into(),
            container: "jpg".into(),
            size_bytes: 2048,
            duration_sec: None,
            width: Some(4032),
            height: Some(3024),
            fps: None,
            pixel_aspect: None,
            video_duration_sec: None,
            video_codec: Some(codec.into()),
            audio_codec: None,
            audio_bitrate_kbps: None,
            has_video: true,
            has_audio: false,
            still: true,
        }
    }

    /// What the screen sends when nothing has been touched: keep everything.
    fn options(target: &str) -> ConvertOptions {
        ConvertOptions {
            target_format: target.into(),
            output_dir: None,
            quality: ConvertQuality::Original,
            max_height: None,
            max_side: None,
            fps: None,
            audio_bitrate_kbps: None,
        }
    }

    fn with_quality(target: &str, quality: ConvertQuality) -> ConvertOptions {
        ConvertOptions {
            quality,
            ..options(target)
        }
    }

    fn args_with(target: &str, pass: Pass, probe: &MediaProbe, options: &ConvertOptions) -> Vec<String> {
        let kind = format_kind(target).expect("a known format");
        build_args(
            Path::new("in.mkv"),
            Path::new(&format!("out.{}", extension_for(target))),
            target,
            kind,
            probe,
            options,
            pass,
        )
    }

    fn args_for(target: &str, pass: Pass, options: &ConvertOptions) -> Vec<String> {
        args_with(target, pass, &sample_probe(), options)
    }

    fn value_after(args: &[String], key: &str) -> Option<String> {
        args.iter()
            .position(|arg| arg == key)
            .map(|index| args[index + 1].clone())
    }

    #[test]
    fn only_known_formats_are_offered() {
        assert_eq!(format_kind("mp4"), Some(ConvertKind::Video));
        assert_eq!(format_kind("MP3"), Some(ConvertKind::Audio));
        assert_eq!(format_kind("gif"), Some(ConvertKind::Gif));
        assert_eq!(format_kind("jpg"), Some(ConvertKind::Image));
        assert_eq!(format_kind("exe"), None);
        assert_eq!(format_kind("../evil"), None);
        // Readable but not writable, so never a target.
        assert_eq!(format_kind("heic"), None);
        assert_eq!(
            catalogue().len(),
            VIDEO_FORMATS.len() + AUDIO_FORMATS.len() + GIF_FORMATS.len() + IMAGE_FORMATS.len()
        );
    }

    #[test]
    fn the_catalogue_keeps_each_list_in_its_own_order() {
        let ids: Vec<String> = catalogue()
            .into_iter()
            .filter(|entry| entry.kind == ConvertKind::Image)
            .map(|entry| entry.id)
            .collect();
        assert_eq!(ids, IMAGE_FORMATS.map(str::to_string));
        assert_eq!(catalogue()[0].id, "mp4");
    }

    #[test]
    fn lossless_and_single_rate_formats_offer_nothing_to_tune() {
        let tunable = |id: &str| catalogue().into_iter().find(|entry| entry.id == id).unwrap().tunable;
        for id in ["wav", "flac", "aiff", "alac", "amr", "png", "bmp", "tiff", "ico", "tga"] {
            assert!(!tunable(id), "{id}");
        }
        for id in ["mp4", "mp3", "gif", "jpg", "webp", "avif", "jp2"] {
            assert!(tunable(id), "{id}");
        }
    }

    /// The screen names each format from its own dictionary; one added here
    /// without a line there shows up as its raw key.
    #[test]
    fn every_format_has_a_hint_in_both_languages() {
        for (language, dictionary) in [
            ("en", include_str!("../../src/i18n/en.ts")),
            ("tr", include_str!("../../src/i18n/tr.ts")),
        ] {
            for format in catalogue().into_iter().filter(|format| format.kind != ConvertKind::Gif) {
                let key = format!("'convert.formatHint.{}':", format.id);
                assert!(dictionary.contains(&key), "{language} has no {key}");
            }
        }
    }

    #[test]
    fn apple_lossless_is_written_as_m4a() {
        assert_eq!(extension_for("alac"), "m4a");
        assert_eq!(extension_for("jpg"), "jpg");
        let args = args_with("alac", Pass::Software, &sample_probe(), &options("alac"));
        assert_eq!(args.last().unwrap(), "out.m4a");
        assert!(args.iter().any(|arg| arg == "+faststart"));
    }

    #[test]
    fn a_copy_pass_never_names_an_encoder() {
        let args = args_for("mp4", Pass::Copy, &options("mp4"));
        assert_eq!(value_after(&args, "-c").as_deref(), Some("copy"));
        assert!(!args.iter().any(|arg| arg == "libx264"));
    }

    #[test]
    fn h264_and_aac_can_be_repackaged_into_mp4_but_not_webm() {
        let probe = sample_probe();
        assert!(copy_is_plausible("mp4", ConvertKind::Video, &probe, &options("mp4")));
        assert!(copy_is_plausible("mkv", ConvertKind::Video, &probe, &options("mkv")));
        assert!(copy_is_plausible("ts", ConvertKind::Video, &probe, &options("ts")));
        assert!(!copy_is_plausible("webm", ConvertKind::Video, &probe, &options("webm")));
        assert!(!copy_is_plausible("wmv", ConvertKind::Video, &probe, &options("wmv")));
    }

    #[test]
    fn choosing_a_quality_asks_for_a_re_encode() {
        let probe = sample_probe();
        for quality in [ConvertQuality::High, ConvertQuality::Balanced, ConvertQuality::Small] {
            let opts = with_quality("mp4", quality);
            assert!(!copy_is_plausible("mp4", ConvertKind::Video, &probe, &opts), "{quality:?}");
        }
    }

    #[test]
    fn aac_audio_is_repackaged_into_m4a_and_re_encoded_into_mp3() {
        let probe = sample_probe();
        assert!(copy_is_plausible("m4a", ConvertKind::Audio, &probe, &options("m4a")));
        assert!(!copy_is_plausible("mp3", ConvertKind::Audio, &probe, &options("mp3")));
        assert!(!copy_is_plausible("wma", ConvertKind::Audio, &probe, &options("wma")));
    }

    #[test]
    fn apple_lossless_fits_m4a_but_not_a_bare_aac_stream() {
        let mut probe = sample_probe();
        probe.audio_codec = Some("alac".into());
        assert!(copy_is_plausible("m4a", ConvertKind::Audio, &probe, &options("m4a")));
        assert!(copy_is_plausible("alac", ConvertKind::Audio, &probe, &options("alac")));
        assert!(!copy_is_plausible("aac", ConvertKind::Audio, &probe, &options("aac")));
    }

    #[test]
    fn asking_for_a_smaller_frame_rules_out_a_repackage() {
        let mut opts = options("mp4");
        opts.max_height = Some(720);
        assert!(!copy_is_plausible("mp4", ConvertKind::Video, &sample_probe(), &opts));
    }

    #[test]
    fn a_cap_the_source_is_already_under_still_repackages() {
        let mut opts = options("mp4");
        opts.max_height = Some(2160);
        assert!(copy_is_plausible("mp4", ConvertKind::Video, &sample_probe(), &opts));
    }

    #[test]
    fn a_slower_frame_rate_rules_out_a_repackage_and_a_faster_one_does_not() {
        let mut opts = options("mp4");
        opts.fps = Some(24.0);
        assert!(!copy_is_plausible("mp4", ConvertKind::Video, &sample_probe(), &opts));
        opts.fps = Some(60.0);
        assert!(copy_is_plausible("mp4", ConvertKind::Video, &sample_probe(), &opts));
    }

    #[test]
    fn a_frame_rate_is_only_ever_lowered() {
        let probe = sample_probe();
        assert_eq!(video_rate(&probe, Some(24.0)), Some(24.0));
        // Asking 30 of a 29.97 file, or 60 of a 30 one, changes nothing.
        assert_eq!(video_rate(&probe, Some(30.0)), None);
        assert_eq!(video_rate(&probe, Some(60.0)), None);
        assert_eq!(video_rate(&probe, None), None);
        let mut unknown = sample_probe();
        unknown.fps = None;
        assert_eq!(video_rate(&unknown, Some(25.0)), Some(25.0));
    }

    #[test]
    fn a_lower_frame_rate_reaches_the_filter_chain() {
        let mut opts = with_quality("mp4", ConvertQuality::Balanced);
        opts.fps = Some(24.0);
        let filter = value_after(&args_for("mp4", Pass::Software, &opts), "-vf").expect("-vf");
        assert!(filter.ends_with(",fps=24"), "{filter}");
    }

    #[test]
    fn asking_for_a_bitrate_rules_out_an_audio_repackage() {
        let mut opts = options("m4a");
        opts.audio_bitrate_kbps = Some(128);
        assert!(!copy_is_plausible("m4a", ConvertKind::Audio, &sample_probe(), &opts));
    }

    #[test]
    fn audio_targets_drop_the_video_stream() {
        for target in AUDIO_FORMATS {
            let args = args_for(target, Pass::Software, &options(target));
            assert!(args.iter().any(|arg| arg == "-vn"), "{target}");
            assert!(
                args.windows(2).any(|w| w[0] == "-map" && w[1] == "0:a:0?"),
                "{target}"
            );
        }
    }

    #[test]
    fn video_targets_keep_both_streams_and_drop_the_rest() {
        for target in VIDEO_FORMATS {
            let args = args_for(target, Pass::Software, &options(target));
            assert!(!args.iter().any(|arg| arg == "-vn"), "{target}");
            assert!(
                args.windows(2).any(|w| w[0] == "-map" && w[1] == "0:v:0?"),
                "{target}"
            );
            assert!(args.iter().any(|arg| arg == "-sn"), "{target}");
        }
    }

    #[test]
    fn each_audio_container_selects_its_encoder() {
        let codec_for =
            |target: &str| value_after(&args_for(target, Pass::Software, &options(target)), "-c:a");
        assert_eq!(codec_for("mp3").as_deref(), Some("libmp3lame"));
        assert_eq!(codec_for("wav").as_deref(), Some("pcm_s16le"));
        assert_eq!(codec_for("flac").as_deref(), Some("flac"));
        assert_eq!(codec_for("opus").as_deref(), Some("libopus"));
        assert_eq!(codec_for("ogg").as_deref(), Some("libvorbis"));
        assert_eq!(codec_for("m4a").as_deref(), Some("aac"));
        assert_eq!(codec_for("aac").as_deref(), Some("aac"));
        assert_eq!(codec_for("wma").as_deref(), Some("wmav2"));
        assert_eq!(codec_for("aiff").as_deref(), Some("pcm_s16be"));
        assert_eq!(codec_for("alac").as_deref(), Some("alac"));
        assert_eq!(codec_for("ac3").as_deref(), Some("ac3"));
        assert_eq!(codec_for("amr").as_deref(), Some("libopencore_amrnb"));
    }

    #[test]
    fn lossless_audio_targets_carry_no_bitrate() {
        for target in ["wav", "flac", "aiff", "alac"] {
            let args = args_for(target, Pass::Software, &options(target));
            assert!(!args.iter().any(|arg| arg == "-b:a"), "{target}");
        }
    }

    #[test]
    fn amr_is_narrowband_mono_at_its_one_rate() {
        let args = args_for("amr", Pass::Software, &options("amr"));
        assert_eq!(value_after(&args, "-ar").as_deref(), Some("8000"));
        assert_eq!(value_after(&args, "-ac").as_deref(), Some("1"));
        assert_eq!(value_after(&args, "-b:a").as_deref(), Some("12.2k"));
    }

    #[test]
    fn the_audio_bitrate_never_exceeds_the_source() {
        let mut probe = sample_probe();
        probe.audio_bitrate_kbps = Some(128.0);
        assert_eq!(audio_bitrate("mp3", &probe, &options("mp3")), Some("128k"));
    }

    #[test]
    fn an_explicit_bitrate_wins_over_the_source() {
        let mut opts = options("mp3");
        opts.audio_bitrate_kbps = Some(320);
        assert_eq!(audio_bitrate("mp3", &sample_probe(), &opts), Some("320k"));
    }

    #[test]
    fn each_video_container_gets_audio_it_can_hold() {
        let codec_for = |target: &str| {
            value_after(
                &args_for(target, Pass::Software, &with_quality(target, ConvertQuality::Balanced)),
                "-c:a",
            )
        };
        assert_eq!(codec_for("mp4").as_deref(), Some("aac"));
        assert_eq!(codec_for("mkv").as_deref(), Some("aac"));
        assert_eq!(codec_for("webm").as_deref(), Some("libopus"));
        assert_eq!(codec_for("avi").as_deref(), Some("libmp3lame"));
        assert_eq!(codec_for("wmv").as_deref(), Some("wmav2"));
        assert_eq!(codec_for("mpg").as_deref(), Some("mp2"));
        assert_eq!(codec_for("ogv").as_deref(), Some("libvorbis"));
        assert_eq!(codec_for("3gp").as_deref(), Some("aac"));
    }

    #[test]
    fn the_original_quality_leaves_fitting_sound_alone_while_the_picture_changes() {
        let mut opts = options("mp4");
        opts.max_height = Some(720);
        let args = args_for("mp4", Pass::Software, &opts);
        assert_eq!(value_after(&args, "-c:a").as_deref(), Some("copy"));
        // WebM cannot hold AAC, so there it is encoded all the same.
        let args = args_for("webm", Pass::Software, &options("webm"));
        assert_eq!(value_after(&args, "-c:a").as_deref(), Some("libopus"));
    }

    #[test]
    fn each_video_container_selects_its_encoder() {
        let codec_for =
            |target: &str| value_after(&args_for(target, Pass::Software, &options(target)), "-c:v");
        assert_eq!(codec_for("mp4").as_deref(), Some("libx264"));
        assert_eq!(codec_for("webm").as_deref(), Some("libvpx-vp9"));
        assert_eq!(codec_for("wmv").as_deref(), Some("wmv2"));
        assert_eq!(codec_for("mpg").as_deref(), Some("mpeg2video"));
        assert_eq!(codec_for("ogv").as_deref(), Some("libtheora"));
        assert_eq!(codec_for("flv").as_deref(), Some("libx264"));
    }

    #[test]
    fn webm_always_uses_vp9_even_when_the_gpu_is_available() {
        let args = args_for("webm", Pass::Hardware, &options("webm"));
        assert_eq!(value_after(&args, "-c:v").as_deref(), Some("libvpx-vp9"));
        assert!(!takes_h264("webm"));
        assert!(takes_h264("mkv"));
    }

    #[test]
    fn the_gpu_pass_and_the_cpu_pass_name_different_encoders() {
        assert_eq!(
            value_after(&args_for("mp4", Pass::Hardware, &options("mp4")), "-c:v").as_deref(),
            Some("h264_nvenc")
        );
        assert_eq!(
            value_after(&args_for("mp4", Pass::Software, &options("mp4")), "-c:v").as_deref(),
            Some("libx264")
        );
    }

    #[test]
    fn a_smaller_target_is_a_downscale_that_never_enlarges() {
        let mut opts = options("mp4");
        opts.max_height = Some(720);
        let filter = value_after(&args_for("mp4", Pass::Software, &opts), "-vf").expect("-vf");
        assert_eq!(filter, "scale=-2:'trunc(min(720,ih)/2)*2'");
    }

    #[test]
    fn a_re_encoded_frame_is_always_made_even() {
        let filter = value_after(&args_for("mp4", Pass::Software, &options("mp4")), "-vf").expect("-vf");
        assert_eq!(filter, "scale='trunc(iw/2)*2':'trunc(ih/2)*2'");
    }

    #[test]
    fn quality_moves_the_constant_rate_factor() {
        assert_eq!(crf_for("mp4", ConvertQuality::Original), "14");
        assert_eq!(crf_for("mp4", ConvertQuality::High), "18");
        assert_eq!(crf_for("mp4", ConvertQuality::Small), "28");
        assert_eq!(crf_for("webm", ConvertQuality::Balanced), "33");
        // Theora's scale runs the other way.
        assert_eq!(crf_for("ogv", ConvertQuality::Original), "10");
    }

    #[test]
    fn mp4_output_is_made_seekable_and_matroska_is_left_alone() {
        assert!(args_for("mp4", Pass::Copy, &options("mp4"))
            .iter()
            .any(|arg| arg == "+faststart"));
        assert!(!args_for("mkv", Pass::Copy, &options("mkv"))
            .iter()
            .any(|arg| arg == "+faststart"));
    }

    #[test]
    fn the_output_path_is_always_the_final_argument() {
        for target in ["mp4", "gif", "jpg", "mp3"] {
            let args = args_for(target, Pass::Software, &options(target));
            assert_eq!(args.last().unwrap(), &format!("out.{target}"));
        }
    }

    // -- GIF ---------------------------------------------------------------

    #[test]
    fn a_gif_is_drawn_from_its_own_palette_and_loops() {
        let args = args_for("gif", Pass::Software, &with_quality("gif", ConvertQuality::Balanced));
        let filter = value_after(&args, "-vf").expect("-vf");
        assert!(filter.contains("palettegen=max_colors=256:stats_mode=diff"), "{filter}");
        assert!(filter.contains("paletteuse=dither=bayer"), "{filter}");
        assert_eq!(value_after(&args, "-loop").as_deref(), Some("0"));
        assert!(args.iter().any(|arg| arg == "-an"));
        assert!(!copy_is_plausible("gif", ConvertKind::Gif, &sample_probe(), &options("gif")));
    }

    #[test]
    fn gif_quality_trades_colours_and_dithering() {
        assert_eq!(gif_palette(ConvertQuality::High).0, 256);
        assert_eq!(gif_palette(ConvertQuality::High).2, "sierra2_4a");
        assert_eq!(gif_palette(ConvertQuality::Small).0, 128);
    }

    #[test]
    fn a_gif_takes_the_rate_and_size_asked_for() {
        let mut opts = with_quality("gif", ConvertQuality::Balanced);
        opts.fps = Some(15.0);
        opts.max_side = Some(480);
        let filter = value_after(&args_for("gif", Pass::Software, &opts), "-vf").expect("-vf");
        assert!(
            filter.starts_with(
                "fps=15,scale='min(480,iw)':'min(480,ih)':force_original_aspect_ratio=decrease"
            ),
            "{filter}"
        );
    }

    #[test]
    fn a_gif_never_runs_faster_than_a_gif_can_play() {
        let mut fast = sample_probe();
        fast.fps = Some(60.0);
        assert_eq!(gif_rate(&fast, None), Some(50.0));
        assert_eq!(gif_rate(&fast, Some(30.0)), Some(30.0));
        // A 30 fps clip asked for 30, or for its own rate, is left alone.
        assert_eq!(gif_rate(&sample_probe(), Some(30.0)), None);
        assert_eq!(gif_rate(&sample_probe(), None), None);
        assert_eq!(gif_rate(&sample_probe(), Some(15.0)), Some(15.0));
        // A single picture has no rate to change.
        assert_eq!(gif_rate(&photo_probe("png"), Some(15.0)), None);
    }

    #[test]
    fn non_square_pixels_are_squared_before_a_gif_is_drawn() {
        let mut probe = sample_probe();
        probe.pixel_aspect = Some(64.0 / 45.0);
        let filter = value_after(
            &args_with("gif", Pass::Software, &probe, &options("gif")),
            "-vf",
        )
        .expect("-vf");
        assert!(filter.starts_with("scale='trunc(iw*max(1,sar))'"), "{filter}");
        assert!(square_pixels(&sample_probe()).is_none());
    }

    // -- pictures ----------------------------------------------------------

    #[test]
    fn a_picture_is_one_frame_of_whatever_ffmpeg_picks() {
        let args = args_with("png", Pass::Software, &photo_probe("mjpeg"), &options("png"));
        assert_eq!(value_after(&args, "-frames:v").as_deref(), Some("1"));
        assert_eq!(value_after(&args, "-update").as_deref(), Some("1"));
        assert!(!args.iter().any(|arg| arg == "-map"));
        // Muxers of their own take no `-update`.
        let args = args_with("webp", Pass::Software, &photo_probe("mjpeg"), &options("webp"));
        assert!(!args.iter().any(|arg| arg == "-update"));
    }

    #[test]
    fn a_photo_already_in_its_target_codec_is_copied() {
        let photo = photo_probe("mjpeg");
        assert!(copy_is_plausible("jpg", ConvertKind::Image, &photo, &options("jpg")));
        assert!(!copy_is_plausible("png", ConvertKind::Image, &photo, &options("png")));
        // A JPEG asked to be smaller is drawn again.
        let smaller = with_quality("jpg", ConvertQuality::Balanced);
        assert!(!copy_is_plausible("jpg", ConvertKind::Image, &photo, &smaller));
        // A lossless target has no quality to ask for, so it copies whatever it was given.
        let png = photo_probe("png");
        assert!(copy_is_plausible("png", ConvertKind::Image, &png, &with_quality("png", ConvertQuality::High)));
        // A frame out of a film is never a copy.
        assert!(!copy_is_plausible("jpg", ConvertKind::Image, &sample_probe(), &options("jpg")));
    }

    #[test]
    fn a_photo_made_smaller_is_drawn_again() {
        let mut opts = options("jpg");
        opts.max_side = Some(1920);
        assert!(!copy_is_plausible("jpg", ConvertKind::Image, &photo_probe("mjpeg"), &opts));
        opts.max_side = Some(8000);
        assert!(copy_is_plausible("jpg", ConvertKind::Image, &photo_probe("mjpeg"), &opts));
    }

    #[test]
    fn jpeg_and_avif_are_laid_over_white() {
        for target in ["jpg", "avif"] {
            let args = args_with(target, Pass::Software, &photo_probe("png"), &options(target));
            let filter = value_after(&args, "-vf").expect("-vf");
            assert!(filter.contains("overlay"), "{target}: {filter}");
        }
        let args = args_with("png", Pass::Software, &photo_probe("mjpeg"), &options("png"));
        assert!(value_after(&args, "-vf").is_none());
    }

    #[test]
    fn the_original_quality_is_lossless_where_the_format_has_a_lossless_mode() {
        let photo = photo_probe("png");
        let webp = args_with("webp", Pass::Software, &photo, &options("webp"));
        assert_eq!(value_after(&webp, "-lossless").as_deref(), Some("1"));
        let avif = args_with("avif", Pass::Software, &photo, &options("avif"));
        assert_eq!(value_after(&avif, "-crf").as_deref(), Some("0"));
        let jp2 = args_with("jp2", Pass::Software, &photo, &options("jp2"));
        assert_eq!(value_after(&jp2, "-pred").as_deref(), Some("1"));
        let jpg = args_with("jpg", Pass::Software, &photo, &options("jpg"));
        assert_eq!(value_after(&jpg, "-q:v").as_deref(), Some("1"));
        assert_eq!(value_after(&jpg, "-qmin").as_deref(), Some("1"));
    }

    #[test]
    fn picture_quality_moves_each_encoder() {
        let photo = photo_probe("png");
        let small = |target: &str| {
            args_with(target, Pass::Software, &photo, &with_quality(target, ConvertQuality::Small))
        };
        assert_eq!(value_after(&small("jpg"), "-q:v").as_deref(), Some("7"));
        assert_eq!(value_after(&small("webp"), "-quality").as_deref(), Some("60"));
        assert_eq!(value_after(&small("avif"), "-crf").as_deref(), Some("36"));
    }

    #[test]
    fn an_icon_never_exceeds_256_pixels() {
        assert_eq!(side_cap("ico", &options("ico")), Some(256));
        let mut opts = options("ico");
        opts.max_side = Some(1920);
        assert_eq!(side_cap("ico", &opts), Some(256));
        opts.max_side = Some(64);
        assert_eq!(side_cap("ico", &opts), Some(64));
        let args = args_with("ico", Pass::Software, &photo_probe("mjpeg"), &options("ico"));
        let filter = value_after(&args, "-vf").expect("-vf");
        assert!(filter.contains("min(256,iw)") && filter.ends_with("format=rgba"), "{filter}");
        assert_eq!(value_after(&args, "-c:v").as_deref(), Some("png"));
    }

    #[test]
    fn tiff_is_written_as_rgb() {
        let args = args_with("tiff", Pass::Software, &photo_probe("mjpeg"), &options("tiff"));
        assert_eq!(value_after(&args, "-vf").as_deref(), Some("format=rgba|rgb24"));
        assert_eq!(value_after(&args, "-compression_algo").as_deref(), Some("lzw"));
    }

    #[test]
    fn a_heic_or_avif_photo_is_unpacked_first_and_nothing_else_is() {
        assert!(is_tiled_still(&photo_probe("hevc")));
        assert!(is_tiled_still(&photo_probe("av1")));
        assert!(!is_tiled_still(&photo_probe("mjpeg")));
        // A film in the same codec is a film.
        let mut film = sample_probe();
        film.video_codec = Some("hevc".into());
        assert!(!is_tiled_still(&film));
    }

    #[test]
    fn a_tile_grid_is_laid_out_and_cut_to_the_picture() {
        let json = serde_json::json!({
            "stream_groups": [
                {
                    "type": "Tile Grid",
                    "components": [{
                        "width": 320, "height": 240,
                        "subcomponents": [
                            { "stream_index": 37, "tile_horizontal_offset": 0, "tile_vertical_offset": 0 }
                        ]
                    }]
                },
                {
                    "type": "Tile Grid",
                    "components": [{
                        "width": 1400, "height": 970,
                        "horizontal_offset": 0, "vertical_offset": 0,
                        "subcomponents": [
                            { "stream_index": 0, "tile_horizontal_offset": 0, "tile_vertical_offset": 0 },
                            { "stream_index": 1, "tile_horizontal_offset": 704, "tile_vertical_offset": 0 }
                        ]
                    }]
                }
            ]
        });
        let grid = parse_tile_grid(&json).expect("a grid");
        assert_eq!((grid.width, grid.height), (1400, 970), "the photo, not its thumbnail");
        assert_eq!(
            grid.filter_graph(),
            "[0:0][0:1]xstack=inputs=2:layout=0_0|704_0,crop=1400:970:0:0[whole]"
        );
        let args = unpack_args(Path::new("in.heic"), Path::new("out.png"), Some(&grid));
        assert_eq!(value_after(&args, "-map").as_deref(), Some("[whole]"));
        // Nothing to assemble: FFmpeg reads it its own way.
        assert!(parse_tile_grid(&serde_json::json!({ "stream_groups": [] })).is_none());
        let plain = unpack_args(Path::new("in.avif"), Path::new("out.png"), None);
        assert!(!plain.iter().any(|arg| arg == "-filter_complex"));
    }

    #[test]
    fn picture_demuxers_are_recognised_as_stills() {
        let stream = serde_json::json!({ "codec_name": "mjpeg" });
        assert!(is_still("image2", &stream));
        assert!(is_still("png_pipe", &stream));
        assert!(is_still("ico", &stream));
        assert!(!is_still("matroska,webm", &stream));
        // AVIF and HEIC arrive through the MP4 demuxer holding one frame.
        let one = serde_json::json!({ "codec_name": "av1", "nb_frames": "1" });
        assert!(is_still("mov,mp4,m4a,3gp,3g2,mj2", &one));
        let film = serde_json::json!({ "codec_name": "gif", "nb_frames": "90" });
        assert!(!is_still("gif", &film));
    }

    #[test]
    fn a_frame_rate_of_zero_over_zero_is_not_a_frame_rate() {
        assert_eq!(
            parse_rational("30000/1001").map(|value| (value * 100.0).round()),
            Some(2997.0)
        );
        assert_eq!(parse_rational("0/0"), None);
        assert_eq!(parse_rational("nonsense"), None);
    }

    #[test]
    fn a_pixel_aspect_is_read_from_the_colon_form_ffprobe_prints() {
        // ffprobe writes a sample aspect ratio as "64:45" rather than "64/45",
        // and a 720x576 frame with that pixel is a 16:9 picture.
        assert_eq!(
            parse_rational("64:45").map(|value| (value * 1000.0).round()),
            Some(1422.0)
        );
        assert_eq!(parse_rational("1:1"), Some(1.0));
        // What ffprobe prints for a stream that never said.
        assert_eq!(parse_rational("0:1"), None);
    }

    #[test]
    fn an_output_folder_that_does_not_exist_is_refused() {
        let mut opts = options("mp4");
        opts.output_dir = Some("Z:\\definitely\\not\\here".into());
        assert!(normalize_output_dir(&mut opts).is_err());
    }

    #[test]
    fn a_blank_output_folder_means_beside_the_source() {
        let mut opts = options("mp4");
        opts.output_dir = Some("   ".into());
        assert!(normalize_output_dir(&mut opts).is_ok());
        assert_eq!(opts.output_dir, None);
    }

    /// Every target, run through the FFmpeg on this machine.
    ///
    /// Ignored by default because it needs FFmpeg: point `UD_FFMPEG_DIR` at a
    /// folder holding `ffmpeg` and `ffprobe` and `UD_CONVERT_SAMPLES` at a
    /// folder holding `clip.mp4`, `photo.jpg`, `alpha.png` and `song.wav`, then
    /// run it with `--ignored`. `UD_CONVERT_HEIC` may name a HEIC photo to add.
    #[test]
    #[ignore = "needs FFmpeg and sample files"]
    fn every_target_produces_a_file_that_ffprobe_can_read() {
        let ffmpeg_dir = PathBuf::from(std::env::var("UD_FFMPEG_DIR").expect("UD_FFMPEG_DIR"));
        let samples = PathBuf::from(std::env::var("UD_CONVERT_SAMPLES").expect("UD_CONVERT_SAMPLES"));
        let exe = |name: &str| ffmpeg_dir.join(if cfg!(windows) { format!("{name}.exe") } else { name.to_string() });
        let out_dir = samples.join("converted");
        std::fs::create_dir_all(&out_dir).unwrap();

        let runtime = tokio::runtime::Runtime::new().unwrap();
        let read = |path: &Path| -> MediaProbe {
            let mut probe = MediaProbe {
                path: path.to_string_lossy().into_owned(),
                file_name: String::new(),
                container: String::new(),
                size_bytes: 0,
                duration_sec: None,
                width: None,
                height: None,
                fps: None,
                pixel_aspect: None,
                video_duration_sec: None,
                video_codec: None,
                audio_codec: None,
                audio_bitrate_kbps: None,
                has_video: false,
                has_audio: false,
                still: false,
            };
            runtime
                .block_on(probe_with_ffprobe(&exe("ffprobe"), &probe.path.clone(), &mut probe))
                .unwrap_or_else(|err| panic!("{}: {err}", path.display()));
            if probe.still {
                probe.duration_sec = None;
            }
            probe
        };

        let mut failures = Vec::new();
        let cases: Vec<(&str, &str)> = VIDEO_FORMATS
            .iter()
            .map(|target| ("clip.mp4", *target))
            .chain(AUDIO_FORMATS.iter().map(|target| ("song.wav", *target)))
            .chain([("clip.mp4", "gif"), ("alpha.png", "gif")])
            .chain(IMAGE_FORMATS.iter().map(|target| ("alpha.png", *target)))
            .chain(IMAGE_FORMATS.iter().map(|target| ("photo.jpg", *target)))
            .chain([("clip.mp4", "jpg"), ("photo.jpg", "mp4")])
            .collect();
        let heic = std::env::var("UD_CONVERT_HEIC").ok();
        let cases: Vec<(&str, &str)> = cases
            .into_iter()
            .chain(
                heic.iter()
                    .flat_map(|path| ["jpg", "png", "webp", "gif"].map(|target| (path.as_str(), target))),
            )
            .collect();
        for (source, target) in cases {
            let mut input = samples.join(source);
            let mut probe = read(&input);
            if is_tiled_still(&probe) {
                let whole = out_dir.join("unpacked.png");
                let grid = runtime.block_on(tile_grid(&exe("ffprobe"), &input.to_string_lossy()));
                assert!(grid.is_some(), "{source} has no tile grid");
                let args = unpack_args(&input, &whole, grid.as_ref());
                let result = runtime.block_on(process::run(&exe("ffmpeg"), &args)).unwrap();
                assert!(result.success(), "unpacking {source}: {}", result.stderr);
                input = whole;
                probe = read(&input);
                println!("{source} unpacked to {:?}x{:?}", probe.width, probe.height);
            }
            let source = Path::new(source).file_name().unwrap().to_str().unwrap();
            let kind = format_kind(target).unwrap();
            for quality in [ConvertQuality::Original, ConvertQuality::Small] {
                let mut opts = with_quality(target, quality);
                if kind == ConvertKind::Gif {
                    opts.fps = Some(15.0);
                    opts.max_side = Some(480);
                }
                let stem = format!("{}-{target}-{quality:?}", source.replace('.', "_"));
                let output = out_dir.join(format!("{stem}.{}", extension_for(target)));
                let _ = std::fs::remove_file(&output);
                let mut passes = Vec::new();
                if copy_is_plausible(target, kind, &probe, &opts) {
                    passes.push(Pass::Copy);
                }
                passes.push(Pass::Software);
                let mut done = false;
                let mut why = String::new();
                for pass in passes {
                    let args = build_args(&input, &output, target, kind, &probe, &opts, pass);
                    let result = runtime.block_on(process::run(&exe("ffmpeg"), &args)).unwrap();
                    if result.success() && std::fs::metadata(&output).map(|m| m.len() > 0).unwrap_or(false) {
                        done = true;
                        break;
                    }
                    why = format!("{pass:?}: {}", result.stderr.lines().next().unwrap_or(""));
                    let _ = std::fs::remove_file(&output);
                }
                if !done {
                    failures.push(format!("{source} -> {target} ({quality:?}): {why}"));
                    continue;
                }
                let written = read(&output);
                let size = std::fs::metadata(&output).unwrap().len();
                println!(
                    "{source} -> {target} ({quality:?}): {size} bytes, {:?} {:?}x{:?} {:?}/{:?}",
                    written.video_codec, written.width, written.height, written.fps, written.audio_codec
                );
            }
        }
        assert!(failures.is_empty(), "{failures:#?}");
    }
}
