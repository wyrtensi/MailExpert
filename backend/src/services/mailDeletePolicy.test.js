import { afterEach, describe, expect, it, vi } from 'vitest';
import { mailDeleteEnabled, MAIL_DELETE_DISABLED_CODE, sendMailDeleteDisabled } from './mailDeletePolicy.js';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('mailDeleteEnabled', () => {
  it('is on when MAIL_DELETE_ENABLED is unset or empty', () => {
    vi.stubEnv('MAIL_DELETE_ENABLED', '');
    expect(mailDeleteEnabled()).toBe(true);
  });

  it('is on for true', () => {
    vi.stubEnv('MAIL_DELETE_ENABLED', 'true');
    expect(mailDeleteEnabled()).toBe(true);
  });

  it('is off for false, case and spaces ignored', () => {
    vi.stubEnv('MAIL_DELETE_ENABLED', ' False ');
    expect(mailDeleteEnabled()).toBe(false);
  });

  it('reads the variable on every call', () => {
    vi.stubEnv('MAIL_DELETE_ENABLED', 'false');
    expect(mailDeleteEnabled()).toBe(false);
    vi.stubEnv('MAIL_DELETE_ENABLED', 'true');
    expect(mailDeleteEnabled()).toBe(true);
  });

  it('stays on for an unknown value and warns about it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('MAIL_DELETE_ENABLED', 'nope');
    expect(mailDeleteEnabled()).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('MAIL_DELETE_ENABLED'));
  });
});

describe('sendMailDeleteDisabled', () => {
  it('answers 403 with the mail_delete_disabled code', () => {
    const res = { status: vi.fn(() => res), json: vi.fn(() => res) };
    sendMailDeleteDisabled(res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: expect.any(String), code: MAIL_DELETE_DISABLED_CODE });
    expect(MAIL_DELETE_DISABLED_CODE).toBe('mail_delete_disabled');
  });
});
