import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../safeFetch.js', () => ({ safeFetch: vi.fn(async () => ({ ok: true, status: 200 })) }));
const node = vi.hoisted(() => ({ cfg: null, disk: null }));
vi.mock('./mailcow.js', () => ({
  getMailNodeConfig: vi.fn(async () => node.cfg),
  getDiskStatus: vi.fn(async () => {
    if (node.disk instanceof Error) throw node.disk;
    return node.disk;
  }),
}));

import { safeFetch } from '../safeFetch.js';
import { checkMailNodeDisk } from './diskWatch.js';

const PING = 'https://hc.example.com/ping/abc';

beforeEach(() => {
  safeFetch.mockClear();
  node.cfg = { mailHost: 'mail.example.com', apiKey: 'k', quotaMb: 5120, diskPingUrl: PING };
  node.disk = { usedPercent: 40, used: '16G', total: '40G' };
});

describe('checkMailNodeDisk', () => {
  it('does nothing without a mail node', async () => {
    node.cfg = null;
    expect(await checkMailNodeDisk()).toBeNull();
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('pings success below the threshold', async () => {
    expect(await checkMailNodeDisk()).toMatchObject({ usedPercent: 40, warn: false });
    expect(safeFetch.mock.calls[0][0]).toBe(PING);
  });

  it('pings /fail at or above 85 percent', async () => {
    node.disk = { usedPercent: 85, used: '34G', total: '40G' };
    expect(await checkMailNodeDisk()).toMatchObject({ warn: true });
    expect(safeFetch.mock.calls[0][0]).toBe(`${PING}/fail`);
    expect(safeFetch.mock.calls[0][1].body).toContain('85%');
  });

  it('sends no ping when the node does not answer, so the ping service notices the silence', async () => {
    node.disk = new Error('unreachable');
    await expect(checkMailNodeDisk()).rejects.toThrow('unreachable');
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('reads the disk without pinging when no ping URL is set', async () => {
    node.cfg.diskPingUrl = null;
    expect(await checkMailNodeDisk()).toMatchObject({ usedPercent: 40 });
    expect(safeFetch).not.toHaveBeenCalled();
  });
});
