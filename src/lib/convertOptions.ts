/**
 * Option lists for the converter.
 *
 * Everything here is pure and derived from the catalogue the backend serves --
 * the set of formats is never written down a second time in TypeScript, so the
 * list on screen cannot offer a target the backend would refuse.
 */

import { fileExtension } from '@/lib/format';
import type {
  ConvertFormatInfo,
  ConvertKind,
  ConvertQuality,
  HistoryEntry,
  MediaProbe,
} from '@/types';

/** The kinds of target, in the order the switch above the options shows them. */
export const CONVERT_KINDS: ConvertKind[] = ['video', 'audio', 'gif', 'image'];

/** Heights offered as a video's downscale cap, largest first. */
export const RESOLUTION_CAPS = [2160, 1440, 1080, 720, 480, 360] as const;

/** Caps on the longer side, largest first. A GIF is small by nature. */
export const GIF_SIDES = [720, 640, 480, 360, 240] as const;
export const IMAGE_SIDES = [3840, 2560, 1920, 1280, 1024, 512] as const;
/** An icon is never larger than 256 px; these are the sizes Windows draws. */
export const ICON_SIDES = [256, 128, 64, 48, 32, 16] as const;

/** Frame rates offered. One above the source's is never applied: the source's
 *  own rate stands instead, since the extra frames would only be repeats. */
export const VIDEO_RATES = [60, 50, 30, 25, 24, 15] as const;
export const GIF_RATES = [30, 25, 20, 15, 12, 10] as const;

/** Audio bitrates offered, in kbps. */
export const AUDIO_BITRATES = [320, 256, 192, 160, 128, 96] as const;

/** What each kind starts on: everything kept for a film, a GIF sized for a chat. */
export interface KindChoice {
  target: string;
  quality: ConvertQuality;
  /** Height cap for a video, longer-side cap for a GIF or a picture. */
  size: number | null;
  fps: number | null;
}

export const DEFAULT_CHOICES: Record<ConvertKind, KindChoice> = {
  video: { target: 'mp4', quality: 'original', size: null, fps: null },
  audio: { target: 'mp3', quality: 'original', size: null, fps: null },
  gif: { target: 'gif', quality: 'balanced', size: 480, fps: 15 },
  image: { target: 'jpg', quality: 'high', size: null, fps: null },
};

/**
 * The quality choices a kind has. A GIF has no "original": 256 colours are
 * never what the source had. A sound is tuned by its bitrate instead.
 */
export function qualitiesFor(kind: ConvertKind): ConvertQuality[] {
  if (kind === 'audio') return [];
  if (kind === 'gif') return ['high', 'balanced', 'small'];
  return ['original', 'high', 'balanced', 'small'];
}

export function formatsOfKind(catalogue: ConvertFormatInfo[], kind: ConvertKind): string[] {
  return catalogue.filter((entry) => entry.kind === kind).map((entry) => entry.id);
}

/** Whether a quality or a bitrate can be chosen for a target. Unknown targets
 *  are assumed tunable until the catalogue says otherwise. */
export function isTunable(catalogue: ConvertFormatInfo[], target: string): boolean {
  return catalogue.find((entry) => entry.id === target)?.tunable ?? true;
}

/**
 * The kind a set of files plainly asks for, when there is only one: photos can
 * only become photos, and a sound with no picture can only become a sound. A
 * film can become any of the four, so it asks for nothing.
 */
export function kindForFiles(probes: MediaProbe[]): ConvertKind | null {
  if (probes.length === 0) return null;
  if (probes.every((probe) => probe.still)) return 'image';
  if (probes.every((probe) => !probe.hasVideo)) return 'audio';
  return null;
}

/**
 * Input extensions offered in the file picker. Deliberately wider than the list
 * of targets: plenty of formats can be read that it makes no sense to write.
 */
export const INPUT_EXTENSIONS = [
  'mp4',
  'mkv',
  'webm',
  'mov',
  'avi',
  'm4v',
  'flv',
  'wmv',
  'mpg',
  'mpeg',
  'ts',
  'm2ts',
  '3gp',
  'ogv',
  'gif',
  'mp3',
  'm4a',
  'aac',
  'wav',
  'flac',
  'opus',
  'ogg',
  'oga',
  'weba',
  'wma',
  'aiff',
  'aif',
  'mka',
  'amr',
  'ac3',
  'jpg',
  'jpeg',
  'jfif',
  'png',
  'webp',
  'heic',
  'heif',
  'avif',
  'bmp',
  'tif',
  'tiff',
  'ico',
  'tga',
  'jp2',
  'jxl',
] as const;

const INPUTS = new Set<string>(INPUT_EXTENSIONS);

/**
 * A download the converter can read. The file's own extension decides, the
 * same test the picker applies -- a video, its sound kept on its own, a photo
 * from a carousel.
 */
export function isConvertibleDownload(entry: HistoryEntry): boolean {
  return INPUTS.has(fileExtension(entry.filePath));
}

/** "1920x1080" when both sides are known, otherwise whichever one is. */
export function formatResolution(
  width: number | null,
  height: number | null,
): string | null {
  if (width != null && height != null) return `${width}x${height}`;
  if (height != null) return `${height}p`;
  return null;
}
