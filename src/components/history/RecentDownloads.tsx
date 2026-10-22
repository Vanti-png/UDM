import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';

import { ListGroup, ListGroupLabel, ROW_LINE } from '@/components/ui/ListGroup';
import { PlatformBadge } from '@/components/ui/PlatformBadge';
import { Spinner } from '@/components/ui/Spinner';
import { useThumbnail } from '@/hooks/useThumbnail';
import { useTranslation, type TranslationKey } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatBytes, formatDate, formatDay } from '@/lib/format';
import { IS_MOBILE } from '@/lib/platform';
import { recentDownloads } from '@/lib/recentDownloads';
import * as ipc from '@/services/ipc';
import { useQueueStore } from '@/stores/useQueueStore';
import type { HistoryEntry } from '@/types';

/** How many rows are offered. */
const SHOWN = 6;

/**
 * How far back the history is read to find them. Files a screen cannot take,
 * and files that have since gone, are passed over, so more is read than is
 * shown -- and an album or a photo post can leave dozens of rows at once.
 */
const SCANNED = 200;

/** Where a row's text starts: its padding, the 72px thumbnail, the gap. */
const TEXT_INSET = IS_MOBILE ? 96 : 104;

interface RecentDownloadsProps {
  /** Which finished downloads this screen can take. */
  accepts: (entry: HistoryEntry) => boolean;
  /**
   * What pressing a row does. A promise holds every row still until it
   * settles, with a spinner on the one pressed; one that resolves to null
   * means the file would not open -- most likely gone since the list was
   * read -- and the list is read again.
   */
  onPress: (path: string) => Promise<unknown> | void;
  /** What a row is called to a screen reader; its `{title}` is filled in. */
  rowLabel: TranslationKey;
  /**
   * The files already chosen, when a row is a choice rather than an action:
   * each row is then a checkbox, ticked while its file is in here.
   */
  picked?: ReadonlySet<string>;
  disabled?: boolean;
  className?: string;
}

/**
 * The last downloads a screen can work on. A file that has just landed is most
 * often the one about to be cut or converted, and pressing it here is quicker
 * than finding it again through the file picker. When there are none, nothing
 * is shown: the card above already says what to do.
 */
export function RecentDownloads({
  accepts,
  onPress,
  rowLabel,
  picked,
  disabled = false,
  className,
}: RecentDownloadsProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  // Bumped when a row would not open, most likely because its file has gone
  // since the list was read; reading it again takes that row away.
  const [stale, setStale] = useState(0);

  // Read again whenever another download finishes, so one that lands while the
  // screen is open is offered without leaving it. A count rather than the
  // list, which changes several times a second while anything is downloading.
  const finished = useQueueStore(
    (state) => state.tasks.filter((task) => task.status === 'completed').length,
  );

  useEffect(() => {
    let live = true;
    ipc
      .listHistory(undefined, SCANNED, 0)
      .then((rows) => {
        if (live) setEntries(recentDownloads(rows, accepts, SHOWN));
      })
      // Nothing to offer is what an unreadable history looks like here, too.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [accepts, finished, stale]);

  if (entries.length === 0) return null;

  const press = async (path: string) => {
    const result = onPress(path);
    if (!(result instanceof Promise)) return;
    setPending(path);
    try {
      if ((await result) == null) setStale((count) => count + 1);
    } finally {
      setPending(null);
    }
  };

  return (
    <section className={className}>
      <ListGroupLabel className="mb-2">{t('history.recent')}</ListGroupLabel>
      <ListGroup inset={TEXT_INSET}>
        {entries.map((entry) => (
          <RecentRow
            key={entry.id}
            entry={entry}
            label={t(rowLabel, { title: entry.title })}
            checked={picked?.has(entry.filePath)}
            pending={pending === entry.filePath}
            disabled={disabled || pending != null}
            onPress={press}
          />
        ))}
      </ListGroup>
    </section>
  );
}

function RecentRow({
  entry,
  label,
  checked,
  pending,
  disabled,
  onPress,
}: {
  entry: HistoryEntry;
  label: string;
  /** Undefined when the row is an action rather than a choice. */
  checked: boolean | undefined;
  pending: boolean;
  disabled: boolean;
  onPress: (path: string) => void;
}) {
  const { language } = useTranslation();
  const { src } = useThumbnail(entry.thumbnailUrl);
  const choice = checked !== undefined;

  return (
    <button
      type="button"
      role={choice ? 'checkbox' : undefined}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onPress(entry.filePath)}
      aria-label={label}
      aria-busy={pending || undefined}
      className={cn(
        'flex w-full items-center py-2.5 text-left',
        IS_MOBILE ? 'gap-3 pl-3 pr-4' : 'gap-4 pl-4 pr-4',
        'transition-colors duration-150 ease-out-quint hover:bg-surface-hover active:bg-surface-active',
        // Every row stands still while one opens; only the one pressed says so.
        'disabled:pointer-events-none',
      )}
    >
      <span className="flex h-11 w-[72px] shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-thumb)] bg-surface-sunken">
        {src ? (
          <img
            src={src}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="no-drag size-full object-cover"
          />
        ) : (
          <PlatformBadge platform={entry.platform} size="md" />
        )}
      </span>

      <span className="block min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium leading-[18px] text-fg">
          {entry.title}
        </span>
        <span className={cn(ROW_LINE, 'mt-0.5 gap-x-3')}>
          {/* A phone has room for the day, not for the year and the minute. */}
          <span>
            {IS_MOBILE ? formatDay(entry.createdAt, language) : formatDate(entry.createdAt, language)}
          </span>
          <span>{entry.qualityLabel}</span>
          <span>{entry.container.toUpperCase()}</span>
          {entry.fileSize != null && <span>{formatBytes(entry.fileSize)}</span>}
        </span>
      </span>

      {pending && <Spinner size={16} className="text-fg-muted" />}

      {choice && (
        <span
          aria-hidden="true"
          className={cn(
            'flex size-[22px] shrink-0 items-center justify-center rounded-full transition-colors duration-150',
            checked ? 'bg-accent text-accent-fg' : 'border-[1.5px] border-fg-faint',
          )}
        >
          {checked && <Check size={13} strokeWidth={3} />}
        </span>
      )}
    </button>
  );
}
