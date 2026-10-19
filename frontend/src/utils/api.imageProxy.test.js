import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.js')) {
    const code = readFileSync(new URL(url), 'utf8');
    if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: code.replaceAll('import.meta.env', '({ MODE: "test" })') };
  }
  return nextLoad(url, context);
} });
const { api } = await import('./api.js');
const path = '/api/mail/messages/4d479e4f-9b21-4013-9c07-3fbc35f275b1/image/123.sig?u=https%3A%2F%2Fimg.example%2Fa.png%3Fx%3D1%26amp%3By%3D2';

test('sends and saves the original image references while leaving the composer payload intact', async () => {
  const originalFetch = globalThis.fetch;
  const submitted = [];
  globalThis.fetch = async (_url, options) => { submitted.push(JSON.parse(options.body)); return { ok: true, json: async () => ({}) }; };
  try {
    const data = { bodyIsHtml: true, body: `<img src="${path}">`, quotedBodyHtml: `<img src="https://panel.example${path}&amp;allow=1">`, editedSignature: '<p>signature</p>' };
    await api.post('/mail/send', data);
    await api.saveDraft(data);
    for (const sent of submitted) {
      assert.equal(sent.body, '<img src="https://img.example/a.png?x=1&amp;y=2">');
      assert.equal(sent.quotedBodyHtml, '<img src="https://img.example/a.png?x=1&amp;y=2">');
    }
    assert.match(data.body, /\/api\/mail\/messages\//);
  } finally { globalThis.fetch = originalFetch; }
});

