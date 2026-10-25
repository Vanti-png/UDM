import { create } from 'zustand';

import type { SourceContext } from '@/types';

/** One plain file waiting for the user in the New download dialog. */
export interface PendingFile {
  id: number;
  url: string;
  /** Where it came from, which the dialog says. */
  origin: 'browser' | 'clipboard';
  /** The page a captured browser download came from; null for a copied link. */
  source: SourceContext | null;
  /** The name the browser was going to save it under, when it said. */
  fileName: string | null;
  /** The size the browser was told, when it was told one. */
  fileSize: number | null;
}

interface NewDownloadState {
  /** Oldest first; the dialog shows the first. */
  pending: PendingFile[];
  /** Offer a file. One already waiting is not offered twice. */
  offer: (file: Omit<PendingFile, 'id'>) => void;
  /** The file on screen was answered; the next one, if any, takes its place. */
  dismiss: (id: number) => void;
}

let nextId = 1;

/**
 * The files the browser and the clipboard brought in, one dialog at a time.
 *
 * A queue rather than one slot: a page that starts three downloads at once
 * hands the app three files, and each is asked about in turn rather than the
 * last one replacing the others unseen.
 */
export const useNewDownloadStore = create<NewDownloadState>((set) => ({
  pending: [],

  offer: (file) =>
    set((state) =>
      state.pending.some((waiting) => waiting.url === file.url)
        ? state
        : { pending: [...state.pending, { ...file, id: nextId++ }] },
    ),

  dismiss: (id) => set((state) => ({ pending: state.pending.filter((file) => file.id !== id) })),
}));
