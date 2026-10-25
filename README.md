# Universal Downloader

A download manager for Windows, in the spirit of Internet Download Manager and
Free Download Manager. It splits large files over several connections, caps
the speed for the whole app or for one download, takes over the downloads your
browser starts, watches the clipboard for links, and also reads media pages --
paste a video link and it shows the real qualities on offer and downloads the
one you pick. No ads, no account, no telemetry.

Built with Tauri 2, React 19, TypeScript and Rust. A fork of
[unsalable/downloader](https://github.com/unsalable/downloader).

## Download

This fork publishes no installers yet; build it from source (see
[Development](#development)). Windows 10/11, 64-bit.

The app's updater still looks for new builds in the upstream repository
(`REPOSITORY` in `src-tauri/src/updater.rs`). Until this fork publishes its
own releases, a build made here can be offered the upstream one, which does
not have the download-manager features below.

---

## What it does

### As a download manager

- **Splits large files over several connections.** A file on a host that
  answers ranged requests is fetched over up to 32 connections at once (8 by
  default), each filling its own piece of one preallocated file. A connection
  that finishes takes over the back half of the largest piece still running,
  so the last seconds are not one slow connection working alone. Hosts that
  pace each connection are where this pays: the download goes as fast as the
  line instead of as fast as one connection is allowed.
- **Resumes exactly.** Each piece's progress is kept beside the partial file,
  so a pause, a crash or a restart carries on every piece where it stopped. A
  file that changed on the server is fetched again rather than stitched.
- **Caps the speed** for the whole app (Settings -> Downloads) and, separately,
  for any one download from its detail window. A cap changed while a download
  runs is felt within a moment.
- **Shows a download's detail window**, as a download manager does: the file
  as a bar cut into the pieces its connections fetch, each filled as far as it
  has got, the list of pieces and which are downloading now, the speed, the
  time left and whether it can be resumed. Press a download that is still
  running, waiting or paused to open it.
- **Takes over the browser's downloads.** With the browser extension
  installed, a download the browser starts is paused while the app checks it
  can fetch the same file itself; if it can, the download moves to the app and
  the New download dialog asks where to save it. If it cannot -- the site wants
  a sign-in, the link only works once -- the browser's download carries on as
  if nothing happened. Private windows are never touched.
- **Watches the clipboard.** Copy a link to a file anywhere in Windows and the
  window comes forward with the New download dialog: the server's own file
  name (editable), the size, whether it can be resumed, and the folder. A link
  to a video page is offered on Home instead.
- **Downloads any file**, not just media: archives, installers, disk images,
  documents. Named the way the server names it, with no analysis.
- **Queues** as many downloads as you like, with a configurable number running
  at once, and survives a restart.

### As a media downloader

- **Reads a link and shows what is actually there** -- title, creator, duration,
  thumbnail, and the genuine list of renditions the source offers. Nothing in
  the quality menu is aspirational: a 720p video does not show a 4K option.
- **Picks the best combination for you**, merging separate video and audio
  streams when that is what "best quality" requires, and telling you *before*
  you start if that merge needs a tool you have not installed yet.
- **Downloads photos, not just videos** -- Instagram photos and carousels, X
  photos, TikTok photo posts, Reddit images and galleries, and Pinterest pins,
  each at the largest size the platform publishes.
- **Keeps a history** with the file, its size, and a one-click re-download.
- **Converts files you already have** into twelve video containers, twelve
  audio formats, animated GIF or nine picture formats. With the "Original"
  quality, when the target container can already hold the streams, it
  repackages rather than re-encodes.
- **Cuts and joins.** The editor keeps several ranges of a video and joins
  them into one file, cut against a waveform and a strip of frames.
- **Takes a video from the browser.** The extension lists what a tab is
  playing and hands one to the app, which opens it on Home. Its picker lets you
  click the video, sound or picture you mean on the page itself. See
  [`extension/README.md`](extension/README.md).

Recognised sources include YouTube, TikTok, Instagram, X, Reddit, Facebook,
Twitch, Pinterest, Vimeo, Dailymotion and SoundCloud, plus direct files and any
page that publishes its media in Open Graph tags. A song shared from Spotify is
downloaded as the same recording published on YouTube; Spotify's own encrypted
audio is never touched.

Whether a particular link yields anything is decided by the platform, not by
this app: several gate parts of their catalogue behind a signed-in session. The
app does not work around that -- it reports it in plain language.

## What it deliberately does not do

The app only downloads what a source makes available to you. It contains no DRM
circumvention, no paywall or authentication bypass, and no watermark removal.
Where a platform publishes both a watermarked and a clean rendition, the clean
one can be selected; where it publishes only a watermarked one, the app says so.

---

## Architecture

```
src/                     React front end
  components/ui/         Design-system primitives
  components/home/       Analyse, preview and download options
  components/downloads/  Queue cards, the New download dialog, the detail
                         window and its segment map
  components/history/    History rows, clearing it, recent downloads
  components/editor/     The editor's preview, timeline and inspector
  components/settings/   Tool cards, hotkey recorder, browser link
  components/convert/    Conversion job rows
  pages/                 Home, Downloads, Editor, Convert, History, Settings, About
  stores/                Zustand stores (settings, queue, convert, editor,
                         tools, analysis, new downloads, update)
  services/ipc.ts        The only place that calls `invoke`
  lib/                   Pure helpers (formatting, URLs, option derivation)
  i18n/                  English source dictionary + Turkish translation

src-tauri/src/           Rust core
  providers/             Source adapters and URL classification
  downloader/            Planning and transfers:
    plan.rs              which streams a request becomes
    http.rs              the single-connection fetcher
    segmented.rs         the multi-connection fetcher and its segment map
    limiter.rs           the speed caps (token buckets)
    file.rs              plain files: probing, naming, saving
    engine_dl.rs         HLS/DASH and sites handed to yt-dlp
    control.rs           pause, cancel and the download's own cap
  queue.rs               Scheduling, retries, persistence, progress events
  clipboard.rs           Watching the clipboard for copied links
  ffmpeg.rs              Merging and conversion during a download
  converter.rs           Probing and converting files already on disk
  export.rs              The editor's cuts, joined into one file
  range.rs               Fetching only a piece of a link for the editor
  editor_media.rs        The editor timeline's waveform and frame strip
  bridge/                The browser link: native messaging host, handoffs,
                         lent sessions (bin/ud-bridge.rs is the host)
  updater.rs             Finding and installing a newer build
  tools.rs               Discovery and installation of the external tools
  db.rs                  SQLite: settings, history, durable queue
  commands.rs            The IPC surface

extension/               The browser extension (see its own README)
```

### The download path

`downloader/plan.rs` turns a media request into concrete streams -- this is
where "Best quality" stops being a word. It is pure, so the selection rules are
tested directly, and the UI asks this same code what a selection resolves to
(`summarize_plan`), which is why the quality, container and size it shows
always match what the download does. A plain file skips it: `downloader/file.rs`
asks the server for the file's first byte, which says its name, its size and
whether it resumes, and saves it as it is.

Every native transfer goes through `downloader/http.rs`. A file of 4 MB or more
on a host that answers ranged requests is handed to `downloader/segmented.rs`,
which splits it over the configured number of connections, writes each piece at
its own offset of one preallocated `.part` file, and keeps the pieces' progress
in a `.part.segs` sidecar written only after the data it describes has been
synced. Its progress reports carry the segment map the detail window draws.
Anything that cannot be split -- no range support, no stated size -- is fetched
over one connection in bounded ranged requests, which several large hosts
throttle far less than one long request.

Every chunk is charged to two token buckets before it is written: the app-wide
one and the download's own, so N connections share a cap evenly however many
downloads run. HLS and DASH are handed to the engine, which is given the same
connection count (`--concurrent-fragments`) and the lower of the two caps.

### Taking downloads from the browser and the clipboard

The extension pauses a download the browser starts and asks the bridge host
(`bin/ud-bridge.rs`) to probe it: one cookie-less ranged request, made as the
app's download would be. Only when the host is served the file the browser was
getting -- not a sign-in page, not a body of another size -- is the download
handed over and the browser's copy cancelled; otherwise the browser resumes it.
The host leaves the link in the app's inbox and starts the app, which opens the
New download dialog on it.

`clipboard.rs` polls Windows' clipboard change count, which opens nothing, and
reads the text only when the count moves -- opening the clipboard to poll it
would make other programs' copies fail. A copied file link brings the window
forward with the New download dialog; a page link is offered on Home.

### Two external tools

Neither is bundled. Both are fetched once, on request, into the app's own data
directory -- and a copy already on your `PATH` is preferred over downloading
anything.

- **yt-dlp** reads public metadata and stream URLs for the media sites. It
  changes weekly, so a bundled copy would be stale the month after release.
- **FFmpeg** merges separate audio and video streams and handles conversion.
  It is GPL, which is cleanest to keep as a separate process the user opts into.

Plain files and direct links need neither. Both tools run as separate
processes with an argument vector; no user-supplied URL ever reaches a command
line as text that could be re-parsed.

### Provider architecture

Every source adapter implements the same `MediaProvider` trait (`id`,
`can_handle`, `analyze`) in `src-tauri/src/providers/mod.rs`. Resolution order
is: a service that encrypts its streams (refused at once) or a song shared from
Spotify -> a direct media file -> a photo post -> the engine -> the generic
page reader -> unsupported.

### The conversion path

`converter.rs` starts from a local file rather than a URL and reuses the same
machinery: FFmpeg is driven through `ffmpeg::run_with_progress`, and a job is
interrupted through the same `TaskControl` a download uses. Each job tries to
repackage, then a GPU encode where one is available, then a CPU encode, and
stops at the first that produces a file. Conversions run one at a time and
never write over their source.

### Single source of truth

- Platform detection lives only in `providers/detect.rs`. The front end asks
  over IPC rather than keeping a second copy of the host patterns.
- Format selection lives only in `downloader/plan.rs`.
- The set of conversion targets lives only in `converter.rs`.

---

## Development

Requirements: Windows 10/11, Node 22.12+, Rust 1.82+ and the MSVC build tools.

```bash
npm install
npm run app:dev      # Vite + Tauri, hot reload
```

`app:dev` also registers the browser link to the native messaging host it was
built with; build that once with `cargo build --manifest-path
src-tauri/Cargo.toml --bin ud-bridge`.

Other scripts:

```bash
npm run build          # type-check and build the front end
npm run app:build      # production build + NSIS installer
npm run test:web       # front-end unit tests (Vitest)
npm run test:rust      # Rust unit and hermetic integration tests
npm run test:online    # network tests (installs the engine, downloads real files)
npm run lint:rust      # clippy, warnings denied
node --test scripts/extension/   # the browser extension's tests
```

### The browser extension during development

- **Chrome / Edge:** `chrome://extensions`, Developer mode, **Load unpacked**,
  and pick the `extension` folder. The manifest's `key` pins the id the native
  host accepts.
- **Firefox:** `node scripts/pack-extension.mjs --firefox`, then
  `about:debugging#/runtime/this-firefox` -> **Load Temporary Add-on** and pick
  `extension-firefox.zip`. A temporary add-on lasts until Firefox closes.

### Tests

- `src/**/*.test.ts` -- front-end unit tests (Vitest) for the pure helpers and
  stores.
- `scripts/extension/` -- the browser extension's tests, kept outside
  `extension/` so the store package never carries them. They run the service
  worker against a stand-in `chrome`, captures included.
- `src-tauri/src/**` -- unit tests next to the code they cover: URL
  classification, format selection, file naming, segment splitting, the speed
  caps, pause/cancel signalling, engine output parsing, FFmpeg arguments.
- `src-tauri/tests/resume.rs`, `segmented.rs`, `file.rs`, `limiter.rs` --
  hermetic tests against purpose-built local HTTP servers: chunking and resume,
  splitting over real concurrent connections, a host that refuses extra
  connections, a file that changed between runs, the segment map, the speed
  caps, and plain files named by `Content-Disposition`. No network.
- `src-tauri/tests/pipeline.rs`, `photos.rs` and the ignored test in
  `file.rs` -- online tests that download real files end to end, checked
  against published checksums where there are any.

### Driving the UI during development

`scripts/drive-ui.mjs` talks to the running app's WebView over the Chrome
DevTools Protocol, so real flows can be exercised against the real backend:

```bash
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 \
  ./src-tauri/target/debug/universal-downloader.exe &

node scripts/drive-ui.mjs type "https://..."
node scripts/drive-ui.mjs press Enter
node scripts/drive-ui.mjs text
```

`scripts/ui-preview/` runs the interface in a browser against a stand-in
backend (`npx vite --config scripts/ui-preview/vite.config.mjs`); its
`__UD_MOCK__` console object can hand over a download or copy a link.

### Generated assets

```bash
python scripts/generate_icon.py       # the mark, flat on transparency, at 1024
npx tauri icon src-tauri/icons/app-icon.json -o src-tauri/icons
python scripts/generate_licenses.py   # third-party licence list for About
```

The mark is a six-blade aperture and nothing else. It is the same shape in
three hands -- `scripts/generate_icon.py`, `src/components/layout/Logo.tsx` and
`extension/make-icons.mjs` -- which have to be changed together.

---

## Where things are stored

Everything the app writes lives under `%APPDATA%\UniversalDownloader`:

```
library.db     settings, history and the durable queue (SQLite, WAL)
tools/         managed copies of yt-dlp and ffmpeg
cache/         thumbnails, bounded by the configured cache limit
temp/          in-flight downloads and their segment maps; a finished file
               is moved out
logs/          app.log and error.log, rotated by size
bridge/        the browser link's state, its inbox, and the sessions it lends,
               sealed with DPAPI
```

Downloads themselves go to your own Downloads folder by default.

## Privacy

No account, no ads, no analytics, no telemetry. Links are resolved by tools
running on this machine, and the only network requests made are to the source
itself, to GitHub when you ask for the two tools, and to GitHub to ask whether
a newer build exists.

The clipboard is read only when its contents change and only while clipboard
monitoring is on; nothing read from it leaves the machine. A download taken
from the browser carries its address, the page it came from and the file's
name, size and type -- never cookies.

Thumbnails are fetched once, cached on disk and handed to the interface as data
URLs, so the content-security policy can forbid remote image origins outright.

## Licences

Universal Downloader is released under the [MIT License](LICENSE).

Third-party licences are listed in the app's About screen, generated into
`src-tauri/resources/licenses.json`. Inter is used under the SIL Open Font
License; its licence text ships in `src/assets/fonts/`.
