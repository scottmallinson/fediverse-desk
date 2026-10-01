import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/shim/app.js';
import {
  decodeId,
  encodeId,
  parseWebfingerResource,
  toStatus,
} from '../src/shim/mastodon.js';
import { LoginThrottle, OAuthServer, OOB_REDIRECT } from '../src/shim/oauth.js';
import { Queue } from '../src/scheduler/queue.js';
import { FakeSocialWeb, makePost, tempDir } from './helpers.js';

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

  beforeEach(async () => {
    dir = await tempDir();
    social = new FakeSocialWeb();
    oauth = OAuthServer.open(dir.path, PASSWORD);
    handle = createApp({
      social,
      oauth,
      queue: Queue.open(dir.path),
      publicUrl: 'https://desk.example',
      version: 'test',
      ghostUrl: 'https://example.com',
      throttle: new LoginThrottle(3, 60_000),
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
