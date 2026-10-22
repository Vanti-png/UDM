import type { HistoryEntry } from '@/types';

/**
 * The first `count` downloads a screen can take, from a history read newest
 * first. Each file once: downloading a link again after its file was deleted
 * writes to the same path and adds a second record of it.
 */
export function recentDownloads(
  entries: HistoryEntry[],
  accepts: (entry: HistoryEntry) => boolean,
  count: number,
): HistoryEntry[] {
  const seen = new Set<string>();
  const recent: HistoryEntry[] = [];
  for (const entry of entries) {
    if (recent.length === count) break;
    if (entry.status !== 'completed' || !entry.fileExists || !accepts(entry)) continue;
    if (seen.has(entry.filePath)) continue;
    seen.add(entry.filePath);
    recent.push(entry);
  }
  return recent;
}
