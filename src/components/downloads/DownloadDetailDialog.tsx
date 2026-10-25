import { Pause, Play, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { create } from 'zustand';

import { Button } from '@/components/ui/Button';
import { Dropdown } from '@/components/ui/Dropdown';
import { Modal } from '@/components/ui/Modal';
import { useTranslation } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatBytes, formatEta, formatSpeed } from '@/lib/format';
import { speedLimitLabel, speedLimitOptions } from '@/lib/speedLimits';
import { displayHost } from '@/lib/url';
import * as ipc from '@/services/ipc';
import { useQueueStore } from '@/stores/useQueueStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import type { DownloadTask, SegmentProgress } from '@/types';

import { SegmentBar, wholeAsSegments } from './SegmentBar';

/** Which download's details are open, if any. */
const useDetailStore = create<{ id: string | null }>(() => ({ id: null }));

/** Open the detail window of one download. Stable: rows are memoised on it. */
export function openDownloadDetails(id: string) {
  useDetailStore.setState({ id });
}

function closeDownloadDetails() {
  useDetailStore.setState({ id: null });
}

/** Rows of the pieces list shown at most; a long split has dozens. */
const MAX_PIECE_ROWS = 64;

/**
 * A download's own window, as a download manager has one: how far it has got
 * and how fast, the map of its connections and the piece each is filling, and
 * a speed cap of its own.
 *
 * It reads the task from the queue store, which the backend's progress events
 * keep current, so it moves as the download does. The task it last showed is
 * held while the window closes, so it fades out with its own content.
 */
export function DownloadDetailDialog() {
  const id = useDetailStore((state) => state.id);
  const live = useQueueStore((state) => (id ? state.tasks.find((task) => task.id === id) : undefined));
  const [held, setHeld] = useState<DownloadTask | null>(null);

  useEffect(() => {
    if (live) setHeld(live);
  }, [live]);
  // Removed from the queue while open: there is nothing left to show.
  useEffect(() => {
    if (id && !live && held?.id === id) closeDownloadDetails();
  }, [id, live, held]);

  const task = live ?? held;
  if (!task) return null;
  return <Details task={task} open={id !== null && live !== undefined} />;
}

