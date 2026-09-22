import { describe, expect, it } from 'vitest';
import { correspondentOf } from './senderHistory.js';

const OWN = new Set(['sales@x.example', 'help@x.example']);

describe('correspondentOf', () => {
  it('is the sender of a received letter, lowercased', () => {
    expect(correspondentOf({ from_email: ' Maya@C.example ', to_addresses: [{ email: 'sales@x.example' }] }, OWN)).toBe('maya@c.example');
  });

  it('is the first outside recipient of a letter the mailbox sent, To before Cc', () => {
    expect(correspondentOf({
      from_email: 'HELP@x.example',
      to_addresses: [{ email: 'sales@x.example' }, { name: 'Boss', email: 'Boss@c.example' }],
      cc_addresses: [{ email: 'maya@c.example' }],
    }, OWN)).toBe('boss@c.example');
    expect(correspondentOf({ from_email: 'sales@x.example', to_addresses: [], cc_addresses: [{ email: 'maya@c.example' }] }, OWN)).toBe('maya@c.example');
  });

  it('reads addresses stored as JSON text or as plain strings', () => {
    expect(correspondentOf({ from_email: 'sales@x.example', to_addresses: '[{"email":"maya@c.example"}]' }, OWN)).toBe('maya@c.example');
    expect(correspondentOf({ from_email: 'sales@x.example', to_addresses: ['maya@c.example'] }, OWN)).toBe('maya@c.example');
  });

  it('is null for a note to self or a letter without usable addresses', () => {
    expect(correspondentOf({ from_email: 'sales@x.example', to_addresses: [{ email: 'help@x.example' }] }, OWN)).toBeNull();
    expect(correspondentOf({ from_email: null, to_addresses: 'not json' }, OWN)).toBeNull();
  });
});
