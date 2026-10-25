import { motion } from 'motion/react';
import { open } from '@tauri-apps/plugin-dialog';
import {
  Check,
  FolderOpen,
  Gauge,
  Keyboard,
  Link2,
  Palette,
  SlidersHorizontal,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { BrowserLinkCard, useBridgeStatus } from '@/components/settings/BrowserLinkCard';
import { HotkeyRecorder } from '@/components/settings/HotkeyRecorder';
import { ToolCard } from '@/components/settings/ToolCard';
import { Button } from '@/components/ui/Button';
import { Dropdown } from '@/components/ui/Dropdown';
import { InlineNotice } from '@/components/ui/InlineNotice';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { Segmented } from '@/components/ui/Segmented';
import { SettingGroup, SettingRow, ToggleRow } from '@/components/ui/SettingRow';
import { Slider } from '@/components/ui/Slider';
import { TextInput } from '@/components/ui/TextInput';
import { Tooltip } from '@/components/ui/Tooltip';
import { useMomentary } from '@/hooks/useMomentary';
import { LANGUAGES, useTranslation } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { cn } from '@/lib/cn';
import { decodeQuality, encodeQuality } from '@/lib/downloadOptions';
import { formatBytes, truncateMiddle } from '@/lib/format';
import { SPRING, T } from '@/lib/motion';
import { speedLimitLabel, speedLimitOptions } from '@/lib/speedLimits';
import * as ipc from '@/services/ipc';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useToolsStore } from '@/stores/useToolsStore';
import type {
  CacheStats,
  DownloadMode,
  HotkeyAction,
  LanguageCode,
  Settings,
  ThemePreference,
  ToolKind,
} from '@/types';

export type SettingsSection =
  | 'general'
  | 'downloads'
  | 'connection'
  | 'appearance'
  | 'performance'
  | 'shortcuts'
  | 'advanced';

const ALL_SECTIONS: {
  id: SettingsSection;
  label: TranslationKey;
  summary: TranslationKey;
  icon: typeof Sparkles;
}[] = [
  { id: 'general', label: 'settings.general', summary: 'settings.generalSummary', icon: Sparkles },
  // Second, not further down: this is the only place left to switch between
  // light and dark, so it is kept where it is seen without looking for it.
  {
    id: 'appearance',
    label: 'settings.appearance',
    summary: 'settings.appearanceSummary',
    icon: Palette,
  },
  {
    id: 'downloads',
    label: 'settings.downloads',
    summary: 'settings.downloadsSummary',
    icon: FolderOpen,
  },
  {
    id: 'connection',
    label: 'settings.connection',
    summary: 'settings.connectionSummary',
    icon: Link2,
  },
  {
    id: 'performance',
    label: 'settings.performance',
    summary: 'settings.performanceSummary',
    icon: Gauge,
  },
  { id: 'shortcuts', label: 'settings.hotkeys', summary: 'settings.hotkeys', icon: Keyboard },
  {
    id: 'advanced',
    label: 'settings.advanced',
    summary: 'settings.advancedSummary',
    icon: SlidersHorizontal,
  },
];

/** Mirrors the defaults in `settings.rs`, for the per-hotkey reset button. */
const DEFAULT_HOTKEYS: Record<HotkeyAction, string> = {
  pasteUrl: 'Ctrl+V',
  download: 'Ctrl+Enter',
  openDownloads: 'Ctrl+Shift+D',
  openHistory: 'Ctrl+Shift+H',
  openSettings: 'Ctrl+,',
};

interface SettingsPageProps {
  settings: Settings;
  /**
   * The section to open at, when something elsewhere pointed here -- the
   * sections themselves are switched in place.
   */
  section?: SettingsSection | null;
}

