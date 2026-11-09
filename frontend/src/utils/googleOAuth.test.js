import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGoogleReconnectUrl,
  buildGoogleRedirectUri,
  isGoogleReconnectRequired,
  oauthMessageToSearchParams,
  parseOAuthResult,
} from './googleOAuth.js';

const params = (query) => new URLSearchParams(query);

describe('buildGoogleReconnectUrl', () => {
  it('names the mailbox by id and never carries its address', () => {
    assert.equal(buildGoogleReconnectUrl('22222222-2222-2222-2222-222222222222'),
      '/oauth/google?account=22222222-2222-2222-2222-222222222222');
  });

  it('encodes the id', () => {
    const url = buildGoogleReconnectUrl('a b&c');
    assert.equal(new URL(url, 'https://mail.example').searchParams.get('account'), 'a b&c');
    assert.deepEqual([...new URL(url, 'https://mail.example').searchParams.keys()], ['account']);
  });

  it('is null without an id', () => {
    for (const id of [undefined, null, '', '   ', 42]) assert.equal(buildGoogleReconnectUrl(id), null);
  });
});

describe('buildGoogleRedirectUri', () => {
  it('builds the callback from the origin', () => {
    assert.equal(buildGoogleRedirectUri({ origin: 'https://mail.example' }), 'https://mail.example/oauth/google/callback');
    assert.equal(buildGoogleRedirectUri({ origin: 'http://localhost:8080' }), 'http://localhost:8080/oauth/google/callback');
  });

  it('strips a trailing slash from the origin', () => {
    assert.equal(buildGoogleRedirectUri({ origin: 'https://mail.example/' }), 'https://mail.example/oauth/google/callback');
  });
});

describe('isGoogleReconnectRequired', () => {
  it('is true only for Google accounts flagged by the backend', () => {
    assert.equal(isGoogleReconnectRequired({ oauth_provider: 'google', oauth_reconnect_required: true }), true);
    assert.equal(isGoogleReconnectRequired({ oauth_provider: 'google', oauth_reconnect_required: false }), false);
    assert.equal(isGoogleReconnectRequired({ oauth_provider: 'google', oauth_reconnect_required: 'true' }), false);
    assert.equal(isGoogleReconnectRequired({ oauth_provider: 'microsoft', oauth_reconnect_required: true }), false);
    assert.equal(isGoogleReconnectRequired({ oauth_reconnect_required: true }), false);
    assert.equal(isGoogleReconnectRequired(null), false);
    assert.equal(isGoogleReconnectRequired(undefined), false);
  });
});

