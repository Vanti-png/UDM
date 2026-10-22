// Unit tests for the Chrome Web Store build (scripts/extension-edition.mjs):
// the changes that turn the full extension into the one the store accepts.
//
//   node --test scripts/extension/
//
// They run the real transforms over the real files, and import the store
// build's own scripts from a scratch copy, so a store package that would
// still list YouTube, still carry the sessions' code or still show a switch
// fails here rather than in review -- where a second refusal counts against
// the account.

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { STORE_DROPPED_PERMISSIONS, STORE_LEFT_OUT, forStore, sessionMessage } from '../extension-edition.mjs';

const { describe, test, after } = process.env.VITEST ? await import('vitest') : await import('node:test');
const afterAll = process.env.VITEST ? (await import('vitest')).afterAll : after;

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = join(repo, 'extension');

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

/** The store build's copy of every file it keeps, by its path inside extension/. */
function storeBuild() {
  return new Map(
    files(source)
      .map((file) => {
        const name = relative(source, file).split(sep).join('/');
        return [name, forStore(name, readFileSync(file))];
      })
      .filter(([, contents]) => contents !== null)
      .map(([name, contents]) => [name, contents.toString('utf8')]),
  );
}

/** What the package ships as text: its scripts, pages, styles and messages. */
const TEXT = /\.(?:js|html|css|json)$/;

// A stand-in for the `chrome` a service worker sees, with what the manifest
// grants and nothing more: a script that reaches for an API the store build
// has no permission for throws, as it would in Chrome. `answer` plays the
// app's helper.
function fakeChrome({ sessions, answer }) {
  const listeners = {};
  const event = (name) => ({ addListener: (listener) => (listeners[name] ??= []).push(listener) });
  const area = (map) => ({
    async get(keys) {
      const wanted = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(wanted.filter((key) => map.has(key)).map((key) => [key, map.get(key)]));
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) map.set(key, value);
    },
    async remove(keys) {
      for (const key of [].concat(keys)) map.delete(key);
    },
  });
  const local = new Map();
  const session = new Map();
  const sent = [];
  const told = [];
  const chrome = {
    runtime: {
      id: 'test',
      getManifest: () => ({ version: '0.0.0' }),
      getURL: (path) => `chrome-extension://test/${path}`,
      sendNativeMessage(host, request, callback) {
        sent.push(request);
        queueMicrotask(() => callback(answer(request)));
      },
      onInstalled: event('onInstalled'),
      onStartup: event('onStartup'),
      onMessage: event('onMessage'),
    },
    storage: { local: area(local), session: area(session) },
    i18n: { getMessage: (key) => key },
    webRequest: { onHeadersReceived: event('onHeadersReceived') },
    tabs: {
      onUpdated: event('onUpdated'),
      onRemoved: event('onRemoved'),
      onReplaced: event('onReplaced'),
      create: async () => {},
      get: async () => ({}),
      // The page picker in every frame, acknowledging what the worker says.
      sendMessage: async (tabId, message, options) => {
        told.push({ tabId, message, frameId: options?.frameId });
        return true;
      },
    },
    scripting: { executeScript: async () => [] },
    action: { setBadgeBackgroundColor: async () => {}, setBadgeTextColor: async () => {}, setBadgeText: async () => {} },
  };
  if (sessions) {
    chrome.alarms = { create: () => {}, onAlarm: event('onAlarm') };
    chrome.cookies = { getAll: async () => [], onChanged: event('onChanged') };
  }
  return { chrome, listeners, local, session, sent, told };
}

