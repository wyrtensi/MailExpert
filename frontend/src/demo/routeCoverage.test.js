import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { demoRequest } from './index.js';

// Guards against the crash class fixed alongside this test: an unhandled GET in demo mode used
// to fall through to a fake `{ ok: true, demo: true }` success, so a settings screen expecting
// `{ users: [...] }` (or similar) read `undefined` off it and crashed the whole app. Every GET
// path pattern api.js can call must now either have a concrete demo answer below, or be listed
// in REJECTED with the reason it legitimately has none — so a newly added endpoint with no demo
// support fails this test instead of shipping a silent crash.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_PATH = path.join(__dirname, '../utils/api.js');

// Mirrors how the pattern api.js actually calls GET with: a literal string/template passed to
// request(...) or (for the couple of calls that bypass it) demoRequestImpl(...). `${expr}`
// segments become ':param'; anything from a literal '?' onward (a query string) is dropped,
// since query params are supplied per-call below, not part of the route pattern.
function extractGetPatterns(source) {
  const re = /(?:request|demoRequestImpl)\(\s*'GET'\s*,\s*(?:'([^']*)'|`([^`]*)`)/g;
  const patterns = new Set();
  let m;
  while ((m = re.exec(source))) {
    const raw = m[1] ?? m[2];
    const normalized = raw.split(/\$\{[^}]*\}/).join(':param');
    const q = normalized.indexOf('?');
    patterns.add(q === -1 ? normalized : normalized.slice(0, q));
  }
  return patterns;
}

// pattern (as extractGetPatterns produces it) -> a concrete path, with real demo fixture ids
// substituted for every :param, to actually call.
const CONCRETE_PATH = {
  '/oauth/microsoft/device/poll': '/oauth/microsoft/device/poll',
  '/mail/messages/:param/attachments/:param': '/mail/messages/demo-001/attachments/1',
  '/mail/messages/:param/body:param': '/mail/messages/demo-001/body',
  '/auth/me': '/auth/me',
  '/auth/config': '/auth/config',
  '/auth/preferences': '/auth/preferences',
  '/auth/registration-status': '/auth/registration-status',
  '/auth/profile/recovery-email': '/auth/profile/recovery-email',
  '/totp/setup': '/totp/setup',
  '/admin/users': '/admin/users',
  '/admin/settings': '/admin/settings',
  '/admin/invites': '/admin/invites',
  '/admin/system-email': '/admin/system-email',
  '/admin/auth-events': '/admin/auth-events?limit=100&offset=0',
  '/admin/audit': '/admin/audit',
  '/admin/access-sync': '/admin/access-sync',
  '/admin/google-apps': '/admin/google-apps',
  '/admin/oidc': '/admin/oidc',
  '/auth/oidc/providers': '/auth/oidc/providers',
  '/auth/oidc/identities': '/auth/oidc/identities',
  '/accounts': '/accounts',
  '/mail-node/config': '/mail-node/config',
  '/mail-node/domains': '/mail-node/domains',
  '/mail-node/mailboxes': '/mail-node/mailboxes',
  '/accounts/:param/folders': '/accounts/demo-sales/folders',
  '/accounts/:param/aliases': '/accounts/demo-sales/aliases',
  '/mail/messages': '/mail/messages?accountId=demo-sales&folder=INBOX',
  '/mail/messages/:param': '/mail/messages/demo-001',
  '/mail/messages/:param/sender-history': '/mail/messages/demo-001/sender-history?limit=5',
  '/mail/messages/:param/conversation': '/mail/messages/demo-001/conversation',
  '/mail/messages/:param/threading': '/mail/messages/demo-001/threading',
  '/mail/resolve-message': '/mail/resolve-message?ref=demo-001',
  '/mail/thread/:param:param': '/mail/thread/demo-renewal?accountId=demo-sales',
  '/mail/unread-counts': '/mail/unread-counts',
  '/mail/mailbox-usage': '/mail/mailbox-usage?accountId=demo-sales',
  '/mail/cleanup-preview': `/mail/cleanup-preview?accountId=demo-sales&fromEmail=${encodeURIComponent('newsletter@aster.example')}`,
  '/mail/messages/:param/headers': '/mail/messages/demo-001/headers',
  '/integrations': '/integrations',
  '/integrations/status': '/integrations/status',
  '/oauth/google/known-emails': '/oauth/google/known-emails?q=archive',
  '/search': '/search?q=renewal',
  '/search/contacts': '/search/contacts?q=maya',
  '/contacts:param': '/contacts',
  '/contacts/:param': '/contacts/demo-contact-1',
  '/contacts/:param/letters:param': '/contacts/demo-contact-1/letters',
  '/rules': '/rules',
  '/block-list': '/block-list',
  '/admin/ai': '/admin/ai',
  '/ai/status': '/ai/status',
  '/admin/ai/codex/status': '/admin/ai/codex/status',
  '/mail/category-counts:param': '/mail/category-counts?accountId=demo-sales',
  '/categories/sources': '/categories/sources',
  '/gtd/sections:param': '/gtd/sections',
  '/plugins': '/plugins',
  '/todoist/status': '/todoist/status',
  '/todoist/projects': '/todoist/projects',
  '/todoist/labels': '/todoist/labels',
};

