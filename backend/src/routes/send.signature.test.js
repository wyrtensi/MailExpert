import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/sendQueue.js', async (importOriginal) => ({
  ...(await importOriginal()),
  enqueueOutgoingSend: vi.fn(),
  existingSendJob: vi.fn(async () => null),
}));
import express from 'express';
import { imageProxyPath } from '../services/imageProxy.js';
import routes from './send.js';
import { query } from '../services/db.js';
import { enqueueOutgoingSend } from '../services/sendQueue.js';
import { wrapSignatureHtml } from '../utils/signatureWrapper.js';

const account = { id: 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1', email_address: 'me@example.com', name: 'Me', signature: '<b>Sig</b>' };
let server, base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', routes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
beforeEach(() => {
  vi.clearAllMocks();
  query.mockImplementation(async sql => ({ rows: sql.includes('FROM email_accounts') ? [account] : [{ preferences: {}, id: 'book1' }] }));
  enqueueOutgoingSend.mockResolvedValue({ job: { id: '1', status: 'queued', run_at: new Date(), payload: {} }, created: true });
});
const post = (extra = {}) => fetch(`${base}/api/mail/send`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': 'sig1' },
  body: JSON.stringify({ accountId: 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1', to: ['you@example.com'], subject: 'Test', body: '<p>Hello</p>', bodyIsHtml: true, ...extra }),
});
// The letter as the route built it for the queue.
const built = (call = 0) => enqueueOutgoingSend.mock.calls[call][0].mail.options;

describe('send signature wrapper (#432)', () => {
  it('wraps the account signature with the shared marked wrapper', async () => {
    expect((await post()).status).toBe(200);
    const mail = built();
    expect(mail.html).toContain(wrapSignatureHtml('<b>Sig</b>'));
    expect(mail.html.match(/class="mailexpert-signature"/g)).toHaveLength(1);
    expect(mail.text.match(/\n-- \n/g)).toHaveLength(1);
  });

  it('keeps ampersands and angle brackets unescaped in the text part', async () => {
    expect((await post({ body: '<p>R&amp;D a &lt; b</p>', editedSignature: '<b>R&amp;D &lt;team&gt;</b>' })).status).toBe(200);
    expect(built().text).toBe('R&D a < b\n\n-- \nR&D <team>');
  });

  it('wraps an edited signature and omits the wrapper for an empty one', async () => {
    await post({ editedSignature: '<i>Edited</i>' });
    expect(built(0).html).toContain(wrapSignatureHtml('<i>Edited</i>'));
    await post({ editedSignature: '' });
    expect(built(1).html).not.toContain('mailexpert-signature');
  });
});


describe('authenticated proxy restoration before queueing', () => {
  it('restores authentic image references in the queued letter and its undo metadata', async () => {
    const path = imageProxyPath('4d479e4f-9b21-4013-9c07-3fbc35f275b1', 'https://img.example/a.png?x=1&amp;y=2', 'u1');
    expect((await post({ body: `<img src="${path}">`, quotedBodyHtml: `<img src="${path}">` })).status).toBe(200);
    expect(built().html).not.toContain('/api/mail/messages/');
    expect(built().html).toContain('https://img.example/a.png?x=1&amp;y=2');
    const compose = enqueueOutgoingSend.mock.calls[0][0].compose;
    expect(compose.body).toContain('https://img.example/a.png?x=1&amp;y=2');
  });
});
