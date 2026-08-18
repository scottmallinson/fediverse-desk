import type { Queue } from '../scheduler/queue.js';
import type { SocialWeb } from '../ghost/types.js';
import {
  LoginThrottle,
  OAuthError,
  OAuthServer,
  OOB_REDIRECT,
} from './oauth.js';
import {
  decodeId,
  encodeId,
  toAccount,
  toInstance,
  toMedia,
  toNodeInfo,
  toNodeInfoLinks,
  toNotification,
  toStatus,
} from './mastodon.js';
import {
  Router,
  error,
  html,
  json,
  many,
  one,
  readParams,
  type RouteContext,
} from './router.js';

export interface ShimDependencies {
  social: SocialWeb;
  oauth: OAuthServer;
  queue: Queue;
  publicUrl: string;
  version: string;
  /** The Ghost site the bridge fronts. Reported in nodeinfo metadata. */
  ghostUrl: string;
  throttle?: LoginThrottle;
}

const AUTHENTICATED_PREFIX = '/api/v1/';

/**
 * A Mastodon-compatible facade over one Ghost publication.
 *
 * Worth being clear about what this is: a control plane, not an identity. A
 * client authenticating here sees an account that lives at the shim's domain,
 * but every note it posts federates from the Ghost actor on the real site.
 * Followers, replies and reputation stay on the one handle. Nothing here creates
 * a second account, and nothing here should be described to a client as if it
 * did.
 */
