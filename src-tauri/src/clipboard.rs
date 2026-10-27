//! Watching the clipboard for links, the way a download manager does.
//!
//! The window's own check, when it regains focus, only notices a link once the
//! user comes back to the app. A download manager notices it as it is copied:
//! a file link brings the window forward with the New download dialog, and a
//! link to a page the app reads by address is offered on Home.
//!
//! Windows counts every change to the clipboard, and reading that count opens
//! nothing. Opening the clipboard to read it every half second would: another
//! program copying at that moment finds it held, and its copy fails. So the
//! count is what is polled, and the text is read only when it moves.

use serde::Serialize;

/// A link was copied somewhere outside the app.
pub const EVENT_COPIED: &str = "clipboard://copied";

/// Longer than any link anyone copies on purpose. A clipboard holding a book
/// is not a link, and is not worth scanning for one.
const MAX_TEXT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopiedLink {
    pub url: String,
    /// The link points straight at a file (`downloader::file::is_file_link`):
    /// the window comes forward and the New download dialog opens on it.
    pub file: bool,
}

/// The first web address in a piece of copied text, as the window's own
/// `extractFirstUrl` finds one: a whitespace-separated word that starts with
/// `http://` or `https://`, without the brackets or quotes it was copied in.
pub fn first_url(text: &str) -> Option<String> {
    if text.len() > MAX_TEXT_BYTES {
        return None;
    }
    text.split_whitespace()
        .map(|word| {
            word.trim_start_matches(['<', '(', '[', '"', '\''])
                .trim_end_matches(['>', ')', ']', '"', '\'', ',', '.', ';'])
        })
        .filter(|word| {
            let lower = word.get(..8).unwrap_or(word).to_ascii_lowercase();
            lower.starts_with("http://") || lower.starts_with("https://")
        })
        .find_map(|word| {
            let parsed = reqwest::Url::parse(word).ok()?;
            parsed
                .host_str()
                .is_some_and(|host| !host.is_empty())
                .then(|| word.to_string())
        })
}

/// What a copied piece of text means to the app, if anything.
pub fn copied_link(text: &str) -> Option<CopiedLink> {
    let url = first_url(text)?;
    let file = crate::downloader::file::is_file_link(&url);
    Some(CopiedLink { url, file })
}

/// How long the same link counts as the same copy.
const SAME_COPY: std::time::Duration = std::time::Duration::from_secs(2);

/// One copy is one offer. A program that puts several formats on the
/// clipboard moves the count once for each, so one copy can be seen two or
/// three times within a moment. The same link copied again later is the user
/// asking again -- after closing the dialog, say -- and is offered again.
#[derive(Default)]
struct RepeatGuard {
    last: Option<(String, std::time::Instant)>,
}

impl RepeatGuard {
    /// Whether `url`, seen at `now`, is a new copy rather than an echo of the
    /// last one.
    fn fresh(&mut self, url: &str, now: std::time::Instant) -> bool {
        let echo = self
            .last
            .as_ref()
            .is_some_and(|(last, at)| last == url && now.saturating_duration_since(*at) < SAME_COPY);
        self.last = Some((url.to_string(), now));
        !echo
    }
}

#[cfg(windows)]
pub fn spawn(app: tauri::AppHandle) {
    let started = std::thread::Builder::new()
        .name("clipboard-watch".into())
        .spawn(move || watch(&app));
    if let Err(err) = started {
        crate::log_warn!("clipboard", "the clipboard cannot be watched: {err}");
    }
}

#[cfg(windows)]
fn watch(app: &tauri::AppHandle) {
    use std::time::Duration;

    use tauri::{Emitter, Manager};
    use tauri_plugin_clipboard_manager::ClipboardExt;
    use windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber;

    const POLL: Duration = Duration::from_millis(500);
    const READ_RETRY: Duration = Duration::from_millis(80);

    // SAFETY: takes nothing and returns a number.
    let sequence = || unsafe { GetClipboardSequenceNumber() };

    // Whatever was copied before the app started is not something the user
    // just did.
    let mut seen = sequence();
    let mut repeats = RepeatGuard::default();

    loop {
        std::thread::sleep(POLL);
        let now = sequence();
        if now == seen {
            continue;
        }
        seen = now;

        let Some(state) = app.try_state::<crate::commands::AppState>() else {
            continue;
        };
        if !state.settings().clipboard_monitoring {
            continue;
        }
        // A copy made in the app's own window is the user working in it.
        let focused = app
            .get_webview_window("main")
            .and_then(|window| window.is_focused().ok())
            .unwrap_or(false);
        if focused {
            continue;
        }

        // The program that copied may still hold the clipboard for a moment.
        let mut text = None;
        for _ in 0..3 {
            match app.clipboard().read_text() {
                Ok(read) => {
                    text = Some(read);
                    break;
                }
                Err(_) => std::thread::sleep(READ_RETRY),
            }
        }
        let Some(link) = text.as_deref().and_then(copied_link) else {
            continue;
        };
        if !repeats.fresh(&link.url, std::time::Instant::now()) {
            continue;
        }

        if link.file {
            crate::tray::show_main_window(app);
        }
        let _ = app.emit(EVENT_COPIED, link);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_web_address_is_found_wherever_it_is() {
        assert_eq!(
            first_url("see https://example.com/a.zip for it").as_deref(),
            Some("https://example.com/a.zip")
        );
        assert_eq!(
            first_url("(<https://example.com/x?y=1>).").as_deref(),
            Some("https://example.com/x?y=1")
        );
        assert_eq!(first_url("HTTPS://Example.com/").as_deref(), Some("HTTPS://Example.com/"));
        assert_eq!(first_url("ftp://a.example/b http://b.example/c").as_deref(), Some("http://b.example/c"));
        assert_eq!(first_url("no link here"), None);
        assert_eq!(first_url("https://"), None);
        assert_eq!(first_url(&format!("https://a.example/ {}", "x".repeat(MAX_TEXT_BYTES))), None);
    }

    #[test]
    fn a_file_link_is_told_from_a_page_link() {
        assert_eq!(
            copied_link("https://cdn.example/setup-2.1.exe"),
            Some(CopiedLink {
                url: "https://cdn.example/setup-2.1.exe".into(),
                file: true
            })
        );
        assert_eq!(
            copied_link("https://www.youtube.com/watch?v=jNQXAC9IVRw"),
            Some(CopiedLink {
                url: "https://www.youtube.com/watch?v=jNQXAC9IVRw".into(),
                file: false
            })
        );
        assert_eq!(copied_link("plain words"), None);
    }

    #[test]
    fn one_copy_is_offered_once_and_a_later_copy_again() {
        let start = std::time::Instant::now();
        let mut guard = RepeatGuard::default();
        let link = "https://cdn.example/setup.exe";
        assert!(guard.fresh(link, start));
        // The same copy seen again as its other formats land.
        assert!(!guard.fresh(link, start + std::time::Duration::from_millis(300)));
        // The user copying it again after closing the dialog.
        assert!(guard.fresh(link, start + std::time::Duration::from_secs(10)));
        // Another link is always new.
        assert!(guard.fresh("https://cdn.example/other.zip", start + std::time::Duration::from_secs(10)));
    }
}
