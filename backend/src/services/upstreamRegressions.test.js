import { describe, it, expect } from 'vitest';
import { parseMessage } from './messageParser.js';
import { sanitizeEmail } from './emailSanitizer.js';
import { createPinnedLookup } from './hostValidation.js';

describe('upstream mail parsing regressions', () => {
  it('keeps CSS rules after an invert declaration without a semicolon', () => {
    const html = sanitizeEmail('<style>img{filter:invert(1)}p{color:red;}div{color:blue;}</style><p>sample</p>');
    expect(html).toContain('p{color:red;}');
    expect(html).toContain('div{color:blue;}');
    expect(html).not.toContain('invert(');
  });
  it('answers every pinned DNS lookup asynchronously', async () => {
    const lookup = createPinnedLookup(['203.0.113.1', '2001:db8::1']);
    let synchronous = true;
    const observed = [];
    const answers = [{ all: true }, { family: 4 }, { family: 5 }].map(options => new Promise(resolve => {
      lookup('imap.example.com', options, (error, address) => {
        observed.push(synchronous);
        resolve({ error, address });
      });
    }));
    synchronous = false;
    const results = await Promise.all(answers);
    expect(observed).toEqual([false, false, false]);
    expect(results[0].address).toHaveLength(2);
    expect(results[1].address).toBe('203.0.113.1');
    expect(results[2].error.code).toBe('ENOTFOUND');
  });
  it('caps display names without cutting a Unicode character or a Message-ID', async () => {
    const messageId = `<${'m'.repeat(600)}@example.com>`;
    const parsed = await parseMessage({ uid: 1, flags: [], envelope: {
      messageId, from: [{ name: 'a'.repeat(499) + '😀tail', address: 'from@example.com' }],
      sender: [{ name: 's'.repeat(550), address: 'sender@example.com' }],
    } });
    expect([...parsed.fromName]).toHaveLength(500);
    expect(parsed.fromName.endsWith('😀')).toBe(true);
    expect(parsed.senderName).toHaveLength(500);
    expect(parsed.messageId).toBe(messageId);
    expect(parsed.fromEmail).toBe('from@example.com');
  });
});