/** A message from the extension's own popup: the answer, or `unanswered`. */
function ask(fake, message, sender = { id: 'test' }) {
  globalThis.chrome = fake.chrome;
  return new Promise((resolve) => {
    const answering = fake.listeners.onMessage[0](message, sender, resolve);
    if (!answering) resolve('unanswered');
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const scratches = [];
afterAll(() => {
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
});

/** The store build's files written side by side, as in the package. */
function unpacked(build) {
  const scratch = mkdtempSync(join(tmpdir(), 'ud-store-'));
  scratches.push(scratch);
  writeFileSync(join(scratch, 'package.json'), '{ "type": "module" }\n');
  for (const [name, contents] of build) if (!name.includes('/') && name.endsWith('.js')) writeFileSync(join(scratch, name), contents);
  return scratch;
}

const PAYLOAD = { url: 'https://vimeo.com/76979871', kind: 'page', title: 'Concert', pageUrl: 'https://vimeo.com/76979871' };

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

  test("carries no session code at all, not even switched off", () => {
    for (const name of STORE_LEFT_OUT) assert.ok(!build.has(name), name);
    for (const [name, text] of build) {
      if (!TEXT.test(name)) continue;
      assert.doesNotMatch(text, /sessions\.js|chrome\.cookies|chrome\.alarms/, name);
      // Every fence was cut, opening and closing alike.
      assert.doesNotMatch(text, /<!-- \/?full -->|\/\/ <\/?full>|\/\* <\/?full> \*\//, name);
    }
    const background = build.get('background.js');
    for (const gone of ['readJar', 'pushSite', 'lendFor', 'lendOther', 'connect,', 'forget,']) {
      assert.ok(!background.includes(gone), gone);
    }
  });

  test('names YouTube and Spotify only in the list that keeps them out', () => {
    for (const [name, text] of build) {
      if (!TEXT.test(name)) continue;
      const rest = text.replace(/^export const UNLISTED_SITES = .*$/m, '');
      assert.doesNotMatch(rest, /youtube|youtu\.be|ytimg|spotify/i, name);
    }
    assert.match(build.get('media.js'), /^export const UNLISTED_SITES = STORE \? \[.*'youtube\.com'.*'spotify\.com'.*\]/m);
  });

  test('shows no switch, and no word about sessions, in the popup or the welcome page', () => {
    for (const page of ['popup.html', 'welcome.html']) {
      const html = build.get(page);
      assert.doesNotMatch(html, /Switch"|sessionsTitle|welcomeSession|youtubeRow|tiktokRow|otherRow/, page);
    }
    // The fence takes only the sessions: the list and the welcome's steps stay.
    assert.match(build.get('popup.html'), /id="list"/);
    assert.match(build.get('welcome.html'), /step3Title/);
    assert.doesNotMatch(build.get('popup.css'), /\.switch|\.setting/);
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
    for (const locale of ['en', 'tr']) {
      const messages = JSON.parse(build.get(`_locales/${locale}/messages.json`));
      for (const page of ['popup.html', 'welcome.html']) {
        for (const [, key] of build.get(page).matchAll(/data-i18n="([^"]+)"/g)) {
          assert.ok(Object.hasOwn(messages, key), `${locale} ${page}: ${key}`);
        }
      }
      for (const script of ['popup.js', 'picker.js', 'background.js']) {
        for (const [, key] of build.get(script).matchAll(/\bt\('([^']+)'\)/g)) {
          assert.ok(Object.hasOwn(messages, key), `${locale} ${script}: ${key}`);
        }
      }
    }
  });

  test('lists nothing on YouTube or Spotify, nor from their players embedded elsewhere', async () => {
    const media = await import(pathToFileURL(join(unpacked(build), 'media.js')).href);
    const watch = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const player = { src: 'blob:https://www.youtube.com/abc', duration: 212, drm: false };
    const frame = (href, frameId, videos = []) =>
      media.normaliseFrame({ isTop: frameId === 0, href, videos, audios: [] }, frameId);

    assert.ok(media.unlisted(watch));
    assert.ok(media.unlisted('https://youtu.be/dQw4w9WgXcQ'));
    assert.ok(media.unlisted('https://music.youtube.com/watch?v=1'));
    assert.ok(media.unlisted('https://www.youtube-nocookie.com/embed/1'));
    assert.ok(media.unlisted('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'));
    assert.ok(!media.unlisted('https://vimeo.com/1'));
    assert.ok(!media.PAGE_SITES.some(([, site]) => /youtube|spotify/i.test(site)));

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
  });

  test('its service worker runs on the store permissions alone, and lends nothing', async () => {
    // A helper that says this profile still holds a binding an earlier copy
    // made, as one updated from a version with switches would.
    const fake = fakeChrome({
      sessions: false,
      answer: (request) => ({ ok: true, status: { bound: request.type === 'status', enabled: true, canDownload: true } }),
    });
    globalThis.chrome = fake.chrome;
    await import(pathToFileURL(join(unpacked(build), 'background.js')).href);

    assert.equal(fake.listeners.onMessage.length, 1);
    assert.equal(fake.listeners.onHeadersReceived.length, 1);
    assert.equal(fake.listeners.onStartup, undefined);

    // The popup's check lets go of the old binding and answers with the app's state.
    const checked = await ask(fake, { action: 'status' });
    assert.deepEqual(fake.sent.map((request) => request.type), ['status', 'forget']);
    assert.equal(checked.result.ok, true);
    assert.equal(checked.result.status.bound, false);

    // İndir hands the row over, and nothing goes with it.
    fake.sent.length = 0;
    const sent = await ask(fake, { action: 'download', payload: PAYLOAD });
    assert.equal(sent.result.ok, true);
    assert.deepEqual(fake.sent.map((request) => request.type), ['download']);
    assert.equal(fake.sent[0].url, PAYLOAD.url);

    // A switch press is not something this build answers.
    assert.equal(await ask(fake, { action: 'connect', site: 'tiktok' }), 'unanswered');
    assert.equal(await ask(fake, { action: 'forget' }), 'unanswered');

    // An update from a version with switches clears what they kept.
    fake.sent.length = 0;
    fake.local.set('link', 'bound');
    fake.local.set('tiktokOn', true);
    fake.listeners.onInstalled[0]({ reason: 'update' });
    await settle();
    assert.deepEqual(fake.sent.map((request) => request.type), ['forget']);
    assert.ok(!fake.local.has('link') && !fake.local.has('tiktokOn'));
  });

  test("its page picker sends what the worker chose, and only for the pick's own token", async () => {
    const fake = fakeChrome({ sessions: false, answer: () => ({ ok: true, status: { canDownload: true } }) });
    const PAGE = 'https://blog.example/post/7';
    fake.chrome.tabs.get = async (id) => ({ id, url: PAGE, title: 'Post' });
    const injected = [];
    fake.chrome.scripting.executeScript = async (details) => {
      injected.push(details.files ?? details.func.name);
      return details.func?.name === 'startPicker' ? [{ frameId: 0, result: true }] : [];
    };
    globalThis.chrome = fake.chrome;
    await import(pathToFileURL(join(unpacked(build), 'background.js')).href);

    assert.deepEqual(await ask(fake, { action: 'pick', tabId: 7 }), { ok: true });
    assert.deepEqual(injected, [['picker.js'], 'startPicker']);
    const { token } = fake.session.get('pick:7');
    const tab = { id: 'test', tab: { id: 7 }, frameId: 0 };

    // Nothing from a page but the picker's four, and those only with the token.
    assert.equal(await ask(fake, { action: 'download', payload: PAYLOAD }, tab), 'unanswered');
    assert.equal(await ask(fake, { action: 'pickGet', token: 'guess' }, tab), null);
    assert.equal(await ask(fake, { action: 'pickGet', token }, { ...tab, tab: { id: 8 } }), null);
    assert.equal(fake.sent.length, 0);

    const picture = 'https://blog.example/media/sunset.jpg';
    const pick = { tag: 'image', href: PAGE, src: picture, width: 1600, height: 900, links: [] };
    assert.deepEqual(await ask(fake, { action: 'picked', token, pick }, tab), { ok: true });
    const card = fake.told.find((word) => word.message.udPick === 'card');
    assert.equal(card.frameId, 0);
    assert.equal(card.message.card.canGet, true);
    assert.equal(card.message.card.thumbnail, picture);

    // İndir sends the picture the worker kept, whatever the page says with it.
    const got = await ask(fake, { action: 'pickGet', token, payload: PAYLOAD }, tab);
    assert.deepEqual(got, { sent: true });
    assert.deepEqual(fake.sent.map((request) => request.type), ['download']);
    assert.equal(fake.sent[0].url, picture);
    assert.equal(fake.sent[0].kind, 'image');

    // Closing the card ends the pick in every frame, and its token with it.
    await ask(fake, { action: 'pickEnd', token }, tab);
    assert.ok(!fake.session.has('pick:7'));
    assert.ok(fake.told.some((word) => word.message.udPick === 'end' && word.frameId === undefined));
    assert.equal(await ask(fake, { action: 'pickGet', token }, tab), null);
  });
});

describe('the full build', () => {
  test('is the working tree: YouTube listed, the switches and their permissions in place', () => {
    const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
    assert.ok(manifest.permissions.includes('cookies'));
    const popup = readFileSync(join(source, 'popup.html'), 'utf8');
    assert.match(popup, /<!-- full -->[\s\S]*linkSwitch[\s\S]*<!-- \/full -->/);
  });

  test('its service worker still lends: the sessions are wired and the switches answered', async () => {
    const fake = fakeChrome({
      sessions: true,
      answer: () => ({ ok: true, status: { bound: false, enabled: true, canDownload: true, sites: ['youtube', 'tiktok', 'other'] } }),
    });
    globalThis.chrome = fake.chrome;
    await import(pathToFileURL(join(source, 'background.js')).href);

    assert.equal(fake.listeners.onChanged.length, 1);
    assert.equal(fake.listeners.onAlarm.length, 1);
    assert.equal(fake.listeners.onStartup.length, 1);

    const checked = await ask(fake, { action: 'status' });
    assert.equal(typeof checked.linkOff, 'boolean');
    assert.notEqual(await ask(fake, { action: 'forget', site: 'tiktok' }), 'unanswered');
  });
});
