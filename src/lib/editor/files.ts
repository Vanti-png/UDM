import type { HistoryEntry } from '@/types';

/** Containers FFmpeg can read and the editor can cut: what the picker offers. */
export const VIDEO_EXTENSIONS = ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'ts', 'mpg', 'mpeg'];

/** Sound the editor can lay under a clip: what the sound picker offers first. */
export const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma'];

const EDITABLE = new Set(VIDEO_EXTENSIONS);

/**
 * A download the editor can open: a video, since it turns away a file with no
 * picture.
 *
 * The container decides, with one exception: sound kept in its source's own
 * container can be a WebM with no picture in it. A request for pictures is no
 * such tell -- a carousel that opens on a photo asks for pictures for all of
 * its items, and its videos still arrive as MP4.
 */
export function isEditableDownload(entry: HistoryEntry): boolean {
  return entry.request?.mode !== 'audio' && EDITABLE.has(entry.container.toLowerCase());
}
