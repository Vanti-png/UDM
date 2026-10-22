# Universal Downloader Connector

The browser half of Universal Downloader. It does two things, both over Chrome's
native messaging channel to the app on the same computer:

- **It sends the videos playing in the browser to the app.** It notices the
  video and audio the open tabs fetch, lists them in its popup, and when the
  user presses **İndir** hands that one item to the app, which comes to the
  front with the video open on its Home screen, where the user picks the quality
  and the watermark and downloads it. The extension never
  downloads anything itself.
- **It lends the app the profile's YouTube and TikTok sessions**, each only
  while the user has its switch on, so members-only videos the user pays for
  and age-restricted posts the user's own TikTok account can see can be
  downloaded. Chrome 127 encrypts its cookie database against other programs on
  the same machine, which is what stopped the download engine reading it
  directly. A third switch, **Diğer sitelerde oturum** (Session on other
  sites), lends one more: the sign-in of the site whose page **İndir** is
  pressed on, read at that press for that site's registrable domain alone and
  sent just before the download as a `pushSite` with `site: "other"` and the
  `domain`. Never in the background, never YouTube's or TikTok's, and the app
  keeps it an hour.

Nothing here listens on a port. Chrome starts `ud-bridge.exe` itself, only for
this extension's ids, and only because the app wrote a registry value under the
user's own hive naming it. The wire format is
`src-tauri/src/bridge/protocol.rs`; every field name in `background.js` comes
from there. No host reply ever carries cookie material.

## How the pieces fit

| File | What it does |
|---|---|
| `media.js` | Pure helpers, no `chrome.*`: what a response is (`classify`), HLS and DASH manifests (`parseHls`, `parseDash`), the popup's list (`rows`) and what a click of the page picker stands for (`pickedRow`). Shared by the worker and the popup. |
| `describe.js` | The words a row is described in (`firstMeta`, `detailMeta`) and what the app's answer means for the user (`problemOf`). Pure; the popup's list and the picker's card say a row alike. |
| `sessions.js` | Pure helpers for the lent sessions: which domain each site's cookies are read from, which of them mean a sign-in, which changes are worth a push, the push's wire head (`push` for YouTube, `pushSite` for any other site), and for the other sites' switch which site a page is (`registrableDomain`, `otherSiteOf`). |
| `background.js` | The service worker (an ES module). Watches `webRequest`, keeps a list per tab in `chrome.storage.session`, draws the badge, answers the popup, talks to the host. |
| `popup.*` | The list, the **İndir** buttons, the page picker's button and the session switches (TikTok's only on TikTok pages, the other sites' only on other sites' pages, each also while it is on). |
| `picker.js` | The page picker, the only script this extension puts into a page, and only when its button is pressed: makes the video, sound or picture under the pointer glow in every frame and reports the one clicked; where the browser will not open the popup to show it, draws a card with **İndir** in the top frame instead. A plain script, since that is what `executeScript` injects. |
| `welcome.*` | Opened once, on install. |
| `theme.css`, `fonts/` | The app's tokens and its typeface (Inter, OFL; the licence ships beside it). |

1. `webRequest.onHeadersReceived` sees every media, XHR and fetch response of
   every tab. `media.classify` sorts it into a stream (HLS, DASH), a file
   (video, audio), or something that is not worth a row: a segment, an advert,
   YouTube's `videoplayback`. Those still mark the tab as playing something.
2. Rows worth keeping go into `tab:<id>` in session storage, with the frame and
   origin that asked for them. A navigation drops them; closing the tab deletes
   the record.
3. Opening the popup runs a scan: a small function in every frame reports the
   page's `<video>`/`<audio>` elements and its title, and each manifest is read
   again inside the frame that first fetched it, so the request carries the
   same Referer, Origin and cookies the player's did. `media.rows` turns all of
   it into the list.
4. **İndir** sends `{ type: "download", …peer, url, kind, title, pageUrl,
   referer, origin, userAgent, thumbnail }` (Contract A). The host writes it to
   the app's inbox and starts the app with `--handoff`.
