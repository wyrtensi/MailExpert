import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSnoozedFolder } from './snoozedFolder.js';

describe('isSnoozedFolder', () => {
  it('knows the plain Snoozed folder and the managed Proton path, where the server refuses a snooze', () => {
    assert.equal(isSnoozedFolder('Snoozed'), true);
    assert.equal(isSnoozedFolder('Folders/Snoozed'), true);
  });
  it('leaves every other folder alone', () => {
    for (const folder of ['INBOX', 'Folders/Snoozed2', 'Folders/Work/Snoozed', 'Archive', '', null, undefined]) {
      assert.equal(isSnoozedFolder(folder), false, String(folder));
    }
  });
});
