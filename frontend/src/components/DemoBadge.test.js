import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/DemoBadge.jsx')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: readFileSync(new URL(url), 'utf8'),
      };
    }
    return nextLoad(url, context);
  },
});

const { demoBadgeLabel } = await import('./DemoBadge.jsx');

test('returns the demo badge label only when enabled', () => {
  assert.equal(demoBadgeLabel(true), 'Demo mode');
  assert.equal(demoBadgeLabel(false), '');
});
