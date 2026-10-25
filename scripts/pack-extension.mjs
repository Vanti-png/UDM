// Build the uploads for the connector extension. Three come out of the one
// folder:
//
//   node scripts/pack-extension.mjs            extension-upload.zip, for the Chrome
//                                              Web Store: the store build (see
//                                              extension/edition.js)
//   node scripts/pack-extension.mjs --firefox  extension-firefox-<version>.zip,
//                                              the full build, for
//                                              addons.mozilla.org
//   node scripts/pack-extension.mjs --full     extension-full.zip, the full build
//                                              for Chrome, published beside the
//                                              app and loaded unpacked
//
// Two things make this more than `zip -r`:
//
// The `key` in extension/manifest.json pins the id of an unpacked install so
// the Rust host's allow-list can name it during development. The store issues
// its own id and Google's guidance is to strip the field before uploading, so
// it is removed from the store and Firefox copies and left alone in the
// working tree. The full Chrome copy keeps it: that one is loaded unpacked,
// and without the key Chrome derives the id from the folder it was unpacked
// to, which the host refuses.
//
// The directory also holds things that must not be published: the private half
// of that key, the icon generator, and the developer and store notes. An
// allow-list of what belongs in a release would rot every time a file is added
// (media.js and fonts/ ship because they are there), so this excludes by name
// and prints what it packed -- a wrong file is then visible in the output
// rather than in the listing. The tests live in scripts/extension/, outside
// the folder, and a test file that strays into it is left out all the same.
//
// The zip is written by hand because Node has no archiver and PowerShell's
// Compress-Archive has been inconsistent about path separators, which is not a
// thing worth debugging against a review queue.

import { deflateRawSync, crc32 } from 'node:zlib';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { forStore } from './extension-edition.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'extension');

// `--firefox` builds the addons.mozilla.org upload from the same files. Only the
// manifest differs: Firefox runs the background as a script rather than a
// service worker, needs an id of its own, and asks every new extension to
// declare what data it collects -- none here: what the extension sends goes to
// the app on the same computer, never off it.
//
// The id is this fork's own. addons.mozilla.org gives an id to one developer
// for good, and the upstream project's `connector@universaldownloader.app`
// is taken there, so an upload under it is refused as a duplicate.
// `FIREFOX_EXTENSION_ID` in src-tauri/src/bridge/protocol.rs must match.
const FIREFOX = process.argv.includes('--firefox');
const FIREFOX_ID = 'udm-connector@vanti-png.github.io';
// Any other Chrome package is the store build, unless the full one is asked for.
const STORE = !FIREFOX && !process.argv.includes('--full');
const { version } = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
// The Firefox package is named for its version. Firefox reads a temporary
// add-on from the file it was loaded from for as long as it runs, and holds
// it open: a new build written over it was refused, and one written while it
// was not held changed the add-on under the running browser, which then
// answered nothing. addons.mozilla.org wants each version uploaded once anyway.
const target = join(
  root,
  FIREFOX
    ? `extension-firefox-${version}.zip`
    : STORE
      ? 'extension-upload.zip'
      : 'extension-full.zip',
);

function forFirefox(manifest) {
  delete manifest.minimum_chrome_version;
  manifest.background = { scripts: ['background.js'], type: 'module' };
  manifest.browser_specific_settings = {
    gecko: {
      id: FIREFOX_ID,
      // The data collection declaration is the newest key here: Firefox
      // reads it from 140 (the ESR line) and Firefox for Android from 142,
      // and addons.mozilla.org warns about any minimum below that.
      // storage.session, isolated scripting and module background scripts
      // all came earlier.
      strict_min_version: '140.0',
      data_collection_permissions: { required: ['none'] },
    },
    gecko_android: { strict_min_version: '142.0' },
  };
  return manifest;
}

const EXCLUDED = new Set([
  'key.pem',
  'make-icons.mjs',
  'README.md',
  'PRIVACY.md',
  'PRIVACY-CHROME.md',
  'STORE-LISTING.md',
  '.gitignore',
]);

function collect(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (EXCLUDED.has(name) || name.endsWith('.zip') || /\.test\.[cm]?js$/.test(name)) return [];
    return statSync(full).isDirectory() ? collect(full) : [full];
  });
}

function contentsOf(file) {
  const name = relative(source, file).split(sep).join('/');
  let contents = readFileSync(file);
  if (name === 'manifest.json') {
    let manifest = JSON.parse(contents.toString('utf8'));
    if (STORE || FIREFOX) delete manifest.key;
    if (FIREFOX) manifest = forFirefox(manifest);
    contents = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  return STORE ? forStore(name, contents) : contents;
}

// A fixed timestamp, so the same sources produce the same bytes and a rejected
// upload can be compared against the one before it.
const DOS_TIME = 0;
const DOS_DATE = 0x2821; // 2000-01-01

// The store build leaves some files out altogether, which forStore answers
// with null.
const files = collect(source)
  .sort()
  .map((file) => [file, contentsOf(file)])
  .filter(([, contents]) => contents !== null);
const locals = [];
const central = [];
let offset = 0;

for (const [file, raw] of files) {
  const name = relative(source, file).split(sep).join('/');
  const body = deflateRawSync(raw, { level: 9 });
  const sum = crc32(raw);
  const named = Buffer.from(name, 'utf8');

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(sum, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(named.length, 26);
  locals.push(local, named, body);

  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(20, 4);
  entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(0, 8);
  entry.writeUInt16LE(8, 10);
  entry.writeUInt16LE(DOS_TIME, 12);
  entry.writeUInt16LE(DOS_DATE, 14);
  entry.writeUInt32LE(sum, 16);
  entry.writeUInt32LE(body.length, 20);
  entry.writeUInt32LE(raw.length, 24);
  entry.writeUInt16LE(named.length, 28);
  entry.writeUInt32LE(offset, 42);
  central.push(entry, named);

  offset += local.length + named.length + body.length;
  console.log(`  ${name}  (${raw.length} bytes)`);
}

const directory = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);

writeFileSync(target, Buffer.concat([...locals, directory, end]));

console.log(`\npacked ${files.length} files, version ${version}, ${STORE ? 'store' : 'full'} build -> ${target}`);
console.log('the signing key and the developer notes are not in it');
