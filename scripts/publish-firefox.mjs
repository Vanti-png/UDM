// Get a signed Firefox copy of the extension ready to hand out.
//
//   node scripts/publish-firefox.mjs <the .xpi addons.mozilla.org signed>
//
// It checks the file is this extension, signed, and able to update itself;
// copies it into scripts/ under the two names the release carries (see
// firefox-addon.mjs); and writes updates/firefox.json, which Firefox reads to
// find it. It then prints what is left to do: upload the two files to the
// `latest` release, then commit and push the update manifest -- in that order,
// so Firefox is never pointed at a file that is not there yet.

import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

import { FIREFOX_ID, FIREFOX_UPDATE_URL, RELEASE_DOWNLOADS, STABLE_XPI, versionedXpi } from './firefox-addon.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every entry of a zip archive by name, read from its central directory. */
export function zipEntries(archive) {
  // The end-of-directory record is the last 22 bytes, unless a comment follows.
  let end = -1;
  for (let at = archive.length - 22; at >= Math.max(0, archive.length - 22 - 0xffff); at -= 1) {
    if (archive.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip archive');

  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(at) !== 0x02014b50) throw new Error('the zip directory is damaged');
    const method = archive.readUInt16LE(at + 10);
    const compressed = archive.readUInt32LE(at + 20);
    const nameLength = archive.readUInt16LE(at + 28);
    const extraLength = archive.readUInt16LE(at + 30);
    const commentLength = archive.readUInt16LE(at + 32);
    const local = archive.readUInt32LE(at + 42);
    const name = archive.toString('utf8', at + 46, at + 46 + nameLength);
    entries.set(name, { method, compressed, local });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** One entry's bytes, or null when the archive has no such entry. */
export function readZipEntry(archive, name) {
  const entry = zipEntries(archive).get(name);
  if (!entry) return null;
  const { method, compressed, local } = entry;
  if (archive.readUInt32LE(local) !== 0x04034b50) throw new Error(`the zip entry ${name} is damaged`);
  const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
  const data = archive.subarray(start, start + compressed);
  if (method === 0) return Buffer.from(data);
  if (method === 8) return inflateRawSync(data);
  throw new Error(`the zip entry ${name} uses compression method ${method}`);
}

/**
 * Why `archive` is not a signed copy of this extension that updates itself,
 * or null when it is one. Signing adds the files under META-INF/.
 */
export function problemWith(archive) {
  const entries = zipEntries(archive);
  const manifestBytes = readZipEntry(archive, 'manifest.json');
  if (!manifestBytes) return 'it has no manifest.json';
  const gecko = JSON.parse(manifestBytes.toString('utf8')).browser_specific_settings?.gecko ?? {};
  if (gecko.id !== FIREFOX_ID) return `its id is ${gecko.id ?? 'missing'}, not ${FIREFOX_ID}`;
  if (gecko.update_url !== FIREFOX_UPDATE_URL) {
    return 'it does not name the update manifest, so a copy installed from it would never update; pack it again with scripts/pack-extension.mjs --firefox';
  }
  const signed = ['META-INF/mozilla.rsa', 'META-INF/cose.sig'].some((name) => entries.has(name));
  if (!signed) return 'it is not signed: upload it to addons.mozilla.org ("On your own") and use the file it gives back';
  return null;
}

/** The update manifest that points Firefox at `version`. */
export function updateManifest({ version, hash, minVersion }) {
  const update = {
    version,
    update_link: `${RELEASE_DOWNLOADS}/${versionedXpi(version)}`,
    update_hash: `sha256:${hash}`,
  };
  if (minVersion) update.applications = { gecko: { strict_min_version: minVersion } };
  return { addons: { [FIREFOX_ID]: { updates: [update] } } };
}

function main(path) {
  if (!path) {
    console.error('usage: node scripts/publish-firefox.mjs <signed .xpi>');
    process.exit(2);
  }
  const archive = readFileSync(path);
  const problem = problemWith(archive);
  if (problem) {
    console.error(`${path} cannot be published: ${problem}`);
    process.exit(1);
  }

  const manifest = JSON.parse(readZipEntry(archive, 'manifest.json').toString('utf8'));
  const { version } = manifest;
  const minVersion = manifest.browser_specific_settings.gecko.strict_min_version;
  const hash = createHash('sha256').update(archive).digest('hex');

  const stable = join(root, 'scripts', STABLE_XPI);
  const versioned = join(root, 'scripts', versionedXpi(version));
  copyFileSync(path, stable);
  copyFileSync(path, versioned);

  const updates = join(root, 'updates', 'firefox.json');
  mkdirSync(dirname(updates), { recursive: true });
  writeFileSync(updates, `${JSON.stringify(updateManifest({ version, hash, minVersion }), null, 2)}\n`);

  console.log(`version ${version}, sha256 ${hash}`);
  console.log(`  ${stable}\n  ${versioned}\n  ${updates}`);
  console.log('\nThen, in this order:');
  console.log(
    `  gh release upload latest scripts/${STABLE_XPI} scripts/${versionedXpi(version)} --repo Vanti-png/UDM --clobber`,
  );
  console.log(`  git add updates/firefox.json && git commit -m "Firefox extension ${version}" && git push`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]);
}