// Patterns the demo deliberately has no success answer for — it must still reject the way a
// real failed request does (never the generic fallback), and each entry says why.
const REJECTED = {
  '/auth/invite/:param': {
    path: '/auth/invite/some-invite-token',
    reason: 'public pre-login registration flow; the demo signs straight in and never renders it',
  },
  '/auth/2fa/enrollment/setup': {
    path: '/auth/2fa/enrollment/setup',
    reason: 'only valid mid-login with a pending unauthenticated session (the real server 400s '
      + 'the same way outside one); the demo is always already signed in',
    match: /No pending enrollment/,
  },
  '/auth/push/vapid-key': {
    path: '/auth/push/vapid-key',
    reason: 'the real server answers 503 when no VAPID keys are configured, and the demo never '
      + 'has any; usePushNotifications already reads the rejection as "push unavailable"',
    match: /not configured/,
  },
  '/gtd/pet/:param/meta': {
    path: '/gtd/pet/demo-pet/meta',
    reason: 'no pet is ever imported in the demo (GtdSettings’ import flow has nothing to '
      + 'upload to); this matches the real 404 for a slug with no stored pet',
    match: /Pet not found/,
  },
};

test('every GET path pattern api.js can call has an explicit demo answer', async () => {
  const source = fs.readFileSync(API_PATH, 'utf8');
  const patterns = extractGetPatterns(source);
  assert.ok(patterns.size > 40, 'sanity check: the extractor should find dozens of GET call sites in api.js');

  const covered = new Set([...Object.keys(CONCRETE_PATH), ...Object.keys(REJECTED)]);
  const missing = [...patterns].filter(p => !covered.has(p));
  assert.deepEqual(
    missing, [],
    `add a demo answer in frontend/src/demo/index.js and a table entry in this test for: ${missing.join(', ')}`,
  );

  for (const [pattern, concretePath] of Object.entries(CONCRETE_PATH)) {
    const result = await demoRequest('GET', concretePath).catch((err) => {
      throw new Error(`${pattern} (${concretePath}) should resolve in demo mode, but rejected: ${err.message}`);
    });
    assert.notDeepEqual(
      result, { ok: true, demo: true },
      `${pattern} (${concretePath}) fell through to the generic demo fallback instead of a real answer`,
    );
  }

  for (const [pattern, { path: rejectPath, reason, match }] of Object.entries(REJECTED)) {
    await assert.rejects(
      () => demoRequest('GET', rejectPath),
      match || /./,
      `${pattern} (${rejectPath}) should reject like a real failed request (${reason})`,
    );
  }
});

test('an unhandled GET in demo mode rejects instead of returning a fake success', async () => {
  await assert.rejects(
    () => demoRequest('GET', '/some/made-up/endpoint'),
    /Not available in demo mode/,
  );
});

test('a write with no demo answer still falls back to a generic success (unlike GET)', async () => {
  // The systemic fix (reject an unhandled GET) is GET-only: writes several call sites rely on
  // the old fallback behavior for actions the demo never persists (see api.demo.test.js's
  // `unlock`/`savePreferencesOnExit` coverage for the createDirectApi side of this).
  assert.deepEqual(await demoRequest('POST', '/some/made-up/write'), { ok: true, demo: true });
});

test('/auth/me answers the signed-in role (admin by default, plain user via demoUser=user)', async () => {
  const originalStorage = globalThis.localStorage;
  let stored = null;
  globalThis.localStorage = { getItem: () => stored, setItem: (_key, value) => { stored = value; } };
  try {
    const admin = await demoRequest('GET', '/auth/me');
    assert.equal(admin.user.isAdmin, true);

    stored = 'user';
    const plain = await demoRequest('GET', '/auth/me');
    assert.equal(plain.user.isAdmin, false);
  } finally {
    globalThis.localStorage = originalStorage;
  }
});
