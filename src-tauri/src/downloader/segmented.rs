//! Multi-connection transfers.
//!
//! A file whose host honours `Range` and states its size is fetched over
//! several connections at once, each filling its own segment of one
//! preallocated `.part` file. This is the technique download managers are
//! known for, and the reason is the same one [`super::http`] chunks for: many
//! hosts pace each connection, not each client, so four connections are close
//! to four times as fast.
//!
//! Segments are split dynamically. When a connection finishes its own segment
//! it takes the back half of the largest one still in progress, so the last
//! few seconds of a download are not one slow connection finishing alone while
//! the others sit idle.
//!
//! Progress lives in a small sidecar next to the partial file
//! (`<target>.part.segs`): the size, the server's validator and, for each
//! segment, how far it has got. It is written only after the file's data has
//! been synced, so after a pause, a crash or a restart the transfer continues
//! from what is really on disk. The sidecar is written before the file is
//! extended to its full length, so a `.part` that is full-length but not full
//! of data never exists without one.
//!
//! Anything that cannot be split -- no range support, no stated size, a file
//! too small to be worth it -- is left to the single-connection fetcher.

use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use futures_util::stream::FuturesUnordered;
use futures_util::StreamExt;
use reqwest::header::{CONTENT_RANGE, ETAG, LAST_MODIFIED, RANGE};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};

use crate::downloader::control::TaskControl;
use crate::downloader::http::{self, FetchOptions, ProgressSample};
use crate::downloader::limiter;
use crate::downloader::speed::SpeedTracker;
use crate::error::{AppError, AppResult};
use crate::model::SegmentProgress;
use crate::{log_debug, log_info, log_warn};

const MIB: u64 = 1024 * 1024;

/// The most connections one download may open. Past this a host is far more
/// likely to start refusing than to get any faster.
pub const MAX_CONNECTIONS: u32 = 32;

/// Low-resource mode keeps a download to this many connections.
const LOW_RESOURCE_CONNECTIONS: u32 = 2;

/// Below this a file is fetched over one connection: opening more would cost
/// more in handshakes than it saves.
pub const MIN_SEGMENTED_BYTES: u64 = 4 * MIB;

/// No segment is split into halves smaller than this. It also bounds how far a
/// split can land from the owning connection's write position, which is what
/// keeps two connections from ever writing the same bytes.
const MIN_SPLIT_BYTES: u64 = MIB;

/// The largest single write. Must stay well under [`MIN_SPLIT_BYTES`].
const MAX_WRITE_BYTES: usize = 256 * 1024;
const _: () = assert!((MAX_WRITE_BYTES as u64) < MIN_SPLIT_BYTES);

/// Bytes per ranged request, as in [`super::http`]: bounded so a host that
/// throttles long-lived connections never gets to.
const REQUEST_BYTES: u64 = 8 * MIB;
const LOW_RESOURCE_REQUEST_BYTES: u64 = 2 * MIB;

/// Attempts per connection before it gives up its segment to the others.
const MAX_ATTEMPTS: u32 = 4;

const REPORT_INTERVAL: Duration = Duration::from_millis(500);
const SAVE_INTERVAL: Duration = Duration::from_secs(2);

const STATE_VERSION: u32 = 1;

/// One piece of the file: `[start, end)`, with everything before `next`
/// already on disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Segment {
    pub start: u64,
    pub end: u64,
    pub next: u64,
}

impl Segment {
    fn fresh(start: u64, end: u64) -> Self {
        Self { start, end, next: start }
    }

    pub fn remaining(&self) -> u64 {
        self.end.saturating_sub(self.next)
    }

