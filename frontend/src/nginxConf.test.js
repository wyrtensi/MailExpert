import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');

// Compression and HTTP/2 of the bundled nginx. The edge (Caddy) and cloudflared pass the
// upstream's Content-Encoding through, so compressing here covers every deployment shape.

test('frontend nginx compresses text responses once, for both servers', () => {
  const conf = read('frontend/nginx.conf');
  const firstServer = conf.indexOf('\nserver {');
  const head = conf.slice(0, firstServer);

  assert.match(head, /^gzip on;$/m, 'gzip must be on in the http context, above both servers');
  assert.match(head, /^gzip_vary on;$/m);
  const types = head.match(/^gzip_types (.+);$/m);
  assert.ok(types, 'gzip_types must be set');
  for (const type of ['application/json', 'application/javascript', 'text/css', 'image/svg+xml']) {
    assert.ok(types[1].split(/\s+/).includes(type), `${type} must be compressed`);
  }
  assert.ok(!types[1].includes('text/event-stream'), 'SSE must not be compressed, it would stop streaming');
  assert.ok(!/^\s*gzip off;/m.test(conf));
});

test('frontend nginx serves HTTP/2 on the TLS server only', () => {
  const conf = read('frontend/nginx.conf');
  const tls = conf.slice(conf.indexOf('listen 443 ssl;'), conf.indexOf('listen 80;'));
  assert.match(tls, /^\s*http2 on;$/m);
  const plain = conf.slice(conf.indexOf('listen 80;'));
  assert.ok(!/http2/.test(plain), 'the port 80 server sits behind an edge and stays HTTP/1.1');
});

test('native nginx example shows the same compression and HTTP/2', () => {
  const conf = read('contrib/nginx.conf');
  assert.match(conf, /^gzip on;$/m);
  assert.ok(!/gzip_types[^;]*text\/event-stream/.test(conf));
  assert.match(conf, /^#\s+http2 on;/m);
});
