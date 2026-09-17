import { describe, expect, it } from 'vitest';
import { gmailProviderIds } from './providerIds.js';

describe('gmailProviderIds', () => {
  it('reads X-GM-THRID and X-GM-MSGID as imapflow returns them', () => {
    expect(gmailProviderIds({ threadId: '1778226461893543920', emailId: '1778226461893543921' }))
      .toEqual({ providerThreadId: '1778226461893543920', providerMessageId: '1778226461893543921' });
  });

  it('accepts numbers and bigints and ignores anything that is not a plain decimal id', () => {
    expect(gmailProviderIds({ threadId: 17n, emailId: 18 })).toEqual({ providerThreadId: '17', providerMessageId: '18' });
    expect(gmailProviderIds({ threadId: 'M12abc', emailId: '' })).toEqual({ providerThreadId: null, providerMessageId: null });
    expect(gmailProviderIds({ threadId: '123456789012345678901' })).toEqual({ providerThreadId: null, providerMessageId: null });
    expect(gmailProviderIds({})).toEqual({ providerThreadId: null, providerMessageId: null });
    expect(gmailProviderIds(null)).toEqual({ providerThreadId: null, providerMessageId: null });
  });
});
