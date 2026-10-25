import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import {
  CircleAlert,
  FilePlus2,
  FolderOpen,
  Link2,
  Redo2,
  Undo2,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { LinkImportModal } from '@/components/editor/LinkImportModal';
import { MediaRail } from '@/components/editor/MediaRail';
import { OutputInspector } from '@/components/editor/OutputInspector';
import { PlayheadTime, createPlayhead } from '@/components/editor/playhead';
import { PreviewStage } from '@/components/editor/PreviewStage';
import { SoundPreview } from '@/components/editor/SoundPreview';
import { SOUND_LANE_ROOM, TimelineDock } from '@/components/editor/TimelineDock';
import { RecentDownloads } from '@/components/history/RecentDownloads';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { InlineNotice } from '@/components/ui/InlineNotice';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { Progress } from '@/components/ui/Progress';
import { useFileActions } from '@/hooks/useFileActions';
import { errorMessage, useTranslation } from '@/i18n';
import { cn } from '@/lib/cn';
import { VIDEO_EXTENSIONS, isEditableDownload } from '@/lib/editor/files';
import { cutAt, nextKeptPosition } from '@/lib/editor/segments';
import { ZOOM_STEP } from '@/lib/editor/zoom';
import { COLLAPSE, EDITOR } from '@/lib/motion';
import { formatMbps } from '@/lib/editor/bitrate';
import { PROBLEM_TEXT } from '@/lib/fileProblem';
import {
  formatBytes,
  formatFrameTimecode,
  formatTimecode,
  prettyCodec,
} from '@/lib/format';
import * as ipc from '@/services/ipc';
import {
  selectActiveClip,
  selectAnyHistory,
  selectCuts,
  selectHistory,
  selectKeptLength,
  selectOptions,
  selectSound,
  useEditorStore,
} from '@/stores/useEditorStore';
import { useToolsStore } from '@/stores/useToolsStore';
import type { Settings } from '@/types';

/** How many buckets and cells the timeline asks for. */
const WAVEFORM_BUCKETS = 4000;
const FILMSTRIP_CELLS = 40;
/** The height the frames are rendered at, in device pixels. */
const FILMSTRIP_CELL_HEIGHT = 68;

const DROP_TRANSITION = 'transition-[background-color,box-shadow] duration-150 ease-out-quint';

/** Whatever is drawn over the editor and has the keyboard while it is open. */
const OVERLAY = '[role="dialog"][aria-modal="true"],[role="combobox"][aria-expanded="true"]';

/** Inputs that hold no text, so there is nothing of theirs for Ctrl+Z to take back. */
const TEXTLESS_INPUTS = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/** A field whose text is being edited, where the text's own undo has to win. */
function isTextField(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable || element instanceof HTMLTextAreaElement) return true;
  return element instanceof HTMLInputElement && !TEXTLESS_INPUTS.has(element.type);
}

/** A control that answers the plain keys itself: a field, a slider, a menu. */
function hasOwnKeys(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  return (
    element.isContentEditable ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    element.closest('[role="combobox"],[role="listbox"],[role="slider"]') != null
  );
}

interface EditorPageProps {
  settings: Settings;
}

/**
 * The editor.
 *
 * Two shapes, one route. With nothing open it is an ordinary page in the app's
 * centred column -- a place to drop a file or paste a link. With something open
 * it takes the whole area and becomes a workspace: a rail of clips, the
 * picture, the settings, and the file laid out in time underneath. The screen
 * only ambushes the user once they have asked it to.
 */