5. **Pick from the page** (the button beside the popup's heading) injects
   `picker.js` into every frame of the tab and starts it with a fresh token,
   kept in session storage as `pick:<id>`. A click reports the element -- its
   source, the widest picture its `srcset` offers, its size, and the links
   around it, nearest first -- and `media.pickedRow` decides what it stands
   for: the post it is part of on a site the app reads by address (a tweet in a
   timeline), the file it plays, the stream its frame fetched, or the page.
   Pictures go as a fifth kind, `image`, which an app from before it reads as
   `page`. The worker then opens the popup (`action.openPopup`), which shows
   the pick above the list with **İndir**, **Pick again** and × back to the
   list, for as long as the tab stays on that page. Chrome before 127 will not
   open it for an extension like this one; there the top frame draws a card
   with the same buttons. The worker keeps the payload; the card only names
   the pick by its token, and a message from a tab is answered only for
   `picked`, `pickProbe`, `pickGet`, `pickEnd` and `pickAgain` with that tab's
   token.

On YouTube and the other sites the app reads by address (`PAGE_SITES` in
`media.js`), the popup offers the page itself rather than the pieces the player
fetched. DRM is never worked around: an element with `mediaKeys`, an HLS key
naming a DRM system or a DASH `ContentProtection` makes the row "Protected",
with no button, and the services the app refuses by name (`PROTECTED`, a mirror
of `src-tauri/src/providers/detect.rs`) list nothing at all.

The tests are `node --test scripts/extension/`, outside this folder so the
store package never carries them. They also check that `PROTECTED` still
matches `detect.rs`, that the sites in `sessions.js` are the host's `Site`
names, and that every sign-in cookie it names is one the app's log masks.

## Loading it for development

1. `node scripts/extension-key.mjs` once, if `key.pem` is not already there. It
   writes the private key, puts the matching `key` into `manifest.json` and
   prints the extension id.
2. Set `EXTENSION_ID_DEV` in `src-tauri/src/bridge/protocol.rs` to that id, and
   rebuild. The host compares the origin Chrome passes it against its two ids
   and refuses anything else.
3. Run the app once so it writes the native messaging registry values.
4. `chrome://extensions`, turn on Developer mode, **Load unpacked**, and pick
   this `extension` directory.
5. The welcome tab opens by itself. Play a video and open the popup.

The toolbar icons are the application's own six-blade aperture, drawn from the
same proportions as `scripts/generate_icon.py`. `node extension/make-icons.mjs`
regenerates `icons/` when the mark changes; `welcome.html` carries the same
shape inline and has to be changed with it.

### Why the manifest carries a key

An unpacked extension's id is normally derived from the path it was loaded
from, so it changes when the checkout moves and the host stops recognising it.
The `key` field pins it: Chrome derives the id from that public key instead --
SHA-256 over the DER SubjectPublicKeyInfo, the first sixteen bytes, hex, each
digit shifted from `0`-`f` onto `a`-`p`.

The Chrome Web Store ignores the manifest `key` and issues its own id, so the
published copy (`oikcjjcihkfmgmmmjagilnfgnfilghic`) has a different id from
every development copy. That is why `protocol.rs` holds two constants and
accepts both; an app built without the store id is what a store user meets as
"Universal Downloader'ı güncelleyin".

Regenerating `key.pem` changes the development id. `scripts/extension-key.mjs`
refuses to overwrite an existing key for that reason, and prints the id it
already implies.

## Packaging for the store

There are two builds of the same files (`edition.js`). The **full build** is
this folder as it is: it lists YouTube and has the three session switches. The
**store build** is what the Chrome Web Store accepts after it refused 1.0.5 for
working on YouTube, made by `scripts/extension-edition.mjs`:

- Whatever only the full build runs -- the sessions, the switches, and the code
  that serves YouTube and Spotify -- is fenced where it is written and cut out:
  `// <full>` to `// </full>` in scripts, `/* <full> */` to `/* </full> */` in
  `popup.css`, `<!-- full -->` to `<!-- /full -->` in the pages. `sessions.js`
  is left out whole. The store package does not carry that code switched off;
  it does not carry it. A fence is whole lines, does not nest, and a file that
  should have one and has lost it fails the pack.
- What only the store build does asks `STORE`, which the script writes `true`
  into in its copy of `edition.js`: YouTube's and Spotify's hosts go into
  `UNLISTED_SITES`, and a profile an earlier store copy connected is let go.
- The manifest drops `cookies` and `alarms`, and both locales drop the session
  messages.

New code for the full build alone goes inside a fence; new code for both goes
outside one and must not name YouTube or Spotify. `scripts/extension/edition.test.mjs`
holds the store build to all of that: its files are cut for real, `media.js` and
`background.js` are imported from a scratch copy, and the service worker is run
against a `chrome` with only the store's permissions.

`node scripts/pack-extension.mjs` writes `extension-upload.zip` at the
repository root: the store build, for the Chrome Web Store, and the only zip
that ever goes there. `--full` writes `extension-full.zip`, the full build for
Chrome, published beside the app for loading unpacked. Both remove the `key`
from the manifest -- Google's guidance is
to strip it -- and leaves out `key.pem` (which must never leave the machine that
publishes), `make-icons.mjs`, `.gitignore`, these notes, `PRIVACY.md`,
`PRIVACY-CHROME.md`, `STORE-LISTING.md` and any test file; the store build
also leaves out `sessions.js`. Everything else ships, `media.js` and
`fonts/` included. It prints what it packed, so a file that should not ship is
visible in the output rather than in the listing.

`node scripts/pack-extension.mjs --firefox` writes `extension-firefox.zip` for
addons.mozilla.org from the same files, as the full build. Only the manifest
differs: the
background runs as a module script instead of a service worker, the id is
`connector@universaldownloader.app` (`FIREFOX_EXTENSION_ID` in
`src-tauri/src/bridge/protocol.rs`), and it declares that no data is collected.
The app registers a second host manifest for Firefox under
`HKCU\Software\Mozilla\NativeMessagingHosts`, with `allowed_extensions` where
Chrome's has `allowed_origins`, and the host accepts Firefox's way of naming
the caller -- the manifest path first, the extension id second. `npx web-ext
lint` on the unpacked zip reports no errors or warnings.

`node scripts/build-store-assets.mjs` photographs the real popup for the
listing images in `store-assets/`, with headless Chrome and no user
interaction.

## What the store listing has to say

The single purpose is *sending the videos playing in the user's browser to
Universal Downloader, a program on the same computer*. Lending the YouTube and
TikTok sessions is part of the same purpose: it is what lets the app download
the members-only videos and age-restricted posts the user can already watch.
So is lending, on İndir, the session of the site the user pressed it on: the
post that site shows only to the user's own account.
The permissions map onto it:

- `webRequest` with `<all_urls>` -- seeing which videos a tab plays. There is
  no narrower pattern: the videos come from whatever server the site uses.
- `scripting` -- reading the page's video elements and title when the popup
  opens, and re-reading a stream's playlist inside the page for its quality;
  and, when the user presses **Pick from the page**, drawing the picker in that
  tab and reading the element clicked.
- `nativeMessaging` -- the only channel out. No remote endpoint, no analytics.
- `cookies` -- youtube.com and tiktok.com, each only while its switch is on;
  and with Session on other sites on, the site of the page İndir is pressed
  on, at that press only.
- `storage` -- a profile id, the three switches, the host's last word on the
  link, and the per-tab lists (session storage, gone when the browser closes).
- `alarms` -- a daily refresh, so a lent session does not go stale unnoticed.

Two things to know before every upload:

- **The permissions grew in 1.0.3.** Chrome disables an installed extension
  whose update asks for new permissions until the user accepts them, so 1.0.2
  users see it switched off with a prompt.
- **YouTube is a policy risk.** The Chrome Web Store refused 1.0.5 for it
  ("Blue Zinc"), and refuses and removes extensions that download from YouTube.
  Only the store build goes there, and it lists nothing on YouTube or Spotify.
  Never upload `extension-full.zip` to the Chrome Web Store.

The section above lists the permissions of the full build; the store build has
the same less `cookies` and `alarms`. `STORE-LISTING.md` holds every field the
dashboard asks for. `PRIVACY-CHROME.md` is the policy the Chrome listing links
to, and `PRIVACY.md` the full build's, for addons.mozilla.org. Each has to
describe exactly the permissions its build asks for.
