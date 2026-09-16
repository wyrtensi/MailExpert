import assert from 'node:assert/strict';
import test from 'node:test';
import { demoRequest } from '../demo/index.js';
import { createDirectApi } from './api.js';

test('demo direct API helpers resolve locally without calling fetch', async () => {
  let fetchCalls = 0;
  const direct = createDirectApi({
    demoMode: true,
    demoRequestImpl: demoRequest,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('demo helper attempted a network request');
    },
  });

  assert.equal(await direct.streamAiChat([{ role: 'user', content: 'Hello' }]), '');
  assert.deepEqual(await direct.unlock('1234'), { ok: true, demo: true });
  assert.deepEqual(await direct.savePreferencesOnExit({ theme: 'dark' }), { ok: true });
  assert.deepEqual(await direct.startMsDeviceFlow(), { disabled: true, configured: false });
  assert.deepEqual(await direct.pollMsDeviceFlow(), { disabled: true, configured: false });
  assert.deepEqual(await direct.deleteMessagesOnExit(['demo-004']), { ok: true, deleted: ['demo-004'] });

  const attachment = await direct.downloadAttachment('demo-001', '1');
  assert.equal(attachment.type, 'text/plain');
  assert.equal(await attachment.text(), 'Demo attachment: renewal order form preview.\n');
  assert.match(direct.attachmentArchiveUrl('demo-001'), /^data:application\/zip;base64,/);
  assert.match(direct.gtdPetSheetUrl('demo-pet'), /^data:image\/gif;base64,/);
  assert.equal(fetchCalls, 0);
});

test('demo shell metadata routes return safe local shapes', async () => {
  assert.deepEqual(await demoRequest('GET', '/update'), { updateAvailable: false });
  assert.deepEqual(await demoRequest('GET', '/version'), { version: '3.3.0-demo', sha: 'demo' });
});

test('production direct API helpers retain their existing network contracts', async () => {
  const calls = [];
  const direct = createDirectApi({
    demoMode: false,
    fetchImpl: async (url, init = {}) => {
      calls.push([url, init]);
      return {
        ok: true,
        json: async () => ({ ok: true }),
        blob: async () => new Blob(['production attachment'], { type: 'text/plain' }),
      };
    },
  });

  await direct.unlock('1234');
  await direct.savePreferencesOnExit({ theme: 'dark' });
  await direct.startMsDeviceFlow();
  await direct.pollMsDeviceFlow();
  await direct.deleteMessagesOnExit(['one', 'two']);
  await direct.deleteMessagesOnExit(['one']);
  assert.equal((await direct.downloadAttachment('message', '1')).type, 'text/plain');

  assert.deepEqual(calls.map(([url, init]) => [url, init.method || 'GET', Boolean(init.keepalive)]), [
    ['/api/auth/unlock', 'POST', false],
    ['/api/auth/preferences', 'PATCH', true],
    ['/oauth/microsoft/device', 'POST', false],
    ['/oauth/microsoft/device/poll', 'GET', false],
    ['/api/mail/messages/bulk-delete', 'POST', true],
    ['/api/mail/messages/one', 'DELETE', true],
    ['/api/mail/messages/message/attachments/1', 'GET', false],
  ]);
  assert.equal(direct.attachmentArchiveUrl('message'), '/api/mail/messages/message/attachments.zip');
  assert.equal(direct.gtdPetSheetUrl('pet slug'), '/api/gtd/pet/pet%20slug/sheet');
});
