import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { firstFamily, fontFaceCss } from './emailFont.js';

const face = (family, cssText) => ({ type: 5, style: { getPropertyValue: (p) => (p === 'font-family' ? family : '') }, cssText });

describe('emailFont', () => {
  it('reads the first family of a font list', () => {
    assert.equal(firstFamily("'Manrope', sans-serif"), 'Manrope');
    assert.equal(firstFamily('"Noto Sans"'), 'Noto Sans');
    assert.equal(firstFamily(''), '');
  });

  it('copies only the @font-face rules of that family, and skips sheets it may not read', () => {
    const sheets = [
      { cssRules: [face('"Manrope"', '@font-face { font-family: "Manrope"; src: url(/fonts/m1.woff2); }'), face('"Lato"', 'lato'), { type: 1, cssText: 'body {}' }] },
      { get cssRules() { throw new Error('cross-origin'); } },
      { cssRules: [face('Manrope', '@font-face { font-family: Manrope; src: url(/fonts/m2.woff2); }')] },
    ];
    const css = fontFaceCss('Manrope', sheets);
    assert.match(css, /m1\.woff2/);
    assert.match(css, /m2\.woff2/);
    assert.doesNotMatch(css, /lato|body/);
    assert.equal(fontFaceCss('', sheets), '');
  });
});