export function createApp(dependencies: ShimDependencies): (request: Request) => Promise<Response> {
  const { social, oauth, queue, publicUrl, version, ghostUrl } = dependencies;
  const throttle = dependencies.throttle ?? new LoginThrottle();
  const router = new Router();

  // Idempotency-Key is how Mastodon clients avoid double posts on a retry.
  // Honouring it costs a Map and saves a duplicate note on a flaky connection.
  const idempotency = new Map<string, unknown>();

  async function currentAccount() {
    return toAccount(await social.me());
  }

  // --- instance metadata, unauthenticated -----------------------------------

  const instanceHandler = async () => {
    let account = null;
    try {
      account = await currentAccount();
    } catch {
      // An unreachable Ghost should not stop a client from discovering the
      // instance: it needs this response to know where to send its login.
    }
    return json(toInstance({ publicUrl, account, version }));
  };

  router.get('/api/v1/instance', instanceHandler);
  router.get('/api/v2/instance', instanceHandler);
  router.get('/api/v1/instance/peers', () => json([]));
  router.get('/api/v1/custom_emojis', () => json([]));

  // Checked before login, and before /api/v1/instance. See toNodeInfo.
  router.get('/.well-known/nodeinfo', () => json(toNodeInfoLinks(publicUrl)));
  router.get('/nodeinfo/2.0', async () => {
    let account = null;
    try {
      account = await currentAccount();
    } catch {
      // Same reasoning as the instance route: discovery must not depend on Ghost
      // being reachable this second.
    }
    return json(toNodeInfo({ account, version, ghostUrl }));
  });

  // --- OAuth ----------------------------------------------------------------

  router.post('/api/v1/apps', async ({ request }) => {
    const params = await readParams(request);
    const redirectUris = [
      ...many(params, 'redirect_uris'),
      ...many(params, 'redirect_uri'),
    ].filter(Boolean);

    const { app, clientSecret } = await oauth.registerApp({
      name: one(params, 'client_name') ?? '',
      redirectUris,
      scopes: one(params, 'scopes') ?? 'read write',
      website: one(params, 'website') ?? null,
    });

    return json({
      id: app.id,
      name: app.name,
      website: app.website,
      redirect_uri: app.redirectUris.join('\n'),
      redirect_uris: app.redirectUris,
      client_id: app.clientId,
      client_secret: clientSecret,
      scopes: app.scopes.split(' '),
      vapid_key: '',
    });
  });

  router.get('/oauth/authorize', async ({ url }) => {
    const clientId = url.searchParams.get('client_id') ?? '';
    const redirectUri = url.searchParams.get('redirect_uri') ?? '';
    const scope = url.searchParams.get('scope') ?? 'read write';
    const state = url.searchParams.get('state') ?? '';

    const app = await oauth.checkRedirect(clientId, redirectUri);
    return html(loginPage({ app: app.name, clientId, redirectUri, scope, state }));
  });

  router.post('/oauth/authorize', async ({ request }) => {
    const params = await readParams(request);
    const clientId = one(params, 'client_id') ?? '';
    const redirectUri = one(params, 'redirect_uri') ?? '';
    const scope = one(params, 'scope') ?? 'read write';
    const state = one(params, 'state') ?? '';
    const password = one(params, 'password') ?? '';

    const app = await oauth.checkRedirect(clientId, redirectUri);

    if (throttle.isLocked(clientId)) {
      return html(
        loginPage({
          app: app.name,
          clientId,
          redirectUri,
          scope,
          state,
          message: 'Too many attempts. Wait fifteen minutes and try again.',
        }),
        { status: 429 },
      );
    }

    if (!oauth.checkPassword(password)) {
      throttle.recordFailure(clientId);
      return html(
        loginPage({
          app: app.name,
          clientId,
          redirectUri,
          scope,
          state,
          message: 'That password was not right.',
        }),
        { status: 401 },
      );
    }

    throttle.reset(clientId);
    const code = await oauth.issueCode(clientId, redirectUri, scope);

    if (redirectUri === OOB_REDIRECT) {
      return html(oobPage(code));
    }

    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    if (state) target.searchParams.set('state', state);
    return new Response(null, { status: 302, headers: { Location: target.toString() } });
  });

  router.post('/oauth/token', async ({ request }) => {
    const params = await readParams(request);
    const grantType = one(params, 'grant_type') ?? 'authorization_code';
    const clientId = one(params, 'client_id') ?? '';
    const clientSecret = one(params, 'client_secret') ?? '';

    if (grantType === 'client_credentials') {
      const app = await oauth.findApp(clientId);
      if (!app) throw new OAuthError('invalid_client', 'Unknown client_id.', 401);
      const token = await oauth.issueToken(clientId, 'read');
      return json({
        access_token: token,
        token_type: 'Bearer',
        scope: 'read',
        created_at: Math.floor(Date.now() / 1000),
      });
    }

    if (grantType !== 'authorization_code') {
      throw new OAuthError('unsupported_grant_type', `${grantType} is not supported.`);
    }

    const { accessToken, scope } = await oauth.exchangeCode({
      clientId,
      clientSecret,
      code: one(params, 'code') ?? '',
      redirectUri: one(params, 'redirect_uri') ?? '',
    });

    return json({
      access_token: accessToken,
      token_type: 'Bearer',
      scope,
      created_at: Math.floor(Date.now() / 1000),
    });
  });

  router.post('/oauth/revoke', async ({ request }) => {
    const params = await readParams(request);
    await oauth.revokeToken(one(params, 'token') ?? '');
    return json({});
  });

  // --- accounts -------------------------------------------------------------

  router.get('/api/v1/accounts/verify_credentials', async () => {
    const account = await currentAccount();
    return json({ ...account, source: { note: account.note, fields: account.fields } });
  });

  router.get('/api/v1/apps/verify_credentials', () =>
    json({ name: 'fediverse-desk', website: null, vapid_key: '' }),
  );

  router.get('/api/v1/accounts/:id', async ({ params }) => {
    const account = await social.account(decodeId(params.id as string));
    return json(toAccount(account));
  });

  // --- statuses -------------------------------------------------------------

  router.post('/api/v1/statuses', async ({ request }) => {
    const key = request.headers.get('idempotency-key');
    if (key && idempotency.has(key)) {
      return json(idempotency.get(key));
    }

    const params = await readParams(request);
    const status = (one(params, 'status') ?? '').trim();
    const mediaIds = many(params, 'media_ids');
    const inReplyTo = one(params, 'in_reply_to_id');
    const scheduledAt = one(params, 'scheduled_at');

    if (!status && mediaIds.length === 0) {
      return error('Cannot post an empty status.', 422);
    }

    // Ghost's note API takes at most one image, so extra attachments would be
    // silently dropped. Say so instead.
    if (mediaIds.length > 1) {
      return error('Ghost accepts one image per note. Post the rest separately.', 422);
    }

    const image = mediaIds[0]
      ? { url: decodeId(mediaIds[0]), altText: one(params, 'spoiler_text') }
      : undefined;

    if (scheduledAt) {
      const when = new Date(scheduledAt);
      if (Number.isNaN(when.getTime())) return error('scheduled_at is not a date.', 422);
      const item = await queue.add({
        content: status,
        publishAt: when,
        ...(inReplyTo ? { replyTo: decodeId(inReplyTo) } : {}),
      });
      return json({
        id: item.id,
        scheduled_at: item.publishAt,
        params: { text: status, visibility: 'public' },
        media_attachments: [],
      });
    }

    const input = image ? { content: status, image } : { content: status };
    const post = inReplyTo
      ? await social.reply(decodeId(inReplyTo), input)
      : await social.note(input);

    const body = toStatus(post, { inReplyTo: inReplyTo ? decodeId(inReplyTo) : null });
    if (key) idempotency.set(key, body);
    return json(body);
  });

  router.delete('/api/v1/statuses/:id', async ({ params }) => {
    const apId = decodeId(params.id as string);
    await social.deletePost(apId);
    return json({});
  });

  router.post('/api/v1/statuses/:id/favourite', async ({ params }) => {
    await social.like(decodeId(params.id as string));
    return json({ id: params.id, favourited: true });
  });

  router.post('/api/v1/statuses/:id/unfavourite', async ({ params }) => {
    await social.unlike(decodeId(params.id as string));
    return json({ id: params.id, favourited: false });
  });

  router.post('/api/v1/statuses/:id/reblog', async ({ params }) => {
    await social.repost(decodeId(params.id as string));
    return json({ id: params.id, reblogged: true });
  });

  router.post('/api/v1/statuses/:id/unreblog', async ({ params }) => {
    await social.derepost(decodeId(params.id as string));
    return json({ id: params.id, reblogged: false });
  });

  // --- media ----------------------------------------------------------------

  const mediaHandler = async ({ request }: RouteContext) => {
    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) return error('No file was uploaded.', 422);

    const bytes = new Uint8Array(await file.arrayBuffer());
    const url = await social.uploadImage(bytes, file.name || 'upload', file.type);
    const description = form?.get('description');
    return json(toMedia(url, typeof description === 'string' ? description : null));
  };

  router.post('/api/v1/media', mediaHandler);
  router.post('/api/v2/media', mediaHandler);

  // --- timelines and notifications -----------------------------------------

  router.get('/api/v1/timelines/home', async ({ url }) => {
    const page = await social.readerFeed({
      limit: numberParam(url, 'limit', 20),
      ...(url.searchParams.get('max_id') ? { next: url.searchParams.get('max_id') as string } : {}),
    });
    return json(page.items.map((post) => toStatus(post)), linkHeader(url, page.next));
  });

  router.get('/api/v1/timelines/public', async ({ url }) => {
    const page = await social.notesFeed({ limit: numberParam(url, 'limit', 20) });
    return json(page.items.map((post) => toStatus(post)), linkHeader(url, page.next));
  });

  router.get('/api/v1/notifications', async ({ url }) => {
    const page = await social.notifications({ limit: numberParam(url, 'limit', 20) });
    return json(page.items.map(toNotification), linkHeader(url, page.next));
  });

  // Endpoints clients probe on connect. Answering with the empty shape keeps
  // them from treating the instance as broken.
  router.get('/api/v1/filters', () => json([]));
  router.get('/api/v2/filters', () => json([]));
  router.get('/api/v1/lists', () => json([]));
  router.get('/api/v1/announcements', () => json([]));
  router.get('/api/v1/markers', () => json({}));
  router.get('/api/v1/preferences', () =>
    json({ 'posting:default:visibility': 'public', 'posting:default:sensitive': false }),
  );

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      const match = router.match(request.method, url.pathname);
      if (!match) return error('Not found', 404);

      if (url.pathname.startsWith(AUTHENTICATED_PREFIX) && !isPublic(url.pathname)) {
        const token = bearer(request);
        if (!token || !(await oauth.verifyToken(token))) {
          return error('The access token is invalid', 401);
        }
      }

      return await match.handler({ request, url, params: match.params });
    } catch (thrown) {
      if (thrown instanceof OAuthError) {
        return json(
          { error: thrown.code, error_description: thrown.message },
          { status: thrown.status },
        );
      }
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      return error(message, 500);
    }
  };
}

