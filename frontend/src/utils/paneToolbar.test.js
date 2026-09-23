import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_LABELS_FROM, PRIMARY_LABELS_FROM, toolbarLabelTier } from './paneToolbar.js';

describe('toolbarLabelTier', () => {
  it('names every button on a wide toolbar and only the everyday ones on a middle one', () => {
    assert.equal(toolbarLabelTier(ALL_LABELS_FROM, false), 'all');
    assert.equal(toolbarLabelTier(ALL_LABELS_FROM - 1, false), 'primary');
    assert.equal(toolbarLabelTier(PRIMARY_LABELS_FROM, false), 'primary');
  });

  it('keeps icons only when narrow, on a phone, or before the width is known', () => {
    assert.equal(toolbarLabelTier(PRIMARY_LABELS_FROM - 1, false), 'none');
    assert.equal(toolbarLabelTier(1400, true), 'none');
    assert.equal(toolbarLabelTier(0, false), 'none');
  });
});