export function SettingsPage({ settings, section: openSection }: SettingsPageProps) {
  const { t } = useTranslation();
  const update = useSettingsStore((state) => state.update);
  const reset = useSettingsStore((state) => state.reset);
  // Opened at the section asked for from the first frame, rather than at
  // General and then moved: an effect alone would show General first and
  // then slide the other in, as if the user had asked twice.
  const [section, setSection] = useState<SettingsSection>(() => openSection ?? 'general');
  useEffect(() => {
    if (openSection) setSection(openSection);
  }, [openSection]);
  const [confirmReset, setConfirmReset] = useState(false);
  const link = useBridgeStatus();

  /**
   * Which sections exist on this machine. This used to be settled once at
   * module scope; Connection cannot be, because whether it is offered depends
   * on what the backend answers.
   */
  const sections = useMemo(
    () =>
      ALL_SECTIONS.filter((candidate) => {
        // Whether the extension has a published listing decides what the
        // section OFFERS, not whether it
        // exists: hiding it outright would also hide a link that is already
        // working, which is the state every install is in before the listing
        // is approved.
        if (candidate.id === 'connection') {
          return link != null && link.supported;
        }
        return true;
      }),
    [link],
  );

  // The screen change has already brought the page in; what is animated here is
  // only a change of section after that, which the user asked for.
  const opened = useRef(false);
  useEffect(() => {
    opened.current = true;
  }, []);
  const arrive = opened.current ? { opacity: 0, y: 6 } : false;

  const content = section && (
    <motion.div
      key={section}
      initial={arrive}
      animate={{ opacity: 1, y: 0 }}
      transition={T.component}
      className="min-w-0 flex-1 space-y-6"
    >
      {section === 'general' && <GeneralSection settings={settings} update={update} />}
      {section === 'downloads' && <DownloadsSection settings={settings} update={update} />}
      {section === 'connection' && (
        <BrowserLinkCard settings={settings} update={update} initialStatus={link} />
      )}
      {section === 'appearance' && <AppearanceSection settings={settings} update={update} />}
      {section === 'performance' && <PerformanceSection settings={settings} update={update} />}
      {section === 'shortcuts' && <ShortcutsSection settings={settings} update={update} />}
      {section === 'advanced' && (
        <AdvancedSection
          settings={settings}
          update={update}
          onRequestReset={() => setConfirmReset(true)}
        />
      )}
    </motion.div>
  );

  const resetModal = (
    <Modal
      open={confirmReset}
      onClose={() => setConfirmReset(false)}
      title={t('settings.resetConfirm')}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button variant="ghost" onClick={() => setConfirmReset(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            data-autofocus
            onClick={async () => {
              await reset();
              setConfirmReset(false);
            }}
          >
            {t('settings.resetSettings')}
          </Button>
        </>
      }
    />
  );


  return (
    <div className="mx-auto w-full max-w-[840px] px-6 pb-12">
      <PageHeader title={t('settings.title')} />

      <div className="flex gap-7">
        {/* Words only. The app's own sidebar stands right beside this list, and
            a second column of icons next to the first is a lot to look at. */}
        <nav
          className="sticky top-6 flex h-fit w-[148px] shrink-0 flex-col gap-0.5"
          aria-label={t('settings.title')}
        >
          {sections.map((candidate) => {
            const active = section === candidate.id;
            return (
              <button
                key={candidate.id}
                type="button"
                onClick={() => setSection(candidate.id)}
                aria-current={active ? 'true' : undefined}
                className={cn(
                  'relative flex h-[34px] w-full items-center rounded-[8px] px-2.5 text-left text-[13px] font-medium',
                  'transition-colors duration-150 ease-out-quint',
                  active ? 'text-fg' : 'text-fg-muted hover:bg-fill hover:text-fg',
                )}
              >
                {active && (
                  <motion.span
                    layoutId="settings-active"
                    transition={SPRING.glide}
                    className="absolute inset-0 rounded-[8px] bg-fill-active"
                  />
                )}
                <span className="relative z-10 truncate">{t(candidate.label)}</span>
              </button>
            );
          })}
        </nav>

        {content}
      </div>
      {resetModal}
    </div>
  );
}

type UpdateFn = (patch: Partial<Settings>) => Promise<void>;

function GeneralSection({ settings, update }: { settings: Settings; update: UpdateFn }) {
  const { t } = useTranslation();

  return (
    <>
      <SettingGroup>
        <>
          <ToggleRow
            title={t('settings.startWithWindows')}
            description={t('settings.startWithWindowsHint')}
            checked={settings.startWithWindows}
            onChange={(value) => void update({ startWithWindows: value })}
          />
          <ToggleRow
            title={t('settings.minimizeToTray')}
            description={t('settings.minimizeToTrayHint')}
            checked={settings.minimizeToTray}
            onChange={(value) => void update({ minimizeToTray: value })}
          />
          <ToggleRow
            title={t('settings.closeToTray')}
            description={t('settings.closeToTrayHint')}
            checked={settings.closeToTray}
            onChange={(value) => void update({ closeToTray: value })}
          />
        </>
        <ToggleRow
          title={t('settings.clipboard')}
          description={t('settings.clipboardHint')}
          checked={settings.clipboardMonitoring}
          onChange={(value) => void update({ clipboardMonitoring: value })}
        />
      </SettingGroup>

      <SettingGroup title={t('settings.notifications')}>
        <ToggleRow
          title={t('settings.notifications')}
          description={t('settings.notificationsHint')}
          checked={settings.notificationsEnabled}
          onChange={(value) => void update({ notificationsEnabled: value })}
        />
        <ToggleRow
          title={t('settings.notifyComplete')}
          checked={settings.notifyOnComplete}
          disabled={!settings.notificationsEnabled}
          onChange={(value) => void update({ notifyOnComplete: value })}
        />
        <ToggleRow
          title={t('settings.notifyError')}
          checked={settings.notifyOnError}
          disabled={!settings.notificationsEnabled}
          onChange={(value) => void update({ notifyOnError: value })}
        />
      </SettingGroup>
    </>
  );
}

function DownloadsSection({ settings, update }: { settings: Settings; update: UpdateFn }) {
  const { t } = useTranslation();
  const [template, setTemplate] = useState(settings.filenameTemplate);
  const [preview, setPreview] = useState('');

  useEffect(() => setTemplate(settings.filenameTemplate), [settings.filenameTemplate]);

  // The preview comes from the same renderer the downloader uses, so what is
  // shown here is exactly the name a file will get.
  useEffect(() => {
    let active = true;
    ipc.previewFilename(template).then((value) => {
      if (active) setPreview(value);
    });
    return () => {
      active = false;
    };
  }, [template]);

  const pickFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: settings.downloadDir,
    });
    if (typeof selected === 'string') void update({ downloadDir: selected });
  };

  return (
    <>
      <SettingGroup>
        <SettingRow
          title={t('settings.downloadDir')}
          description={
            <Tooltip label={settings.downloadDir}>
              <span>{truncateMiddle(settings.downloadDir, 52)}</span>
            </Tooltip>
          }
          control={
            <Button size="sm" variant="secondary" onClick={pickFolder}>
              {t('settings.browse')}
            </Button>
          }
        />

        <SettingRow
          title={t('settings.defaultMode')}
          control={
            <div className="w-[220px]">
              <Segmented
                value={settings.defaultMode}
                options={[
                  { value: 'video', label: t('options.modeVideo') },
                  { value: 'audio', label: t('options.modeAudio') },
                ]}
                onChange={(mode) => void update({ defaultMode: mode as DownloadMode })}
                size="sm"
              />
            </div>
          }
        />

        <SettingRow
          title={t('settings.defaultQuality')}
          control={
            <div className="w-[200px]">
              <Dropdown
                value={encodeQuality(settings.defaultQuality)}
                options={[
                  { value: 'best', label: t('options.qualityBest') },
                  { value: 'auto', label: t('options.qualityAuto') },
                  { value: 'h:2160', label: '2160p' },
                  { value: 'h:1440', label: '1440p' },
                  { value: 'h:1080', label: '1080p' },
                  { value: 'h:720', label: '720p' },
                  { value: 'h:480', label: '480p' },
                  { value: 'h:360', label: '360p' },
                ]}
                onChange={(key) => void update({ defaultQuality: decodeQuality(key) })}
              />
            </div>
          }
        />

        <SettingRow
          title={t('settings.defaultContainer')}
          control={
            <div className="w-[200px]">
              <Dropdown
                value={settings.defaultContainer ?? ''}
                options={[
                  { value: '', label: t('settings.containerKeep') },
                  { value: 'mp4', label: 'MP4' },
                  { value: 'mkv', label: 'MKV' },
                  { value: 'webm', label: 'WEBM' },
                ]}
                onChange={(value) => void update({ defaultContainer: value || null })}
              />
            </div>
          }
        />

        <SettingRow
          title={t('settings.maxConcurrent')}
          description={t('settings.maxConcurrentHint')}
          control={
            <div className="w-[180px]">
              <Slider
                value={settings.maxConcurrentDownloads}
                min={1}
                max={10}
                onChange={(value) => void update({ maxConcurrentDownloads: value })}
                formatValue={(value) => String(value)}
              />
            </div>
          }
        />

        <SettingRow
          title={t('settings.connections')}
          description={t('settings.connectionsHint')}
          control={
            <div className="w-[180px]">
              <Slider
                value={settings.connectionsPerDownload}
                min={1}
                max={32}
                onChange={(value) => void update({ connectionsPerDownload: value })}
                formatValue={(value) => String(value)}
              />
            </div>
          }
        />

        <SettingRow
          title={t('settings.speedLimit')}
          description={t('settings.speedLimitHint')}
          control={
            <div className="w-[200px]">
              <Dropdown
                value={String(settings.speedLimitKbps)}
                options={speedLimitOptions(settings.speedLimitKbps).map((kbps) => ({
                  value: String(kbps),
                  label: speedLimitLabel(kbps, t('settings.speedLimitOff')),
                }))}
                onChange={(value) => void update({ speedLimitKbps: Number(value) || 0 })}
              />
            </div>
          }
        />

        <SettingRow
          title={t('settings.autoRetry')}
          description={t('settings.autoRetryHint')}
          control={
            <div className="w-[180px]">
              <Slider
                value={settings.autoRetryCount}
                min={0}
                max={10}
                onChange={(value) => void update({ autoRetryCount: value })}
                formatValue={(value) => String(value)}
              />
            </div>
          }
        />

        <SettingRow
          title={t('settings.filenameTemplate')}
          description={t('settings.filenameTemplateHint')}
          stacked
          control={
            <div className="space-y-2">
              <TextInput
                value={template}
                onChange={(event) => setTemplate(event.target.value)}
                onBlur={() => void update({ filenameTemplate: template })}
                aria-label={t('settings.filenameTemplate')}
              />
              <p className={cn('truncate text-fg-muted', 'text-[12.5px]')}>
                {t('settings.filenamePreview')}: {preview}
              </p>
            </div>
          }
        />
      </SettingGroup>
    </>
  );
}

