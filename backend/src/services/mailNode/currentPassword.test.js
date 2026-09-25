import { describe, expect, it } from 'vitest';
import { currentAuthPass, noteRestoredPassword } from './currentPassword.js';

describe('currentAuthPass', () => {
  it('gives the restored password to a mail node row that still holds the one it replaced', () => {
    noteRestoredPassword('a1', 'enc:old', 'enc:new');
    expect(currentAuthPass({ id: 'a1', mail_node: true, auth_pass: 'enc:old' })).toBe('enc:new');
    expect(currentAuthPass({ id: 'a1', mail_node: true, auth_pass: 'enc:new' })).toBe('enc:new');
  });

  it('never overrides a row that is not a mail node mailbox', () => {
    noteRestoredPassword('a2', 'enc:old', 'enc:new');
    expect(currentAuthPass({ id: 'a2', mail_node: false, auth_pass: 'enc:old' })).toBe('enc:old');
    expect(currentAuthPass({ id: 'a2', auth_pass: 'enc:old' })).toBe('enc:old');
  });

  it('never overrides a row holding a password the map did not see replaced', () => {
    noteRestoredPassword('a3', 'enc:old', 'enc:new');
    // Written after the restore by some other path: the row is newer than the map.
    expect(currentAuthPass({ id: 'a3', mail_node: true, auth_pass: 'enc:other' })).toBe('enc:other');
    expect(currentAuthPass({ id: 'unknown', mail_node: true, auth_pass: 'enc:old' })).toBe('enc:old');
  });

  it('follows two restores in a row, for a row read before either', () => {
    noteRestoredPassword('a4', 'enc:first', 'enc:second');
    noteRestoredPassword('a4', 'enc:second', 'enc:third');
    for (const held of ['enc:first', 'enc:second', 'enc:third']) {
      expect(currentAuthPass({ id: 'a4', mail_node: true, auth_pass: held })).toBe('enc:third');
    }
  });
});
