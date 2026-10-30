// Where the Firefox copy of the extension lives, shared by the packer
// (pack-extension.mjs) and the publisher (publish-firefox.mjs).
//
// The Firefox copy is signed on addons.mozilla.org for distribution "on your
// own" and handed out from this repository's `latest` release. Firefox asks
// FIREFOX_UPDATE_URL for newer versions, and fetches the one it names from the
// release.

/**
 * The extension's Firefox id. This fork's own: addons.mozilla.org keeps an id
 * for the developer who first used it, and the upstream project's is taken
 * there. `FIREFOX_EXTENSION_ID` in src-tauri/src/bridge/protocol.rs must match.
 */
export const FIREFOX_ID = 'udm-connector@vanti-png.github.io';

/**
 * The update manifest Firefox reads. A file in the repository, served as it is
 * on the default branch. A copy listed on the store must not name this: the
 * store refuses a listed version that names its own updates.
 */
export const FIREFOX_UPDATE_URL = 'https://raw.githubusercontent.com/Vanti-png/UDM/main/updates/firefox.json';

/** Where the release's files are downloaded from. */
export const RELEASE_DOWNLOADS = 'https://github.com/Vanti-png/UDM/releases/download/latest';

/** The file people are pointed at: the newest version, under a name that stays. */
export const STABLE_XPI = 'UniversalDownloadManager-firefox.xpi';

/**
 * The file Firefox updates from, named for its version, so a newer upload
 * never changes what an older update manifest names.
 */
export function versionedXpi(version) {
  return `udm-connector-${version}.xpi`;
}
