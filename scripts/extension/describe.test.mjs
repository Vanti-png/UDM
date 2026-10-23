// Unit tests for extension/describe.js, the words the popup's rows and the
// page picker's card are described in.
//
//   node --test scripts/extension/

import assert from 'node:assert/strict';

import { NOTICES, detailMeta, firstMeta, problemOf } from '../../extension/describe.js';

const { describe, test } = process.env.VITEST ? await import('vitest') : await import('node:test');

// The message's key stands in for its English, so a test can see which one
// was asked for.
const t = (key) => `<${key}>`;

describe('describe', () => {
  test('the first line is the kind, or the site, and what the page gave away', () => {
    assert.equal(firstMeta({ label: 'stream', parts: ['1080p', '23:41'] }, t), '<kindStream> · 1080p · 23:41');
    assert.equal(firstMeta({ label: 'site', site: 'Vimeo', parts: [] }, t), 'Vimeo');
    assert.equal(firstMeta({ label: 'image', parts: ['1600×900'] }, t), '<kindImage> · 1600×900');
    assert.equal(firstMeta({ label: 'unknown' }, t), '<kindVideo>');
  });

  test("the app's details, in its own order, with the length only where asked", () => {
    const preview = { qualityLabel: '1080p', container: 'mkv', estimatedBytes: 82 * 1024 * 1024, durationSec: 65 };
    assert.equal(detailMeta(preview, {}, t), '1080p · MKV · ~82 MB');
    assert.equal(detailMeta(preview, {}, t, { withLength: true }), '1080p · MKV · ~82 MB · 1:05');
    // A label that only repeats the kind says nothing.
    assert.equal(detailMeta({ qualityLabel: 'Image', container: 'jpg' }, {}, t), 'JPG');
    assert.equal(detailMeta({ isLive: true, qualityLabel: '720p', durationSec: 60 }, {}, t, { withLength: true }), '<kindLive> · 720p');
  });

  test("the app's answer as one of three problems, or none", () => {
    assert.equal(problemOf({ ok: true, status: { canDownload: true } }), null);
    assert.equal(problemOf({ ok: true, status: {} }), 'update');
    assert.equal(problemOf({ ok: false, code: 'notInstalled' }), 'notInstalled');
    for (const code of ['forbidden', 'version', 'malformed']) assert.equal(problemOf({ ok: false, code }), 'update');
    assert.equal(problemOf({ ok: false, code: 'internal' }), 'unreachable');
    assert.equal(problemOf(null), 'unreachable');
    for (const name of ['notInstalled', 'update', 'unreachable']) assert.ok(NOTICES[name].text);
  });
});
