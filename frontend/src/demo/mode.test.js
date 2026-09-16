import assert from 'node:assert/strict';
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