function AppearanceSection({ settings, update }: { settings: Settings; update: UpdateFn }) {
  const { t } = useTranslation();

  return (
    <SettingGroup>
      {/* The only place the theme is switched, so it leads the section and
          says in so many words that light and dark are what it chooses between. */}
      <SettingRow
        title={t('settings.theme')}
        description={t('settings.themeHint')}
        control={
          <div className="w-[240px]">
            <Segmented
              value={settings.theme}
              options={[
                { value: 'system', label: t('settings.themeSystem') },
                { value: 'light', label: t('settings.themeLight') },
                { value: 'dark', label: t('settings.themeDark') },
              ]}
              onChange={(theme) => void update({ theme: theme as ThemePreference })}
              size="sm"
            />
          </div>
        }
      />
      <SettingRow
        title={t('settings.language')}
        control={
          <div className="w-[180px]">
            <Dropdown
              value={settings.language}
              options={LANGUAGES.map((entry) => ({ value: entry.code, label: entry.label }))}
              onChange={(language) => void update({ language: language as LanguageCode })}
            />
          </div>
        }
      />
      <ToggleRow
        title={t('settings.reduceMotion')}
        description={t('settings.reduceMotionHint')}
        checked={settings.reduceMotion}
        onChange={(value) => void update({ reduceMotion: value })}
      />
      <ToggleRow
        title={t('settings.animatedBackground')}
        description={t('settings.animatedBackgroundHint')}
        checked={settings.showAnimatedBackground}
        onChange={(value) => void update({ showAnimatedBackground: value })}
      />
    </SettingGroup>
  );
}

