import { describe, expect, it } from 'vitest';
import { buildInclude, domainAdmits, exceedsDisableLimit, removedInCloudflare } from './reconcile.js';

const email = (address) => ({ email: { email: address } });
const domain = (name) => ({ email_domain: { domain: name } });
const group = { group: { id: 'g-1' } };
const policy = (include, exclude = []) => ({ id: 'p', name: 'Allow', decision: 'allow', include, exclude, require: [] });
const none = new Set();

describe('domainAdmits', () => {
  it('admits an email at an included domain unless the email or domain is excluded', () => {
    const admits = domainAdmits(policy([domain('Team.example')], [email('out@team.example'), domain('gone.example')]));
    expect(admits('in@team.example')).toBe(true);
    expect(admits('out@team.example')).toBe(false);
    expect(admits('in@other.example')).toBe(false);
    expect(domainAdmits(policy([domain('gone.example')], [domain('gone.example')]))('a@gone.example')).toBe(false);
  });
});

describe('removedInCloudflare', () => {
  const base = { baseline: ['a@example.com', 'b@example.com'], activeEmails: ['a@example.com', 'b@example.com', 'new@example.com'], pinned: none };

  it('finds an email MailExpert wrote that Cloudflare no longer lists', () => {
    expect(removedInCloudflare({ ...base, policy: policy([email('A@example.com')]) })).toEqual(['b@example.com']);
  });

  it('never treats a user added in MailExpert since the last run as removed', () => {
    expect(removedInCloudflare({ ...base, policy: policy([email('a@example.com'), email('b@example.com')]) })).toEqual([]);
  });

  it('keeps a user a domain rule still admits, but not one the policy excludes', () => {
    expect(removedInCloudflare({ ...base, policy: policy([email('a@example.com'), domain('example.com')]) })).toEqual([]);
    expect(removedInCloudflare({ ...base, policy: policy([email('a@example.com'), domain('example.com')], [email('b@example.com')]) }))
      .toEqual(['b@example.com']);
  });

  it('ignores inactive users, bootstrap admins and a policy without any email rule', () => {
    expect(removedInCloudflare({ ...base, activeEmails: ['a@example.com'], policy: policy([email('a@example.com')]) })).toEqual([]);
    expect(removedInCloudflare({ ...base, pinned: new Set(['b@example.com']), policy: policy([email('a@example.com')]) })).toEqual([]);
    expect(removedInCloudflare({ ...base, policy: policy([group]) })).toEqual([]);
  });
});

describe('exceedsDisableLimit', () => {
  it('stops above the absolute limit or above half of the active users', () => {
    expect(exceedsDisableLimit(0, 0, 10)).toBe(false);
    expect(exceedsDisableLimit(10, 100, 10)).toBe(false);
    expect(exceedsDisableLimit(11, 100, 10)).toBe(true);
    expect(exceedsDisableLimit(2, 4, 10)).toBe(false);
    expect(exceedsDisableLimit(2, 3, 10)).toBe(true);
    expect(exceedsDisableLimit(1, 1, 10)).toBe(true);
    expect(exceedsDisableLimit(1, 100, 0)).toBe(true);
  });
});

describe('buildInclude', () => {
  it('adds wanted emails, drops emails MailExpert wrote and no longer wants, keeps everything else', () => {
    const current = policy([group, domain('example.org'), email('foreign@example.net'), email('old@example.com'), email('keep@example.com')]);
    const result = buildInclude({ policy: current, baseline: ['old@example.com', 'keep@example.com'], desired: ['keep@example.com', 'new@example.com'] });
    expect(result.include).toEqual([
      group, domain('example.org'), email('foreign@example.net'), email('keep@example.com'), email('new@example.com'),
    ]);
    expect(result).toMatchObject({ changed: true, added: ['new@example.com'], removed: ['old@example.com'] });
  });

  it('reports no change when the policy already lists exactly the wanted emails', () => {
    const current = policy([email('Keep@example.com'), domain('example.org')]);
    expect(buildInclude({ policy: current, baseline: ['keep@example.com'], desired: ['keep@example.com'] }))
      .toMatchObject({ changed: false, added: [], removed: [] });
  });

  it('takes over a wanted email someone listed by hand without duplicating it', () => {
    const current = policy([email('Person@example.com')]);
    const result = buildInclude({ policy: current, baseline: [], desired: ['person@example.com'] });
    expect(result.include).toEqual([email('person@example.com')]);
    expect(result.changed).toBe(false);
  });

  it('leaves a foreign email that MailExpert never wrote even when no user has it', () => {
    const current = policy([email('contractor@example.net'), email('gone@example.com')]);
    const result = buildInclude({ policy: current, baseline: ['gone@example.com'], desired: ['a@example.com'] });
    expect(result.include).toEqual([email('contractor@example.net'), email('a@example.com')]);
  });
});
