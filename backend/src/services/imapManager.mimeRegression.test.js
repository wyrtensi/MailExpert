import { it, expect, vi } from 'vitest';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./messageParser.js', () => ({ parseMessage: vi.fn(), buildSnippetFromHtml: vi.fn(), snippetFromBody: vi.fn(), decodeMimeWords: vi.fn(), detectBulkFromParsedHeaders: vi.fn(), parseRawHeaders: vi.fn(), enrichParsedMetadata: vi.fn((parsed) => parsed) }));
// IMAP refreshes through the token manager (single entry point). Keep its real OAuthTokenError and
// pass accounts through unchanged unless a test scripts a refresh.
vi.mock('./oauth/tokenManager.js', async (importOriginal) => ({
  OAuthTokenError: (await importOriginal()).OAuthTokenError,
  ensureFreshOAuthAccount: vi.fn(async account => account),
}));
vi.mock('./emailSanitizer.js', () => ({ sanitizeEmail: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn() }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToActiveUsers: vi.fn() }));
vi.mock('../utils/redact.js', () => ({ redactEmail: vi.fn() }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
import { walkStructure, extractBodyFromMsg, ImapManager, evictPool } from './imapManager.js';
import { query } from './db.js';
import { EventEmitter } from 'node:events';
import { ImapFlow } from 'imapflow';
import { getConnectionPolicy } from './connectionPolicy.js';
import { resolveForConnection } from './hostValidation.js';

it('lists and downloads a live inline part with its own 7bit encoding', async () => {
  const account = { id: 'mime-live-regression', imap_host: 'imap.example.com', auth_user: 'user', auth_pass: 'test' };
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  const structure = { type: 'multipart/mixed', childNodes: [
    { part: '1', type: 'text/plain', encoding: '7bit' },
    { part: '2', type: 'image/svg+xml', id: '<logo>', encoding: '7bit', disposition: 'inline',
      dispositionParameters: { filename: 'logo.svg' } },
  ] };
  ImapFlow.mockImplementation(function () {
    const client = new EventEmitter();
    client.usable = true;
    client.connect = vi.fn(async () => {});
    client.logout = vi.fn(async () => {});
    client.close = vi.fn();
    client.getMailboxLock = vi.fn(async () => ({ release() {} }));
    client.fetch = vi.fn(async function* (_range, options) {
      yield { uid: 42, bodyStructure: options.bodyStructure ? structure : undefined,
        bodyParts: options.bodyParts ? new Map(options.bodyParts.map(part => [part, Buffer.from(part === '1' ? 'Logo attached' : svg)])) : undefined };
    });
    return client;
  });
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
  resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
  const manager = new ImapManager({ clients: new Set() });
  try {
    const body = await manager.fetchMessageBody(account, 42, 'INBOX');
    expect(body.attachments).toMatchObject([{ part: '2', filename: 'logo.svg', encoding: '7bit' }]);
    expect((await manager.fetchAttachment(account, 42, 'INBOX', '2')).toString()).toBe(svg);
  } finally { evictPool(account.id); }
});

it('does not treat an inline-image-only message as a binary text body', () => {
  const body = extractBodyFromMsg({ bodyStructure: { part: '1', type: 'image/jpeg', id: '<photo>',
    encoding: 'base64', disposition: 'inline', dispositionParameters: { filename: 'photo.jpg' } },
  bodyParts: new Map([['1', Buffer.from('/9j/4AAQ')]]) });
  expect(body.text).toBeNull();
  expect(body.attachments.map(attachment => attachment.filename)).toEqual(['photo.jpg']);
});

it('persists Sent Bcc and preserves it when a later seed has no Bcc', async () => {
  query.mockResolvedValue({ rows: [] });
  const manager = { _scheduleProviderIdBackfill: vi.fn() };
  const bcc = [{ email: 'hidden@example.com', name: '' }];
  await ImapManager.prototype.upsertSentMessageRecord.call(manager, { id: 'account' }, 'Sent', 7, { bcc });
  const [sql, params] = query.mock.calls.at(-1);
  expect(sql).toContain('bcc_addresses');
  expect(params).toContain(JSON.stringify(bcc));
  expect(sql).toContain("WHEN EXCLUDED.bcc_addresses <> '[]'::jsonb");
  expect(sql).toContain('ELSE messages.bcc_addresses END');
  await ImapManager.prototype.upsertSentMessageRecord.call(manager, { id: 'account' }, 'Sent', 7, {});
  expect(query.mock.calls.at(-1)[1].at(-1)).toBe('[]');
});
it('lists an inline photo when no HTML references it', () => {
 const image={part:'2',type:'image/jpeg',id:'<photo>',encoding:'base64',size:12,disposition:'inline',dispositionParameters:{filename:'photo.jpg'}};
 const body=extractBodyFromMsg({bodyStructure:{type:'multipart/mixed',childNodes:[{part:'1',type:'text/plain',encoding:'7bit'},image]},bodyParts:new Map([['1',Buffer.from('Photo attached')]])});
 expect(body.text).toBe('Photo attached'); expect(body.attachments).toMatchObject([{part:'2',filename:'photo.jpg',encoding:'base64',size:12}]);
});
it('lists only inline images not referenced by the whole case-insensitive CID', () => {
 const image=(part,id,name)=>({part,type:'image/png',id,disposition:'inline',dispositionParameters:{filename:name}});
 const body=extractBodyFromMsg({bodyStructure:{type:'multipart/related',childNodes:[{part:'1',type:'text/html',encoding:'7bit'},image('2','<logo-dark>','dark.png'),image('3','<logo>','logo.png')]},bodyParts:new Map([['1',Buffer.from('<img src="cid:<LOGO-DARK>">')]])});
 expect(body.attachments.map(x=>x.filename)).toEqual(['logo.png']);
});
it('lists an attached eml as one file and leaves its body out of the outer body', () => {
 const node={part:'2',type:'message/rfc822',disposition:'attachment',dispositionParameters:{filename:'forward.eml'},childNodes:[{part:'2.1',type:'text/plain'},{part:'2.2',type:'application/octet-stream',disposition:'attachment',dispositionParameters:{filename:'program.exe'}}]};
 const out={textParts:[],attachments:[],inlineImages:[]}; walkStructure({type:'multipart/mixed',childNodes:[{part:'1',type:'text/plain'},node]},out);
 expect(out.textParts.map(x=>x.part)).toEqual(['1']); expect(out.attachments).toMatchObject([{part:'2',filename:'forward.eml',type:'message/rfc822',contains:[{filename:'program.exe'}]}]);
});
it('keeps an unlabelled embedded bounce original as body content', () => {
 const out={textParts:[],attachments:[],inlineImages:[]}; walkStructure({type:'message/rfc822',childNodes:[{part:'1',type:'text/plain'}]},out);
 expect(out.textParts.map(x=>x.part)).toEqual(['1']); expect(out.attachments).toEqual([]);
});
