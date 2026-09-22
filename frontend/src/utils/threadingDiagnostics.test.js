import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  conversationFolders,
  conversationTotal,
  hasGmailThreadNumber,
  hasReferences,
  modeKey,
  reasonKey,
} from './threadingDiagnostics.js';

describe('reasonKey', () => {
  it('maps every reason computeThreading returns to its own sentence', () => {
    assert.equal(reasonKey('gmail-thrid'), 'message.threading.reason.gmailThrid');
    assert.equal(reasonKey('new-root'), 'message.threading.reason.newRoot');
    assert.equal(reasonKey('rfc-root'), 'message.threading.reason.rfcRoot');
    assert.equal(reasonKey('rfc-ancestor'), 'message.threading.reason.rfcAncestor');
    assert.equal(reasonKey('rfc-provisional'), 'message.threading.reason.rfcProvisional');
  });

  it('reads a null or unrecognized reason as not recorded', () => {
    assert.equal(reasonKey(null), 'message.threading.reason.unknown');
    assert.equal(reasonKey(undefined), 'message.threading.reason.unknown');
    assert.equal(reasonKey('something-new'), 'message.threading.reason.unknown');
  });
});

describe('modeKey', () => {
  it('maps the mailbox thread_mode to its sentence', () => {
    assert.equal(modeKey('gmail'), 'message.threading.mode.gmail');
    assert.equal(modeKey('rfc'), 'message.threading.mode.rfc');
  });

  it('defaults an unset mode to rfc', () => {
    assert.equal(modeKey(null), 'message.threading.mode.rfc');
    assert.equal(modeKey(undefined), 'message.threading.mode.rfc');
  });
});

describe('hasGmailThreadNumber', () => {
  it('is true only when the server backfilled a provider thread id', () => {
    assert.equal(hasGmailThreadNumber({ providerThreadId: '12345' }), true);
    assert.equal(hasGmailThreadNumber({ providerThreadId: null }), false);
    assert.equal(hasGmailThreadNumber(null), false);
  });
});

describe('hasReferences', () => {
  it('is true only for a non-empty references array', () => {
    assert.equal(hasReferences({ references: ['<a@example.com>'] }), true);
    assert.equal(hasReferences({ references: [] }), false);
    assert.equal(hasReferences({ references: null }), false);
    assert.equal(hasReferences(null), false);
  });
});

describe('conversationFolders / conversationTotal', () => {
  it('reads the server-sorted folder list and total, defaulting to empty', () => {
    const diagnostics = { conversation: { total: 3, folders: [{ folder: 'INBOX', count: 2 }, { folder: 'Archive', count: 1 }] } };
    assert.deepEqual(conversationFolders(diagnostics), [{ folder: 'INBOX', count: 2 }, { folder: 'Archive', count: 1 }]);
    assert.equal(conversationTotal(diagnostics), 3);
    assert.deepEqual(conversationFolders(null), []);
    assert.equal(conversationTotal(null), 0);
  });
});