function Details({ task, open }: { task: DownloadTask; open: boolean }) {
  const { t } = useTranslation();
  const globalCap = useSettingsStore((state) => state.settings?.speedLimitKbps ?? 0);
  const { progress, status } = task;

  const running = status === 'downloading' || status === 'preparing' || status === 'processing';
  const waiting = status === 'paused' || status === 'queued';
  const finished = status === 'completed' || status === 'failed' || status === 'canceled';

  const pieces: SegmentProgress[] =
    progress.segments && progress.segments.length > 0
      ? progress.segments
      : wholeAsSegments(progress.receivedBytes, progress.totalBytes);
  const split = (progress.segments?.length ?? 0) > 0;
  const activeCount = progress.segments?.filter((piece) => piece.active).length ?? 0;
  const ownCap = task.speedLimitKbps ?? 0;

  const statusText = (() => {
    if (status === 'paused') return t('downloads.paused');
    if (status === 'queued') return t('downloads.queued');
    if (status === 'failed') return t('downloads.failed');
    if (status === 'canceled') return t('downloads.canceled');
    if (status === 'completed') return t('stage.done');
    return t(`stage.${progress.stage}` as TranslationKey);
  })();

  const sizeText =
    progress.totalBytes != null && progress.totalBytes > 0
      ? `${formatBytes(progress.receivedBytes)} / ${formatBytes(progress.totalBytes)}`
      : progress.receivedBytes > 0
        ? formatBytes(progress.receivedBytes)
        : '—';
  const percent =
    progress.percent != null ? `${Math.min(100, Math.max(0, progress.percent)).toFixed(1)}%` : null;

  const connectionsText = split
    ? t('details.connectionsSplit', { active: activeCount, pieces: pieces.length })
    : t('details.connectionsSingle');

  return (
    <Modal
      open={open}
      onClose={closeDownloadDetails}
      width={600}
      closeLabel={t('details.close')}
      title={<span className="block truncate">{task.title}</span>}
      description={
        <span className="block truncate">
          {[displayHost(task.url) ?? task.url, task.formatLabel].filter(Boolean).join(' · ')}
        </span>
      }
      footer={
        <>
          {running && (
            <Button variant="secondary" icon={<Pause size={15} />} onClick={() => void ipc.pauseDownload(task.id)}>
              {t('downloads.pause')}
            </Button>
          )}
          {waiting && (
            <Button variant="secondary" icon={<Play size={15} />} onClick={() => void ipc.resumeDownload(task.id)}>
              {t('downloads.resume')}
            </Button>
          )}
          {!finished && (
            <Button variant="danger" icon={<X size={15} />} onClick={() => void ipc.cancelDownload(task.id)}>
              {t('downloads.cancel')}
            </Button>
          )}
          <Button variant="primary" onClick={closeDownloadDetails} data-autofocus>
            {t('details.close')}
          </Button>
        </>
      }
    >
      <div className="space-y-5 pb-1">
        <div>
          <div className="mb-2 flex items-baseline justify-between gap-3 text-[13px]">
            <span className="min-w-0 truncate font-medium text-fg">{statusText}</span>
            {percent && <span className="shrink-0 tabular-nums text-fg-muted">{percent}</span>}
          </div>
          <SegmentBar segments={pieces} label={task.title} />
        </div>

        <dl className="grid grid-cols-[auto_1fr_auto_1fr] gap-x-4 gap-y-2 text-[13px]">
          <dt className="text-fg-muted">{t('details.downloaded')}</dt>
          <dd className="tabular-nums text-fg">{sizeText}</dd>
          <dt className="text-fg-muted">{t('details.speed')}</dt>
          <dd className="tabular-nums text-fg">{running && progress.speedBps > 0 ? formatSpeed(progress.speedBps) : '—'}</dd>
          <dt className="text-fg-muted">{t('details.timeLeft')}</dt>
          <dd className="tabular-nums text-fg">{running && progress.etaSec != null ? formatEta(progress.etaSec) : '—'}</dd>
          <dt className="text-fg-muted">{t('details.resume')}</dt>
          <dd className="text-fg">{t(progress.resumable ? 'details.yes' : 'details.no')}</dd>
          <dt className="text-fg-muted">{t('details.connections')}</dt>
          <dd className="col-span-3 text-fg">{connectionsText}</dd>
        </dl>

        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-fg">{t('details.speedLimit')}</p>
            <p className="text-[12px] text-fg-muted">
              {globalCap > 0
                ? t('details.speedLimitWithApp', { cap: speedLimitLabel(globalCap, '') })
                : t('details.speedLimitHint')}
            </p>
          </div>
          <div className="w-[170px] shrink-0">
            <Dropdown
              value={String(ownCap)}
              options={speedLimitOptions(ownCap).map((kbps) => ({
                value: String(kbps),
                label: speedLimitLabel(kbps, t('settings.speedLimitOff')),
              }))}
              onChange={(value) => void ipc.setDownloadSpeedLimit(task.id, Number(value) || 0)}
            />
          </div>
        </div>

        {split && <PieceList pieces={pieces} />}
      </div>
    </Modal>
  );
}

/** Every piece, as the connections table of a download manager lists them. */
function PieceList({ pieces }: { pieces: SegmentProgress[] }) {
  const { t } = useTranslation();
  const shown = pieces.slice(0, MAX_PIECE_ROWS);

  return (
    <div>
      <p className="mb-1.5 text-[12px] font-medium uppercase tracking-wide text-fg-faint">{t('details.pieces')}</p>
      <ol className="max-h-48 space-y-1 overflow-y-auto pr-1">
        {shown.map((piece, index) => {
          const size = piece.end - piece.start;
          const done = piece.received >= size;
          const state = piece.active ? 'details.pieceActive' : done ? 'details.pieceDone' : 'details.pieceWaiting';
          return (
            <li
              key={piece.start}
              className="grid grid-cols-[28px_1fr_150px_92px] items-center gap-3 text-[12px] tabular-nums"
            >
              <span className="text-fg-faint">{index + 1}</span>
              <span className="relative h-1.5 overflow-hidden rounded-full bg-fill-hover">
                <span
                  className={cn(
                    'motion-essential absolute inset-0 origin-left bg-accent transition-transform duration-300 ease-linear',
                    !piece.active && 'opacity-60',
                  )}
                  style={{ transform: `scaleX(${size > 0 ? Math.min(1, piece.received / size) : 0})` }}
                />
              </span>
              <span className="truncate text-right text-fg-muted">
                {formatBytes(piece.received)} / {formatBytes(size)}
              </span>
              <span className={cn('truncate', piece.active ? 'text-accent' : 'text-fg-muted')}>{t(state)}</span>
            </li>
          );
        })}
      </ol>
      {pieces.length > shown.length && (
        <p className="mt-1 text-[12px] text-fg-faint">
          {t('details.morePieces', { count: pieces.length - shown.length })}
        </p>
      )}
    </div>
  );
}
