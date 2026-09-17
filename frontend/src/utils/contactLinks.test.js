import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { contactComposeAddress, contactForEmail, contactFormFromSender, websiteHref, websiteLabel } from './contactLinks.js';

describe('websiteHref', () => {
  it('opens only http(s) addresses', () => {
    assert.equal(websiteHref('https://example.com/team'), 'https://example.com/team');
    assert.equal(websiteHref('http://intranet.example.com'), 'http://intranet.example.com/');
    assert.equal(websiteHref('javascript:alert(1)'), null);
    assert.equal(websiteHref('example.com'), null);
    assert.equal(websiteHref(''), null);
  });

  it('shows a website without its scheme and trailing slash', () => {
    assert.equal(websiteLabel('https://www.example.com/'), 'www.example.com');
    assert.equal(websiteLabel('http://example.com/a/b'), 'example.com/a/b');
  });
});

describe('contactComposeAddress', () => {
  it('addresses the contact by name and primary address', () => {
    assert.equal(contactComposeAddress({ display_name: 'Maya Chen', primary_email: 'maya@example.com' }), 'Maya Chen <maya@example.com>');
    assert.equal(contactComposeAddress({ display_name: '', emails: [{ value: 'a@example.com' }] }), 'a@example.com');
    assert.equal(contactComposeAddress({ display_name: 'x <y>', primary_email: 'x@example.com' }), 'x y <x@example.com>');
    assert.equal(contactComposeAddress({ display_name: 'No mail' }), null);
  });
});

describe('contactForEmail', () => {
  const contacts = [
    { id: '1', primary_email: 'maya@example.com', emails: [{ value: 'maya@example.com' }, { value: 'maya.chen@home.example' }] },
    { id: '2', primary_email: 'maya@example.co', emails: [] },
  ];
  it('matches any of the contact\'s addresses exactly, ignoring case', () => {
    assert.equal(contactForEmail(contacts, 'MAYA.CHEN@home.example').id, '1');
    assert.equal(contactForEmail(contacts, 'maya@example.co').id, '2');
    assert.equal(contactForEmail(contacts, 'maya@example'), null);
  });
});

describe('contactFormFromSender', () => {
  it('prefills a new contact from a sender', () => {
    const form = contactFormFromSender({ email: ' noah@example.com ', name: 'Noah Williams' });
    assert.equal(form.displayName, 'Noah Williams');
    assert.deepEqual(form.emails, [{ value: 'noah@example.com', type: 'other', primary: true }]);
    assert.deepEqual(form.urls, []);
    assert.equal(contactFormFromSender({ email: 'a@example.com', name: 'a@example.com' }).displayName, '');
  });
});