describe('parseOAuthResult', () => {
  it('returns null when no OAuth result is present', () => {
    assert.equal(parseOAuthResult(params('')), null);
    assert.equal(parseOAuthResult(params('m=123&oidc_success=linked')), null);
    assert.equal(parseOAuthResult(null), null);
    assert.equal(parseOAuthResult(undefined), null);
  });

  it('maps a created Google mailbox', () => {
    assert.deepEqual(parseOAuthResult(params('oauth_success=google&oauth_result=created')), {
      provider: 'google', status: 'success', messageKey: 'admin.integrations.google.resultCreated',
    });
  });

  it('maps an updated Google mailbox', () => {
    assert.deepEqual(parseOAuthResult(params('oauth_success=google&oauth_result=updated')), {
      provider: 'google', status: 'success', messageKey: 'admin.integrations.google.resultUpdated',
    });
  });

  it('maps a Google success with a missing or unknown result to the generic connected key', () => {
    for (const q of ['oauth_success=google', 'oauth_success=google&oauth_result=<script>']) {
      assert.deepEqual(parseOAuthResult(params(q)), {
        provider: 'google', status: 'success', messageKey: 'admin.integrations.google.resultConnected',
      }, q);
    }
  });

  const errorCases = {
    access_denied: 'admin.integrations.google.errorAccessDenied',
    invalid_state: 'admin.integrations.google.errorInvalidState',
    not_configured: 'admin.integrations.google.errorNotConfigured',
    email_not_verified: 'admin.integrations.google.errorEmailNotVerified',
    missing_refresh_token: 'admin.integrations.google.errorMissingRefreshToken',
    scope_missing: 'admin.integrations.google.errorScopeMissing',
    authentication_failed: 'admin.integrations.google.errorAuthenticationFailed',
  };
  for (const [code, key] of Object.entries(errorCases)) {
    it(`maps the Google error code ${code}`, () => {
      // A missing tick or a cancel on Google's screen is fixed by trying again; the toast offers it.
      const retry = code === 'access_denied' || code === 'scope_missing' ? { retryable: true } : {};
      assert.deepEqual(parseOAuthResult(params(`oauth_error=${code}&oauth_provider=google`)), {
        provider: 'google', status: 'error', messageKey: key, ...retry,
      });
    });
  }

  it('maps the multi-app callback codes to their own messages', () => {
    const cases = {
      already_connected: 'admin.integrations.google.errorAlreadyConnected',
      account_mismatch: 'admin.integrations.google.errorAccountMismatch',
      no_app_capacity: 'admin.integrations.google.errorNoAppCapacity',
    };
    for (const [code, key] of Object.entries(cases)) {
      const parsed = parseOAuthResult(`?oauth_error=${code}&oauth_provider=google`);
      assert.deepEqual(parsed, { provider: 'google', status: 'error', messageKey: key });
    }
  });

  it('maps an unknown Google error code to the generic Google failure key', () => {
    for (const q of [
      'oauth_error=invalid_grant&oauth_provider=google',
      'oauth_error=Token%20ya29.secret%20leaked&oauth_provider=google',
      'oauth_error=__proto__&oauth_provider=google',
      'oauth_error=toString&oauth_provider=google',
    ]) {
      assert.deepEqual(parseOAuthResult(params(q)), {
        provider: 'google', status: 'error', messageKey: 'admin.integrations.google.errorGeneric',
      }, q);
    }
  });

  it('maps non-Google providers to generic keys', () => {
    assert.deepEqual(parseOAuthResult(params('oauth_success=microsoft')), {
      provider: 'other', status: 'success', messageKey: 'admin.integrations.oauthGenericSuccess',
    });
    // Microsoft errors carry no oauth_provider.
    assert.deepEqual(parseOAuthResult(params('oauth_error=access_denied')), {
      provider: 'other', status: 'error', messageKey: 'admin.integrations.oauthGenericError',
    });
    assert.deepEqual(parseOAuthResult(params('oauth_error=access_denied&oauth_provider=microsoft')), {
      provider: 'other', status: 'error', messageKey: 'admin.integrations.oauthGenericError',
    });
  });

  it('prefers the error when both success and error are present', () => {
    assert.deepEqual(parseOAuthResult(params('oauth_success=google&oauth_result=created&oauth_error=invalid_state&oauth_provider=google')), {
      provider: 'google', status: 'error', messageKey: 'admin.integrations.google.errorInvalidState',
    });
  });

  it('never returns raw query text', () => {
    const raw = 'ya29.a0AfH6SMsecret';
    const result = parseOAuthResult(params(`oauth_error=${raw}&oauth_provider=google&oauth_result=${raw}`));
    assert.equal(JSON.stringify(result).includes(raw), false);
  });

  it('accepts a plain query string', () => {
    assert.deepEqual(parseOAuthResult('?oauth_success=google&oauth_result=created'), {
      provider: 'google', status: 'success', messageKey: 'admin.integrations.google.resultCreated',
    });
  });
});

describe('parseOAuthResult notices', () => {
  it('adds the notice key when the second sender name was dropped', () => {
    assert.deepEqual(parseOAuthResult(params('oauth_success=google&oauth_result=created&oauth_notice=sender_name_duplicate')), {
      provider: 'google', status: 'success', messageKey: 'admin.integrations.google.resultCreated',
      noticeKey: 'admin.integrations.google.noticeSenderNameDuplicate',
    });
  });

  it('ignores an unknown notice', () => {
    assert.deepEqual(parseOAuthResult(params('oauth_success=google&oauth_result=created&oauth_notice=__proto__')), {
      provider: 'google', status: 'success', messageKey: 'admin.integrations.google.resultCreated',
    });
  });
});