    pub fn received(&self) -> u64 {
        self.next.saturating_sub(self.start)
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedState {
    version: u32,
    total: u64,
    /// ETag or Last-Modified, when the host sent one. A file that changed on
    /// the server between runs cannot be stitched onto what was already
    /// fetched of the old one.
    validator: Option<String>,
    segments: Vec<Segment>,
}

struct Slot {
    segment: Segment,
    /// The connection filling it, if any.
    owner: Option<usize>,
}

/// Every segment of the file and who is working on it.
struct Board {
    slots: Vec<Slot>,
}

impl Board {
    fn new(segments: Vec<Segment>) -> Self {
        Self {
            slots: segments
                .into_iter()
                .map(|segment| Slot { segment, owner: None })
                .collect(),
        }
    }

    /// Give `worker` something to fetch: an unclaimed segment if there is one,
    /// otherwise the back half of the largest segment still in progress.
    fn claim(&mut self, worker: usize) -> Option<usize> {
        let unclaimed = self
            .slots
            .iter()
            .enumerate()
            .filter(|(_, slot)| slot.owner.is_none() && slot.segment.remaining() > 0)
            .min_by_key(|(_, slot)| slot.segment.next)
            .map(|(index, _)| index);
        if let Some(index) = unclaimed {
            self.slots[index].owner = Some(worker);
            return Some(index);
        }

        let (index, _) = self
            .slots
            .iter()
            .enumerate()
            .filter(|(_, slot)| slot.segment.remaining() >= MIN_SPLIT_BYTES * 2)
            .max_by_key(|(_, slot)| slot.segment.remaining())?;
        let segment = &mut self.slots[index].segment;
        let middle = segment.next + segment.remaining() / 2;
        let tail = Segment::fresh(middle, segment.end);
        segment.end = middle;
        self.slots.push(Slot {
            segment: tail,
            owner: Some(worker),
        });
        Some(self.slots.len() - 1)
    }

    fn release(&mut self, index: usize) {
        self.slots[index].owner = None;
    }

    fn received(&self) -> u64 {
        self.slots.iter().map(|slot| slot.segment.received()).sum()
    }

    fn complete(&self) -> bool {
        self.slots.iter().all(|slot| slot.segment.remaining() == 0)
    }

    #[cfg(test)]
    fn active_connections(&self) -> usize {
        self.slots
            .iter()
            .filter(|slot| slot.owner.is_some() && slot.segment.remaining() > 0)
            .count()
    }

    fn segments(&self) -> Vec<Segment> {
        let mut segments: Vec<Segment> = self.slots.iter().map(|slot| slot.segment).collect();
        segments.sort_by_key(|segment| segment.start);
        segments
    }

    /// The map the detail window draws: every piece in file order, how much of
    /// it is on disk, and whether a connection is filling it now.
    fn progress(&self) -> Vec<SegmentProgress> {
        let mut map: Vec<SegmentProgress> = self
            .slots
            .iter()
            .filter(|slot| slot.segment.end > slot.segment.start)
            .map(|slot| SegmentProgress {
                start: slot.segment.start,
                end: slot.segment.end,
                received: slot.segment.received(),
                active: slot.owner.is_some() && slot.segment.remaining() > 0,
            })
            .collect();
        map.sort_by_key(|piece| piece.start);
        map
    }
}

/// How a fresh transfer of `total` bytes is cut up, given `already` bytes from
/// a single-connection run that are already on disk at the front of the file.
pub fn initial_layout(total: u64, already: u64, connections: u32) -> Vec<Segment> {
    let already = already.min(total);
    let mut segments = Vec::new();
    if already > 0 {
        segments.push(Segment {
            start: 0,
            end: already,
            next: already,
        });
    }

    let remaining = total - already;
    if remaining == 0 {
        return segments;
    }
    let pieces = (remaining / (MIN_SPLIT_BYTES * 2)).clamp(1, u64::from(connections.max(1)));
    let size = remaining / pieces;
    let mut start = already;
    for piece in 0..pieces {
        let end = if piece + 1 == pieces { total } else { start + size };
        segments.push(Segment::fresh(start, end));
        start = end;
    }
    segments
}

/// Whether saved segments describe `total` bytes exactly: in order, without
/// gaps or overlaps, each one's progress inside itself.
pub fn valid_layout(segments: &[Segment], total: u64) -> bool {
    let mut sorted = segments.to_vec();
    sorted.sort_by_key(|segment| segment.start);
    let mut expected = 0;
    for segment in &sorted {
        if segment.start != expected
            || segment.end < segment.start
            || segment.next < segment.start
            || segment.next > segment.end
        {
            return false;
        }
        expected = segment.end;
    }
    expected == total
}

pub fn state_path(target: &Path) -> PathBuf {
    let mut name = http::part_path(target).into_os_string();
    name.push(".segs");
    PathBuf::from(name)
}

struct Probe {
    total: u64,
    validator: Option<String>,
}

/// Ask for the first byte, which says whether ranges work, how large the file
/// is and what the server calls this version of it.
async fn probe(client: &reqwest::Client, options: &FetchOptions<'_>) -> AppResult<Option<Probe>> {
    let mut request = client.get(options.url);
    for (name, value) in options.headers {
        request = request.header(name, value);
    }
    let response = request.header(RANGE, "bytes=0-0").send().await?;
    let status = response.status();

    if status == StatusCode::PARTIAL_CONTENT {
        let headers = response.headers();
        let total = headers
            .get(CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.rsplit('/').next()?.trim().parse::<u64>().ok());
        let validator = headers
            .get(ETAG)
            // A weak tag promises equivalence, not the same bytes.
            .filter(|value| !value.as_bytes().starts_with(b"W/"))
            .or_else(|| headers.get(LAST_MODIFIED))
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        // One byte: reading it lets the connection go back to the pool.
        let _ = response.bytes().await;
        return Ok(total.map(|total| Probe { total, validator }));
    }

    // A 200 is the whole file, which nobody asked for: dropped unread, it
    // closes the connection rather than streaming it.
    if status.is_success() || status == StatusCode::RANGE_NOT_SATISFIABLE {
        return Ok(None);
    }
    Err(AppError::from_status(
        status.as_u16(),
        status.canonical_reason().unwrap_or("request failed"),
    ))
}

/// Everything the connections of one download share.
struct Shared<'a> {
    client: &'a reqwest::Client,
    url: &'a str,
    headers: &'a [(String, String)],
    file: &'a File,
    board: &'a Mutex<Board>,
    control: &'a TaskControl,
    request_bytes: u64,
}

impl Shared<'_> {
    fn board(&self) -> MutexGuard<'_, Board> {
        self.board.lock().unwrap_or_else(|err| err.into_inner())
    }
}

