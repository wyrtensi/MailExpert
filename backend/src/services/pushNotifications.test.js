import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() } }));
vi.mock('./db.js', () => ({ query: vi.fn() }));

process.env.VAPID_PUBLIC_KEY = 'test-public';
process.env.VAPID_PRIVATE_KEY = 'test-private';
const { default: webPush } = await import('web-push');
const { query } = await import('./db.js');
const { sendPushToActiveUsers } = await import('./pushNotifications.js');

beforeEach(() => {
  query.mockReset();
  webPush.sendNotification.mockReset();
});

// Mailboxes are shared, so new mail reaches every active user who subscribed a device.
describe('sendPushToActiveUsers', () => {
  it('notifies every device of every active user and prunes gone subscriptions', async () => {
    query
      .mockResolvedValueOnce({ rows: [
        { id: 1, endpoint: 'https://push.example.com/a', p256dh: 'k1', auth: 'a1' },
        { id: 2, endpoint: 'https://push.example.com/b', p256dh: 'k2', auth: 'a2' },
      ] })
      .mockResolvedValueOnce({ rows: [] });
    webPush.sendNotification
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }));

    await sendPushToActiveUsers({ title: 'New mail' });

    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/JOIN users u ON u\.id = s\.user_id/);
    expect(sql).toMatch(/u\.disabled_at IS NULL/);
    expect(params).toBeUndefined();
    expect(webPush.sendNotification).toHaveBeenCalledTimes(2);
    expect(webPush.sendNotification.mock.calls[0][1]).toBe(JSON.stringify({ title: 'New mail' }));
    expect(query).toHaveBeenLastCalledWith('DELETE FROM push_subscriptions WHERE id = ANY($1)', [[2]]);
  });

  it('sends nothing when nobody subscribed', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await sendPushToActiveUsers({ title: 'New mail' });
    expect(webPush.sendNotification).not.toHaveBeenCalled();
  });
});
