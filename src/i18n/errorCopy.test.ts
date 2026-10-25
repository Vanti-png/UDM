/**
 * What a failure is called and what is said about it: the dictionary's words
 * for a code it knows, the backend's own for one it does not.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { AppErrorInfo } from '@/types';

import { en } from './en';
import { errorCopy, errorMessage, setLanguage } from './index';
import { tr } from './tr';

// Switching the language names it on the page, and there is no page here.
vi.stubGlobal('document', { documentElement: { lang: 'en' } });

function failure(code: string): AppErrorInfo {
  return {
    code,
    title: 'What the backend called it',
    message: 'What the backend said about it',
    technical: null,
    retryable: false,
  };
}

beforeEach(() => setLanguage('en'));

describe('errorCopy', () => {
  test('a known code is said in the dictionary’s words', () => {
    expect(errorCopy(failure('tiktokSignIn'))).toEqual({
      title: en['error.tiktokSignIn.title'],
      message: en['error.tiktokSignIn.message'],
    });
    expect(errorMessage(failure('membershipRequired'))).toBe(
      en['error.membershipRequired.message'],
    );
  });

  test('a code no dictionary knows keeps the backend’s own words', () => {
    expect(errorCopy(failure('somethingNew'))).toEqual({
      title: 'What the backend called it',
      message: 'What the backend said about it',
    });
  });

  test('speaks the chosen language', () => {
    setLanguage('tr');
    expect(errorCopy(failure('tiktokSignIn'))).toEqual({
      title: tr['error.tiktokSignIn.title'],
      message: tr['error.tiktokSignIn.message'],
    });
  });
});
