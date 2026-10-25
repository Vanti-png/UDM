import assert from 'node:assert/strict';

import { addressOf, appCanTake, baseName, captureCandidate, filePayload } from '../../extension/capture.js';

const { describe, test } = process.env.VITEST ? await import('vitest') : await import('node:test');

const item = (extra = {}) => ({
  id: 1,
  url: 'https://github.com/x/y/releases/download/v1/app.msi',
  state: 'in_progress',
  referrer: 'https://github.com/x/y/releases',
  filename: 'C:\\Users\\me\\Downloads\\app.msi',
  totalBytes: 1234,
  mime: 'application/x-msi',
  ...extra,
});

const AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

describe('capture', () => {
  test('a download the browser just started over the web is a candidate', () => {
    assert.equal(captureCandidate(item()), true);
    assert.equal(captureCandidate(item({ mime: '' })), true);
    // Its address is where it led, when the browser knows.
    assert.equal(captureCandidate(item({ url: 'blob:x', finalUrl: 'https://cdn.example/a.zip' })), true);
  });

  test('anything else is left to the browser', () => {
    for (const [why, extra] of [
      ['over already', { state: 'complete' }],
      ['interrupted', { state: 'interrupted' }],
      ['private window', { incognito: true }],
      ["another extension's", { byExtensionId: 'abcdef' }],
      ['the page itself', { url: 'blob:https://site.example/1' }],
      ['bytes a page made', { url: 'data:application/zip;base64,AAAA' }],
      ['a file on this computer', { url: 'file:///C:/a.zip' }],
      ['a web page saved', { mime: 'text/html; charset=utf-8' }],
      ['no id', { id: undefined }],
    ]) {
      assert.equal(captureCandidate(item(extra)), false, why);
    }
    assert.equal(captureCandidate(null), false);
  });

  test('the payload is the address, the page and what the browser knew of the file', () => {
    assert.deepEqual(filePayload(item(), AGENT), {
      url: 'https://github.com/x/y/releases/download/v1/app.msi',
      kind: 'file',
      pageUrl: 'https://github.com/x/y/releases',
      referer: 'https://github.com/x/y/releases',
      userAgent: AGENT,
      fileName: 'app.msi',
      fileSize: 1234,
      mime: 'application/x-msi',
    });
  });

  test('what the browser did not know is left out, never guessed', () => {
    const payload = filePayload(item({ referrer: '', filename: '', totalBytes: -1, fileSize: 0, mime: '' }), AGENT);
    assert.deepEqual(Object.keys(payload).sort(), ['kind', 'url', 'userAgent']);
    // A referrer that is not a web page is no referrer.
    assert.equal(filePayload(item({ referrer: 'chrome://newtab/' }), AGENT).pageUrl, undefined);
    // The type goes without its parameters.
    assert.equal(filePayload(item({ mime: 'Application/PDF; x=1' }), AGENT).mime, 'application/pdf');
    assert.equal(filePayload(item({ url: 'blob:x' }), AGENT), null);
  });

  test('a path is only ever sent as its last part', () => {
    assert.equal(baseName('C:\\Users\\me\\Downloads\\a b.zip'), 'a b.zip');
    assert.equal(baseName('/home/me/Downloads/a.tar.gz'), 'a.tar.gz');
    assert.equal(baseName('a.zip'), 'a.zip');
    assert.equal(baseName(undefined), '');
  });

  test('where a download is fetched from', () => {
    assert.equal(addressOf(item({ finalUrl: 'https://mirror.example/app.msi' })), 'https://mirror.example/app.msi');
    assert.equal(addressOf(item({ finalUrl: '' })), item().url);
  });

  test("only the helper's answer with a file in it says the app can take one", () => {
    assert.equal(appCanTake({ ok: true, file: { fileName: 'a.zip' } }), true);
    assert.equal(appCanTake({ ok: true, file: null, preview: { title: 'x' } }), false);
    assert.equal(appCanTake({ ok: false, code: 'unavailable' }), false);
    assert.equal(appCanTake(null), false);
  });
});
