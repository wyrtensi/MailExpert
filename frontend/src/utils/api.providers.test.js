import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, CSRF_HEADER, CSRF_VALUE } from './api.js';

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const REQUEST_ID = '0b9a7f0c-2d44-4c40-8f55-1d3b4d8a9e21';
const CONNECTION_ID = '5a8b1a22-3f5d-4be0-9b8e-3c1a5f0d7e11';

let calls;
let answer;
let events;

beforeEach(() => {
  calls = [];
  events = [];
  answer = { ok: true, status: 200, json: async () => ({ ok: true }) };
  globalThis.fetch = async (url, init = {}) => { calls.push({ url, init }); return typeof answer === 'function' ? answer(url, init) : answer; };
  globalThis.window = { dispatchEvent: (event) => events.push(event.type), location: { origin: 'https://mail.example.invalid' } };
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
});

const last = () => calls.at(-1);
const bodyOf = (call) => JSON.parse(call.init.body);

describe('provider and Proton connection API', () => {
  it('addProviderAccount posts to the fixed-provider route with the attempt id as Idempotency-Key', async () => {
    const controller = new AbortController();
    await api.addProviderAccount({ provider: 'yahoo', email: 'a@yahoo.com', appPassword: 'secret-sentinel' }, { signal: controller.signal, requestId: REQUEST_ID });
    assert.equal(last().url, '/api/accounts/provider');
    assert.equal(last().init.method, 'POST');
    assert.equal(last().init.headers['Idempotency-Key'], REQUEST_ID);
    assert.equal(last().init.headers[CSRF_HEADER], CSRF_VALUE);
    assert.equal(last().init.credentials, 'include');
    assert.equal(last().init.signal, controller.signal);
    assert.deepEqual(bodyOf(last()), { provider: 'yahoo', email: 'a@yahoo.com', appPassword: 'secret-sentinel' });
    assert.equal(JSON.stringify(last().url).includes('secret-sentinel'), false);
  });

  it('addAccount sends the same header and keeps accepting the older option name', async () => {
    await api.addAccount({ provider: 'other', email_address: 'a@example.com' }, { requestId: REQUEST_ID });
    assert.equal(last().url, '/api/accounts');
    assert.equal(last().init.headers['Idempotency-Key'], REQUEST_ID);
    await api.addAccount({ provider: 'other' }, { idempotencyKey: CONNECTION_ID });
    assert.equal(last().init.headers['Idempotency-Key'], CONNECTION_ID);
    await api.addAccount({ provider: 'other' });
    assert.equal('Idempotency-Key' in last().init.headers, false);
  });

  it('startProtonConnection carries the attempt id in the body, never in a header', async () => {
    const controller = new AbortController();
    await api.startProtonConnection({ email: 'a@proton.me', password: 'secret-sentinel', requestId: REQUEST_ID }, { signal: controller.signal });
    assert.equal(last().url, '/api/accounts/proton/connect');
    assert.equal(last().init.method, 'POST');
    assert.equal(last().init.signal, controller.signal);
    assert.equal(bodyOf(last()).requestId, REQUEST_ID);
    assert.equal('Idempotency-Key' in last().init.headers, false);
    assert.equal(last().init.headers[CSRF_HEADER], CSRF_VALUE);
  });

  it('reads, continues and cancels an operation by its id', async () => {
    const controller = new AbortController();
    await api.getProtonConnection(CONNECTION_ID, { signal: controller.signal });
    assert.equal(last().url, `/api/accounts/proton/connect/${CONNECTION_ID}`);
    assert.equal(last().init.method, 'GET');
    assert.equal(last().init.signal, controller.signal);
    await api.continueProtonConnection(CONNECTION_ID, { challenge: '2fa', secret: '123456' }, { signal: controller.signal });
    assert.equal(last().url, `/api/accounts/proton/connect/${CONNECTION_ID}/continue`);
    assert.deepEqual(bodyOf(last()), { challenge: '2fa', secret: '123456' });
    await api.cancelProtonConnection(CONNECTION_ID);
    assert.equal(last().url, `/api/accounts/proton/connect/${CONNECTION_ID}/cancel`);
    assert.equal(last().init.method, 'POST');
    // Cancel is sent after the attempt's own signal was aborted, so it takes none.
    assert.equal('signal' in last().init, false);
  });

  it('encodes an operation id so it cannot change the path', async () => {
    await api.getProtonConnection('../x?y=1');
    assert.equal(last().url, '/api/accounts/proton/connect/..%2Fx%3Fy%3D1');
  });

  it('keeps the locked-screen and session handling of every request', async () => {
    answer = { ok: false, status: 423, json: async () => ({ error: 'locked', code: 'screen_locked' }) };
    await assert.rejects(api.addProviderAccount({}, { requestId: REQUEST_ID }), (err) => err.status === 423 && err.code === 'screen_locked');
    assert.ok(events.includes('mailexpert:locked'));
    answer = { ok: false, status: 401, json: async () => ({ error: 'expired' }) };
    await assert.rejects(api.getProtonConnection(CONNECTION_ID));
    assert.ok(events.includes('mailexpert:session_expired'));
  });

  it('surfaces the stable code of a refused connection', async () => {
    answer = { ok: false, status: 400, json: async () => ({ error: 'imap_auth_failed', code: 'imap_auth_failed' }) };
    await assert.rejects(api.addProviderAccount({}, { requestId: REQUEST_ID }), (err) => err.code === 'imap_auth_failed' && err.status === 400);
  });
});
