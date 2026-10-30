// Unit tests for scripts/publish-firefox.mjs, which gets a signed Firefox copy
// of the extension ready for the release and writes the update manifest.
//
//   node --test scripts/extension/

import assert from 'node:assert/strict';
import { crc32, deflateRawSync } from 'node:zlib';

import { FIREFOX_ID, FIREFOX_UPDATE_URL, RELEASE_DOWNLOADS } from '../firefox-addon.mjs';
import { problemWith, readZipEntry, updateManifest, zipEntries } from '../publish-firefox.mjs';

const { describe, test } = process.env.VITEST ? await import('vitest') : await import('node:test');

/** A zip of `files` ({ name: text }), the even ones deflated and the odd ones stored. */
function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  Object.entries(files).forEach(([name, text], index) => {
    const raw = Buffer.from(text, 'utf8');
    const deflated = index % 2 === 0;
    const body = deflated ? deflateRawSync(raw) : raw;
    const named = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflated ? 8 : 0, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(named.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(deflated ? 8 : 0, 10);
    entry.writeUInt32LE(crc32(raw), 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(named.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, named, body);
    central.push(entry, named);
    offset += local.length + named.length + body.length;
  });
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const manifest = (gecko) => JSON.stringify({ name: 'x', version: '1.1.2', browser_specific_settings: { gecko } });
const ours = { id: FIREFOX_ID, update_url: FIREFOX_UPDATE_URL, strict_min_version: '140.0' };

describe('publish-firefox', () => {
  test('reads an entry whether it was stored or deflated', () => {
    const archive = zip({ 'manifest.json': '{"a":1}', 'background.js': 'let x = 1;', 'popup.html': '<p>' });
    assert.deepEqual([...zipEntries(archive).keys()], ['manifest.json', 'background.js', 'popup.html']);
    assert.equal(readZipEntry(archive, 'manifest.json').toString(), '{"a":1}');
    assert.equal(readZipEntry(archive, 'background.js').toString(), 'let x = 1;');
    assert.equal(readZipEntry(archive, 'missing.js'), null);
    assert.throws(() => zipEntries(Buffer.from('not a zip at all, just text')), /not a zip/);
  });

  test('only a signed copy of this extension that can update itself passes', () => {
    const signed = (gecko) => zip({ 'manifest.json': manifest(gecko), 'META-INF/mozilla.rsa': 'sig' });
    assert.equal(problemWith(signed(ours)), null);
    assert.equal(problemWith(zip({ 'manifest.json': manifest(ours), 'META-INF/cose.sig': 'sig' })), null);

    // The upload, before addons.mozilla.org signed it.
    assert.match(problemWith(zip({ 'manifest.json': manifest(ours) })), /not signed/);
    // Someone else's extension.
    assert.match(problemWith(signed({ ...ours, id: 'other@example.com' })), /other@example\.com/);
    // A build from before the update address, which would never update.
    assert.match(problemWith(signed({ id: FIREFOX_ID })), /never update/);
    assert.match(problemWith(zip({ 'popup.html': '<p>' })), /no manifest/);
  });

  test('the update manifest names the versioned file and its hash', () => {
    const written = updateManifest({ version: '1.1.2', hash: 'ab'.repeat(32), minVersion: '140.0' });
    const [update] = written.addons[FIREFOX_ID].updates;
    assert.equal(update.version, '1.1.2');
    // Named for its version, so the next upload never changes what this names.
    assert.equal(update.update_link, `${RELEASE_DOWNLOADS}/udm-connector-1.1.2.xpi`);
    assert.ok(update.update_link.startsWith('https://'));
    assert.equal(update.update_hash, `sha256:${'ab'.repeat(32)}`);
    assert.deepEqual(update.applications, { gecko: { strict_min_version: '140.0' } });
    // The address Firefox reads it from is served over https too.
    assert.ok(FIREFOX_UPDATE_URL.startsWith('https://'));
  });
});