function PerformanceSection({ settings, update }: { settings: Settings; update: UpdateFn }) {
  const { t } = useTranslation();
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [cleared, markCleared] = useMomentary();
  const [clearError, setClearError] = useState<string | null>(null);

  const refreshStats = useCallback(() => {
    ipc.cacheStats().then(setStats).catch(() => setStats(null));
  }, []);

  useEffect(refreshStats, [refreshStats]);

  const clearCache = async () => {
    setClearError(null);
    try {
      await ipc.clearCache();
      refreshStats();
      // The usage figure a row up drops as well, but that is easy to miss, so
      // the button answers for itself.
      markCleared();
    } catch (caught) {
      setClearError(ipc.toAppError(caught).message);
    }
  };

  return (
    <SettingGroup>
      <ToggleRow
        title={t('settings.lowResource')}
        description={t('settings.lowResourceHint')}
        checked={settings.lowResourceMode}
        onChange={(value) => void update({ lowResourceMode: value })}
      />
      <ToggleRow
        title={t('settings.hardwareAcceleration')}
        description={t('settings.hardwareAccelerationHint')}
        checked={settings.hardwareAcceleration}
        onChange={(value) => void update({ hardwareAcceleration: value })}
      />
      <SettingRow
        title={t('settings.cacheLimit')}
        description={
          stats
            ? t('settings.cacheUsage', {
                used: formatBytes(stats.totalBytes),
                limit: formatBytes(settings.cacheLimitMb * 1024 * 1024),
              })
            : undefined
        }
        control={
          <div className="w-[200px]">
            <Slider
              value={settings.cacheLimitMb}
              min={32}
              max={2048}
              step={32}
              onChange={(value) => void update({ cacheLimitMb: value })}
              formatValue={(value) => `${value} MB`}
            />
          </div>
        }
      />
      <SettingRow
        title={t('settings.cacheTitle')}
        description={t('settings.cacheHint')}
        control={
          <Button
            size="sm"
            variant="secondary"
            icon={cleared ? <Check size={13} /> : <Trash2 size={13} />}
            onClick={() => void clearCache()}
          >
            {t('settings.clearCache')}
          </Button>
        }
      >
        {/* The check is for the eye; this is the same news for a screen reader. */}
        {cleared && (
          <span role="status" className="sr-only">
            {t('settings.cacheCleared')}
          </span>
        )}
        {clearError && (
          <InlineNotice tone="error" className="-mt-2 w-full">
            {clearError}
          </InlineNotice>
        )}
      </SettingRow>
    </SettingGroup>
  );
}

