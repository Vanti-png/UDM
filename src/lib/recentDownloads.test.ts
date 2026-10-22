import { describe, expect, it } from 'vitest';

import { isConvertibleDownload } from '@/lib/convertOptions';
import { isEditableDownload } from '@/lib/editor/files';
import { fileExtension } from '@/lib/format';
import type { DownloadRequest, HistoryEntry } from '@/types';

import { recentDownloads } from './recentDownloads';

let nextId = 1;

const entry = (patch: Partial<HistoryEntry>): HistoryEntry => ({
  id: nextId++,
  url: 'https://example.com/v',
  title: 'A video',
  platform: 'youtube',
  thumbnailUrl: null,
  filePath: 'C:\\Users\\me\\Downloads\\A video.mp4',
  fileExists: true,
  container: 'mp4',
  qualityLabel: '1080p',
  fileSize: 1_000_000,
  createdAt: 0,
  status: 'completed',
  request: null,
  ...patch,
});

const request = (mode: DownloadRequest['mode']): DownloadRequest => ({
  url: 'https://example.com/v',
  mode,
  quality: { type: 'best' },
  videoFormatId: null,
  audioFormatId: null,
  container: null,
  watermark: 'any',
  outputDir: null,
  title: null,
  thumbnailUrl: null,
  platform: null,
});

const everything = () => true;

describe('recentDownloads', () => {
  it('offers only finished files that are still there', () => {
    const kept = entry({});
    const rows = [
      entry({ status: 'failed', filePath: '/d/failed.mp4' }),
      entry({ fileExists: false, filePath: '/d/gone.mp4' }),
      kept,
    ];
    expect(recentDownloads(rows, everything, 6)).toEqual([kept]);
  });

  it('offers what the screen accepts and passes over the rest', () => {
    const song = entry({ filePath: '/d/song.m4a', container: 'm4a' });
    const film = entry({ filePath: '/d/film.mp4' });
    expect(recentDownloads([song, film], isEditableDownload, 6)).toEqual([film]);
  });

  // The history is newest first, so the first record of a path is its latest.
  it('offers each file once, as its newest record', () => {
    const newest = entry({ filePath: '/d/same.mp4', createdAt: 2 });
    const older = entry({ filePath: '/d/same.mp4', createdAt: 1 });
    expect(recentDownloads([newest, older], everything, 6)).toEqual([newest]);
  });

  it('stops at the count, keeping the newest', () => {
    const rows = Array.from({ length: 10 }, (_, index) => entry({ filePath: `/d/${index}.mp4` }));
    expect(recentDownloads(rows, everything, 6)).toEqual(rows.slice(0, 6));
  });
});

describe('isConvertibleDownload', () => {
  it('takes a video, a sound and a photo by the extension they were saved with', () => {
    for (const path of [
      'C:\\Downloads\\clip.MP4',
      '/storage/emulated/0/Download/Universal Downloader/song.m4a',
      '/home/me/Downloads/photo.jpg',
      '/home/me/Downloads/post.webp',
    ]) {
      expect(isConvertibleDownload(entry({ filePath: path })), path).toBe(true);
    }
  });

  it('turns away a file FFmpeg is not offered for', () => {
    for (const path of ['/d/subtitles.vtt', '/d/notes.txt', '/d/no-extension']) {
      expect(isConvertibleDownload(entry({ filePath: path })), path).toBe(false);
    }
  });
});

describe('isEditableDownload', () => {
  it('takes a video and turns away a sound', () => {
    expect(isEditableDownload(entry({ container: 'MKV' }))).toBe(true);
    expect(isEditableDownload(entry({ container: 'mp3' }))).toBe(false);
  });

  it('turns away sound kept in a video container', () => {
    expect(isEditableDownload(entry({ container: 'webm', request: request('audio') }))).toBe(false);
  });
});

describe('fileExtension', () => {
  it('is the part after the last dot of the name, lower-cased', () => {
    expect(fileExtension('C:\\a.b\\Clip.final.MKV')).toBe('mkv');
    expect(fileExtension('/a.b/clip')).toBe('');
    expect(fileExtension('/a/.hidden')).toBe('');
  });
});
