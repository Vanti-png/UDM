import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { Clipboard, Download, Globe } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { InlineNotice } from '@/components/ui/InlineNotice';
import { Modal } from '@/components/ui/Modal';
import { TextInput } from '@/components/ui/TextInput';
import { errorCopy, useTranslation } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatBytes, truncateMiddle } from '@/lib/format';
import { displayHost } from '@/lib/url';
import * as ipc from '@/services/ipc';
import { useNewDownloadStore, type PendingFile } from '@/stores/useNewDownloadStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import type { AppErrorInfo, DownloadRequest, FileInfo, Settings } from '@/types';

interface NewDownloadDialogProps {
  /** A file was queued and nothing else is waiting: show it downloading. */
  onQueued: () => void;
}

/**
 * The New download dialog, as a download manager has one: a file the browser
 * started or a file link copied elsewhere, with its name, its size and where
 * it goes, to be confirmed before anything is fetched.
 *
 * Files arriving together are asked about one after another. The last one
 * shown is held while the dialog closes, so it fades out with its own content
 * rather than going blank first.
 */
export function NewDownloadDialog({ onQueued }: NewDownloadDialogProps) {
  const current = useNewDownloadStore((state) => state.pending[0] ?? null);
  const count = useNewDownloadStore((state) => state.pending.length);
  const settings = useSettingsStore((state) => state.settings);
  const [last, setLast] = useState<PendingFile | null>(null);

  useEffect(() => {
    if (current) setLast(current);
  }, [current]);

  const file = current ?? last;
  if (!file || !settings) return null;
  return (
    <FileDialog
      key={file.id}
      file={file}
      open={current !== null}
      count={count}
      settings={settings}
      onQueued={onQueued}
    />
  );
}

interface FileDialogProps {
  file: PendingFile;
  open: boolean;
  count: number;
  settings: Settings;
  onQueued: () => void;
}

function FileDialog({ file, open, count, settings, onQueued }: FileDialogProps) {
  const { t } = useTranslation();
  const dismiss = useNewDownloadStore((state) => state.dismiss);

  const [info, setInfo] = useState<FileInfo | null>(null);
  const [probeError, setProbeError] = useState<AppErrorInfo | null>(null);
  const [name, setName] = useState(file.fileName ?? '');
  const [folder, setFolder] = useState(settings.downloadDir);
  const [submitting, setSubmitting] = useState(false);
  const [enqueueError, setEnqueueError] = useState<AppErrorInfo | null>(null);
  const edited = useRef(file.fileName !== null);

  // One request to the server, for the name, the size and whether it resumes.
  useEffect(() => {
    let live = true;
    ipc
      .probeFile(file.url, file.source)
      .then((found) => {
        if (!live) return;
        setInfo(found);
        if (!edited.current) setName(found.fileName);
      })
      .catch((caught) => {
        if (live) setProbeError(ipc.toAppError(caught));
      });
    return () => {
      live = false;
    };
  }, [file.url, file.source]);

  const close = () => {
    if (!submitting) dismiss(file.id);
  };

  const pickFolder = async () => {
    const selected = await openDialog({ directory: true, multiple: false, defaultPath: folder });
    if (typeof selected === 'string') setFolder(selected);
  };

  const start = async () => {
    setSubmitting(true);
    setEnqueueError(null);
    const fileName = name.trim() || null;
    const request: DownloadRequest = {
      url: file.url,
      mode: settings.defaultMode,
      quality: settings.defaultQuality,
      videoFormatId: null,
      audioFormatId: null,
      container: null,
      watermark: 'any',
      outputDir: folder === settings.downloadDir ? null : folder,
      // What the queue card is called until the file is saved under it.
      title: fileName ?? info?.fileName ?? null,
      thumbnailUrl: null,
      platform: null,
      audioLanguage: null,
      source: file.source,
      file: { fileName },
    };
    try {
      await ipc.enqueueDownload(request);
      dismiss(file.id);
      if (count <= 1) onQueued();
    } catch (caught) {
      setEnqueueError(ipc.toAppError(caught));
      setSubmitting(false);
    }
  };

  const size = info?.size ?? file.fileSize;
  const sizeText =
    size != null ? formatBytes(size) : info || probeError ? t('newDownload.sizeUnknown') : t('newDownload.reading');
  const resumeText = info
    ? t(info.resumable ? 'newDownload.resumable' : 'newDownload.notResumable')
    : probeError
      ? t('newDownload.sizeUnknown')
      : t('newDownload.reading');
  const isPage = info?.mime === 'text/html' || info?.mime === 'application/xhtml+xml';
  const shownError = enqueueError ?? probeError;
  const host = displayHost(file.url) ?? file.url;
  const OriginIcon = file.origin === 'browser' ? Globe : Clipboard;

  return (
    <Modal
      open={open}
      onClose={close}
      width={520}
      closeLabel={t('newDownload.cancel')}
      title={t('newDownload.title')}
      description={
        <span className="flex items-center gap-1.5">
          <OriginIcon size={13} aria-hidden="true" className="shrink-0" />
          <span className="truncate">
            {t(file.origin === 'browser' ? 'newDownload.fromBrowser' : 'newDownload.fromClipboard')} · {host}
          </span>
          {count > 1 && (
            <span className="ml-auto shrink-0 tabular-nums text-fg-faint">
              {t('newDownload.queueCount', { index: '1', count: String(count) })}
            </span>
          )}
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={submitting}>
            {t('newDownload.cancel')}
          </Button>
          <Button
            variant="primary"
            icon={<Download size={15} />}
            loading={submitting}
            onClick={() => void start()}
            data-autofocus
          >
            {t('newDownload.start')}
          </Button>
        </>
      }
    >
      <div className="space-y-4 pb-1">
        <TextInput
          label={t('newDownload.fileName')}
          value={name}
          spellCheck={false}
          onChange={(event) => {
            edited.current = true;
            setName(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void start();
          }}
        />

        <dl className={cn('grid grid-cols-[auto_1fr] gap-x-4 gap-y-2', 'text-[13px]')}>
          <dt className="text-fg-muted">{t('newDownload.size')}</dt>
          <dd className="tabular-nums text-fg">{sizeText}</dd>
          <dt className="text-fg-muted">{t('newDownload.resume')}</dt>
          <dd className="text-fg">{resumeText}</dd>
          <dt className="self-center text-fg-muted">{t('newDownload.saveTo')}</dt>
          <dd className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-fg" title={folder}>
              {truncateMiddle(folder, 40)}
            </span>
            <Button size="sm" variant="secondary" onClick={() => void pickFolder()} disabled={submitting}>
              {t('newDownload.change')}
            </Button>
          </dd>
        </dl>

        <p className="truncate text-[12px] text-fg-faint" title={file.url}>
          {file.url}
        </p>

        {isPage && <InlineNotice tone="info">{t('newDownload.isPage')}</InlineNotice>}
        {shownError && (
          <InlineNotice tone="error">
            {(() => {
              const { title, message } = errorCopy(shownError);
              return `${title}. ${message}`;
            })()}
          </InlineNotice>
        )}
      </div>
    </Modal>
  );
}
