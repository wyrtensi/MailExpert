import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseDemoMode } from './mode.js';

test('enables demo mode only for the literal string true', () => {
  assert.equal(parseDemoMode('true'), true);
  assert.equal(parseDemoMode(true), false);
  assert.equal(parseDemoMode('True'), false);
  assert.equal(parseDemoMode(' true '), false);
  assert.equal(parseDemoMode('false'), false);
  assert.equal(parseDemoMode(undefined), false);
});

test('passes the demo mode build argument to Vite', async () => {
  const dockerfile = await readFile(new URL('../../Dockerfile', import.meta.url), 'utf8');

  assert.match(dockerfile, /ARG VITE_DEMO_MODE/);
  assert.match(dockerfile, /ENV VITE_DEMO_MODE=\$\{VITE_DEMO_MODE:-false\}/);
});