export function EditorPage({ settings }: EditorPageProps) {
  const { t, language } = useTranslation();

  const pool = useEditorStore((state) => state.pool);
  const clip = useEditorStore(selectActiveClip);
  const cuts = useEditorStore(selectCuts);
  const options = useEditorStore(selectOptions);
  const sound = useEditorStore(selectSound);
  const keptLength = useEditorStore(selectKeptLength);
  const opening = useEditorStore((state) => state.opening);
  const openError = useEditorStore((state) => state.openError);
  const timeline = useEditorStore((state) => state.timeline);
  const job = useEditorStore((state) => state.job);
  const submitting = useEditorStore((state) => state.submitting);
  const submitError = useEditorStore((state) => state.submitError);
  const canUndo = useEditorStore((state) => selectHistory(state).past.length > 0);
  const canRedo = useEditorStore((state) => selectHistory(state).future.length > 0);
  const anyHistory = useEditorStore(selectAnyHistory);
  // The finished export, opened by whatever the system hands it to. A failure
  // is said beside the button, and forgotten when the next export replaces the
  // file.
  const result = useFileActions(job.status === 'completed' ? job.outputPath : null);

  const openPath = useEditorStore((state) => state.open);
  const activate = useEditorStore((state) => state.activate);
  const closeClip = useEditorStore((state) => state.closeClip);
  const closeAll = useEditorStore((state) => state.closeAll);
  const split = useEditorStore((state) => state.split);
  const removeCut = useEditorStore((state) => state.remove);
  const dragEdge = useEditorStore((state) => state.drag);
  const beginGesture = useEditorStore((state) => state.beginGesture);
  const endGesture = useEditorStore((state) => state.endGesture);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const loadKeyframes = useEditorStore((state) => state.loadKeyframes);
  const startExport = useEditorStore((state) => state.startExport);
  const cancelExport = useEditorStore((state) => state.cancelExport);

  const ffmpeg = useToolsStore((state) => state.tools?.ffmpeg ?? null);
  const installing = useToolsStore((state) => state.installing.ffmpeg);
  const installTool = useToolsStore((state) => state.install);
  const ffmpegReady = ffmpeg?.available ?? false;

  const hardware = settings.hardwareAcceleration;

  const videoRef = useRef<HTMLVideoElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  // The dock fills this in with its own zoom, which is the only way the keys
  // the toolbar advertises can reach a scale that lives inside it.
  const zoomRef = useRef<{ by: (factor: number) => void; fit: () => void } | null>(null);
  // Where the playhead is. Not state: it moves on every frame of playback, and
  // the few things that follow it subscribe (see playhead.tsx).
  const [playhead] = useState(createPlayhead);
  const [playing, setPlaying] = useState(false);
  const [playable, setPlayable] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snapping, setSnapping] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [pickFailed, setPickFailed] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  // A recent download being opened says so on its own row, so the card's
  // button above it stands still instead of spinning as well.
  const [openingRecent, setOpeningRecent] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  // Whether the preview has to stop at 100 %, which the inspector then says.
  const [previewCapped, setPreviewCapped] = useState(false);

  // Validated against the list rather than trusted: a split replaces the piece
  // it divides, so an id held from before it would name something that is no
  // longer there -- and the Delete button would offer to remove it.
  const selected = cuts.find((cut) => cut.id === selectedId) ?? null;

  const duration = clip?.probe.durationSec ?? 0;
  const fps = clip?.probe.fps ?? null;
  const frameStep = fps && fps > 0 ? 1 / fps : 0.04;
  const running = job.status === 'running';
  const losslessMode = options?.mode === 'lossless';

  // -- opening -------------------------------------------------------------

  const pickFile = useCallback(async () => {
    setPickFailed(false);
    try {
      const selected = await open({
        multiple: true,
        filters: [{ name: t('editor.videoFiles'), extensions: VIDEO_EXTENSIONS }],
      });
      const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
      for (const path of paths) await openPath(path, hardware);
    } catch {
      // Only the picker can land here -- opening reports its own failures. What
      // it rejects with is a bare sentence in English, so the editor says it in
      // its own words instead.
      setPickFailed(true);
    }
  }, [hardware, openPath, t]);

  // Stable, for the memoised children they are handed to.
  const addClip = useCallback(() => void pickFile(), [pickFile]);
  const openLink = useCallback(() => setLinkOpen(true), []);
  const closeLink = useCallback(() => setLinkOpen(false), []);
  // A clip from a link is a new attempt like a pick or a drop, so it clears a
  // picker's failure as they do: left standing, the sentence stayed under the
  // clip it had nothing to do with, and came back when that clip was closed.
  const openFetched = useCallback(
    (path: string) => {
      setPickFailed(false);
      void openPath(path, hardware);
    },
    [hardware, openPath],
  );
  // A recent download is one more way to pick, and clears a picker's failure
  // the same way.
  const openRecent = useCallback(
    async (path: string) => {
      setPickFailed(false);
      setOpeningRecent(true);
      try {
        return await openPath(path, hardware);
      } finally {
        setOpeningRecent(false);
      }
    },
    [hardware, openPath],
  );

  // A file dropped on the window arrives as an OS event, and only while this
  // screen is up: dropping one on Home has nothing to do there.
  useEffect(() => {
    const pending = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === 'over') {
        setDragging(true);
        return;
      }
      setDragging(false);
      if (event.payload.type === 'drop') {
        setPickFailed(false);
        for (const path of event.payload.paths) {
          void openPath(path, hardware);
        }
      }
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, [hardware, openPath]);

  // A new clip is a new element: the playhead, and whether the last file could
  // be decoded at all, say nothing about this one.
  //
  // Keyed on the clip's identity rather than on the object, because the object
  // is replaced when its keyframes land -- a minute into the edit on a large
  // file -- and re-running this then would quietly throw the playhead back to
  // the start and deselect the piece the user had just split off.
  //
  // The focus is here too: the transport's keys only answer when the keyboard
  // is aimed at the editor, and a clip opened from the sidebar or the Home
  // screen would otherwise leave it aimed somewhere else.
  useLayoutEffect(() => {
  }, [opening, clip]);

  const clipId = clip?.id ?? null;
  useEffect(() => {
    playhead.set(0);
    setPlaying(false);
    setPlayable(true);
    setSelectedId(null);
    if (clipId) {
      surfaceRef.current?.focus();
      void loadKeyframes();
    }
  }, [clipId, loadKeyframes, playhead]);

  // -- the playhead --------------------------------------------------------

  const seek = useCallback(
    (seconds: number) => {
      const bounded = Math.max(0, seconds);
      playhead.set(bounded);
      const video = videoRef.current;
      // A file that never decoded still has a timeline; only the picture is
      // missing, so a failed seek must not take the marks down with it.
      if (video && Number.isFinite(bounded)) {
        try {
          video.currentTime = bounded;
        } catch {
          // Not seekable yet. The playhead has already moved, which is what the
          // marks are read against.
        }
      }
    },
    [playhead],
  );

  // What is being watched is the film being made, not the one it came from, so
  // playback steps over the pieces that have been thrown away. Asked on every
  // position the video reports while it plays, which also catches the piece
  // under the playhead being deleted mid-play.
  const stepOver = useEffectEvent((video: HTMLVideoElement) => {
    if (video.paused || cuts.length === 0) return;
    const seconds = video.currentTime;
    if (cutAt(cuts, seconds)) return;
    const next = nextKeptPosition(cuts, seconds);
    if (next == null) {
      video.pause();
      return;
    }
    seek(next);
  });

  // `timeupdate` fires about four times a second, which is a playhead that
  // hops. While the video actually plays the position is read per frame
  // instead, and the loop stops the moment it pauses. The event is kept as
  // well, because the frame loop never runs while the window is hidden and
  // nothing in the page can detect that state.
  //
  // Every one of these goes to the playhead and to nothing else: a frame of
  // playback renders nothing in React (see playhead.tsx).
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let frame = 0;

    const report = () => {
      playhead.set(video.currentTime);
      stepOver(video);
    };
    const follow = () => {
      report();
      frame = requestAnimationFrame(follow);
    };
    const start = () => {
      setPlaying(true);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(follow);
    };
    const stop = () => {
      setPlaying(false);
      cancelAnimationFrame(frame);
      playhead.set(video.currentTime);
    };

    video.addEventListener('play', start);
    video.addEventListener('pause', stop);
    video.addEventListener('ended', stop);
    video.addEventListener('seeked', report);
    video.addEventListener('timeupdate', report);
    return () => {
      cancelAnimationFrame(frame);
      video.removeEventListener('play', start);
      video.removeEventListener('pause', stop);
      video.removeEventListener('ended', stop);
      video.removeEventListener('seeked', report);
      video.removeEventListener('timeupdate', report);
    };
  }, [clip?.id, playhead]);

  const playPause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().catch((error: unknown) => {
        // A pause that arrives before playback has started -- a second tap,
        // or the end of the kept film reached at once -- rejects the play it
        // interrupted. Right after a seek that window is as long as the
        // decoder takes, and reading it as a file that cannot play took the
        // picture away for the rest of the edit.
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setPlayable(false);
      });
    } else {
      video.pause();
    }
  }, []);

  const step = useCallback(
    (frames: number) => {
      videoRef.current?.pause();
      seek(Math.min(Math.max(playhead.get() + frames * frameStep, 0), duration));
    },
    [duration, frameStep, playhead, seek],
  );

  const markUnplayable = useCallback(() => setPlayable(false), []);
  const toggleSnapping = useCallback(() => setSnapping((value) => !value), []);

  // The position under the picture, to the frame. Kept stable so the readout's
  // subscription is not made again on every render.
  const framePosition = useCallback((seconds: number) => formatFrameTimecode(seconds, fps), [fps]);

  // -- what the timeline is drawn from -------------------------------------

  const tokenRef = useRef(0);
  const lastRequestRef = useRef<string | null>(null);
  const requestTimeline = useCallback(
    (startSec: number, lengthSec: number) => {
      if (!clip || !ffmpegReady) return;
      // The whole file, unless the window has been zoomed past what a
      // whole-file pass can resolve: 4000 buckets over an hour is a bucket
      // every 0.9 s, which is plenty across a whole track and useless inside a
      // twenty-second window.
      const windowed = lengthSec > 0 && lengthSec < duration / 8;
      // Panning across a whole-file view asks for the same bytes it is already
      // showing, and asking again is not free: a new token supersedes the work
      // in flight, which blanks both tracks before three ffprobes run to draw
      // exactly what was there. Three decimals is the precision the cache on
      // the other side keys on, so two windows that match here really do agree.
      const key = windowed
        ? `${clip.id}|${startSec.toFixed(3)}|${lengthSec.toFixed(3)}`
        : `${clip.id}|all`;
      if (key === lastRequestRef.current) return;
      lastRequestRef.current = key;
      tokenRef.current += 1;
      const token = tokenRef.current;
      // A window that was never really asked for must not count as the one on
      // screen, or the next gesture back to it would be skipped as a repeat.
      const forget = () => {
        if (lastRequestRef.current === key) lastRequestRef.current = null;
      };
      const base = {
        path: clip.path,
        startSec: windowed ? startSec : null,
        lengthSec: windowed ? lengthSec : null,
        token,
      };
      void ipc
        .requestTimeline({
          ...base,
          kind: 'waveform',
          count: WAVEFORM_BUCKETS,
          cellHeight: null,
        })
        .catch(forget);
      void ipc
        .requestTimeline({
          ...base,
          kind: 'filmstrip',
          count: FILMSTRIP_CELLS,
          cellHeight: FILMSTRIP_CELL_HEIGHT,
        })
        .catch(forget);
    },
    [clip, duration, ffmpegReady],
  );

  // A split leaves the playhead between two new pieces. The one it opens is
  // the one the user is about to work on, so that is the one that is selected;
  // leaving nothing selected would mean reaching for the piece by hand before
  // Delete could mean anything.
  const splitHere = useCallback(() => {
    const at = playhead.get();
    split(at);
    const next = selectCuts(useEditorStore.getState());
    setSelectedId((next.find((cut) => cut.startSec === at) ?? cutAt(next, at))?.id ?? null);
  }, [playhead, split]);

  const deleteSelected = useCallback(() => {
    if (!selected) return;
    removeCut(selected.id);
    setSelectedId(null);
  }, [removeCut, selected]);

  // -- the keyboard --------------------------------------------------------
  //
  // Heard on the window, in the capture phase, for as long as a clip is open
  // and this screen is the one showing. The window, because focus does not stay
  // on the editor: whatever held it -- a dialog, a menu, a piece just deleted
  // -- hands it to the body when it goes, and a key map bound to the surface
  // went deaf until the user clicked back in. The capture phase, so the editor
  // hears a key before the app's own accelerators do and can keep two of them
  // from pulling the user off this screen mid-edit: Ctrl+V and Ctrl+Enter both
  // navigate Home.
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (!clip || event.defaultPrevented || event.isComposing) return;

    const target = event.target instanceof Element ? event.target : null;
    const take = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    const key = event.key;
    const control = event.ctrlKey || event.metaKey;

    // Held back wherever it was pressed, a field or the link sheet included:
    // the app's accelerator for a download would take this whole screen away.
    if (control && key === 'Enter') {
      take();
      return;
    }

    // A dialog, or a menu that is open, has the keyboard to itself -- all but
    // Ctrl+V, which outside a field is the app's accelerator for Home and would
    // take the screen away from under the dialog.
    if (document.querySelector(OVERLAY)) {
      if (control && key.toLowerCase() === 'v' && !isTextField(target)) event.stopPropagation();
      return;
    }

    if (control) {
      // The rest are the screen's from anywhere on it -- a menu's button, the
      // slider just let go of, the body -- except a text field, where Ctrl+Z
      // and Ctrl+V belong to the text being typed.
      if (isTextField(target)) return;
      switch (key.toLowerCase()) {
        case 'z':
          take();
          if (event.shiftKey) redo();
          else undo();
          break;
        case 'y':
          take();
          redo();
          break;
        case 'b':
          take();
          splitHere();
          break;
        case 'v':
          take();
          setLinkOpen(true);
          break;
        case 'i':
          take();
          void pickFile();
          break;
        case 'e':
          take();
          if (!running) void startExport();
          break;
        case '0':
          take();
          zoomRef.current?.fit();
          break;
        default:
          break;
      }
      return;
    }

    // The transport's keys answer only when the keyboard is aimed at the
    // editor -- or at nothing in particular -- and never at a control with keys
    // of its own: Space opens a menu, the arrows move a slider, and Delete would
    // take the selected piece away from behind a field.
    if (target && target !== document.body && !surfaceRef.current?.contains(target)) return;
    if (hasOwnKeys(target)) return;

    switch (key) {
      case ' ':
        take();
        playPause();
        break;
      case 'ArrowLeft':
        take();
        step(event.shiftKey ? -Math.round(1 / frameStep) : -1);
        break;
      case 'ArrowRight':
        take();
        step(event.shiftKey ? Math.round(1 / frameStep) : 1);
        break;
      case 'Home':
        take();
        seek(0);
        break;
      case 'End':
        take();
        seek(duration);
        break;
      case 'i':
      case 'I':
        take();
        if (selected) dragEdge(selected.id, 'start', playhead.get());
        break;
      case 'o':
      case 'O':
        take();
        if (selected) dragEdge(selected.id, 'end', playhead.get());
        break;
      case 'Delete':
      case 'Backspace':
        take();
        deleteSelected();
        break;
      case 's':
      case 'S':
        take();
        setSnapping((value) => !value);
        break;
      case 'm':
      case 'M':
        take();
        if (videoRef.current) videoRef.current.muted = !videoRef.current.muted;
        break;
      case '+':
      case '=':
        take();
        zoomRef.current?.by(ZOOM_STEP);
        break;
      case '-':
      case '_':
        take();
        zoomRef.current?.by(1 / ZOOM_STEP);
        break;
      case 'Escape':
        take();
        setSelectedId(null);
        break;
      default:
        break;
    }
  });

  // Only while this screen is the one showing: on the way out it is still
  // mounted for as long as its exit takes, and the screen coming in owns the
  // keyboard from the moment it was asked for.
  const present = useIsPresent();
  const listening = clipId != null && present;
  useEffect(() => {
    if (!listening) return;
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [listening]);

  // Closing takes every clip and every cut with it. Worth a question only when
  // there is something to lose: a clip opened and not yet touched is no more
  // than a file the user can open again in one press, and asking about it would
  // be the kind of dialog people learn to dismiss without reading. Any clip:
  // the one on screen is not the only one that goes.
  const hasEdits = cuts.length > 1 || anyHistory || cuts[0]?.startSec !== 0;

  const requestClose = useCallback(() => {
    if (hasEdits) setDiscardOpen(true);
    else closeAll();
  }, [closeAll, hasEdits]);

  const installFfmpeg = useCallback(async () => {
    setInstallError(null);
    if (await installTool('ffmpeg')) return;
    setInstallError(useToolsStore.getState().error ?? t('error.network.message'));
  }, [installTool, t]);

  const railClips = useMemo(
    () =>
      pool.map((entry) => ({
        id: entry.id,
        name: entry.name,
        path: entry.path,
        durationSec: entry.probe.durationSec ?? 0,
      })),
    [pool],
  );

  // `language` is in the list for the words in it: `t` itself never changes,
  // so without it a language switch left "Lossless" standing in Turkish.
  const summary = useMemo(() => {
    if (!options || !clip) return '';
    const parts: string[] = [];
    const height = options.maxHeight ?? clip.probe.height;
    if (height) parts.push(`${height}p`);
    if (options.mode === 'lossless') {
      parts.push(t('editor.lossless'));
    } else {
      parts.push(prettyCodec(options.videoCodec) ?? options.videoCodec);
      // A rate the user typed is the one number they will want to see again.
      if (options.videoBitrateKbps != null) {
        parts.push(`${formatMbps(options.videoBitrateKbps, language)} Mbps`);
      }
    }
    if (options.fps) parts.push(`${options.fps} fps`);
    parts.push(options.container.toUpperCase());
    return parts.join(' · ');
  }, [clip, language, options, t]);

  const shownOpenError = pickFailed
    ? t('editor.openFailed')
    : openError
      ? errorMessage(openError)
      : null;

  const ffmpegNotice = ffmpeg != null && !ffmpegReady && (
    <div className="flex items-center gap-3 rounded-[var(--radius-card)] border border-card-edge bg-surface px-4 py-3">
      <CircleAlert size={16} aria-hidden="true" className="shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-medium text-fg">{t('convert.ffmpegRequired')}</p>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-fg-muted">
          {t('editor.ffmpegRequiredBody')}
        </p>
        {installError && (
          <InlineNotice tone="error" className="mt-1.5">
            {installError}
          </InlineNotice>
        )}
      </div>
      <Button
        size="sm"
        variant="secondary"
        loading={installing != null}
        onClick={() => void installFfmpeg()}
      >
        {installing != null ? t('settings.toolInstalling') : t('settings.toolInstall')}
      </Button>
    </div>
  );

  const linkSheet = (
    <LinkImportModal open={linkOpen} onClose={closeLink} onFetched={openFetched} />
  );

  const soundPreview = clip && sound && (
    <SoundPreview
      src={sound.previewSrc}
      videoRef={videoRef}
      clipId={clip.id}
      cuts={cuts}
      volume={options?.soundVolume ?? 1}
    />
  );

  const discardQuestion = (
    <Modal
      open={discardOpen}
      onClose={() => setDiscardOpen(false)}
      title={t('editor.discardTitle')}
      description={t('editor.discardBody')}
      closeLabel={t('common.close')}
      width={400}
      footer={
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => setDiscardOpen(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              setDiscardOpen(false);
              closeAll();
            }}
          >
            {t('editor.discardConfirm')}
          </Button>
        </div>
      }
    />
  );

  // -- nothing open --------------------------------------------------------

  if (!clip) {
    return (
      <div className="mx-auto w-full max-w-[760px] px-6 pb-12">
        <PageHeader title={t('editor.title')} />
        {ffmpegNotice && <div className="mb-5">{ffmpegNotice}</div>}

        <div
          className={cn(
            'flex flex-col items-center rounded-[var(--radius-card)] border border-card-edge px-6 py-9 text-center',
            DROP_TRANSITION,
            dragging ? 'bg-accent-soft ring-2 ring-accent' : 'bg-surface',
          )}
        >
          <FilePlus2 size={28} strokeWidth={1.5} aria-hidden="true" className="text-fg-faint" />
          <p className="mt-3 text-[14px] font-medium text-fg">{t('editor.emptyTitle')}</p>
          <p className="mt-0.5 text-[12.5px] text-fg-muted">{t('editor.emptyBody')}</p>
          <div className="mt-4 flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              loading={opening && !openingRecent}
              disabled={opening}
              onClick={addClip}
            >
              {t('editor.chooseFile')}
            </Button>
            <Button size="sm" variant="ghost" icon={<Link2 size={15} />} onClick={openLink}>
              {t('editor.linkTitle')}
            </Button>
          </div>
        </div>

        {shownOpenError && (
          <InlineNotice tone="error" className="mt-2 px-4">
            {shownOpenError}
          </InlineNotice>
        )}

        <RecentDownloads
          accepts={isEditableDownload}
          onPress={openRecent}
          rowLabel="editor.openRecent"
          disabled={opening}
          className="mt-7"
        />

        {linkSheet}
      </div>
    );
  }

  // -- editing -------------------------------------------------------------

  return (
    <motion.div
      ref={surfaceRef}
      variants={EDITOR}
      initial="initial"
      animate="animate"
      tabIndex={-1}
      className={cn(
        // Exactly the window's height and never more: App gives this route a
        // screen of `h-full` rather than `min-h-full`, so growing into it and
        // `min-h-0` together cap the workspace, and a region taller than its
        // share -- the settings column, above all -- scrolls inside itself
        // instead of growing the page and pushing the dock off the bottom.
        'flex min-h-0 flex-1 flex-col outline-none',
        DROP_TRANSITION,
        dragging && 'ring-2 ring-inset ring-accent',
      )}
    >
      {/* -- the bar --------------------------------------------------------- */}
      <div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-[var(--border)] px-4">
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <p className="truncate text-[13.5px] font-medium text-fg">{clip.name}</p>
          <span className="tabular shrink-0 text-[12px] text-fg-faint">
            {formatTimecode(keptLength)} · {formatBytes(clip.probe.sizeBytes)}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <IconButton
            size="sm"
            icon={<Undo2 size={15} />}
            label={`${t('editor.undo')} · Ctrl+Z`}
            disabled={!canUndo}
            onClick={undo}
          />
          <IconButton
            size="sm"
            icon={<Redo2 size={15} />}
            label={`${t('editor.redo')} · Ctrl+Shift+Z`}
            disabled={!canRedo}
            onClick={redo}
          />
          <span aria-hidden="true" className="mx-1 h-4 w-px bg-[var(--border)]" />
          <span className="tabular hidden text-[12px] text-fg-faint lg:inline">{summary}</span>
          {running ? (
            <Button size="sm" variant="secondary" onClick={() => void cancelExport()}>
              {t('common.cancel')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              loading={submitting}
              disabled={!ffmpegReady}
              onClick={() => void startExport()}
            >
              {t('editor.export')}
            </Button>
          )}
          <IconButton
            size="sm"
            icon={<X size={15} />}
            label={t('editor.close')}
            onClick={requestClose}
          />
        </div>
      </div>

      {/* -- the stage ------------------------------------------------------- */}
      <div className="flex min-h-0 flex-1">
        <MediaRail
          clips={railClips}
          activeId={clip.id}
          onActivate={activate}
          onRemove={closeClip}
          onAdd={addClip}
          onAddLink={openLink}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <PreviewStage
            src={clip.previewSrc}
            videoRef={videoRef}
            aspect={options?.aspect ?? 'source'}
            fit={options?.fit ?? 'fill'}
            sourceWidth={clip.probe.width}
            sourceHeight={clip.probe.height}
            // What the export will sound like, removed audio included. M still
            // mutes the element on top of this, for the preview alone.
            volume={options ? (options.mute ? 0 : options.volume) : 1}
            playable={playable}
            onUnplayable={markUnplayable}
            onCappedChange={setPreviewCapped}
            className="min-h-0 flex-1"
          />
          {soundPreview}

          <div className="flex h-7 shrink-0 items-center justify-between px-4">
            <span className="tabular text-[12px] text-fg-faint">
              <PlayheadTime playhead={playhead} format={framePosition} /> /{' '}
              {formatFrameTimecode(duration, fps)}
            </span>
            <span className="tabular text-[12px] text-fg-faint">
              {t('editor.length')} {formatFrameTimecode(keptLength, fps)}
            </span>
          </div>
        </div>

        <OutputInspector
          settings={settings}
          previewCapped={previewCapped}
          className="w-[272px] shrink-0 border-l border-[var(--border)] xl:w-[300px]"
        />
      </div>

      {/* -- the file, in time ----------------------------------------------- */}
      {/* Exactly as tall as what is in it -- 36 of tools, 24 of ruler, the two
          tracks, an added sound's lane when there is one, and the overview
          bar. A taller dock would be empty space under the waveform, which
          reads as something that failed to load. */}
      <div
        className="flex shrink-0 flex-col border-t border-[var(--border)]"
        style={{ height: 196 + (sound ? SOUND_LANE_ROOM : 0) }}
      >
        <TimelineDock
          clipId={clip.id}
          durationSec={duration}
          fps={fps}
          hasAudio={clip.probe.hasAudio}
          sound={sound}
          cuts={cuts}
          selectedId={selected?.id ?? null}
          playhead={playhead}
          playing={playing}
          snapping={snapping}
          keyframes={clip.keyframes}
          losslessMode={losslessMode}
          waveform={timeline.waveform}
          filmstrip={timeline.filmstrip}
          waveformWorking={timeline.working}
          disabled={running}
          onSeek={seek}
          onSelect={setSelectedId}
          onDragEdge={dragEdge}
          onDragEdgeStart={beginGesture}
          onDragEdgeEnd={endGesture}
          onSplit={splitHere}
          onDelete={deleteSelected}
          onToggleSnapping={toggleSnapping}
          onPlayPause={playPause}
          onStep={step}
          onViewChange={requestTimeline}
          zoomRef={zoomRef}
        />
      </div>

      {/* -- what the export said -------------------------------------------- */}
      <AnimatePresence initial={false}>
        {(running ||
          submitError ||
          shownOpenError ||
          job.status === 'failed' ||
          job.status === 'completed') && (
          <motion.div
            variants={COLLAPSE}
            initial="initial"
            animate="animate"
            exit="exit"
            className="shrink-0 overflow-hidden border-t border-[var(--border)]"
          >
            <div className="flex items-center gap-3 px-4 py-2.5">
              {/* A second file that would not open. The empty state is where
                  this is said with nothing open; with clips open it has no
                  other place, and a failed add that says nothing reads as a
                  button that did not work. Dismissed by hand, because it
                  belongs to no edit that could clear it. */}
              {shownOpenError && !running && (
                <>
                  <InlineNotice tone="error" className="flex-1">
                    {shownOpenError}
                  </InlineNotice>
                  <IconButton
                    size="sm"
                    icon={<X size={15} />}
                    label={t('common.close')}
                    onClick={() => {
                      setPickFailed(false);
                      useEditorStore.setState({ openError: null });
                    }}
                  />
                </>
              )}
              {running && <Progress value={job.percent} className="flex-1" label={t('editor.exporting')} />}

              {submitError && (
                <InlineNotice tone="error" className="flex-1">
                  {errorMessage(submitError)}
                </InlineNotice>
              )}
              {job.status === 'failed' && job.error && (
                <InlineNotice tone="error" className="flex-1">
                  {/* An export that failed for a reason with no code of its own
                      would otherwise be reported as a download that failed. */}
                  {job.error.code === 'unknown'
                    ? t('editor.exportFailed')
                    : errorMessage(job.error)}
                </InlineNotice>
              )}
              {job.status === 'completed' && job.outputPath && (
                <>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium text-fg">{t('editor.exported')}</p>
                    {/* A failed press says so where the path was: the path is
                        what it failed on, and the bar has no room for both. */}
                    {result.problem ? (
                      <p className="mt-0.5 truncate text-[12px] text-error">
                        {t(PROBLEM_TEXT[result.problem])}
                      </p>
                    ) : (
                      <p className="mt-0.5 truncate text-[12px] text-fg-muted">{job.outputPath}</p>
                    )}
                  </div>
                  <Button size="sm" variant="secondary" onClick={result.open}>
                    {t('common.open')}
                  </Button>
                  <IconButton
                    size="sm"
                    icon={<FolderOpen size={15} />}
                    label={t('downloads.showInFolder')}
                    onClick={result.reveal}
                  />
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {linkSheet}
      {discardQuestion}
    </motion.div>
  );
}
