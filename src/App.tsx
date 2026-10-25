import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { DesktopUpdater } from '@/components/DesktopUpdater';
import { WelcomeScreen } from '@/components/WelcomeScreen';
import { NewDownloadDialog } from '@/components/downloads/NewDownloadDialog';
import { Background } from '@/components/layout/Background';
import { Sidebar, type Route } from '@/components/layout/Sidebar';
import type { UrlInputHandle } from '@/components/home/UrlInput';
import { useClipboardMonitor } from '@/hooks/useClipboardMonitor';
import { useHotkeys } from '@/hooks/useHotkeys';
import { cn } from '@/lib/cn';
import { homeFromHandoff } from '@/lib/handoff';
import { SCREEN } from '@/lib/motion';
import { IS_WINDOWS } from '@/lib/platform';
import { AboutPage } from '@/pages/AboutPage';
import { ConvertPage } from '@/pages/ConvertPage';
import { DownloadsPage } from '@/pages/DownloadsPage';
import { EditorPage } from '@/pages/EditorPage';
import { HistoryPage } from '@/pages/HistoryPage';
import { HomePage } from '@/pages/HomePage';
import { SettingsPage, type SettingsSection } from '@/pages/SettingsPage';
import * as ipc from '@/services/ipc';
import { useAnalysisStore } from '@/stores/useAnalysisStore';
import { selectConvertInFlight, useConvertStore } from '@/stores/useConvertStore';
import { useNewDownloadStore } from '@/stores/useNewDownloadStore';
import { useEditorStore } from '@/stores/useEditorStore';
import { selectInFlightCount, useQueueStore } from '@/stores/useQueueStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useToolsStore } from '@/stores/useToolsStore';
import type { Handoff, ToolsState } from '@/types';

const SIDEBAR_COLLAPSED_KEY = 'ud.sidebar.collapsed';

interface NavState {
  route: Route;
  /** The section of Settings to open at, when one was asked for. */
  section: SettingsSection | null;
}

const HOME: NavState = { route: 'home', section: null };

