import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach } from 'vitest';
vi.mock('./diagnosticsRing.js', () => ({ recordWsConnect: vi.fn(), recordWsDisconnect: vi.fn() }));
import { setupWebSocket } from './websocket.js';

function setup(sessionMiddleware, manager = { connectAllForUser: vi.fn().mockResolvedValue() }) {
  const wss = new EventEmitter();
  const ws = Object.assign(new EventEmitter(), {
    readyState: 1, close: vi.fn(), terminate: vi.fn(), send: vi.fn(),
  });
  setupWebSocket(wss, sessionMiddleware, manager);
  wss.emit('connection', ws, { headers: {}, session: { userId: 'u1' } });
  return { ws, manager };
}
afterEach(() => vi.restoreAllMocks());
describe('WebSocket failure recovery', () => {
  it('absorbs transport errors even while session lookup is pending', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ws } = setup(() => {});
    expect(() => ws.emit('error', new Error('ECONNRESET'))).not.toThrow();
    expect(ws.terminate).toHaveBeenCalledOnce();
  });
  it('allows the browser to retry a session-store outage', () => {
    const { ws, manager } = setup((_req, _res, next) => next(new Error('Redis unavailable')));
    expect(ws.close).toHaveBeenCalledWith(1011, 'Session unavailable');
    expect(manager.connectAllForUser).not.toHaveBeenCalled();
  });
  it('does not authenticate a socket closed during session lookup', () => {
    let finish;
    const { ws, manager } = setup((_req, _res, next) => { finish = next; });
    ws.readyState = 3;
    finish();
    expect(ws.send).not.toHaveBeenCalled();
    expect(manager.connectAllForUser).not.toHaveBeenCalled();
  });
  it('handles a database failure during account reconnect without an unhandled rejection', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ws } = setup((_req, _res, next) => next(), {
      connectAllForUser: vi.fn().mockRejectedValue(new Error('database unavailable')),
    });
    await Promise.resolve();
    expect(error).toHaveBeenCalledWith('WebSocket account reconnect failed:', 'database unavailable');
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'connected' }));
  });
});

describe('WebSocket origins', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('accepts APP_URL and APP_ALT_URLS origins and closes others', async () => {
    vi.resetModules();
    vi.stubEnv('APP_URL', 'https://mail.example.com');
    vi.stubEnv('APP_ALT_URLS', 'https://direct.example.com');
    const { setupWebSocket: setupWithOrigins } = await import('./websocket.js');
    const connect = (origin) => {
      const wss = new EventEmitter();
      const ws = Object.assign(new EventEmitter(), {
        readyState: 1, close: vi.fn(), terminate: vi.fn(), send: vi.fn(),
      });
      // Session lookup never finishes: only the origin check runs.
      setupWithOrigins(wss, () => {}, { connectAllForUser: vi.fn() });
      wss.emit('connection', ws, { headers: { origin } });
      return ws;
    };
    expect(connect('https://mail.example.com').close).not.toHaveBeenCalled();
    expect(connect('https://direct.example.com').close).not.toHaveBeenCalled();
    expect(connect('https://evil.example.com').close).toHaveBeenCalledWith(1008, 'Forbidden');
  });
});
