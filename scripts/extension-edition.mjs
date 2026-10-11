// The Chrome Web Store build of the connector extension, as a set of changes to
// the files of the full one. See extension/edition.js for why there are two.
//
// Used by scripts/pack-extension.mjs, which zips the result for the store, and
// by scripts/build-store-assets.mjs, so the store's screenshots show the popup
// the store's users get -- the full build's screenshots, with a YouTube
// session switch in them, were part of what the review objected to.
//
// What changes:
// - edition.js says STORE, which the code reads to leave YouTube unlisted, to
//   skip every session path and to answer no switch presses;
// - the manifest drops `cookies` and `alarms`, which only the sessions use, so
//   the store copy cannot read a cookie at all, not merely chooses not to;
// - the popup's and the welcome page's session markup, fenced in their HTML by
//   `<!-- full -->` and `<!-- /full -->`, is cut out;
// - the messages only that markup and the session code use are left out of
//   both locales, so nothing in the package describes a feature it lacks.

export const STORE_DROPPED_PERMISSIONS = ['cookies', 'alarms'];

/** Messages the store build has no use for: the sessions' and the switches'. */
export function sessionMessage(key) {
  return /^(link|tiktok|other)[A-Z]/.test(key) || ['sessionsTitle', 'welcomeSession', 'rowSignIn', 'rowWithSession'].includes(key);
}

const FENCE = /[ \t]*<!-- full -->[\s\S]*?<!-- \/full -->[ \t]*\r?\n?/g;

/**
 * The store build's copy of one file, by its path inside extension/ (with
 * forward slashes). Files it does not change come back as they were given.
 */
export function forStore(name, contents) {
  if (name === 'edition.js') {
    const text = contents.toString('utf8');
    const flipped = text.replace('export const STORE = false;', 'export const STORE = true;');
    if (flipped === text) throw new Error('edition.js no longer reads `export const STORE = false;`');
    return Buffer.from(flipped, 'utf8');
  }
  if (name === 'manifest.json') {
    const manifest = JSON.parse(contents.toString('utf8'));
    manifest.permissions = manifest.permissions.filter((permission) => !STORE_DROPPED_PERMISSIONS.includes(permission));
    return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  if (name === 'popup.html' || name === 'welcome.html') {
    const text = contents.toString('utf8');
    const cut = text.replace(FENCE, '');
    if (cut === text) throw new Error(`${name} has no <!-- full --> block to leave out`);
    return Buffer.from(cut, 'utf8');
  }
  if (/^_locales\/[^/]+\/messages\.json$/.test(name)) {
    const messages = JSON.parse(contents.toString('utf8'));
    const kept = Object.fromEntries(Object.entries(messages).filter(([key]) => !sessionMessage(key)));
    return Buffer.from(`${JSON.stringify(kept, null, 2)}\n`, 'utf8');
  }
  return contents;
}
