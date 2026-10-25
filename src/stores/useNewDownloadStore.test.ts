import { beforeEach, describe, expect, it } from 'vitest';

import { useNewDownloadStore } from './useNewDownloadStore';

const file = (url: string) => ({
  url,
  origin: 'clipboard' as const,
  source: null,
  fileName: null,
  fileSize: null,
});

describe('useNewDownloadStore', () => {
  beforeEach(() => useNewDownloadStore.setState({ pending: [] }));

  it('asks about files one at a time, in the order they came', () => {
    const { offer } = useNewDownloadStore.getState();
    offer(file('https://a.example/1.zip'));
    offer(file('https://a.example/2.zip'));
    const [first, second] = useNewDownloadStore.getState().pending;
    expect(first?.url).toBe('https://a.example/1.zip');
    expect(second?.url).toBe('https://a.example/2.zip');
    expect(first?.id).not.toBe(second?.id);

    useNewDownloadStore.getState().dismiss(first!.id);
    expect(useNewDownloadStore.getState().pending.map((waiting) => waiting.url)).toEqual([
      'https://a.example/2.zip',
    ]);
  });

  it('does not ask twice about a file already waiting', () => {
    const { offer } = useNewDownloadStore.getState();
    offer(file('https://a.example/1.zip'));
    offer({ ...file('https://a.example/1.zip'), origin: 'browser' });
    expect(useNewDownloadStore.getState().pending).toHaveLength(1);
  });
});