describe('oauthMessageToSearchParams', () => {
  it('carries the notice of a popup success message', () => {
    const p = oauthMessageToSearchParams({ type: 'oauth_success', provider: 'google', result: 'created', notice: 'sender_name_duplicate' });
    assert.equal(parseOAuthResult(p).noticeKey, 'admin.integrations.google.noticeSenderNameDuplicate');
  });

  it('converts a popup success message', () => {
    const p = oauthMessageToSearchParams({ type: 'oauth_success', provider: 'google', result: 'updated' });
    assert.deepEqual(parseOAuthResult(p), {
      provider: 'google', status: 'success', messageKey: 'admin.integrations.google.resultUpdated',
    });
  });

  it('converts a popup error message', () => {
    const p = oauthMessageToSearchParams({ type: 'oauth_error', provider: 'google', error: 'scope_missing' });
    assert.deepEqual(parseOAuthResult(p), {
      provider: 'google', status: 'error', messageKey: 'admin.integrations.google.errorScopeMissing', retryable: true,
    });
  });

  it('keeps the legacy Microsoft message shapes generic', () => {
    assert.equal(parseOAuthResult(oauthMessageToSearchParams({ type: 'oauth_success', provider: 'microsoft' })).provider, 'other');
    assert.equal(parseOAuthResult(oauthMessageToSearchParams({ type: 'oauth_error', error: 'x' })).provider, 'other');
  });

  it('ignores unrelated or malformed messages', () => {
    for (const data of [null, undefined, 'oauth_success', {}, { type: 'other', provider: 'google' }, { type: 'oauth_success', provider: { a: 1 } }]) {
      assert.equal(parseOAuthResult(oauthMessageToSearchParams(data)), null, JSON.stringify(data));
    }
  });
});

describe('googleResultNotifications', () => {
  const t = (key) => `t:${key}`;
  it('offers Try again on a retryable error when a retry is given', async () => {
    const { googleResultNotifications } = await import('./googleOAuth.js');
    let retried = 0;
    const [toast, ...rest] = googleResultNotifications(parseOAuthResult('?oauth_error=scope_missing&oauth_provider=google'), { t, onRetry: () => { retried += 1; } });
    assert.equal(rest.length, 0);
    assert.equal(toast.type, 'error');
    assert.equal(toast.body, 't:admin.integrations.google.errorScopeMissing');
    assert.equal(toast.actionLabel, 't:admin.integrations.google.retry');
    toast.onAction();
    assert.equal(retried, 1);
  });

  it('offers nothing without a retry, or for an error a retry does not fix', async () => {
    const { googleResultNotifications } = await import('./googleOAuth.js');
    const [plain] = googleResultNotifications(parseOAuthResult('?oauth_error=access_denied&oauth_provider=google'), { t });
    assert.equal(plain.actionLabel, undefined);
    const [fixed] = googleResultNotifications(parseOAuthResult('?oauth_error=invalid_state&oauth_provider=google'), { t, onRetry: () => {} });
    assert.equal(fixed.actionLabel, undefined);
  });

  it('keeps a success and its notice as two info toasts', async () => {
    const { googleResultNotifications } = await import('./googleOAuth.js');
    const toasts = googleResultNotifications(parseOAuthResult('?oauth_success=google&oauth_result=created&oauth_notice=sender_name_duplicate'), { t, onRetry: () => {} });
    assert.deepEqual(toasts.map(n => [n.type, n.body, n.actionLabel]), [
      ['info', 't:admin.integrations.google.resultCreated', undefined],
      ['info', 't:admin.integrations.google.noticeSenderNameDuplicate', undefined],
    ]);
  });
});
