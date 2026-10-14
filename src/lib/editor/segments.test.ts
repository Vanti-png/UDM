import { describe, expect, test } from 'vitest';

import { outputPosition, soundSpans, type Cut } from '@/lib/editor/segments';

const cut = (id: string, startSec: number, endSec: number): Cut => ({ id, startSec, endSec });

/** Two pieces kept out of a 30-second file: 2-6 and 10-20. */
const kept = [cut('a', 2, 6), cut('b', 10, 20)];

describe('where the source lands in the result', () => {
  test('counts only the kept seconds ahead of it', () => {
    expect(outputPosition(kept, 2)).toBe(0);
    expect(outputPosition(kept, 4)).toBe(2);
    expect(outputPosition(kept, 12)).toBe(6);
  });

  test('a dropped stretch stands where the next piece begins', () => {
    expect(outputPosition(kept, 0)).toBe(0);
    expect(outputPosition(kept, 8)).toBe(4);
    expect(outputPosition(kept, 25)).toBe(14);
  });
});

describe('what an added sound plays under', () => {
  test('a sound runs on across the join until it runs out', () => {
    expect(soundSpans(kept, 7)).toEqual([
      { startSec: 2, endSec: 6 },
      { startSec: 10, endSec: 13 },
    ]);
  });

  test('a sound longer than the result covers every kept piece and no more', () => {
    expect(soundSpans(kept, 90)).toEqual([
      { startSec: 2, endSec: 6 },
      { startSec: 10, endSec: 20 },
    ]);
    expect(soundSpans(kept, null)).toEqual(soundSpans(kept, 90));
  });

  test('a short one ends inside the first piece', () => {
    expect(soundSpans(kept, 1.5)).toEqual([{ startSec: 2, endSec: 3.5 }]);
  });
});
