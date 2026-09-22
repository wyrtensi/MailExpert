import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { directionKey, hasSenderHistory, moreCount, senderSearchQuery } from './senderHistory.js';

const item = (id, direction = 'in') => ({ id, direction, subject: 's', date: '2026-09-01T00:00:00Z' });

describe('hasSenderHistory', () => {
  it('shows the block only with a correspondent and earlier letters', () => {
    assert.equal(hasSenderHistory({ correspondent: 'maya@c.example', total: 2, items: [item('a'), item('b')] }), true);
    assert.equal(hasSenderHistory({ correspondent: null, total: 0, items: [] }), false);
    assert.equal(hasSenderHistory({ correspondent: 'maya@c.example', total: 0, items: [] }), false);
    assert.equal(hasSenderHistory(null), false);
  });
});

describe('directionKey', () => {
  it('marks letters from the person and letters to them differently', () => {
    assert.equal(directionKey('in'), 'message.senderHistory.incoming');
    assert.equal(directionKey('out'), 'message.senderHistory.outgoing');
    assert.notEqual(directionKey('in'), directionKey('out'));
  });

  it('treats an unknown direction as incoming', () => {
    assert.equal(directionKey(undefined), 'message.senderHistory.incoming');
  });
});

describe('senderSearchQuery', () => {
  it('searches by the sender address', () => {
    assert.equal(senderSearchQuery(' maya@c.example '), 'from:maya@c.example');
    assert.equal(senderSearchQuery(''), '');
    assert.equal(senderSearchQuery(null), '');
  });
});

describe('moreCount', () => {
  it('counts the earlier letters beyond the short list', () => {
    assert.equal(moreCount({ total: 12, items: [item('a'), item('b'), item('c'), item('d'), item('e')] }), 7);
    assert.equal(moreCount({ total: 2, items: [item('a'), item('b')] }), 0);
    assert.equal(moreCount(null), 0);
  });
});
