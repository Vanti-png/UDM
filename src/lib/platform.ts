import { platform } from '@tauri-apps/plugin-os';

/**
 * Whether this is the Windows build, where the backend watches the clipboard
 * itself (`clipboard.rs`) and the browser extension can hand downloads over.
 * Read once: it cannot change while the app runs.
 */
export const IS_WINDOWS: boolean = (() => {
  try {
    return platform() === 'windows';
  } catch {
    return false;
  }
})();
