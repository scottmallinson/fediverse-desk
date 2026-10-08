import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/shim/app.js';
import {
  decodeAccountId,
  decodeId,
  encodeAccountId,
  encodeId,
  parseWebfingerResource,
  toStatus,
} from '../src/shim/mastodon.js';
import { LoginThrottle, OAuthServer, OOB_REDIRECT } from '../src/shim/oauth.js';
import { SocialWebError } from '../src/ghost/direct.js';
import { Queue } from '../src/scheduler/queue.js';
import type { Post } from '../src/ghost/types.js';
import { FakeSocialWeb, makeAccount, makePost, tempDir } from './helpers.js';

const REDIRECT = 'https://client.example/callback';
const PASSWORD = 'correct-horse-battery-staple';

describe('id encoding', () => {
  it('round-trips an ActivityPub URL through a path-safe id', () => {
    const apId = 'https://example.com/.ghost/activitypub/note/1?x=2';
    expect(decodeId(encodeId(apId))).toBe(apId);
  });

  it('produces an id with nothing a router would split on', () => {
    expect(encodeId('https://example.com/a/b/c')).not.toContain('/');
  });

  it('refuses an id it did not issue', () => {
    expect(() => decodeId('not-one-of-ours')).toThrow(/not an id this shim issued/);
  });
});

describe('status mapping', () => {
  it('carries the counts and the canonical URLs across', () => {
    const status = toStatus(makePost());
    expect(status).toMatchObject({
      uri: 'https://example.com/.ghost/activitypub/note/1',
      url: 'https://example.com/notes/1',
      content: 'Hello fediverse',
      favourites_count: 2,
      replies_count: 1,
      visibility: 'public',
    });
    expect(status.account.acct).toBe('scott@example.com');
  });

  it('falls back to the excerpt when a post has no content', () => {
    const status = toStatus(makePost({ content: '', excerpt: 'from the excerpt' }));
    expect(status.content).toBe('from the excerpt');
  });
});

