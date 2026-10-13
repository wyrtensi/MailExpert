import { describe, it, expect, vi, beforeAll } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { createResilientJwks, verifyCloudflareAccessToken } from './cloudflareAccess.js';

const ISSUER = 'https://team.cloudflareaccess.com';
const AUDIENCE = 'aud-tag';
const CONFIG = { issuer: ISSUER, audience: AUDIENCE };

let signingKey;
let foreignKey;
let jwksDocument;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  signingKey = pair.privateKey;
  jwksDocument = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] };
  foreignKey = (await generateKeyPair('RS256')).privateKey;
});

const sign = ({ claims = { email: 'User@Example.com' }, key = signingKey, iss = ISSUER, aud = AUDIENCE, exp = '5m' } = {}) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(key);

describe('verifyCloudflareAccessToken', () => {
  const local = () => ({ jwks: createLocalJWKSet(jwksDocument) });

  it('returns the lower-cased email of a valid token', async () => {
    expect(await verifyCloudflareAccessToken(await sign(), CONFIG, local())).toBe('user@example.com');
  });

  it('rejects another audience, another issuer, a foreign key and an expired token', async () => {
    expect(await verifyCloudflareAccessToken(await sign({ aud: 'other' }), CONFIG, local())).toBeNull();
    expect(await verifyCloudflareAccessToken(await sign({ iss: 'https://other.cloudflareaccess.com' }), CONFIG, local())).toBeNull();
    expect(await verifyCloudflareAccessToken(await sign({ key: foreignKey }), CONFIG, local())).toBeNull();
    const past = Math.floor(Date.now() / 1000) - 60;
    expect(await verifyCloudflareAccessToken(await sign({ exp: past }), CONFIG, local())).toBeNull();
  });

  it('rejects a token without an email, garbage and a missing token', async () => {
    expect(await verifyCloudflareAccessToken(await sign({ claims: {} }), CONFIG, local())).toBeNull();
    expect(await verifyCloudflareAccessToken('not.a.jwt', CONFIG, local())).toBeNull();
    expect(await verifyCloudflareAccessToken(undefined, CONFIG, local())).toBeNull();
  });
});

describe('createResilientJwks', () => {
  it('refreshes an unknown kid once, shares the refresh and limits repeated unknown kids', async () => {
    let document = jwksDocument;
    let calls = 0;
    const jwks = createResilientJwks({ fetchJwks: async () => { calls++; return document; }, now: () => 0 });
    expect(await verifyCloudflareAccessToken(await sign(), CONFIG, { jwks })).toBe('user@example.com');
    document = { keys: [{ ...jwksDocument.keys[0], kid: 'rotated' }] };
    const rotated = await new SignJWT({ email: 'user@example.com' }).setProtectedHeader({ alg: 'RS256', kid: 'rotated' })
      .setIssuer(ISSUER).setAudience(AUDIENCE).setExpirationTime('5m').sign(signingKey);
    expect(await Promise.all([verifyCloudflareAccessToken(rotated, CONFIG, { jwks }), verifyCloudflareAccessToken(rotated, CONFIG, { jwks })]))
      .toEqual(['user@example.com', 'user@example.com']);
    expect(calls).toBe(2);
    const forged = await new SignJWT({ email: 'user@example.com' }).setProtectedHeader({ alg: 'RS256', kid: 'rotated' })
      .setIssuer(ISSUER).setAudience(AUDIENCE).setExpirationTime('5m').sign(foreignKey);
    expect(await verifyCloudflareAccessToken(forged, CONFIG, { jwks })).toBeNull();
    for (let i = 0; i < 3; i++) expect(await verifyCloudflareAccessToken(await sign(), CONFIG, { jwks })).toBeNull();
    expect(calls).toBe(2);
  });

  it('backs off failed refreshes, retries later and never extends absolute stale trust', async () => {
    let clock = 0;
    const fetchJwks = vi.fn(async () => jwksDocument);
    const jwks = createResilientJwks({ fetchJwks, now: () => clock, cacheMaxAgeMs: 1000, staleMaxAgeMs: 5000 });
    const token = await sign();
    expect(await verifyCloudflareAccessToken(token, CONFIG, { jwks })).toBe('user@example.com');
    fetchJwks.mockRejectedValue(new Error('fixture outage'));
    clock = 2000;
    for (let i = 0; i < 3; i++) expect(await verifyCloudflareAccessToken(token, CONFIG, { jwks })).toBe('user@example.com');
    expect(fetchJwks).toHaveBeenCalledTimes(2);
    clock = 6000;
    expect(await verifyCloudflareAccessToken(token, CONFIG, { jwks })).toBeNull();
    expect(fetchJwks).toHaveBeenCalledTimes(2);
    clock = 40_000;
    fetchJwks.mockResolvedValue(jwksDocument);
    expect(await verifyCloudflareAccessToken(token, CONFIG, { jwks })).toBe('user@example.com');
    expect(fetchJwks).toHaveBeenCalledTimes(3);
  });

  it('backs off even without any initial keys and fails closed', async () => {
    const fetchJwks = vi.fn(async () => { throw new Error('fixture outage'); });
    const jwks = createResilientJwks({ fetchJwks, now: () => 0 });
    for (let i = 0; i < 3; i++) expect(await verifyCloudflareAccessToken(await sign(), CONFIG, { jwks })).toBeNull();
    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });
  it('caches the key set, refreshes it after max age and serves a stale copy while a refresh fails', async () => {
    let clock = 0;
    const fetchJwks = vi.fn(async () => jwksDocument);
    const jwks = createResilientJwks({ fetchJwks, now: () => clock, cacheMaxAgeMs: 1000, staleMaxAgeMs: 5000 });
    const token = await sign();

    expect(await verifyCloudflareAccessToken(token, CONFIG, { jwks })).toBe('user@example.com');
    clock = 500;
    expect(await verifyCloudflareAccessToken(token, CONFIG, { jwks })).toBe('user@example.com');
    expect(fetchJwks).toHaveBeenCalledTimes(1);

    clock = 2000;
    fetchJwks.mockRejectedValueOnce(new Error('certs unreachable'));
    expect(await verifyCloudflareAccessToken(token, CONFIG, { jwks })).toBe('user@example.com');
    expect(fetchJwks).toHaveBeenCalledTimes(2);

    clock = 10_000;
    fetchJwks.mockRejectedValueOnce(new Error('certs unreachable'));
    expect(await verifyCloudflareAccessToken(token, CONFIG, { jwks })).toBeNull();
  });

  it('shares one refresh between concurrent requests', async () => {
    let release;
    const fetchJwks = vi.fn(() => new Promise((resolve) => { release = () => resolve(jwksDocument); }));
    const jwks = createResilientJwks({ fetchJwks });
    const token = await sign();
    const pending = [
      verifyCloudflareAccessToken(token, CONFIG, { jwks }),
      verifyCloudflareAccessToken(token, CONFIG, { jwks }),
    ];
    await vi.waitFor(() => expect(fetchJwks).toHaveBeenCalledTimes(1));
    release();
    expect(await Promise.all(pending)).toEqual(['user@example.com', 'user@example.com']);
  });
});
