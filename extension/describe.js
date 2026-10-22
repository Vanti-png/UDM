// The words a row is described in, shared by the popup's list and the page
// picker's card (worded in the service worker), so the two say a row alike.
//
// Pure, like media.js: `t` is chrome.i18n.getMessage, or a stand-in under
// Node (scripts/extension/describe.test.mjs).

import { formatDuration, formatEstimate } from './media.js';

// The kind of each row, in the words the meta line uses for it.
const LABELS = {
  stream: 'kindStream',
  video: 'kindVideo',
  audio: 'kindAudio',
  image: 'kindImage',
  page: 'kindPage',
  protected: 'kindProtected',
};

// The labels a plan falls back on when the source named no quality. They say
// nothing the kind of the row does not already say.
const VAGUE_QUALITY = new Set(['video', 'audio', 'image']);

// What the app's answer means for a page of this extension, as one of three
// sentences. `forbidden`, `version` and `malformed` all come down to an app
// older than this extension: one that does not know the store copy's id,
// speaks an older wire, or does not know what a download request is.
export function problemOf(result) {
  if (!result) return 'unreachable';
  if (result.ok) return result.status?.canDownload === true ? null : 'update';
  switch (result.code) {
    case 'notInstalled':
      return 'notInstalled';
    case 'forbidden':
    case 'version':
    case 'malformed':
      return 'update';
    default:
      return 'unreachable';
  }
}

export const NOTICES = {
  notInstalled: { text: 'noticeNotInstalled', retry: true },
  update: { text: 'noticeUpdate', retry: false },
  unreachable: { text: 'noticeUnreachable', retry: true },
};

// What the row knows before the app has said anything: its kind, and the
// quality, size or length the page gave away.
export function firstMeta(meta, t) {
  const label = meta.label === 'site' ? meta.site : t(LABELS[meta.label] ?? 'kindVideo');
  return [label, ...(meta.parts ?? [])].filter(Boolean).join(' · ');
}

// What the app said it would download, in the order its own Home screen
// says it -- "1080p - MKV" there, "1080p · MKV · ~82 MB" here. The length
// is added on the large card, where there is room for it; in a row of the
// list it would push the size out of sight.
export function detailMeta(preview, row, t, { withLength = false } = {}) {
  const quality = preview.qualityLabel && !VAGUE_QUALITY.has(preview.qualityLabel.toLowerCase())
    ? preview.qualityLabel
    : null;
  const length = withLength && !preview.isLive
    ? formatDuration(preview.durationSec ?? row.durationSec ?? 0)
    : '';
  return [
    preview.isLive ? t('kindLive') : null,
    quality,
    preview.container ? preview.container.toUpperCase() : null,
    formatEstimate(preview.estimatedBytes) || null,
    length || null,
  ]
    .filter(Boolean)
    .join(' · ');
}
