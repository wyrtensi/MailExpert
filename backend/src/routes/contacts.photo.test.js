import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.session = { userId: 'user-1' }; next(); },
}));
vi.mock('../services/addressBooks.js', () => ({ defaultAddressBookId: vi.fn(async () => 'shared-book') }));

import express from 'express';
import contactRoutes from './contacts.js';
import { query } from '../services/db.js';

// A stored photo is served with the panel's origin, so its type comes from an allowlist of
// image types and never from the stored data: PHOTO:data:text/html from an old CardDAV contact
// must not render as a page.
describe('GET /api/contacts/photo', () => {
  let server;
  let base;
  let photo;
  beforeAll(async () => {
    const app = express();
    app.use('/api/contacts', contactRoutes);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
  beforeEach(() => {
    query.mockReset().mockImplementation(async () => ({ rows: [{ photo_data: photo }] }));
  });

  const get = () => fetch(`${base}/api/contacts/photo?email=a@example.com`);
  const b64 = (text) => Buffer.from(text).toString('base64');

  it.each([
    ['data:text/html;base64,'],
    ['data:image/svg+xml;base64,'],
    ['data:application/javascript;base64,'],
    ['data:text/html;charset=utf-8;base64,'],
  ])('serves %s as octet-stream in a sandbox', async (prefix) => {
    photo = `${prefix}${b64('<script>alert(1)</script>')}`;
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toMatch(/sandbox/);
  });

  it.each(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'IMAGE/PNG'])('keeps the image type %s', async (type) => {
    photo = `data:${type};base64,${b64('img')}`;
    const res = await get();
    expect(res.headers.get('content-type')).toBe(type.toLowerCase());
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('img');
  });
});
