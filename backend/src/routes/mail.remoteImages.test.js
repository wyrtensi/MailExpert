// Remote images blocked: the body route says whether blocking applies to the message at all
// (remoteImagesBlocked), not only whether it found something to block (hasBlockedRemoteImages),
// so the email frame can forbid remote loads outright behind the rewriting. Images are shown by
// default (utils/imageBlocking.js); blocking applies only once the user turned it on.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../index.js', () => ({
  imapManager: {
    fetchMessageBody: vi.fn(),
    noteUserActivity: vi.fn(),
    moveQueue: { serverLocation: async (m) => ({ folder: m.folder, uid: Number(m.uid) }) },
  },
}));

import express from 'express';
import mailRoutes from './mail.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';

const MESSAGE_ID = '4d479e4f-9b21-4013-9c07-3fbc35f275b1';
const PIXEL = '<p>Hi</p><img src="//tracker.example/p.gif" width="1" height="1">';
const BLOCKING = { blockRemoteImages: true };
// Nothing cached (no HTML and no text) sends the route to the mail server.
const row = (body_html, preferences = BLOCKING) => ({
  id: MESSAGE_ID, account_id: 'acc-1', uid: 42, folder: 'INBOX', user_id: 'user-1', body_html,
  body_text: body_html ? 'Hi' : null, attachments: '[]', snippet: 'Hi', preferences,
  from_email: 's@sender.example', sender_email: null, sender_name: null, eop_category: null,
});

describe('GET /api/mail/messages/:id/body and blocked remote images', () => {
  let server;
  let base;
  beforeAll(async () => {
    const app = express();
    app.use('/api/mail', mailRoutes);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => { query.mockReset(); imapManager.fetchMessageBody.mockReset(); });

  const get = async (suffix = '') => (await fetch(`${base}/api/mail/messages/${MESSAGE_ID}/body${suffix}`)).json();
  const answer = (first) => query.mockResolvedValueOnce({ rows: [first] }).mockResolvedValue({ rows: [{ id: 'acc-1' }] });

  it('blocks a protocol-relative tracking pixel in a cached body and says so', async () => {
    answer(row(PIXEL));
    const body = await get();
    expect(body.html).not.toContain('tracker.example');
    expect(body.hasBlockedRemoteImages).toBe(true);
    expect(body.remoteImagesBlocked).toBe(true);
  });

  it('blocks it in a body fetched from the server too', async () => {
    answer(row(null));
    imapManager.fetchMessageBody.mockResolvedValue({ html: PIXEL, text: 'Hi', attachments: [] });
    const body = await get();
    expect(body.html).not.toContain('tracker.example');
    expect(body.remoteImagesBlocked).toBe(true);
  });

  it('reports blocking even when nothing remote was found', async () => {
    answer(row('<p>Plain</p>'));
    const body = await get();
    expect(body.hasBlockedRemoteImages).toBe(false);
    expect(body.remoteImagesBlocked).toBe(true);
  });

  it('does not report blocking by default, when images were asked for, or from an allowed sender', async () => {
    answer(row(PIXEL, {}));
    const byDefault = await get();
    expect(byDefault.remoteImagesBlocked).toBe(false);
    expect(byDefault.html).toContain('//tracker.example/p.gif');
    answer(row(PIXEL));
    expect((await get('?remoteImages=1')).remoteImagesBlocked).toBe(false);
    answer(row(PIXEL, { ...BLOCKING, imageWhitelist: { domains: ['sender.example'] } }));
    const allowed = await get();
    expect(allowed.remoteImagesBlocked).toBe(false);
    expect(allowed.html).toContain('//tracker.example/p.gif');
  });
});
