import { create } from 'zustand';

import * as ipc from '@/services/ipc';
import type { AppErrorInfo, AppUpdate, UpdateProgress } from '@/types';

/**
 * `ready` means the installer is staged and verified, and waits for `apply`;
 * `applying` is the moment between starting it and the app going away.
 */
export type UpdatePhase = 'idle' | 'downloading' | 'ready' | 'applying' | 'failed';

const ATTEMPT_KEY = 'ud.update.attempt';
const ATTEMPT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * The app installs without asking, so an installer that keeps failing -- a
 * declined elevation prompt, a file it cannot replace -- would close the app
 * at every launch. A build that is still on offer after its installer ran is
 * one that did not take, so by itself the app tries each build once a day.
 */
function attemptedRecently(commit: string): boolean {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(ATTEMPT_KEY) ?? 'null');
    if (typeof stored !== 'object' || stored === null) return false;
    const { commit: tried, at } = stored as { commit?: unknown; at?: unknown };
    return tried === commit && typeof at === 'number' && Date.now() - at < ATTEMPT_COOLDOWN_MS;
  } catch {
    return false;
  }
}

function rememberAttempt(commit: string) {
  try {
    localStorage.setItem(ATTEMPT_KEY, JSON.stringify({ commit, at: Date.now() }));
  } catch {
    // Without storage the guard is lost, not the update.
  }
}

interface UpdateState {
  update: AppUpdate | null;
  phase: UpdatePhase;
  progress: UpdateProgress | null;
  error: AppErrorInfo | null;
  lastCheckedAt: number;
  /** Whether a check has been answered: "up to date" is only said once one has. */
  checked: boolean;
  /**
   * This build's installer has already been run and the old build is still
   * here, so it is not run again until the user asks on the About page.
   */
  stalled: boolean;
  /**
   * Look for a newer build. An automatic check stays silent about failures --
   * being offline is no reason to interrupt anyone. A manual one throws them.
   */
  check: (manual?: boolean) => Promise<AppUpdate | null>;
  install: () => Promise<void>;
  /** Hand over to the staged installer. The app exits when it works. */
  apply: () => Promise<void>;
  setProgress: (progress: UpdateProgress) => void;
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  update: null,
  phase: 'idle',
  progress: null,
  error: null,
  lastCheckedAt: 0,
  checked: false,
  stalled: false,

  check: async (manual = false) => {
    const busy = get().phase;
    if (busy === 'downloading' || busy === 'applying') return get().update;
    set({ lastCheckedAt: Date.now() });

    let found: AppUpdate | null;
    try {
      found = await ipc.checkAppUpdate();
    } catch (caught) {
      if (manual) throw caught;
      return null;
    }

    if (!found) {
      set({ update: null, checked: true, stalled: false, phase: 'idle', error: null, progress: null });
      return null;
    }
    // Nothing asks: `DesktopUpdater` installs what is found here without a word.
    set((state) => ({
      update: found,
      checked: true,
      // Asking by hand is asking for another attempt.
      stalled: !manual && attemptedRecently(found.commit),
      // A different build replaces whatever state the previous one was in.
      ...(state.update?.commit !== found.commit
        ? { phase: 'idle' as const, error: null, progress: null }
        : {}),
    }));
    return found;
  },

  install: async () => {
    const { update, phase } = get();
    if (!update || phase === 'downloading' || phase === 'applying') return;
    // A second press has nothing to do: the file is already where it needs to be.
    if (phase === 'ready') return;
    set({ phase: 'downloading', progress: null, error: null });
    try {
      await ipc.installAppUpdate(update);
      set({ phase: 'ready' });
    } catch (caught) {
      set({ phase: 'failed', error: ipc.toAppError(caught) });
    }
  },

  apply: async () => {
    const { update, phase } = get();
    if (!update || phase !== 'ready') return;
    // Written first: once the installer is running, nothing after this line
    // can be counted on to.
    rememberAttempt(update.commit);
    set({ phase: 'applying', error: null });
    try {
      await ipc.applyAppUpdate(update);
    } catch (caught) {
      set({ phase: 'failed', error: ipc.toAppError(caught), stalled: true });
    }
  },

  setProgress: (progress) => set({ progress }),
}));
