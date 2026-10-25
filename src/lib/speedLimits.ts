import { formatBytes } from '@/lib/format';

/** Speed caps offered in Settings and in a download's detail window, in KB/s. 0 is no cap. */
export const SPEED_LIMITS_KBPS = [0, 128, 256, 512, 1024, 2048, 5120, 10240, 25600, 51200];

/** The presets, plus a figure that is none of them -- one saved by hand. */
export function speedLimitOptions(current: number): number[] {
  return SPEED_LIMITS_KBPS.includes(current)
    ? SPEED_LIMITS_KBPS
    : [...SPEED_LIMITS_KBPS, current].sort((a, b) => a - b);
}

/** A cap as the dropdowns say it: "512 KB/s", "2.00 MB/s", or the word for none. */
export function speedLimitLabel(kbps: number, unlimited: string): string {
  return kbps === 0 ? unlimited : `${formatBytes(kbps * 1024)}/s`;
}