/// Fetch `options.url` over up to `connections` connections.
///
/// `Ok(None)` means this transfer is not one to split and nothing was touched;
/// the caller fetches it over a single connection instead.
pub async fn fetch(
    client: &reqwest::Client,
    options: &FetchOptions<'_>,
    connections: u32,
    control: &Arc<TaskControl>,
    on_progress: &mut (dyn FnMut(ProgressSample) + Send),
) -> AppResult<Option<u64>> {
    let part_path = http::part_path(options.target);
    let state_path = state_path(options.target);
    let resuming = state_path.exists();

    let mut connections = connections.clamp(1, MAX_CONNECTIONS);
    if options.low_resource {
        connections = connections.min(LOW_RESOURCE_CONNECTIONS);
    }
    // One connection is still worth running here when an earlier run left a
    // split file behind: only this code knows which parts of it are filled.
    if connections < 2 && !resuming {
        return Ok(None);
    }

    let probe = match probe(client, options).await {
        Ok(Some(probe)) if probe.total >= MIN_SEGMENTED_BYTES || resuming => probe,
        Ok(_) => {
            abandon(&part_path, &state_path);
            return Ok(None);
        }
        // A single connection retries on its own. A split file, though, is
        // only readable by this code, and a passing failure is no reason to
        // throw away what it holds.
        Err(err) if http::is_retryable(&err) && !resuming => {
            log_debug!("segmented", "probe failed ({err}); using a single connection");
            return Ok(None);
        }
        Err(err) => return Err(err),
    };
    let total = probe.total;

    let saved = load_state(&state_path).filter(|saved| {
        saved.version == STATE_VERSION
            && saved.total == total
            && saved.validator == probe.validator
            && valid_layout(&saved.segments, total)
            && std::fs::metadata(&part_path).is_ok_and(|meta| meta.len() == total)
    });
    let segments = match saved {
        Some(saved) => {
            log_debug!("segmented", "resuming {} segments", saved.segments.len());
            saved.segments
        }
        None => {
            // A split file that no longer matches the server is worthless;
            // a single-connection partial is a filled prefix and is kept.
            let already = if resuming {
                let _ = std::fs::remove_file(&part_path);
                0
            } else {
                std::fs::metadata(&part_path).map(|meta| meta.len()).unwrap_or(0)
            };
            initial_layout(total, already, connections)
        }
    };

    // Written before the file is extended, so a full-length `.part` always
    // comes with the record of which parts of it are real.
    save_state(&state_path, total, probe.validator.as_deref(), &segments)?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .read(true)
        .truncate(false)
        .open(&part_path)?;
    file.set_len(total)?;

    let board = Mutex::new(Board::new(segments));
    let shared = Shared {
        client,
        url: options.url,
        headers: options.headers,
        file: &file,
        board: &board,
        control,
        request_bytes: if options.low_resource {
            LOW_RESOURCE_REQUEST_BYTES
        } else {
            REQUEST_BYTES
        },
    };

    let start_received = shared.board().received();
    let mut tracker = SpeedTracker::new(start_received);
    let mut reported = start_received;
    emit(on_progress, &tracker, total, shared.board().progress());
    log_info!(
        "segmented",
        "{} bytes over up to {connections} connections ({} already on disk)",
        total,
        start_received
    );

    let mut workers: FuturesUnordered<_> = (0..connections as usize)
        .map(|id| worker(id, &shared))
        .collect();
    let mut ticker = tokio::time::interval(REPORT_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_saved = Instant::now();
    let mut failure: Option<AppError> = None;

    loop {
        tokio::select! {
            finished = workers.next() => match finished {
                None => break,
                Some(Ok(())) | Some(Err(AppError::Canceled)) => {}
                // One connection failing is not the download failing: hosts
                // that cap connections refuse the extra ones, and the rest
                // take its segment over. Only the last one's error counts.
                Some(Err(err)) => {
                    log_warn!("segmented", "a connection gave up: {err}");
                    failure = Some(err);
                }
            },
            _ = ticker.tick() => {
                // A tick with nothing new still closes a window, which is
                // what lets the readout fall to zero on a stall.
                let (received, map) = {
                    let board = shared.board();
                    (board.received(), board.progress())
                };
                tracker.record(received.saturating_sub(reported));
                reported = received;
                emit(on_progress, &tracker, total, map);

                if last_saved.elapsed() >= SAVE_INTERVAL {
                    let segments = shared.board().segments();
                    if file.sync_data().is_ok() {
                        let _ = save_state(&state_path, total, probe.validator.as_deref(), &segments);
                    }
                    last_saved = Instant::now();
                }
            }
        }
    }
    drop(workers);

    let (complete, segments, map) = {
        let board = shared.board();
        (board.complete(), board.segments(), board.progress())
    };
    file.sync_data()?;

    if !complete {
        save_state(&state_path, total, probe.validator.as_deref(), &segments)?;
        if control.interrupted() {
            return Err(AppError::Canceled);
        }
        return Err(failure.unwrap_or_else(|| {
            AppError::Network("every connection closed before the file was complete".into())
        }));
    }

    drop(file);
    let received = segments.iter().map(Segment::received).sum::<u64>();
    tracker.record(received.saturating_sub(reported));
    emit(on_progress, &tracker, total, map);
    http::finalize(&part_path, options.target)?;
    let _ = std::fs::remove_file(&state_path);
    Ok(Some(total))
}

/// One connection: claim a segment, fill it, claim the next, until nothing is
/// left that is worth taking.
async fn worker(id: usize, shared: &Shared<'_>) -> AppResult<()> {
    let mut attempt = 0u32;
    loop {
        if shared.control.interrupted() {
            return Err(AppError::Canceled);
        }
        let Some(slot) = shared.board().claim(id) else {
            return Ok(());
        };

        let mut written = 0u64;
        let result = fill(slot, shared, &mut written).await;
        shared.board().release(slot);

        if written > 0 {
            attempt = 0;
        }
        match result {
            Ok(()) => {}
            Err(AppError::Canceled) => return Err(AppError::Canceled),
            Err(err) => {
                attempt += 1;
                // The others may still finish; this one steps aside, and its
                // segment goes back on the board for them.
                if attempt >= MAX_ATTEMPTS || !http::is_retryable(&err) {
                    return Err(err);
                }
                log_debug!("segmented", "connection {id} attempt {attempt} failed: {err}");
                tokio::time::sleep(Duration::from_millis(400 * u64::from(attempt))).await;
            }
        }
    }
}

/// Fill segment `slot` with bounded ranged requests until it is complete, or
/// until a split elsewhere has shortened it to where this connection already
/// is.
async fn fill(slot: usize, shared: &Shared<'_>, written: &mut u64) -> AppResult<()> {
    loop {
        if shared.control.interrupted() {
            return Err(AppError::Canceled);
        }
        let Segment { next: from, end, .. } = shared.board().slots[slot].segment;
        if from >= end {
            return Ok(());
        }
        let to = end.min(from + shared.request_bytes);

        let mut request = shared.client.get(shared.url);
        for (name, value) in shared.headers {
            request = request.header(name, value);
        }
        let response = request
            .header(RANGE, format!("bytes={}-{}", from, to - 1))
            .send()
            .await?;
        let status = response.status();
        if status != StatusCode::PARTIAL_CONTENT {
            if status.is_success() {
                return Err(AppError::Network(
                    "the server stopped honouring ranged requests".into(),
                ));
            }
            return Err(AppError::from_status(
                status.as_u16(),
                status.canonical_reason().unwrap_or("request failed"),
            ));
        }
        let answered_from = response
            .headers()
            .get(CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .and_then(range_start);
        if answered_from.is_some_and(|start| start != from) {
            return Err(AppError::Network("the server answered a different range".into()));
        }

        let mut cursor = from;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            if shared.control.interrupted() {
                return Err(AppError::Canceled);
            }
            let chunk = chunk?;
            limiter::global().acquire(chunk.len() as u64).await;
            shared.control.limiter().acquire(chunk.len() as u64).await;

            for piece in chunk.chunks(MAX_WRITE_BYTES) {
                // Read fresh each time: another connection may have taken the
                // back of this segment while the request was in flight.
                let end = shared.board().slots[slot].segment.end;
                let room = end.saturating_sub(cursor);
                let take = (piece.len() as u64).min(room) as usize;
                if take > 0 {
                    write_all_at(shared.file, &piece[..take], cursor)?;
                    cursor += take as u64;
                    *written += take as u64;
                    shared.board().slots[slot].segment.next = cursor;
                }
                if cursor >= end {
                    // The rest of this response belongs to someone else.
                    return Ok(());
                }
            }
        }

        if cursor < to {
            return Err(AppError::Network(format!(
                "the connection closed after {} of {} bytes",
                cursor - from,
                to - from
            )));
        }
    }
}

/// The first byte of a `Content-Range: bytes START-END/TOTAL`.
fn range_start(value: &str) -> Option<u64> {
    value
        .trim()
        .strip_prefix("bytes")?
        .trim()
        .split('-')
        .next()?
        .trim()
        .parse()
        .ok()
}

fn emit(
    on_progress: &mut (dyn FnMut(ProgressSample) + Send),
    tracker: &SpeedTracker,
    total: u64,
    segments: Vec<SegmentProgress>,
) {
    on_progress(ProgressSample {
        received: tracker.received().min(total),
        total: Some(total),
        speed_bps: tracker.speed_bps(),
        eta_sec: tracker.eta_sec(Some(total)),
        percent: tracker.percent(Some(total)),
        resumable: true,
        segments,
    });
}

fn load_state(path: &Path) -> Option<SavedState> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Write the sidecar through a temporary file, so a crash mid-write leaves the
/// previous version rather than half of this one.
fn save_state(path: &Path, total: u64, validator: Option<&str>, segments: &[Segment]) -> AppResult<()> {
    let state = SavedState {
        version: STATE_VERSION,
        total,
        validator: validator.map(str::to_string),
        segments: segments.to_vec(),
    };
    let mut temporary = path.as_os_str().to_os_string();
    temporary.push(".tmp");
    let temporary = PathBuf::from(temporary);
    std::fs::write(&temporary, serde_json::to_vec(&state)?)?;
    std::fs::rename(&temporary, path)?;
    Ok(())
}

/// Drop a split file this code can no longer continue. Only when there is
/// one: a single-connection partial is left for the single-connection fetcher.
fn abandon(part_path: &Path, state_path: &Path) {
    if state_path.exists() {
        log_debug!("segmented", "discarding a split partial file the server can no longer continue");
        let _ = std::fs::remove_file(part_path);
        let _ = std::fs::remove_file(state_path);
    }
}

#[cfg(windows)]
fn write_all_at(file: &File, mut buffer: &[u8], mut offset: u64) -> std::io::Result<()> {
    use std::os::windows::fs::FileExt;
    while !buffer.is_empty() {
        let written = file.seek_write(buffer, offset)?;
        if written == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::WriteZero,
                "the disk accepted no more data",
            ));
        }
        buffer = &buffer[written..];
        offset += written as u64;
    }
    Ok(())
}