function ShortcutsSection({ settings, update }: { settings: Settings; update: UpdateFn }) {
  const { t } = useTranslation();
  const actions = Object.keys(DEFAULT_HOTKEYS) as HotkeyAction[];

  const findConflict = useCallback(
    (accelerator: string) => {
      const clash = actions.find((action) => settings.hotkeys[action] === accelerator);
      return clash ? t(`hotkey.${clash}` as TranslationKey) : null;
    },
    [actions, settings.hotkeys, t],
  );

  return (
    <SettingGroup>
      {actions.map((action) => (
        <SettingRow
          key={action}
          title={t(`hotkey.${action}` as TranslationKey)}
          control={
            <HotkeyRecorder
              value={settings.hotkeys[action] ?? DEFAULT_HOTKEYS[action]}
              defaultValue={DEFAULT_HOTKEYS[action]}
              findConflict={findConflict}
              onChange={(accelerator) =>
                void update({ hotkeys: { ...settings.hotkeys, [action]: accelerator } })
              }
            />
          }
        />
      ))}
    </SettingGroup>
  );
}

function AdvancedSection({
  settings,
  update,
  onRequestReset,
}: {
  settings: Settings;
  update: UpdateFn;
  onRequestReset: () => void;
}) {
  const { t } = useTranslation();
  const tools = useToolsStore((state) => state.tools);
  const installing = useToolsStore((state) => state.installing);
  const install = useToolsStore((state) => state.install);
  const checks = useToolsStore((state) => state.checks);
  const checkUpdate = useToolsStore((state) => state.checkUpdate);
  const [installErrors, setInstallErrors] = useState<Partial<Record<ToolKind, string>>>({});
  // The folder opening is its own answer; only a failure needs words, and they
  // go where the hint was, under the button that failed.
  const [logsFailed, setLogsFailed] = useState(false);

  const [proxy, setProxy] = useState(settings.proxyUrl ?? '');
  const [userAgent, setUserAgent] = useState(settings.customUserAgent ?? '');

  useEffect(() => setProxy(settings.proxyUrl ?? ''), [settings.proxyUrl]);
  useEffect(() => setUserAgent(settings.customUserAgent ?? ''), [settings.customUserAgent]);

  // A tool that installed says so itself: its row turns to the version it now
  // has. Only a failure needs words, and it gets them in the row it belongs to.
  const runInstall = async (tool: ToolKind) => {
    setInstallErrors((current) => ({ ...current, [tool]: undefined }));
    if (await install(tool)) return true;
    const message = useToolsStore.getState().error ?? t('error.network.message');
    setInstallErrors((current) => ({ ...current, [tool]: message }));
    return false;
  };

  // Asked first, fetched only when there is something newer. Once the new copy
  // is in, it is asked about again without a spinner, so the row can say it is
  // current rather than leave the user to trust that it is.
  const runUpdate = async (tool: ToolKind) => {
    setInstallErrors((current) => ({ ...current, [tool]: undefined }));
    if (!(await checkUpdate(tool))) return;
    if (await runInstall(tool)) void checkUpdate(tool, { quiet: true });
  };

  const engine = tools?.engine ?? {
    name: 'engine' as const,
    available: false,
    path: null,
    version: null,
    source: 'missing' as const,
  };
  const ffmpeg = tools?.ffmpeg ?? {
    name: 'ffmpeg' as const,
    available: false,
    path: null,
    version: null,
    source: 'missing' as const,
  };
  const jsRuntime = tools?.jsRuntime ?? {
    name: 'jsRuntime' as const,
    available: false,
    path: null,
    version: null,
    source: 'missing' as const,
  };

  return (
    <>
      <SettingGroup title={t('about.externalTools')}>
        <ToolCard
          status={engine}
          titleKey="settings.engine"
          hintKey="settings.engineHint"
          installing={installing.engine}
          installError={installErrors.engine}
          check={checks.engine}
          customPath={settings.enginePath}
          onInstall={() => void runInstall('engine')}
          onCheck={() => void runUpdate('engine')}
          onLocate={(path) => void update({ enginePath: path })}
          onResetPath={() => void update({ enginePath: null })}
        />
        <ToolCard
          status={ffmpeg}
          titleKey="settings.ffmpeg"
          hintKey="settings.ffmpegHint"
          installing={installing.ffmpeg}
          installError={installErrors.ffmpeg}
          check={checks.ffmpeg}
          customPath={settings.ffmpegPath}
          optionalNoteKey="setup.ffmpegOptional"
          onInstall={() => void runInstall('ffmpeg')}
          onCheck={() => void runUpdate('ffmpeg')}
          onLocate={(path) => void update({ ffmpegPath: path })}
          onResetPath={() => void update({ ffmpegPath: null })}
        />
        <ToolCard
          status={jsRuntime}
          titleKey="settings.jsRuntime"
          hintKey="settings.jsRuntimeHint"
          installing={installing.jsRuntime}
          installError={installErrors.jsRuntime}
          check={checks.jsRuntime}
          optionalNoteKey="settings.jsRuntimeOptional"
          optional
          onInstall={() => void runInstall('jsRuntime')}
          onCheck={() => void runUpdate('jsRuntime')}
        />
      </SettingGroup>

      <SettingGroup title={t('settings.advanced')}>
        <SettingRow
          title={t('settings.networkTimeout')}
          control={
            <div className="w-[200px]">
              <Slider
                value={settings.networkTimeoutSec}
                min={5}
                max={180}
                step={5}
                onChange={(value) => void update({ networkTimeoutSec: value })}
                formatValue={(value) => t('common.seconds', { n: value })}
              />
            </div>
          }
        />
        <SettingRow
          title={t('settings.proxy')}
          stacked
          control={
            <TextInput
              value={proxy}
              placeholder={t('settings.proxyPlaceholder')}
              onChange={(event) => setProxy(event.target.value)}
              onBlur={() => void update({ proxyUrl: proxy.trim() || null })}
              aria-label={t('settings.proxy')}
            />
          }
        />
        <SettingRow
          title={t('settings.userAgent')}
          stacked
          control={
            <TextInput
              value={userAgent}
              placeholder={t('settings.userAgentPlaceholder')}
              onChange={(event) => setUserAgent(event.target.value)}
              onBlur={() => void update({ customUserAgent: userAgent.trim() || null })}
              aria-label={t('settings.userAgent')}
            />
          }
        />
        <ToggleRow
          title={t('settings.debugLogging')}
          description={t('settings.debugLoggingHint')}
          checked={settings.debugLogging}
          onChange={(value) => void update({ debugLogging: value })}
        />
        <SettingRow
          title={t('settings.logs')}
          description={
            logsFailed ? (
              <span className="text-error">{t('file.revealFailed')}</span>
            ) : (
              t('settings.logsHint')
            )
          }
          control={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setLogsFailed(false);
                void ipc.openLogDir().catch(() => setLogsFailed(true));
              }}
            >
              {t('settings.openLogs')}
            </Button>
          }
        />
        <SettingRow
          title={t('settings.resetTitle')}
          description={t('settings.resetHint')}
          control={
            <Button size="sm" variant="danger" onClick={onRequestReset}>
              {t('settings.resetSettings')}
            </Button>
          }
        />
      </SettingGroup>
    </>
  );
}

export { DEFAULT_HOTKEYS };
