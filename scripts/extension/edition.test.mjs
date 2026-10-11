// Unit tests for the Chrome Web Store build (scripts/extension-edition.mjs):
// the changes that turn the full extension into the one the store accepts.
//
//   node --test scripts/extension/
//
// They run the real transforms over the real files, and import the store
// build's own media.js from a scratch copy, so a store package that would
// still list YouTube, still ask for cookies or still show a switch fails here
// rather than in review -- where a second refusal counts against the account.

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { STORE_DROPPED_PERMISSIONS, forStore, sessionMessage } from '../extension-edition.mjs';

const { describe, test } = process.env.VITEST ? await import('vitest') : await import('node:test');

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = join(repo, 'extension');

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

/** The store build's copy of every file, by its path inside extension/. */
function storeBuild() {
  return new Map(
    files(source).map((file) => {
      const name = relative(source, file).split(sep).join('/');
      return [name, forStore(name, readFileSync(file)).toString('utf8')];
    }),
  );
}

describe('the Chrome Web Store build', () => {
  const build = storeBuild();

  test('says it is the store build, and the working tree does not', () => {
    assert.match(build.get('edition.js'), /export const STORE = true;/);
    assert.match(readFileSync(join(source, 'edition.js'), 'utf8'), /export const STORE = false;/);
  });

  test('cannot read a cookie: neither permission the sessions use is asked for', () => {
    const manifest = JSON.parse(build.get('manifest.json'));
    for (const permission of STORE_DROPPED_PERMISSIONS) assert.ok(!manifest.permissions.includes(permission), permission);
    // What the list and İndir need is all still there.
    for (const permission of ['nativeMessaging', 'storage', 'webRequest', 'scripting']) {
      assert.ok(manifest.permissions.includes(permission), permission);
    }
  });

  test('shows no switch, and no word about sessions, in the popup or the welcome page', () => {
    for (const page of ['popup.html', 'welcome.html']) {
      const html = build.get(page);
      assert.doesNotMatch(html, /<!-- \/?full -->/, page);
      assert.doesNotMatch(html, /Switch"|sessionsTitle|welcomeSession|youtubeRow|tiktokRow|otherRow/, page);
    }
    // The fence takes only the sessions: the list and the welcome's steps stay.
    assert.match(build.get('popup.html'), /id="list"/);
    assert.match(build.get('welcome.html'), /step3Title/);
  });

  test("keeps no session's message in either language", () => {
    for (const locale of ['en', 'tr']) {
      const messages = JSON.parse(build.get(`_locales/${locale}/messages.json`));
      const left = Object.keys(messages).filter(sessionMessage);
      assert.deepEqual(left, [], locale);
      assert.doesNotMatch(JSON.stringify(messages), /youtube/i, locale);
      assert.ok(messages.unlistedTitle && messages.emptyTitle && messages.btnDownload, locale);
    }
  });

  test('every message the store popup and welcome page name is still there', () => {
    const messages = JSON.parse(build.get('_locales/en/messages.json'));
    for (const page of ['popup.html', 'welcome.html']) {
      for (const [, key] of build.get(page).matchAll(/data-i18n="([^"]+)"/g)) {
        assert.ok(Object.hasOwn(messages, key), `${page}: ${key}`);
      }
    }
  });

  test('lists nothing on YouTube, nor from its players embedded elsewhere', async () => {
    // The store build's media.js and edition.js, side by side as in the
    // package, imported for real.
    const scratch = mkdtempSync(join(tmpdir(), 'ud-store-'));
    try {
      for (const name of ['media.js', 'edition.js']) writeFileSync(join(scratch, name), build.get(name));
      const media = await import(pathToFileURL(join(scratch, 'media.js')).href);
      const watch = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
      const player = { src: 'blob:https://www.youtube.com/abc', duration: 212, drm: false };
      const frame = (href, frameId, videos = []) =>
        media.normaliseFrame({ isTop: frameId === 0, href, videos, audios: [] }, frameId);

      assert.ok(media.unlisted(watch));
      assert.ok(media.unlisted('https://youtu.be/dQw4w9WgXcQ'));
      assert.ok(media.unlisted('https://music.youtube.com/watch?v=1'));
      assert.ok(media.unlisted('https://www.youtube-nocookie.com/embed/1'));
      assert.ok(!media.unlisted('https://vimeo.com/1'));

      assert.deepEqual(media.rows({ url: watch, sawMedia: true, items: [] }, [frame(watch, 0, [player])]), []);
      const page = 'https://dizi.example/izle/5';
      const embed = frame('https://www.youtube.com/embed/dQw4w9WgXcQ', 6, [player]);
      const fetched = {
        id: 'i1',
        url: 'https://manifest.googlevideo.com/api/manifest/hls_playlist/x/index.m3u8',
        kind: 'hls',
        frameId: 6,
        initiator: 'https://www.youtube.com',
        headers: {},
      };
      assert.deepEqual(media.rows({ url: page, title: 'Bölüm 5', sawMedia: true, items: [fetched] }, [frame(page, 0), embed]), []);
      // Another site's own video is listed as before.
      const vimeo = 'https://vimeo.com/76979871';
      assert.equal(media.rows({ url: vimeo, sawMedia: true, items: [] }, [frame(vimeo, 0, [player])]).length, 1);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('the full build', () => {
  test('is the working tree: YouTube listed, the switches and their permissions in place', () => {
    const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
    assert.ok(manifest.permissions.includes('cookies'));
    const popup = readFileSync(join(source, 'popup.html'), 'utf8');
    assert.match(popup, /<!-- full -->[\s\S]*linkSwitch[\s\S]*<!-- \/full -->/);
  });
});