#[cfg(unix)]
fn write_all_at(file: &File, buffer: &[u8], offset: u64) -> std::io::Result<()> {
    use std::os::unix::fs::FileExt;
    file.write_all_at(buffer, offset)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_file_is_cut_into_one_piece_per_connection() {
        let segments = initial_layout(100 * MIB, 0, 8);
        assert_eq!(segments.len(), 8);
        assert!(valid_layout(&segments, 100 * MIB));
        assert!(segments.iter().all(|segment| segment.received() == 0));
    }

    #[test]
    fn a_small_file_gets_fewer_pieces_than_connections() {
        // 5 MiB with 2 MiB minimum halves: two pieces, not sixteen slivers.
        let segments = initial_layout(5 * MIB, 0, 16);
        assert_eq!(segments.len(), 2);
        assert!(valid_layout(&segments, 5 * MIB));
    }

    #[test]
    fn a_single_connection_prefix_is_kept_as_a_finished_segment() {
        let segments = initial_layout(64 * MIB, 10 * MIB, 4);
        assert_eq!(
            segments[0],
            Segment {
                start: 0,
                end: 10 * MIB,
                next: 10 * MIB
            }
        );
        assert!(valid_layout(&segments, 64 * MIB));
        let received: u64 = segments.iter().map(Segment::received).sum();
        assert_eq!(received, 10 * MIB);
    }

    #[test]
    fn layouts_with_gaps_or_overlaps_are_rejected() {
        let good = vec![Segment::fresh(0, 10), Segment::fresh(10, 20)];
        assert!(valid_layout(&good, 20));
        assert!(!valid_layout(&good, 30), "short of the total");
        assert!(!valid_layout(&[Segment::fresh(0, 10), Segment::fresh(12, 20)], 20));
        assert!(!valid_layout(&[Segment::fresh(0, 12), Segment::fresh(10, 20)], 20));
        let past_end = Segment {
            start: 0,
            end: 20,
            next: 25,
        };
        assert!(!valid_layout(&[past_end], 20));
    }

    #[test]
    fn an_idle_connection_takes_the_back_half_of_the_largest_segment() {
        let mut board = Board::new(vec![Segment::fresh(0, 10 * MIB), Segment::fresh(10 * MIB, 40 * MIB)]);
        assert_eq!(board.claim(0), Some(0));
        assert_eq!(board.claim(1), Some(1));
        // Connection 0 is done with its piece.
        board.slots[0].segment.next = 10 * MIB;
        board.release(0);

        let taken = board.claim(0).expect("there is a large segment to split");
        assert_eq!(board.slots[1].segment.end, 25 * MIB);
        assert_eq!(board.slots[taken].segment, Segment::fresh(25 * MIB, 40 * MIB));
        assert!(valid_layout(&board.segments(), 40 * MIB));
    }

    #[test]
    fn a_split_never_lands_behind_the_owner() {
        let mut board = Board::new(vec![Segment::fresh(0, 8 * MIB)]);
        board.claim(0);
        board.slots[0].segment.next = 5 * MIB;
        board.claim(1);
        let middle = board.slots[0].segment.end;
        assert!(middle >= 5 * MIB + MIN_SPLIT_BYTES, "split at {middle}");
    }

    #[test]
    fn segments_too_small_to_halve_are_left_alone() {
        let mut board = Board::new(vec![Segment::fresh(0, MIB + MIB / 2)]);
        assert_eq!(board.claim(0), Some(0));
        assert_eq!(board.claim(1), None);
        assert_eq!(board.active_connections(), 1);
    }

    #[test]
    fn the_map_is_every_piece_in_file_order_with_who_is_filling_it() {
        let mut board = Board::new(vec![Segment::fresh(10 * MIB, 20 * MIB), Segment::fresh(0, 10 * MIB)]);
        board.claim(0);
        board.slots[1].segment.next = 4 * MIB;
        // A piece already finished, held by nobody.
        board.slots[0].segment.next = 20 * MIB;

        assert_eq!(
            board.progress(),
            vec![
                SegmentProgress {
                    start: 0,
                    end: 10 * MIB,
                    received: 4 * MIB,
                    active: true
                },
                SegmentProgress {
                    start: 10 * MIB,
                    end: 20 * MIB,
                    received: 10 * MIB,
                    active: false
                },
            ]
        );
        // A connection that has finished its piece is not shown as filling it.
        board.slots[1].segment.next = 10 * MIB;
        assert!(board.progress().iter().all(|piece| !piece.active));
    }

    #[test]
    fn unclaimed_segments_go_first_and_in_file_order() {
        let mut board = Board::new(vec![
            Segment::fresh(20 * MIB, 30 * MIB),
            Segment::fresh(0, 10 * MIB),
            Segment::fresh(10 * MIB, 20 * MIB),
        ]);
        assert_eq!(board.claim(0), Some(1));
        assert_eq!(board.claim(1), Some(2));
        assert_eq!(board.claim(2), Some(0));
    }

    #[test]
    fn the_answered_range_is_read_from_content_range() {
        assert_eq!(range_start("bytes 1048576-2097151/9000000"), Some(1_048_576));
        assert_eq!(range_start("bytes 0-0/*"), Some(0));
        assert_eq!(range_start("items 0-1/2"), None);
    }

    #[test]
    fn the_sidecar_sits_beside_the_partial_file() {
        let path = state_path(Path::new(r"C:\d\video.mp4"));
        assert!(path.to_string_lossy().ends_with("video.mp4.part.segs"));
    }

    #[test]
    fn a_saved_state_round_trips() {
        let dir = std::env::temp_dir().join("ud-segmented-state");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("x.part.segs");
        let segments = initial_layout(64 * MIB, 0, 4);
        save_state(&path, 64 * MIB, Some("\"abc\""), &segments).unwrap();
        let loaded = load_state(&path).unwrap();
        assert_eq!(loaded.total, 64 * MIB);
        assert_eq!(loaded.validator.as_deref(), Some("\"abc\""));
        assert_eq!(loaded.segments, segments);
        let _ = std::fs::remove_file(&path);
    }
}
