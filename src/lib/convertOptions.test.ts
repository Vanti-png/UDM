import { describe, expect, it } from 'vitest';

import type { ConvertFormatInfo, MediaProbe } from '@/types';

import { DEFAULT_CHOICES, isTunable, kindForFiles, qualitiesFor } from './convertOptions';

const probe = (patch: Partial<MediaProbe>): MediaProbe => ({
  path: 'x',
  fileName: 'x',
  container: 'mp4',
  sizeBytes: 1,
  durationSec: 10,
  width: 1920,
  height: 1080,
  fps: 30,
  videoDurationSec: 10,
  pixelAspect: null,
  videoCodec: 'h264',
  audioCodec: 'aac',
  audioBitrateKbps: 128,
  hasVideo: true,
  hasAudio: true,
  still: false,
  ...patch,
});

const photo = probe({ still: true, durationSec: null, hasAudio: false, videoCodec: 'mjpeg' });
const song = probe({ hasVideo: false, width: null, height: null, videoCodec: null });
const film = probe({});

describe('kindForFiles', () => {
  it('photos can only become photos and a sound only a sound', () => {
    expect(kindForFiles([photo, photo])).toBe('image');
    expect(kindForFiles([song])).toBe('audio');
  });

  it('a film, or a mixture, asks for nothing', () => {
    expect(kindForFiles([film])).toBeNull();
    expect(kindForFiles([photo, film])).toBeNull();
    expect(kindForFiles([])).toBeNull();
  });
});

describe('qualitiesFor', () => {
  it('a GIF has no original, and a sound is tuned by its bitrate', () => {
    expect(qualitiesFor('video')[0]).toBe('original');
    expect(qualitiesFor('image')[0]).toBe('original');
    expect(qualitiesFor('gif')).not.toContain('original');
    expect(qualitiesFor('audio')).toEqual([]);
  });

  it('every kind starts on a quality it offers', () => {
    for (const kind of ['video', 'gif', 'image'] as const) {
      expect(qualitiesFor(kind)).toContain(DEFAULT_CHOICES[kind].quality);
    }
  });
});

describe('isTunable', () => {
  const catalogue: ConvertFormatInfo[] = [
    { id: 'png', kind: 'image', tunable: false },
    { id: 'jpg', kind: 'image', tunable: true },
  ];

  it('follows the catalogue, and assumes a target it has not heard of is tunable', () => {
    expect(isTunable(catalogue, 'png')).toBe(false);
    expect(isTunable(catalogue, 'jpg')).toBe(true);
    expect(isTunable([], 'jpg')).toBe(true);
  });
});