const PUBLIC_PATHS = new Set([
  '/api/v1/instance',
  '/api/v2/instance',
  '/api/v1/instance/peers',
  '/api/v1/apps',
  '/api/v1/custom_emojis',
]);

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname);
}

function bearer(request: Request): string | null {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() ?? null;
}

function numberParam(url: URL, key: string, fallback: number): number {
  const raw = url.searchParams.get(key);
  const value = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 40) : fallback;
}

/** Mastodon clients page by following the Link header rather than a body field. */
function linkHeader(url: URL, next: string | null): ResponseInit {
  if (!next) return {};
  const target = new URL(url.toString());
  target.searchParams.set('max_id', next);
  return { headers: { Link: `<${target.toString()}>; rel="next"` } };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loginPage(options: {
  app: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  message?: string;
}): string {
  const hidden = (name: string, value: string) =>
    `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Authorise ${escapeHtml(options.app)}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; }
  label { display: block; margin: 1rem 0 0.25rem; }
  input[type=password] { width: 100%; padding: 0.5rem; font-size: 1rem; }
  button { margin-top: 1rem; padding: 0.5rem 1rem; font-size: 1rem; }
  .note { color: #555; font-size: 0.9rem; }
  .message { color: #a00; }
</style>
</head>
<body>
<h1>Authorise ${escapeHtml(options.app)}</h1>
<p class="note">
  This grants <strong>${escapeHtml(options.app)}</strong> permission to post as your
  publication's Fediverse handle. Posts will federate from your site, not from this bridge.
</p>
${options.message ? `<p class="message">${escapeHtml(options.message)}</p>` : ''}
<form method="post" action="/oauth/authorize">
  ${hidden('client_id', options.clientId)}
  ${hidden('redirect_uri', options.redirectUri)}
  ${hidden('scope', options.scope)}
  ${hidden('state', options.state)}
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
  <button type="submit">Authorise</button>
</form>
</body>
</html>`;
}

function oobPage(code: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><title>Authorisation code</title></head>
<body style="font: 16px/1.5 system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem;">
<h1>Authorisation code</h1>
<p>Paste this into the client that sent you here. It expires in five minutes.</p>
<pre style="padding: 1rem; background: #f4f4f4; overflow-wrap: anywhere; white-space: pre-wrap;">${escapeHtml(code)}</pre>
</body>
</html>`;
}

export { encodeId, decodeId };
