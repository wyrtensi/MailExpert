import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSnoozedFolder } from './snoozedFolder.js';

describe('isSnoozedFolder', () => {
  it('knows the plain Snoozed folder and the managed Proton path, where the server refuses a snooze', () => {
    assert.equal(isSnoozedFolder('Snoozed'), true);
    assert.equal(isSnoozedFolder('Folders/Snoozed'), true);
  });
  it('knows the folder under a server namespace, whatever its delimiter or casing', () => {
    for (const folder of ['INBOX.Snoozed', 'INBOX/Snoozed', 'inbox.snoozed', 'snoozed', 'Folders.Snoozed']) {
      assert.equal(isSnoozedFolder(folder), true, folder);
    }
  });
  it('leaves every other folder alone', () => {
    for (const folder of ['INBOX', 'Folders/Snoozed2', 'Folders/Work/Snoozed', 'INBOX.Work.Snoozed', 'Archive.Snoozed', 'INBOX.Snoozed2', 'Archive', '', null, undefined]) {
      assert.equal(isSnoozedFolder(folder), false, String(folder));
    }
  });
});
