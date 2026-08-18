import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { createAdminToken, decodeJwtPayload } from '../src/ghost/admin-token.js';
import { IdentityProvider, GhostAuthError } from '../src/ghost/identity.js';
import { parseStaffToken, ConfigError } from '../src/config.js';

const ID = 'a1b2c3d4e5f60718293a4b5c';
const SECRET = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

function signIdentity(claims: Record<string, unknown>): string {
  // Not a real RS256 token: the provider only decodes the payload, it does not
  // verify the signature. Ghost's ActivityPub service is what verifies it.
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.signature`;
}

describe('parseStaffToken', () => {
  it('splits a well formed token', () => {
    expect(parseStaffToken(`${ID}:${SECRET}`)).toEqual({ id: ID, secret: SECRET });
  });

  it('rejects a token with no colon', () => {
    expect(() => parseStaffToken(ID)).toThrow(ConfigError);
  });

  it('rejects a non-hex secret', () => {
    expect(() => parseStaffToken(`${ID}:not-hex`)).toThrow(ConfigError);
  });
});

describe('createAdminToken', () => {
  it('signs HS256 over the hex-decoded secret, the way Ghost verifies it', () => {
    const token = createAdminToken(ID, SECRET, { now: 1_700_000_000_000 });
    const [header, payload, signature] = token.split('.') as [string, string, string];

    const expected = createHmac('sha256', Buffer.from(SECRET, 'hex'))
      .update(`${header}.${payload}`)
      .digest('base64url');

    expect(signature).toBe(expected);
  });

  it('puts the token id in kid and targets the admin audience', () => {
    const token = createAdminToken(ID, SECRET, { now: 1_700_000_000_000 });
    const header = JSON.parse(
      Buffer.from(token.split('.')[0] as string, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    const claims = decodeJwtPayload(token);

    expect(header).toMatchObject({ alg: 'HS256', kid: ID });
    expect(claims).toMatchObject({ aud: '/admin/', iat: 1_700_000_000, exp: 1_700_000_300 });
  });

  it('expires within the five minutes Ghost allows', () => {
    const claims = decodeJwtPayload(createAdminToken(ID, SECRET, { now: 0 })) as {
      iat: number;
      exp: number;
    };
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(300);
  });
});

describe('IdentityProvider', () => {
  const staffToken = `${ID}:${SECRET}`;

  function providerReturning(token: string, calls: string[] = [], now = () => 1_000_000) {
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(String(input));
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      if (!auth.startsWith('Ghost ')) {
        return new Response('no', { status: 401 });
      }
      return new Response(JSON.stringify({ identities: [{ token }] }), { status: 200 });
    }) as typeof fetch;

    return new IdentityProvider('https://example.com', staffToken, fetcher, now);
  }

  it('reads the token and its claims out of the identities endpoint', async () => {
    const calls: string[] = [];
    const token = signIdentity({
      sub: 'scott@example.com',
      role: 'Administrator',
      exp: 1300,
    });
    const identity = await providerReturning(token, calls).get();

    expect(calls).toEqual(['https://example.com/ghost/api/admin/identities/']);
    expect(identity.subject).toBe('scott@example.com');
    expect(identity.role).toBe('Administrator');
    expect(identity.expiresAt).toBe(1_300_000);
  });

  it('caches while the token is fresh and refetches once it is nearly expired', async () => {
    const calls: string[] = [];
    let now = 1_000_000;
    const provider = providerReturning(
      signIdentity({ sub: 'scott@example.com', role: 'Owner', exp: 1300 }),
      calls,
      () => now,
    );

    await provider.get();
    await provider.get();
    expect(calls).toHaveLength(1);

    // Inside the 30s refresh headroom, so the next call must go back to Ghost.
    now = 1_280_000;
    await provider.get();
    expect(calls).toHaveLength(2);
  });

  it('collapses concurrent bootstraps into one request', async () => {
    const calls: string[] = [];
    const provider = providerReturning(
      signIdentity({ sub: 'scott@example.com', role: 'Owner', exp: 1300 }),
      calls,
    );

    await Promise.all([provider.get(), provider.get(), provider.get()]);
    expect(calls).toHaveLength(1);
  });

  it('explains the 403 that an integration key produces', async () => {
    const fetcher = (async () => new Response('{}', { status: 403 })) as typeof fetch;
    const provider = new IdentityProvider('https://example.com', staffToken, fetcher);

    await expect(provider.get()).rejects.toThrow(GhostAuthError);
    await expect(provider.get()).rejects.toThrow(/Owner or Administrator/);
  });

  it('fails loudly when Ghost returns no token', async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify({ identities: [] }), { status: 200 })) as typeof fetch;
    const provider = new IdentityProvider('https://example.com', staffToken, fetcher);

    await expect(provider.get()).rejects.toThrow(/no identity token/);
  });
});