export function App() {
  const settings = useSettingsStore((state) => state.settings);
  const settingsLoading = useSettingsStore((state) => state.loading);
  const loadSettings = useSettingsStore((state) => state.load);
  const updateSettings = useSettingsStore((state) => state.update);
  const applyExternalSettings = useSettingsStore((state) => state.applyExternal);

  const loadQueue = useQueueStore((state) => state.load);
  const replaceQueue = useQueueStore((state) => state.replace);
  const applyProgress = useQueueStore((state) => state.applyProgress);

  const loadConversions = useConvertStore((state) => state.load);
  const replaceConversions = useConvertStore((state) => state.replace);
  const applyConvertProgress = useConvertStore((state) => state.applyProgress);

  const applyExport = useEditorStore((state) => state.applyExport);
  const applyFetch = useEditorStore((state) => state.applyFetch);
  const applyTimeline = useEditorStore((state) => state.applyTimeline);

  const tools = useToolsStore((state) => state.tools);
  const loadTools = useToolsStore((state) => state.load);
  const applyTools = useToolsStore((state) => state.apply);
  const setInstallProgress = useToolsStore((state) => state.setInstallProgress);

  const setUrl = useAnalysisStore((state) => state.setUrl);
  const analyze = useAnalysisStore((state) => state.analyze);
  const setClipboardSuggestion = useAnalysisStore((state) => state.setClipboardSuggestion);

  const [nav, setNav] = useState<NavState>(HOME);
  const route = nav.route;
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1',
  );
  const urlInputRef = useRef<UrlInputHandle | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  // Set once the welcome has been let go this session. The setting says the
  // same for good, but it is saved after the fact: a save that failed would
  // roll it back and show the welcome again under the user's hand.
  const [welcomeDone, setWelcomeDone] = useState(false);

  // A screen always opens at its top. The scroller outlives the screen inside
  // it, so without this, arriving at Downloads from halfway down History put
  // the user halfway down Downloads -- past the header, with no indication
  // that anything was above.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [route, nav.section]);

  const navigate = useCallback((next: NavState) => {
    setNav((current) =>
      current.route === next.route && current.section === next.section ? current : next,
    );
  }, []);

  const setRoute = useCallback((next: Route) => navigate({ route: next, section: null }), [navigate]);
  const setSettingsSection = useCallback(
    (section: SettingsSection | null) => navigate({ route: 'settings', section }),
    [navigate],
  );

  // A download just started is the thing to look at.
  const goToDownloads = useCallback(() => setRoute('downloads'), [setRoute]);

  // -- bootstrap -----------------------------------------------------------

  useEffect(() => {
    void loadSettings();
    void loadQueue();
    void loadConversions();
    void loadTools();
  }, [loadSettings, loadQueue, loadConversions, loadTools]);

  // Event subscriptions. Each `listen` returns an unlisten function that must
  // be awaited before it can be called, hence the promise juggling.
  useEffect(() => {
    const unlisten: Promise<() => void>[] = [
      ipc.onProgress(applyProgress),
      ipc.onQueueChanged(replaceQueue),
      ipc.onToolsChanged(applyTools),
      ipc.onToolProgress(setInstallProgress),
      ipc.onSettingsChanged(applyExternalSettings),
      ipc.onConvertChanged(replaceConversions),
      ipc.onConvertProgress(applyConvertProgress),
      ipc.onExportChanged(applyExport),
      ipc.onFetchChanged(applyFetch),
      ipc.onTimelineChanged(applyTimeline),
      ipc.onNavigate((target) => {
        if (['home', 'downloads', 'convert', 'editor', 'history', 'settings', 'about'].includes(target)) {
          setRoute(target as Route);
        }
      }),
    ];

    return () => {
      for (const promise of unlisten) void promise.then((off) => off());
    };
  }, [
    applyProgress,
    replaceQueue,
    applyTools,
    setInstallProgress,
    applyExternalSettings,
    replaceConversions,
    applyConvertProgress,
    applyExport,
    applyFetch,
    applyTimeline,
    setRoute,
  ]);

  // A download that failed only because a tool was missing is retried as soon
  // as that tool appears. The error told the user to install it; having done
  // so, they should not also have to find the task and press Retry -- and
  // before this, a restart was what seemed to fix it.
  const previousTools = useRef<ToolsState | null>(null);
  useEffect(() => {
    const before = previousTools.current;
    previousTools.current = tools;
    if (!before || !tools) return;

    const resolved = new Set<string>();
    if (!before.engine.available && tools.engine.available) resolved.add('engineMissing');
    if (!before.ffmpeg.available && tools.ffmpeg.available) resolved.add('ffmpegMissing');
    if (resolved.size === 0) return;

    for (const task of useQueueStore.getState().tasks) {
      if (task.status === 'failed' && task.error && resolved.has(task.error.code)) {
        void ipc.retryDownload(task.id).catch(() => {});
      }
    }
  }, [tools]);

  // A video handed over by the browser extension waits in the bridge's inbox
  // until the app takes it: once at start-up, for the press that launched the
  // app, and again whenever the running app is told another has come in. It
  // opens on Home, analysed, with the default options chosen: İndir in the
  // browser picks the video, and the quality, the watermark and the rest are
  // chosen here, where they always are, before anything is downloaded.
  //
  // Home holds one link at a time, so of several taken at once the last one
  // pressed is the one shown -- the press the user is looking for an answer
  // to. One pull at a time: two at once would race to fill the field. A signal
  // that comes in meanwhile is remembered and answered by one more pull when
  // this one is done.
  const settingsReady = settings != null;
  const handoffPull = useRef({ busy: false, again: false });
  useEffect(() => {
    if (!settingsReady) return;
    const state = handoffPull.current;

    const show = (handoffs: Handoff[]) => {
      // A download the browser started is a file, asked about in the New
      // download dialog -- each of them, in the order they came. It leaves
      // whatever is on Home where it is.
      const offer = useNewDownloadStore.getState().offer;
      for (const captured of handoffs.filter((handoff) => handoff.kind === 'file')) {
        offer({
          url: captured.url,
          origin: 'browser',
          source: {
            pageUrl: captured.pageUrl || null,
            referer: captured.referer || null,
            origin: captured.origin || null,
            userAgent: captured.userAgent || null,
          },
          fileName: captured.fileName || null,
          fileSize: captured.fileSize ?? null,
        });
      }

      const media = handoffs.filter((handoff) => handoff.kind !== 'file');
      const latest = media[media.length - 1];
      const current = useSettingsStore.getState().settings;
      if (!latest || !current) return;
      const { url, options, context } = homeFromHandoff(latest, current);
      // Out of the welcome's way: the user has just pressed İndir and is
      // waiting on that. Aside for this session only.
      setWelcomeDone(true);
      setRoute('home');
      setUrl(url);
      void analyze(url, { ...options, outputDir: null }, context);
    };

    const pull = async () => {
      if (state.busy) {
        state.again = true;
        return;
      }
      state.busy = true;
      try {
        do {
          state.again = false;
          const handoffs = await ipc.takeHandoffs().catch((): Handoff[] => []);
          if (handoffs.length > 0) show(handoffs);
        } while (state.again);
      } finally {
        state.busy = false;
      }
    };

    // Listening first and taking second: a handoff written between the two is
    // still in the inbox when the pull reads it, where one written before the
    // listener was in place would have waited for the next press.
    const unlisten = ipc.onHandoff(() => void pull());
    void unlisten.then(
      () => pull(),
      () => pull(),
    );
    return () => {
      void unlisten.then(
        (off) => off(),
        () => {},
      );
    };
  }, [analyze, setRoute, setUrl, settingsReady]);

  // A media link on the clipboard is only offered, under the empty field on
  // Home. It takes the user nowhere: they may be in the middle of something
  // else. On Windows the backend watches the clipboard as links are copied
  // (`clipboard.rs`), so the window's own look when it regains focus is left
  // to the other platforms.
  const clipboardOn = settings?.clipboardMonitoring ?? false;
  useClipboardMonitor(clipboardOn && !IS_WINDOWS, setClipboardSuggestion);

  // A file link copied elsewhere is what a download manager is for: the
  // backend has already brought the window forward, and the New download
  // dialog asks about it. Anything else is offered on Home, as above.
  useEffect(() => {
    if (!IS_WINDOWS) return;
    const unlisten = ipc.onClipboardCopied((link) => {
      if (!useSettingsStore.getState().settings?.clipboardMonitoring) return;
      if (link.file) {
        useNewDownloadStore.getState().offer({
          url: link.url,
          origin: 'clipboard',
          source: null,
          fileName: null,
          fileSize: null,
        });
      } else {
        setClipboardSuggestion(link.url);
      }
    });
    return () => {
      void unlisten.then(
        (off) => off(),
        () => {},
      );
    };
  }, [setClipboardSuggestion]);

  // Turning the setting off takes the standing offer away with it, instead of
  // leaving a live one on Home for a feature that is no longer on.
  useEffect(() => {
    if (!clipboardOn) setClipboardSuggestion(null);
  }, [clipboardOn, setClipboardSuggestion]);

  const hotkeyHandlers = useMemo(
    () => ({
      pasteUrl: () => {
        setRoute('home');
        window.setTimeout(() => urlInputRef.current?.focus(), 40);
      },
      download: () => {
        // Handled by the Home screen's own Enter binding when a result is on
        // screen; from anywhere else, the useful action is to focus the field.
        setRoute('home');
        window.setTimeout(() => urlInputRef.current?.focus(), 40);
      },
      openDownloads: () => setRoute('downloads'),
      openHistory: () => setRoute('history'),
      openSettings: () => setRoute('settings'),
    }),
    [setRoute],
  );

  useHotkeys(settings?.hotkeys ?? ({} as never), hotkeyHandlers);

  // Counts, not lists: a count that has not changed does not re-render.
  const inFlight = useQueueStore((state) => selectInFlightCount(state.tasks));
  const converting = useConvertStore((state) => selectConvertInFlight(state.jobs));

  const toggleCollapsed = () => {
    setCollapsed((value) => {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, value ? '0' : '1');
      return !value;
    });
  };

  if (settingsLoading || !settings) {
    // Settings gate the theme, so painting before they land would flash the
    // wrong colours. This is a single frame in practice.
    return <div className="h-full bg-bg" />;
  }

  if (!settings.onboardingComplete && !welcomeDone) {
    return (
      <WelcomeScreen
        onStart={() => {
          setWelcomeDone(true);
          void updateSettings({ onboardingComplete: true });
        }}
      />
    );
  }

  // The glow stands still (see Background), so reduced motion has no say in it.
  const backgroundActive = route === 'home' && !settings.lowResourceMode && settings.showAnimatedBackground;

  // Every screen is at least as tall as its scroller and scrolls past that --
  // except the editor, which is a workspace rather than a page: it is exactly
  // the scroller's height so each of its regions can scroll inside itself.
  // With only a minimum here, the editor's height was its content's, and a tall
  // settings column grew the whole screen and pushed the timeline off the
  // bottom.
  const fill = cn('flex flex-col', route === 'editor' ? 'h-full' : 'min-h-full');

  const screen = (
    <>
      {route === 'home' && (
        <HomePage
          settings={settings}
          inputRef={urlInputRef}
          onGoToDownloads={goToDownloads}
          // A section to point at opens Settings already at it.
          onOpenSettings={(section) => (section ? setSettingsSection(section) : setRoute('settings'))}
        />
      )}
      {route === 'downloads' && <DownloadsPage onGoHome={() => setRoute('home')} />}
      {route === 'convert' && <ConvertPage settings={settings} />}
      {route === 'editor' && <EditorPage settings={settings} />}
      {route === 'history' && <HistoryPage onGoHome={() => setRoute('home')} />}
      {route === 'settings' && <SettingsPage settings={settings} section={nav.section} />}
      {route === 'about' && <AboutPage />}
    </>
  );

  return (
    <div className="flex h-full overflow-clip bg-bg">
      <NewDownloadDialog onQueued={goToDownloads} />
      <Sidebar
        route={route}
        onNavigate={setRoute}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        activeCount={inFlight}
        convertingCount={converting}
      />

      <div className="relative flex min-w-0 flex-1 flex-col">
        <Background active={backgroundActive} />

        <main ref={mainRef} className="relative z-10 min-h-0 flex-1 overflow-y-auto">
          <AnimatePresence mode="wait">
            <motion.div
              key={route}
              variants={SCREEN}
              initial="initial"
              animate="animate"
              exit="exit"
              className={fill}
            >
              {screen}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>

      <DesktopUpdater />
    </div>
  );
}
