import { cn } from '@/lib/cn';
import type { SegmentProgress } from '@/types';

interface SegmentBarProps {
  /** The pieces of a split transfer, in file order. */
  segments: SegmentProgress[];
  label: string;
  className?: string;
}

/**
 * The whole file as one bar, cut into the pieces its connections fetch, each
 * filled as far as it has got -- the map a download manager draws. A piece a
 * connection is filling now is drawn in the full accent; one that is finished,
 * or waiting for a connection, a step quieter, so the eye finds the ones at
 * work. A hairline divides each piece from the one before it.
 *
 * Fills are scaled rather than resized, for the reason `Progress` gives: the
 * map is redrawn twice a second for as long as the window is open.
 */
export function SegmentBar({ segments, label, className }: SegmentBarProps) {
  const total = segments.length > 0 ? segments[segments.length - 1]!.end : 0;
  const received = segments.reduce((sum, piece) => sum + piece.received, 0);
  const percent = total > 0 ? Math.round((received / total) * 100) : 0;

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className={cn('relative h-4 w-full overflow-hidden rounded-[6px] bg-fill-hover', className)}
    >
      {total > 0 &&
        segments.map((piece) => {
          const size = piece.end - piece.start;
          if (size <= 0) return null;
          const filled = Math.min(1, Math.max(0, piece.received / size));
          return (
            <div
              key={piece.start}
              className="absolute inset-y-0"
              style={{ left: `${(piece.start / total) * 100}%`, width: `${(size / total) * 100}%` }}
            >
              <div
                className={cn(
                  'motion-essential h-full w-full origin-left bg-accent transition-transform duration-300 ease-linear',
                  !piece.active && 'opacity-60',
                )}
                style={{ transform: `scaleX(${filled})` }}
              />
              {piece.start > 0 && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-px bg-surface" />}
            </div>
          );
        })}
    </div>
  );
}

/** The map of a transfer fetched as one piece: what one connection has done. */
export function wholeAsSegments(received: number, total: number | null): SegmentProgress[] {
  if (total == null || total <= 0) return [];
  return [{ start: 0, end: total, received: Math.min(received, total), active: false }];
}