describe('shim', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let social: FakeSocialWeb;
  let oauth: OAuthServer;
  let handle: (request: Request) => Promise<Response>;
  let fetched: string[];
  /** Join dates other servers report, by the URL the shim asks. */
  let joinDates: Map<string, string>;

  beforeEach(async () => {
    dir = await tempDir();
    social = new FakeSocialWeb();
    fetched = [];
    joinDates = new Map();
    oauth = OAuthServer.open(dir.path, PASSWORD);
    handle = createApp({
      social,
      oauth,
      queue: Queue.open(dir.path),
      publicUrl: 'https://desk.example',
      version: 'test',
      ghostUrl: 'https://example.com',
      throttle: new LoginThrottle(3, 60_000),
      fetcher: async (input) => {
        const url = String(input);
        fetched.push(url);
        const createdAt = joinDates.get(url);
        return createdAt
          ? Response.json({ created_at: createdAt })
          : new Response('Not found', { status: 404 });
      },
    });
  });

  afterEach(async () => {
    await dir.cleanup();
  });

  async function registerApp(): Promise<{ clientId: string; clientSecret: string }> {
    const response = await handle(
      new Request('https://desk.example/api/v1/apps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Buffer',
          redirect_uris: REDIRECT,
          scopes: 'read write',
        }),
      }),
    );
    const body = (await response.json()) as { client_id: string; client_secret: string };
    return { clientId: body.client_id, clientSecret: body.client_secret };
  }

  async function login(): Promise<string> {
    const { clientId, clientSecret } = await registerApp();

    const authorize = await handle(
      new Request('https://desk.example/oauth/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          redirect_uri: REDIRECT,
          scope: 'read write',
          password: PASSWORD,
        }),
      }),
    );

    const location = new URL(authorize.headers.get('location') as string);
    const code = location.searchParams.get('code') as string;

    const token = await handle(
      new Request('https://desk.example/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: REDIRECT,
        }),
      }),
    );

    const body = (await token.json()) as { access_token: string };
    return body.access_token;
  }

  function authed(path: string, token: string, init: RequestInit = {}): Request {
    return new Request(`https://desk.example${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    });
  }

  describe('instance discovery', () => {
    it('answers without a token, because a client needs it before logging in', async () => {
      const response = await handle(new Request('https://desk.example/api/v1/instance'));
      expect(response.status).toBe(200);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.uri).toBe('desk.example');
      expect(String(body.version)).toMatch(/^4\.2\.0 \(compatible; fediverse-desk/);
      expect(body.registrations).toBe(false);
    });

    it('serves the v2 shape on /api/v2/instance, with thumbnail as an object', async () => {
      const response = await handle(new Request('https://desk.example/api/v2/instance'));
      expect(response.status).toBe(200);

      const body = (await response.json()) as Record<string, any>;
      expect(body.domain).toBe('desk.example');
      expect(typeof body.thumbnail).toBe('object');
      expect(typeof body.thumbnail.url).toBe('string');
      expect(body.registrations).toEqual({
        enabled: false,
        approval_required: true,
        message: null,
      });
      expect(body.configuration.statuses.max_characters).toBe(5000);
      expect(body.configuration.urls).toBeDefined();
    });

    it('points nodeinfo discovery at the 2.0 document', async () => {
      const response = await handle(new Request('https://desk.example/.well-known/nodeinfo'));
      expect(response.status).toBe(200);

      const body = (await response.json()) as { links: Array<Record<string, string>> };
      expect(body.links[0]).toEqual({
        rel: 'http://nodeinfo.diaspora.software/ns/schema/2.0',
        href: 'https://desk.example/nodeinfo/2.0',
      });
    });

    it('claims mastodon in nodeinfo, because clients gate the login on it', async () => {
      const response = await handle(new Request('https://desk.example/nodeinfo/2.0'));
      expect(response.status).toBe(200);

      const body = (await response.json()) as Record<string, any>;
      expect(body.software.name).toBe('mastodon');
      expect(body.protocols).toContain('activitypub');
      expect(body.openRegistrations).toBe(false);
    });

    it('tells the truth about itself in nodeinfo metadata', async () => {
      const response = await handle(new Request('https://desk.example/nodeinfo/2.0'));
      const body = (await response.json()) as Record<string, any>;

      expect(body.metadata.software).toBe('fediverse-desk test');
      expect(body.metadata.upstream).toBe('https://example.com');
    });

    it('serves nodeinfo without a token, and without needing Ghost', async () => {
      social.failNext = new Error('Ghost is down');
      const response = await handle(new Request('https://desk.example/nodeinfo/2.0'));
      expect(response.status).toBe(200);
      expect((await response.json() as Record<string, any>).software.name).toBe('mastodon');
    });

    it('still answers when Ghost is unreachable, so login can proceed', async () => {
      social.failNext = new Error('Ghost is down');
      const response = await handle(new Request('https://desk.example/api/v1/instance'));
      expect(response.status).toBe(200);
      expect((await response.json() as Record<string, unknown>).contact_account).toBeNull();
    });
  });

  describe('webfinger', () => {
    it('points at the Ghost actor, not at the bridge', async () => {
      const response = await handle(
        new Request(
          'https://desk.example/.well-known/webfinger?resource=acct:scott@desk.example',
        ),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/jrd+json');

      const body = (await response.json()) as Record<string, any>;
      expect(body.subject).toBe('acct:scott@desk.example');
      expect(body.links[0]).toEqual({
        rel: 'self',
        type: 'application/activity+json',
        href: 'https://example.com/.ghost/activitypub/users/index',
      });
    });

    it('answers for the publication host as well as the bridge host', async () => {
      const response = await handle(
        new Request(
          'https://desk.example/.well-known/webfinger?resource=acct:scott@example.com',
        ),
      );
      expect(response.status).toBe(200);
    });

    it('accepts a bare handle and an https resource', async () => {
      for (const resource of [
        'scott@desk.example',
        'https://desk.example/@scott',
      ]) {
        const response = await handle(
          new Request(
            `https://desk.example/.well-known/webfinger?resource=${encodeURIComponent(resource)}`,
          ),
        );
        expect(response.status, resource).toBe(200);
      }
    });

    it('404s for an account that is not the one account', async () => {
      const response = await handle(
        new Request(
          'https://desk.example/.well-known/webfinger?resource=acct:someone@desk.example',
        ),
      );
      expect(response.status).toBe(404);
    });

    it('404s for a host that is neither the bridge nor the publication', async () => {
      const response = await handle(
        new Request(
          'https://desk.example/.well-known/webfinger?resource=acct:scott@elsewhere.example',
        ),
      );
      expect(response.status).toBe(404);
    });

    it('400s on a malformed or missing resource', async () => {
      for (const query of ['', '?resource=', '?resource=nonsense']) {
        const response = await handle(
          new Request(`https://desk.example/.well-known/webfinger${query}`),
        );
        expect(response.status, query).toBe(400);
      }
    });

    it('says try again rather than no such account when Ghost is down', async () => {
      social.failNext = new Error('Ghost is down');
      const response = await handle(
        new Request(
          'https://desk.example/.well-known/webfinger?resource=acct:scott@desk.example',
        ),
      );

      // A 404 here is a lie a client might cache.
      expect(response.status).toBe(503);
    });

    it('needs no token', async () => {
      const response = await handle(
        new Request(
          'https://desk.example/.well-known/webfinger?resource=acct:scott@desk.example',
        ),
      );
      expect(response.status).not.toBe(401);
    });
  });

  describe('OAuth', () => {
    it('walks a client from registration to a usable token', async () => {
      const token = await login();
      const response = await handle(
        authed('/api/v1/accounts/verify_credentials', token),
      );

      expect(response.status).toBe(200);
      expect((await response.json() as Record<string, unknown>).acct).toBe('scott@example.com');
    });

    it('rejects a redirect_uri the client did not register', async () => {
      const { clientId } = await registerApp();
      const response = await handle(
        new Request(
          `https://desk.example/oauth/authorize?client_id=${clientId}&redirect_uri=https://evil.example/steal&response_type=code`,
        ),
      );

      expect(response.status).toBe(400);
      expect((await response.json() as Record<string, unknown>).error).toBe('invalid_grant');
    });

    it('rejects an unknown client', async () => {
      const response = await handle(
        new Request(
          `https://desk.example/oauth/authorize?client_id=nope&redirect_uri=${REDIRECT}`,
        ),
      );
      expect(response.status).toBe(401);
    });

    it('does not issue a code for the wrong password', async () => {
      const { clientId } = await registerApp();
      const response = await handle(
        new Request('https://desk.example/oauth/authorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            redirect_uri: REDIRECT,
            password: 'guess',
          }),
        }),
      );

      expect(response.status).toBe(401);
      expect(response.headers.get('location')).toBeNull();
    });

    it('locks out after repeated wrong passwords', async () => {
      const { clientId } = await registerApp();
      const attempt = () =>
        handle(
          new Request('https://desk.example/oauth/authorize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: clientId,
              redirect_uri: REDIRECT,
              password: 'guess',
            }),
          }),
        );

      await attempt();
      await attempt();
      await attempt();
      expect((await attempt()).status).toBe(429);
    });

    it('preserves the state parameter through the redirect', async () => {
      const { clientId } = await registerApp();
      const response = await handle(
        new Request('https://desk.example/oauth/authorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            redirect_uri: REDIRECT,
            password: PASSWORD,
            state: 'xyz123',
          }),
        }),
      );

      const location = new URL(response.headers.get('location') as string);
      expect(location.searchParams.get('state')).toBe('xyz123');
    });

    it('registers each URI of a newline-separated redirect_uris value', async () => {
      const second = 'https://other.example/callback';
      const response = await handle(
        new Request('https://desk.example/api/v1/apps', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_name: 'Buffer', redirect_uris: `${REDIRECT}\n${second}\n` }),
        }),
      );
      const { client_id: clientId } = (await response.json()) as { client_id: string };

      for (const uri of [REDIRECT, second]) {
        const authorize = await handle(
          new Request(
            `https://desk.example/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(uri)}&response_type=code`,
          ),
        );
        expect(authorize.status).toBe(200);
      }
    });

    it('still matches apps stored with several URIs in one entry by an older build', async () => {
      const second = 'https://other.example/callback';
      const { app } = await oauth.registerApp({
        name: 'Buffer',
        redirectUris: [`${REDIRECT}\n${second}`],
      });

      for (const uri of [REDIRECT, second]) {
        const authorize = await handle(
          new Request(
            `https://desk.example/oauth/authorize?client_id=${app.clientId}&redirect_uri=${encodeURIComponent(uri)}&response_type=code`,
          ),
        );
        expect(authorize.status).toBe(200);
      }

      const prefix = await handle(
        new Request(
          `https://desk.example/oauth/authorize?client_id=${app.clientId}&redirect_uri=${encodeURIComponent('https://other.example/')}&response_type=code`,
        ),
      );
      expect(prefix.status).toBe(400);
    });

    it('accepts a redirect_uris array and reports client_secret_expires_at', async () => {
      const second = 'https://other.example/callback';
      const response = await handle(
        new Request('https://desk.example/api/v1/apps', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_name: 'App', redirect_uris: [REDIRECT, second] }),
        }),
      );
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.redirect_uris).toEqual([REDIRECT, second]);
      expect(body.scopes).toEqual(['read']);
      expect(body.client_secret_expires_at).toBe(0);
    });

    it('refuses client_credentials without the client secret', async () => {
      const { clientId, clientSecret } = await registerApp();
      const request = (secret: string) =>
        handle(
          new Request('https://desk.example/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'client_credentials',
              client_id: clientId,
              client_secret: secret,
            }),
          }),
        );
      expect((await request('')).status).toBe(401);
      expect((await request(clientSecret)).status).toBe(200);
    });

    describe('PKCE', () => {
      const verifier = 'a-long-random-verifier-string-0123456789';
      const challenge = createHash('sha256').update(verifier).digest('base64url');

      async function authorizeWith(clientId: string, extra: Record<string, string>) {
        const response = await handle(
          new Request('https://desk.example/oauth/authorize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: clientId,
              redirect_uri: REDIRECT,
              password: PASSWORD,
              ...extra,
            }),
          }),
        );
        return response;
      }

      async function exchange(clientId: string, clientSecret: string, code: string, v?: string) {
        const params: Record<string, string> = {
          grant_type: 'authorization_code',
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: REDIRECT,
        };
        if (v) params.code_verifier = v;
        return handle(
          new Request('https://desk.example/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(params),
          }),
        );
      }

      it('redeems a code only with the matching verifier', async () => {
        const { clientId, clientSecret } = await registerApp();
        const pkce = { code_challenge: challenge, code_challenge_method: 'S256' };

        const bad = await authorizeWith(clientId, pkce);
        const badCode = new URL(bad.headers.get('location') as string).searchParams.get('code');
        expect((await exchange(clientId, clientSecret, badCode as string, 'wrong')).status).toBe(400);

        const good = await authorizeWith(clientId, pkce);
        const goodCode = new URL(good.headers.get('location') as string).searchParams.get('code');
        expect((await exchange(clientId, clientSecret, goodCode as string)).status).toBe(400);

        const ok = await authorizeWith(clientId, pkce);
        const okCode = new URL(ok.headers.get('location') as string).searchParams.get('code');
        expect((await exchange(clientId, clientSecret, okCode as string, verifier)).status).toBe(200);
      });

      it('rejects a non-S256 challenge method', async () => {
        const { clientId } = await registerApp();
        const response = await authorizeWith(clientId, {
          code_challenge: challenge,
          code_challenge_method: 'plain',
        });
        expect(response.status).toBe(400);
      });
    });

    it('shows the code on a page for out-of-band clients', async () => {
      const response = await handle(
        new Request('https://desk.example/api/v1/apps', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_name: 'CLI', redirect_uris: OOB_REDIRECT }),
        }),
      );
      const { client_id: clientId } = (await response.json()) as { client_id: string };

      const authorize = await handle(
        new Request('https://desk.example/oauth/authorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            redirect_uri: OOB_REDIRECT,
            password: PASSWORD,
          }),
        }),
      );

      expect(authorize.status).toBe(200);
      expect(await authorize.text()).toContain('Authorisation code');
    });

    it('will not spend the same code twice', async () => {
      const { clientId, clientSecret } = await registerApp();
      const authorize = await handle(
        new Request('https://desk.example/oauth/authorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            redirect_uri: REDIRECT,
            password: PASSWORD,
          }),
        }),
      );
      const code = new URL(authorize.headers.get('location') as string).searchParams.get(
        'code',
      ) as string;

      const exchange = () =>
        handle(
          new Request('https://desk.example/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'authorization_code',
              client_id: clientId,
              client_secret: clientSecret,
              code,
              redirect_uri: REDIRECT,
            }),
          }),
        );

      expect((await exchange()).status).toBe(200);
      expect((await exchange()).status).toBe(400);
    });

    it('rejects a code exchange with the wrong client secret', async () => {
      const { clientId } = await registerApp();
      const authorize = await handle(
        new Request('https://desk.example/oauth/authorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            redirect_uri: REDIRECT,
            password: PASSWORD,
          }),
        }),
      );
      const code = new URL(authorize.headers.get('location') as string).searchParams.get(
        'code',
      ) as string;

      const response = await handle(
        new Request('https://desk.example/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientId,
            client_secret: 'wrong',
            code,
            redirect_uri: REDIRECT,
          }),
        }),
      );

      expect(response.status).toBe(401);
    });

    it('revokes a token', async () => {
      const token = await login();
      await handle(
        new Request('https://desk.example/oauth/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token }),
        }),
      );

      const response = await handle(authed('/api/v1/accounts/verify_credentials', token));
      expect(response.status).toBe(401);
    });

    it('never stores a token or secret in a replayable form', async () => {
      const token = await login();
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(`${dir.path}/oauth.json`, 'utf8');
      expect(raw).not.toContain(token);
    });
  });

  describe('authentication', () => {
    it('refuses an API call with no token', async () => {
      const response = await handle(
        new Request('https://desk.example/api/v1/accounts/verify_credentials'),
      );
      expect(response.status).toBe(401);
    });

    it('refuses a made-up token', async () => {
      const response = await handle(
        authed('/api/v1/timelines/home', 'not-a-real-token'),
      );
      expect(response.status).toBe(401);
    });

    it('refuses to post without a token, and does not touch Ghost', async () => {
      const response = await handle(
        new Request('https://desk.example/api/v1/statuses', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'sneaky' }),
        }),
      );
      expect(response.status).toBe(401);
      expect(social.calls).toHaveLength(0);
    });
  });

  describe('posting', () => {
    it('turns a status into a Ghost note', async () => {
      const token = await login();
      social.calls.length = 0;

      const response = await handle(
        authed('/api/v1/statuses', token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ status: 'Hello from Buffer' }),
        }),
      );

      expect(response.status).toBe(200);
      expect(social.calls).toEqual([
        { method: 'note', args: [{ content: 'Hello from Buffer' }] },
      ]);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.content).toBe('Hello from Buffer');
      expect(body.uri).toBe('https://example.com/.ghost/activitypub/note/1');
    });

    it('accepts JSON as readily as a form', async () => {
      const token = await login();
      social.calls.length = 0;

      await handle(
        authed('/api/v1/statuses', token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'json please' }),
        }),
      );

      expect(social.calls[0]).toEqual({ method: 'note', args: [{ content: 'json please' }] });
    });

    it('routes in_reply_to_id to a reply on the decoded ActivityPub id', async () => {
      const token = await login();
      social.calls.length = 0;
      const parent = 'https://example.com/.ghost/activitypub/note/42';

      await handle(
        authed('/api/v1/statuses', token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ status: 'agreed', in_reply_to_id: encodeId(parent) }),
        }),
      );

      expect(social.calls[0]).toEqual({
        method: 'reply',
        args: [parent, { content: 'agreed' }],
      });
    });

    it('honours Idempotency-Key so a retry does not double post', async () => {
      const token = await login();
      social.calls.length = 0;

      const send = () =>
        handle(
          authed('/api/v1/statuses', token, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Idempotency-Key': 'abc-123',
            },
            body: new URLSearchParams({ status: 'once only' }),
          }),
        );

      const first = (await (await send()).json()) as Record<string, unknown>;
      const second = (await (await send()).json()) as Record<string, unknown>;

      expect(second).toEqual(first);
      expect(social.calls.filter((call) => call.method === 'note')).toHaveLength(1);
    });

    it('rejects an empty status', async () => {
      const token = await login();
      const response = await handle(
        authed('/api/v1/statuses', token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ status: '   ' }),
        }),
      );
      expect(response.status).toBe(422);
    });

    it('says so rather than silently dropping extra images', async () => {
      const token = await login();
      const response = await handle(
        authed('/api/v1/statuses', token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'two pictures',
            media_ids: [encodeId('https://s.example/a.png'), encodeId('https://s.example/b.png')],
          }),
        }),
      );

      expect(response.status).toBe(422);
      expect(String((await response.json() as Record<string, unknown>).error)).toMatch(
        /one image per note/,
      );
    });

    it('attaches a single uploaded image by its stored URL', async () => {
      const token = await login();
      social.calls.length = 0;

      await handle(
        authed('/api/v1/statuses', token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'one picture',
            media_ids: [encodeId('https://s.example/a.png')],
          }),
        }),
      );

      expect(social.calls[0]?.args[0]).toMatchObject({
        content: 'one picture',
        image: { url: 'https://s.example/a.png' },
      });
    });

    it('sends scheduled_at to the queue instead of publishing now', async () => {
      const token = await login();
      social.calls.length = 0;

      const response = await handle(
        authed('/api/v1/statuses', token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'later', scheduled_at: '2099-01-01T00:00:00Z' }),
        }),
      );

      expect(response.status).toBe(200);
      expect(social.calls).toHaveLength(0);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.scheduled_at).toBe('2099-01-01T00:00:00.000Z');
      expect(await Queue.open(dir.path).list()).toHaveLength(1);
    });

    it('deletes through to Ghost on the decoded id', async () => {
      const token = await login();
      social.calls.length = 0;
      const apId = 'https://example.com/.ghost/activitypub/note/7';

      const response = await handle(
        authed(`/api/v1/statuses/${encodeId(apId)}`, token, { method: 'DELETE' }),
      );

      expect(response.status).toBe(200);
      expect(social.calls).toEqual([{ method: 'deletePost', args: [apId] }]);
    });

    it('maps favourite and reblog onto like and repost', async () => {
      const token = await login();
      social.calls.length = 0;
      const id = encodeId('https://example.com/.ghost/activitypub/note/7');

      await handle(authed(`/api/v1/statuses/${id}/favourite`, token, { method: 'POST' }));
      await handle(authed(`/api/v1/statuses/${id}/reblog`, token, { method: 'POST' }));

      expect(social.calls.map((call) => call.method)).toEqual(['like', 'repost']);
    });
  });

  describe('media', () => {
    it('uploads to Ghost and returns an attachment the client can attach', async () => {
      const token = await login();
      social.calls.length = 0;

      const form = new FormData();
      form.set('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'card.png');
      form.set('description', 'a card');

      const response = await handle(
        authed('/api/v2/media', token, { method: 'POST', body: form }),
      );

      expect(response.status).toBe(200);
      expect(social.calls[0]).toEqual({
        method: 'uploadImage',
        args: ['card.png', 'image/png', 3],
      });

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.url).toBe('https://storage.example.com/images/card.png');
      expect(body.description).toBe('a card');
      expect(decodeId(String(body.id))).toBe('https://storage.example.com/images/card.png');
    });

    it('rejects an upload with no file', async () => {
      const token = await login();
      const response = await handle(
        authed('/api/v2/media', token, { method: 'POST', body: new FormData() }),
      );
      expect(response.status).toBe(422);
    });
  });

  describe('reading', () => {
    it('maps the reader feed onto the home timeline', async () => {
      const token = await login();
      const response = await handle(authed('/api/v1/timelines/home', token));

      expect(response.status).toBe(200);
      const body = (await response.json()) as Array<Record<string, unknown>>;
      expect(body).toHaveLength(1);
      expect(body[0]?.content).toBe('Hello fediverse');
    });

    it('advertises the next page through a Link header', async () => {
      const token = await login();
      const response = await handle(authed('/api/v1/timelines/home', token));
      expect(response.headers.get('link')).toContain('max_id=cursor-2');
    });

    it('maps a like notification onto a favourite', async () => {
      const token = await login();
      const response = await handle(authed('/api/v1/notifications', token));
      const body = (await response.json()) as Array<Record<string, unknown>>;
      expect(body[0]?.type).toBe('favourite');
    });

    it('answers the endpoints clients probe on connect', async () => {
      const token = await login();
      for (const path of ['/api/v1/filters', '/api/v1/lists', '/api/v1/announcements']) {
        const response = await handle(authed(path, token));
        expect(response.status, path).toBe(200);
        expect(await response.json(), path).toEqual([]);
      }
    });
  });

  describe('profiles', () => {
    async function ownId(token: string): Promise<string> {
      const response = await handle(authed('/api/v1/accounts/verify_credentials', token));
      return ((await response.json()) as { id: string }).id;
    }

    it('gives an account the same id in verify_credentials and on its posts', async () => {
      const token = await login();
      const id = await ownId(token);
      const home = await handle(authed('/api/v1/timelines/home', token));
      const [status] = (await home.json()) as Array<{ account: { id: string } }>;
      expect(status?.account.id).toBe(id);
      expect(decodeAccountId(id)).toEqual({ handle: '@scott@example.com' });
    });

    it('serves the publication itself from Ghost\'s "me" account', async () => {
      const token = await login();
      const response = await handle(authed(`/api/v1/accounts/${await ownId(token)}`, token));
      expect(response.status).toBe(200);
      expect(((await response.json()) as { acct: string }).acct).toBe('scott@example.com');
      expect(social.calls.filter((call) => call.method === 'account')).toEqual([]);
    });

    it('lists the publication\'s own posts from its outbox', async () => {
      const token = await login();
      const response = await handle(
        authed(`/api/v1/accounts/${await ownId(token)}/statuses?limit=5`, token),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as Array<{ content: string }>;
      expect(body[0]?.content).toBe('Hello fediverse');
      expect(social.calls.find((call) => call.method === 'posts')?.args).toEqual([
        'me',
        { limit: 5 },
      ]);
      expect(response.headers.get('link')).toContain('max_id=posts-cursor-2');
    });

    it('asks Ghost about another account by its handle', async () => {
      const token = await login();
      const id = encodeAccountId('@murat@muratcorlu.com');

      const account = await handle(authed(`/api/v1/accounts/${id}`, token));
      expect(account.status).toBe(200);
      expect(social.calls.find((call) => call.method === 'account')?.args).toEqual([
        '@murat@muratcorlu.com',
      ]);

      const statuses = await handle(authed(`/api/v1/accounts/${id}/statuses`, token));
      expect(statuses.status).toBe(200);
      expect(social.calls.find((call) => call.method === 'posts')?.args[0]).toBe(
        '@murat@muratcorlu.com',
      );
    });

    it('pages on from the id of the last status, not only from the Link header', async () => {
      const token = await login();
      const id = await ownId(token);
      const first = await handle(authed(`/api/v1/accounts/${id}/statuses`, token));
      const [last] = (await first.json()) as Array<{ id: string }>;

      const second = await handle(
        authed(`/api/v1/accounts/${id}/statuses?max_id=${last?.id}`, token),
      );
      expect(second.status).toBe(200);
      const calls = social.calls.filter((call) => call.method === 'posts');
      expect(calls[1]?.args[1]).toMatchObject({ next: 'posts-cursor-2' });
    });

    it('ends the list rather than send Ghost a status id it cannot page from', async () => {
      const token = await login();
      const maxId = encodeId('https://example.com/.ghost/activitypub/note/99');
      const response = await handle(
        authed(`/api/v1/accounts/${await ownId(token)}/statuses?max_id=${maxId}`, token),
      );
      expect(await response.json()).toEqual([]);
      expect(social.calls.some((call) => call.method === 'posts')).toBe(false);
    });

    it('maps another server\'s posts in the raw shape Ghost passes through', async () => {
      const token = await login();
      // As Ghost relays a remote outbox: compacted JSON-LD, so a lone attachment
      // is an object rather than a list, url can be a Link, mediaType can be absent.
      const remote = {
        ...makePost({
          id: 'https://mastodon.social/users/adactio/statuses/1',
          author: {
            id: 'https://mastodon.social/users/adactio',
            name: 'Jeremy Keith',
            handle: '@adactio@mastodon.social',
            avatarUrl: '',
            url: 'https://mastodon.social/users/adactio',
            followedByMe: true,
          },
        }),
        url: [{ type: 'Link', href: 'https://mastodon.social/@adactio/1' }],
        attachments: { type: 'Document', url: 'https://files.example/a.mp4', name: null },
      } as unknown as Post;
      const broken = { id: 42, author: null } as unknown as Post;
      social.postsPage = { items: [remote, broken, makePost()], next: null };

      const id = encodeAccountId('@adactio@mastodon.social');
      const response = await handle(authed(`/api/v1/accounts/${id}/statuses`, token));

      expect(response.status).toBe(200);
      const body = (await response.json()) as Array<{
        url: string;
        media_attachments: Array<{ url: string; type: string }>;
        account: { id: string };
      }>;
      expect(body).toHaveLength(2);
      expect(body[0]?.url).toBe('https://mastodon.social/@adactio/1');
      expect(body[0]?.media_attachments).toEqual([
        expect.objectContaining({ url: 'https://files.example/a.mp4', type: 'unknown' }),
      ]);
      expect(body[0]?.account.id).toBe(id);
    });

    it('answers pinned with an empty list, because Ghost has no pins', async () => {
      const token = await login();
      const response = await handle(
        authed(`/api/v1/accounts/${await ownId(token)}/statuses?pinned=true`, token),
      );
      expect(await response.json()).toEqual([]);
    });

    it('still resolves the publication from an id an older build issued', async () => {
      const token = await login();
      const legacy = encodeId('https://example.com/.ghost/activitypub/users/index');
      const response = await handle(authed(`/api/v1/accounts/${legacy}/statuses`, token));
      expect(response.status).toBe(200);
    });

    it('404s an id it cannot turn into a handle', async () => {
      const token = await login();
      const response = await handle(authed('/api/v1/accounts/MTIz', token));
      expect(response.status).toBe(404);
    });

    it('reports relationships from what Ghost says about each account', async () => {
      const token = await login();
      const id = encodeAccountId('@alice@social.example');
      const response = await handle(
        authed(`/api/v1/accounts/relationships?id[]=${id}`, token),
      );
      expect(response.status).toBe(200);
      const [relationship] = (await response.json()) as Array<Record<string, unknown>>;
      expect(relationship).toMatchObject({ id, following: false, blocking: false });
    });

    it('lists followers and following', async () => {
      const token = await login();
      const id = await ownId(token);
      for (const type of ['followers', 'following']) {
        const response = await handle(authed(`/api/v1/accounts/${id}/${type}`, token));
        expect(response.status, type).toBe(200);
        const [account] = (await response.json()) as Array<{ acct: string }>;
        expect(account?.acct).toBe('alice@social.example');
      }
    });

    it('follows by handle', async () => {
      const token = await login();
      const id = encodeAccountId('@alice@social.example');
      const response = await handle(
        authed(`/api/v1/accounts/${id}/follow`, token, { method: 'POST' }),
      );
      expect(((await response.json()) as { following: boolean }).following).toBe(true);
      expect(social.calls.find((call) => call.method === 'follow')?.args).toEqual([
        '@alice@social.example',
      ]);
    });

    it('fills a post author with the full account, so its profile has counts', async () => {
      const token = await login();
      social.postsPage = {
        items: [
          makePost({
            id: 'https://mastodon.social/users/smallseasons/statuses/1',
            author: {
              id: 'https://mastodon.social/users/smallseasons',
              name: 'Small Seasons Bot',
              handle: '@smallseasons@mastodon.social',
              avatarUrl: '',
              url: 'https://mastodon.social/@smallseasons',
              followedByMe: true,
            },
          }),
        ],
        next: null,
      };
      social.accounts.set(
        '@smallseasons@mastodon.social',
        makeAccount({
          handle: '@smallseasons@mastodon.social',
          followerCount: 106,
          followingCount: 1,
          postCount: 250,
        }),
      );
      joinDates.set(
        'https://mastodon.social/api/v1/accounts/lookup?acct=smallseasons',
        '2024-11-12T00:00:00.000Z',
      );

      const id = encodeAccountId('@smallseasons@mastodon.social');
      const response = await handle(authed(`/api/v1/accounts/${id}/statuses`, token));
      const [status] = (await response.json()) as Array<{ account: Record<string, unknown> }>;
      expect(status?.account).toMatchObject({
        id,
        followers_count: 106,
        following_count: 1,
        statuses_count: 250,
        created_at: '2024-11-12T00:00:00.000Z',
      });
    });

    it('asks an account\'s own server when it joined', async () => {
      const token = await login();
      joinDates.set(
        'https://social.example/api/v1/accounts/lookup?acct=alice',
        '2022-10-30T00:00:00.000Z',
      );
      const id = encodeAccountId('@alice@social.example');
      const response = await handle(authed(`/api/v1/accounts/${id}`, token));
      expect(((await response.json()) as { created_at: string }).created_at).toBe(
        '2022-10-30T00:00:00.000Z',
      );
    });

    it('falls back to the epoch when no join date can be found', async () => {
      const token = await login();
      const id = encodeAccountId('@alice@social.example');
      const response = await handle(authed(`/api/v1/accounts/${id}`, token));
      expect(response.status).toBe(200);
      expect(((await response.json()) as { created_at: string }).created_at).toBe(
        new Date(0).toISOString(),
      );
    });

    it('does not ask the publication\'s own site for a Mastodon API it lacks', async () => {
      const token = await login();
      await handle(authed(`/api/v1/accounts/${await ownId(token)}`, token));
      await handle(authed('/api/v1/timelines/home', token));
      expect(fetched).toEqual([]);
    });

    it('looks an account up by acct', async () => {
      const token = await login();
      const response = await handle(
        authed('/api/v1/accounts/lookup?acct=alice@social.example', token),
      );
      expect(response.status).toBe(200);
      expect(social.calls.find((call) => call.method === 'account')?.args).toEqual([
        '@alice@social.example',
      ]);
    });
  });

  describe('threads and favourites', () => {
    const parentId = 'https://social.example/users/stu/statuses/1';
    const postId = 'https://social.example/users/stu/statuses/2';

    it('fetches a single status by its id', async () => {
      const token = await login();
      const response = await handle(authed(`/api/v1/statuses/${encodeId(postId)}`, token));
      expect(response.status).toBe(200);
      expect(((await response.json()) as { uri: string }).uri).toBe(postId);
      expect(social.calls.find((call) => call.method === 'post')?.args).toEqual([postId]);
    });

    it('404s a status Ghost cannot find', async () => {
      const token = await login();
      social.failNext = new SocialWebError('GET v1/post failed: 404', 404);
      const response = await handle(authed(`/api/v1/statuses/${encodeId(postId)}`, token));
      expect(response.status).toBe(404);
    });

    it('maps the thread onto ancestors and descendants linked by in_reply_to_id', async () => {
      const token = await login();
      const reply = 'https://example.com/.ghost/activitypub/note/3';
      const answer = 'https://social.example/users/stu/statuses/4';
      social.threadResult = {
        ancestors: { chain: [makePost({ id: parentId })], hasMore: false },
        post: makePost({ id: postId }),
        children: [
          {
            post: makePost({ id: reply }),
            chain: [makePost({ id: answer })],
            hasMore: false,
          },
        ],
        next: null,
      };

      const response = await handle(
        authed(`/api/v1/statuses/${encodeId(postId)}/context`, token),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        ancestors: Array<{ uri: string; in_reply_to_id: string | null }>;
        descendants: Array<{ uri: string; in_reply_to_id: string | null }>;
      };
      expect(body.ancestors).toEqual([
        expect.objectContaining({ uri: parentId, in_reply_to_id: null }),
      ]);
      expect(body.descendants).toEqual([
        expect.objectContaining({ uri: reply, in_reply_to_id: encodeId(postId) }),
        expect.objectContaining({ uri: answer, in_reply_to_id: encodeId(reply) }),
      ]);
    });

    it('leaves deleted posts out of a thread', async () => {
      const token = await login();
      social.threadResult = {
        ancestors: { chain: [makePost({ id: parentId, type: 2, content: '' })], hasMore: false },
        post: makePost({ id: postId }),
        children: [],
        next: null,
      };
      const response = await handle(
        authed(`/api/v1/statuses/${encodeId(postId)}/context`, token),
      );
      expect(await response.json()).toEqual({ ancestors: [], descendants: [] });
    });

    it('shows a post Ghost has no thread for on its own, not as deleted', async () => {
      const token = await login();
      social.threadResult = new SocialWebError('GET v1/replies failed: 404', 404);
      const response = await handle(
        authed(`/api/v1/statuses/${encodeId(postId)}/context`, token),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ancestors: [], descendants: [] });
    });

    it('lists the publication\'s liked posts as its favourites', async () => {
      const token = await login();
      const response = await handle(authed('/api/v1/favourites?limit=10', token));
      expect(response.status).toBe(200);
      const [status] = (await response.json()) as Array<{ favourited: boolean }>;
      expect(status?.favourited).toBe(true);
      expect(social.calls.find((call) => call.method === 'liked')?.args).toEqual([
        { limit: 10 },
      ]);
      expect(response.headers.get('link')).toContain('max_id=liked-cursor-2');
    });
  });

  it('answers an unknown route with 404 rather than a stack trace', async () => {
    const response = await handle(new Request('https://desk.example/api/v1/nope'));
    expect(response.status).toBe(404);
  });
});

describe('parseWebfingerResource', () => {
  it('reads the forms that turn up in the wild', () => {
    expect(parseWebfingerResource('acct:scott@example.com')).toEqual({
      username: 'scott',
      host: 'example.com',
    });
    expect(parseWebfingerResource('scott@example.com')).toEqual({
      username: 'scott',
      host: 'example.com',
    });
    expect(parseWebfingerResource('acct:@scott@example.com')).toEqual({
      username: 'scott',
      host: 'example.com',
    });
    expect(parseWebfingerResource('https://example.com/@scott')).toEqual({
      username: 'scott',
      host: 'example.com',
    });
  });

  it('lowercases the host but leaves the username alone', () => {
    expect(parseWebfingerResource('acct:Scott@EXAMPLE.com')).toEqual({
      username: 'Scott',
      host: 'example.com',
    });
  });

  it('returns null for anything it cannot read', () => {
    for (const value of ['', '   ', 'nonsense', 'acct:', '@example.com', 'https://']) {
      expect(parseWebfingerResource(value), value).toBeNull();
    }
  });
});
