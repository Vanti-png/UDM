// The Chrome Web Store build of the connector extension, as a set of changes to
// the files of the full one. See extension/edition.js for why there are two.
//
// Used by scripts/pack-extension.mjs, which zips the result for the store, and
// by scripts/build-store-assets.mjs, so the store's screenshots show the popup
// the store's users get -- the full build's screenshots, with a YouTube
// session switch in them, were part of what the review objected to.
//
// What changes:
// - edition.js says STORE, which the code reads for the little the store build
//   adds: the sites it lists nothing for, and letting go of a session an
//   earlier copy lent;
// - the code only the full build runs -- the sessions and the switches, and
//   what serves YouTube and Spotify -- is fenced in its file and cut out:
//   `// <full>` to `// </full>` in scripts, `/* <full> */` to `/* </full> */`
//   in stylesheets, `<!-- full -->` to `<!-- /full -->` in pages. The store
//   package does not carry that code switched off; it does not carry it;
// - sessions.js, which only the sessions use, is left out of the package;
// - the manifest drops `cookies` and `alarms`, which only the sessions use, so
//   the store copy cannot read a cookie at all, not merely chooses not to;
// - the messages only the sessions use are left out of both locales, so
//   nothing in the package describes a feature it lacks.

export const STORE_DROPPED_PERMISSIONS = ['cookies', 'alarms'];

/** Files of extension/ that the store build leaves out altogether. */
export const STORE_LEFT_OUT = ['sessions.js'];

/** Files that must carry a fence: one that has lost it would ship whole. */
const FENCED = ['edition.js', 'background.js', 'popup.js', 'media.js', 'popup.css', 'popup.html', 'welcome.html'];

/** Messages the store build has no use for: the sessions' and the switches'. */
export function sessionMessage(key) {
  return /^(link|tiktok|other)[A-Z]/.test(key) || ['sessionsTitle', 'welcomeSession', 'rowSignIn', 'rowWithSession'].includes(key);
}

// Each fence is a whole line, opening and closing, and nothing nests: the
// first close after an open ends it.
const FENCES = {
  '.html': { open: '<!-- full -->', close: '<!-- /full -->' },
  '.js': { open: '// <full>', close: '// </full>' },
  '.css': { open: '/* <full> */', close: '/* </full> */' },
};

function escaped(text) {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function cutFences(name, text) {
  const fence = FENCES[name.slice(name.lastIndexOf('.'))];
  if (!fence) return text;
  const open = escaped(fence.open);
  const close = escaped(fence.close);
  const block = new RegExp(`^[ \\t]*${open}[ \\t]*\\r?\\n[\\s\\S]*?^[ \\t]*${close}[ \\t]*(?:\\r?\\n|$)`, 'gm');
  const cut = text.replace(block, '');
  if (FENCED.includes(name) && cut === text) throw new Error(`${name} has no ${fence.open} block to leave out`);
  // An open without its close, or a close without its open, would leave half
  // a block behind, and the half left could be the half that lends.
  if (cut.includes(fence.open) || cut.includes(fence.close)) throw new Error(`${name} has an unmatched ${fence.open} fence`);
  // A block between two blank lines leaves both behind; one is enough.
  return cut.replace(/(?:[ \t]*\r?\n){3,}/g, (run) => (run.includes('\r') ? '\r\n\r\n' : '\n\n'));
}

/**
 * The store build's copy of one file, by its path inside extension/ (with
 * forward slashes), or null for a file it leaves out. Files it does not change
 * come back as they were given.
 */
export function forStore(name, contents) {
  if (STORE_LEFT_OUT.includes(name)) return null;
  if (name === 'edition.js') {
    const text = cutFences(name, contents.toString('utf8'));
    const flipped = text.replace('export const STORE = false;', 'export const STORE = true;');
    if (flipped === text) throw new Error('edition.js no longer reads `export const STORE = false;`');
    return Buffer.from(flipped, 'utf8');
  }
  if (name === 'manifest.json') {
    const manifest = JSON.parse(contents.toString('utf8'));
    manifest.permissions = manifest.permissions.filter((permission) => !STORE_DROPPED_PERMISSIONS.includes(permission));
    return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  if (/^_locales\/[^/]+\/messages\.json$/.test(name)) {
    const messages = JSON.parse(contents.toString('utf8'));
    const kept = Object.fromEntries(Object.entries(messages).filter(([key]) => !sessionMessage(key)));
    return Buffer.from(`${JSON.stringify(kept, null, 2)}\n`, 'utf8');
  }
  if (/\.(?:js|css|html)$/.test(name) && !name.includes('/')) {
    const text = contents.toString('utf8');
    const cut = cutFences(name, text);
    return cut === text ? contents : Buffer.from(cut, 'utf8');
  }
  return contents;
}
