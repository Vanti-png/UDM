// The downloads the browser starts, and which of them go to the app instead.
//
// A download manager takes every file the browser is about to save. This one
// takes a download only once the app has said it can fetch the same file
// itself: the worker pauses the browser's download, asks the app's helper to
// look at the address with one request -- as the app would, with the page as
// Referer and no cookies -- and hands the download over only if the helper is
// served the file the browser was getting. Otherwise, a page that wants a
// sign-in, a link that only works once, an answer of another size, the
// browser's download is resumed where it was. A capture never turns a working
// download into a broken one.
//
// Pure helpers, no `chrome.*`: what is worth capturing, and what goes over the
// wire for it. The worker does the rest.

import { isHttpUrl, toPayload } from './media.js';

// Stored the other way up, as "turned off": capturing is on until the user
// turns it off, which a missing value then says.
export const CAPTURE_OFF_KEY = 'captureOff';

const PAGE_TYPES = new Set(['text/html', 'application/xhtml+xml']);

// No browser download is anything near this, and a size past it is not one a
// server sent.
const MAX_FILE_SIZE = 2 ** 50;

/** The type of a download, without its parameters. */
function typeOf(mime) {
  return typeof mime === 'string' ? mime.split(';')[0].trim().toLowerCase() : '';
}

/**
 * Whether a download the browser just started is one to offer the app.
 *
 * Not: one already over or never started; one in a private window, which the
 * user has kept out of everything; one another extension started, which is
 * that extension's; one with no web address to hand over (`blob:` and
 * `data:` are the page's own bytes, not anything the app could fetch); and a
 * web page saved as a file, which is the page the user is looking at.
 */
export function captureCandidate(item) {
  if (!item || typeof item !== 'object' || !Number.isInteger(item.id)) return false;
  if (item.state !== 'in_progress') return false;
  if (item.incognito === true) return false;
  if (typeof item.byExtensionId === 'string' && item.byExtensionId !== '') return false;
  if (!isHttpUrl(addressOf(item))) return false;
  if (PAGE_TYPES.has(typeOf(item.mime))) return false;
  return true;
}

/** The address a download is fetched from: where it led, else where it began. */
export function addressOf(item) {
  return isHttpUrl(item?.finalUrl) ? item.finalUrl : item?.url;
}

/** The last part of a path, on either kind of separator. */
export function baseName(path) {
  if (typeof path !== 'string') return '';
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1].trim();
}

function sizeOf(item) {
  for (const value of [item.totalBytes, item.fileSize]) {
    if (Number.isInteger(value) && value > 0 && value < MAX_FILE_SIZE) return value;
  }
  return undefined;
}

/**
 * What goes to the app for a captured download: the address, the page it was
 * started from, and what the browser knew of the file -- its name, its size
 * and its type, which the helper compares with what it is served. Checked as
 * a row's payload is (`toPayload`), and `null` when there is nothing to send.
 */
export function filePayload(item, userAgent) {
  const referrer = isHttpUrl(item?.referrer) ? item.referrer : undefined;
  const base = toPayload({
    url: addressOf(item),
    kind: 'page',
    pageUrl: referrer,
    referer: referrer,
    userAgent,
  });
  if (!base) return null;
  const out = { ...base, kind: 'file' };
  const name = baseName(item.filename);
  if (name) out.fileName = name.slice(0, 255);
  const size = sizeOf(item);
  if (size !== undefined) out.fileSize = size;
  const mime = typeOf(item.mime);
  if (mime && mime.length <= 255 && !/[\u0000-\u001f\u007f]/.test(mime)) out.mime = mime;
  return out;
}

/** Whether the helper's answer to a probe says the app can take the file. */
export function appCanTake(probed) {
  return probed?.ok === true && probed.file !== null && typeof probed.file === 'object';
}
