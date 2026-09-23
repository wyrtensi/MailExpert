import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { priorityFromHeaders } from './draftPriority.js';

describe('priorityFromHeaders', () => {
  it('reads X-Priority as nodemailer writes it', () => {
    assert.equal(priorityFromHeaders('Subject: x\r\nX-Priority: 1 (Highest)\r\nX-MSMail-Priority: High\r\n'), 'high');
    assert.equal(priorityFromHeaders('X-Priority: 5 (Lowest)\n'), 'low');
    assert.equal(priorityFromHeaders('X-Priority: 3\n'), 'normal');
  });

  it('falls back to Importance, then to normal', () => {
    assert.equal(priorityFromHeaders('Importance: High\n'), 'high');
    assert.equal(priorityFromHeaders('Importance: low\n'), 'low');
    assert.equal(priorityFromHeaders('Subject: no priority\n'), 'normal');
    assert.equal(priorityFromHeaders(null), 'normal');
  });
});
