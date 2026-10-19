import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { emailFrameCsp, printWindowCsp, proxiedRemoteLoads } from './remoteImagePolicy.js';

// A body served with remote images blocked may load no remote image, font or media in the document
// that shows it, whatever its HTML still references (a CSS escape no server pattern recognizes).
describe('emailFrameCsp', () => {
  it('forbids remote images, fonts and media when the body was served blocked', () => {
    const policy = emailFrameCsp(true);
    assert.match(policy, /^script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; style-src 'unsafe-inline';/, 'the rest unchanged');
    assert.match(policy, /img-src 'self' data: blob:;/);
    assert.match(policy, /font-src 'self' data:;/);
    assert.match(policy, /media-src 'self' data: blob:;/);
  });

  it('leaves images to the email when they are allowed', () => {
    for (const blocked of [false, undefined]) {
      assert.equal(emailFrameCsp(blocked), "script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; style-src 'unsafe-inline';");
    }
  });
});

describe('printWindowCsp', () => {
  it('forbids scripts always and remote loads when a printed body was served blocked', () => {
    assert.equal(printWindowCsp(false), "script-src 'none'; object-src 'none'; base-uri 'none';");
    assert.match(printWindowCsp(true), /^script-src 'none'; object-src 'none'; base-uri 'none'; img-src 'self' data: blob:;/);
  });
});


describe('proxied remote loads', () => {
  it('forbids direct remote loads in the email and print documents', () => {
    for (const csp of [emailFrameCsp(false, true), printWindowCsp(false, true)]) {
      assert.match(csp, /img-src 'self' data: blob:;/);
      assert.match(csp, /font-src 'self' data:;/);
      assert.match(csp, /media-src 'self' data: blob:;/);
    }
  });
});


it('names the exact panel origin for Firefox and rejects CSP injection', () => {
  assert.match(proxiedRemoteLoads('https://panel.example'), /img-src 'self' https:\/\/panel.example data: blob:;/);
  for (const origin of ["https://panel.example; img-src *", 'https://panel.example/path', 'data:text/html,x', 'https://user:pass@panel.example']) {
    assert.equal(proxiedRemoteLoads(origin), "img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:;");
  }
});
