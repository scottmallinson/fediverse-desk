import type { Queue } from '../scheduler/queue.js';
import { SocialWebError } from '../ghost/direct.js';
import type { Fetcher } from '../ghost/identity.js';
import type { Account, SocialWeb } from '../ghost/types.js';
import {
  LoginThrottle,
  OAuthError,
  OAuthServer,
  OOB_REDIRECT,
} from './oauth.js';
import {
  decodeAccountId,
  decodeId,
  encodeId,
  toAccount,
  toContext,
  toRelationship,
  toInstance,
  toInstanceV2,
  toMedia,
  toNodeInfo,
  toNodeInfoLinks,
  toWebfinger,
  parseWebfingerResource,
  toNotification,
  toStatus,
  type MastodonAccount,
  type MastodonStatus,
} from './mastodon.js';
import { ProfileDirectory, within } from './profiles.js';
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
  /** Asks other servers when an account joined. Tests pass one that never connects. */
  fetcher?: Fetcher;
}

const AUTHENTICATED_PREFIX = '/api/v1/';

// How long a response will wait on a profile lookup before going without it.
// A lookup still running carries on and fills the cache for the next request.
const PROFILE_BUDGET_MS = 3000;
const AUTHOR_BUDGET_MS = 1500;

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

  // The publication's own handle and ActivityPub id, learned once. Neither
  // changes while the process runs, and asking Ghost on every profile request
  // would double the calls behind each one.
  let self: Promise<{ handle: string; apId: string }> | null = null;
  function selfIdentity() {
    self ??= social.me().then(
      (account) => ({ handle: account.handle.toLowerCase(), apId: account.apId }),
      (thrown) => {
        self = null;
        throw thrown;
      },
    );
    return self;
  }

  /**
   * The handle Ghost should be asked about for a Mastodon account id: "me" for
   * the publication itself, whose posts come from its outbox rather than a
   * webfinger round trip to its own domain. Null for an id this bridge did not
   * issue, or one from an older build that cannot be turned into a handle.
   */
  async function accountHandle(id: string): Promise<string | null> {
    const decoded = decodeAccountId(id);
    if (!decoded) return null;
    const own = await selfIdentity();
    if ('apId' in decoded) return decoded.apId === own.apId ? 'me' : null;
    return decoded.handle.toLowerCase() === own.handle ? 'me' : decoded.handle;
  }

  async function lookupAccount(handle: string): Promise<Account> {
    return handle === 'me' ? social.me() : social.account(handle);
  }

  async function isSelf(handle: string): Promise<boolean> {
    const own = await selfIdentity();
    return `@${handle.replace(/^@/, '').toLowerCase()}` === `@${own.handle.replace(/^@/, '')}`;
  }

  const profiles = new ProfileDirectory(
    async (handle) =>
      lookupAccount((await isSelf(handle)) ? 'me' : `@${handle.replace(/^@/, '')}`),
    dependencies.fetcher,
  );

  /** Ghost's own site has no Mastodon API to ask, so the publication has no join date. */
  async function joinedAt(handle: string): Promise<string | null> {
    return (await isSelf(handle).catch(() => true)) ? null : profiles.joinedAt(handle);
  }

  /** A full account as Mastodon shows it, with its join date if it arrives in time. */
  async function present(account: Account): Promise<MastodonAccount> {
    profiles.remember(account);
    const createdAt = await within(joinedAt(account.handle), PROFILE_BUDGET_MS, null);
    return toAccount(account, { createdAt });
  }

  /**
   * Swaps each status's bare author for the full account, so a profile opened
   * from a post shows real counts and a join date. Authors that take too long
   * keep the bare record this time round.
   */
  async function withAuthors(statuses: MastodonStatus[]): Promise<MastodonStatus[]> {
    const accounts = await fullAccounts(statuses.map((status) => status.account.acct));
    return statuses.map((status) => {
      const account = accounts.get(status.account.acct);
      return account ? { ...status, account } : status;
    });
  }

  async function fullAccounts(handles: string[]): Promise<Map<string, MastodonAccount>> {
    const unique = [...new Set(handles.filter(Boolean))];
    const found = await Promise.all(
      unique.map(async (handle) => {
        const [account, createdAt] = await Promise.all([
          within(profiles.account(handle), AUTHOR_BUDGET_MS, null),
          within(joinedAt(handle), AUTHOR_BUDGET_MS, null),
        ]);
        return [handle, account ? toAccount(account, { createdAt }) : null] as const;
      }),
    );
    return new Map(
      found.filter((entry): entry is readonly [string, MastodonAccount] => entry[1] !== null),
    );
  }

  // Mastodon clients page with max_id in one of two ways: by following the Link
  // header, which carries Ghost's own cursor, or by sending the id of the last
  // item they were given, which Ghost has never heard of. The second is mapped
  // back to the cursor that page ended on.
  const cursors = new CursorMemory();

  /** Ghost's cursor for a request, or "end" when there is no way to continue. */
  function pageCursor(url: URL): { next?: string } | 'end' {
    const maxId = url.searchParams.get('max_id');
    if (!maxId) return {};
    if (maxId === END_OF_FEED) return 'end';
    const remembered = cursors.get(maxId);
    if (remembered) return { next: remembered };
    // One of our own ids that was not the end of a page we served. Passing it to
    // Ghost as a cursor would be an error, and there is nothing older to find.
    return isIssuedId(maxId) ? 'end' : { next: maxId };
  }

  function rememberPage(ids: string[], next: string | null): void {
    if (!next) return;
    const last = ids[ids.length - 1];
    if (last) cursors.set(last, next);
  }

  // --- instance metadata, unauthenticated -----------------------------------

  const instanceHandler = (render: typeof toInstance) => async () => {
    let account = null;
    try {
      account = await currentAccount();
    } catch {
      // An unreachable Ghost should not stop a client from discovering the
      // instance: it needs this response to know where to send its login.
    }
    return json(render({ publicUrl, account, version }));
  };

  router.get('/api/v1/instance', instanceHandler(toInstance));
  router.get('/api/v2/instance', instanceHandler(toInstanceV2));
  router.get('/api/v1/instance/peers', () => json([]));
  router.get('/api/v1/custom_emojis', () => json([]));

  router.get('/.well-known/webfinger', async ({ url }) => {
    const resource = url.searchParams.get('resource') ?? '';
    const parsed = parseWebfingerResource(resource);
    if (!parsed) return error('resource is missing or malformed', 400);

    let account;
    try {
      account = await social.me();
    } catch {
      // We cannot answer authoritatively without Ghost, and a 404 here would be
      // a lie a client might cache. Say "try again" instead.
      return error('Cannot reach the upstream publication', 503);
    }

    // One account, so the only question is whether the query is asking for it.
    // Both the bridge's own host and the publication's real host are accepted:
    // a client may have either, depending on how it found us.
    const handle = account.handle.replace(/^@/, '');
    const username = (handle.split('@')[0] ?? '').toLowerCase();
    const ghostHost = (handle.split('@')[1] ?? '').toLowerCase();
    const bridgeHost = new URL(publicUrl).host.toLowerCase();

    const knownHost = parsed.host === bridgeHost || parsed.host === ghostHost;
    if (!knownHost || parsed.username.toLowerCase() !== username) {
      return error('No such account', 404);
    }

    return json(toWebfinger(account, `acct:${parsed.username}@${parsed.host}`), {
      headers: { 'Content-Type': 'application/jrd+json; charset=utf-8' },
    });
  });

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
    // Mastodon documents redirect_uris as a newline-separated string, so a client
    // registering several URIs (or one with stray whitespace) sends them in one
    // value. Split every value so each URI is stored on its own.
    const redirectUris = [
      ...many(params, 'redirect_uris'),
      ...many(params, 'redirect_uri'),
    ]
      .flatMap((value) => value.split(/\s+/))
      .filter(Boolean);

    const { app, clientSecret } = await oauth.registerApp({
      name: one(params, 'client_name') ?? '',
      redirectUris,
      scopes: one(params, 'scopes'),
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
      client_secret_expires_at: 0,
      vapid_key: '',
    });
  });

  router.get('/oauth/authorize', async ({ url }) => {
    const clientId = url.searchParams.get('client_id') ?? '';
    const redirectUri = url.searchParams.get('redirect_uri') ?? '';
    const scope = url.searchParams.get('scope') || 'read';
    const state = url.searchParams.get('state') ?? '';
    const codeChallenge = pkceChallenge(
      url.searchParams.get('code_challenge'),
      url.searchParams.get('code_challenge_method'),
    );

    const app = await oauth.checkRedirect(clientId, redirectUri);
    return html(
      loginPage({ app: app.name, clientId, redirectUri, scope, state, codeChallenge }),
    );
  });

  router.post('/oauth/authorize', async ({ request }) => {
    const params = await readParams(request);
    const clientId = one(params, 'client_id') ?? '';
    const redirectUri = one(params, 'redirect_uri') ?? '';
    const scope = one(params, 'scope') || 'read';
    const state = one(params, 'state') ?? '';
    const password = one(params, 'password') ?? '';
    const codeChallenge = pkceChallenge(
      one(params, 'code_challenge'),
      one(params, 'code_challenge_method'),
    );

    const app = await oauth.checkRedirect(clientId, redirectUri);

    if (throttle.isLocked(clientId)) {
      return html(
        loginPage({
          app: app.name,
          clientId,
          redirectUri,
          scope,
          state,
          codeChallenge,
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
          codeChallenge,
          message: 'That password was not right.',
        }),
        { status: 401 },
      );
    }

    throttle.reset(clientId);
    const code = await oauth.issueCode(clientId, redirectUri, scope, codeChallenge);

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
      await oauth.authenticateClient(clientId, clientSecret);
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
      codeVerifier: one(params, 'code_verifier'),
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
    const account = await present(await social.me());
    return json({ ...account, source: { note: account.note, fields: account.fields } });
  });

  router.get('/api/v1/apps/verify_credentials', () =>
    json({ name: 'fediverse-desk', website: null, vapid_key: '' }),
  );

  // Fixed paths first: the router takes the first pattern that matches, and
  // "relationships" and "lookup" would otherwise be read as account ids.
  router.get('/api/v1/accounts/relationships', async ({ url }) => {
    const ids = [...url.searchParams.getAll('id[]'), ...url.searchParams.getAll('id')];
    const relationships = await Promise.all(
      ids.map(async (id) => {
        const handle = await accountHandle(id);
        if (!handle || handle === 'me') return toRelationship(id, null);
        const account = await social.account(handle).catch(() => null);
        return toRelationship(id, account);
      }),
    );
    return json(relationships);
  });

  router.get('/api/v1/accounts/lookup', async ({ url }) => {
    const acct = (url.searchParams.get('acct') ?? '').trim().replace(/^@/, '');
    if (!acct) return error('acct is required', 400);
    const own = await selfIdentity();
    const ownHandle = own.handle.replace(/^@/, '');
    const handle =
      acct.toLowerCase() === ownHandle || acct.toLowerCase() === ownHandle.split('@')[0]
        ? 'me'
        : acct.includes('@')
          ? `@${acct}`
          : null;
    if (!handle) return error('Record not found', 404);
    return json(await present(await lookupAccount(handle)));
  });

  router.get('/api/v1/accounts/:id', async ({ params }) => {
    const handle = await accountHandle(params.id as string);
    if (!handle) return error('Record not found', 404);
    return json(await present(await lookupAccount(handle)));
  });

  router.get('/api/v1/accounts/:id/statuses', async ({ params, url }) => {
    const handle = await accountHandle(params.id as string);
    if (!handle) return error('Record not found', 404);

    // Ghost has no pinned posts, and asking for them is the first thing a
    // profile screen does. An empty list is the honest answer.
    const cursor = pageCursor(url);
    if (url.searchParams.get('pinned') === 'true' || cursor === 'end') return json([]);

    const page = await social.posts(handle, { limit: numberParam(url, 'limit', 20), ...cursor });

    // Another server's posts come through Ghost close to raw, so one that cannot
    // be mapped is skipped rather than allowed to fail the whole profile.
    const seen = new Set<string>();
    const mapped = page.items.flatMap((post) => {
      try {
        const status = toStatus(post);
        if (seen.has(status.id)) return [];
        seen.add(status.id);
        return [{ post, status }];
      } catch {
        return [];
      }
    });
    rememberPage(
      mapped.map(({ status }) => status.id),
      page.next,
    );

    let statuses = mapped;
    if (url.searchParams.get('only_media') === 'true') {
      statuses = statuses.filter(({ status }) => status.media_attachments.length > 0);
    }
    if (url.searchParams.get('exclude_reblogs') === 'true') {
      statuses = statuses.filter(({ post }) => !post.repostedBy);
    }
    rememberPage(
      statuses.map(({ status }) => status.id),
      page.next,
    );
    return json(
      await withAuthors(statuses.map(({ status }) => status)),
      linkHeader(url, page.next, mapped.length),
    );
  });

  const followsHandler =
    (type: 'followers' | 'following') =>
    async ({ params, url }: RouteContext) => {
      const handle = await accountHandle(params.id as string);
      if (!handle) return error('Record not found', 404);
      const cursor = pageCursor(url);
      if (cursor === 'end') return json([]);

      const page = await social.follows(handle, type, {
        limit: numberParam(url, 'limit', 40),
        ...cursor,
      });
      const accounts = await Promise.all(page.items.map(present));
      rememberPage(
        accounts.map((account) => account.id),
        page.next,
      );
      return json(accounts, linkHeader(url, page.next, accounts.length));
    };

  router.get('/api/v1/accounts/:id/followers', followsHandler('followers'));
  router.get('/api/v1/accounts/:id/following', followsHandler('following'));

  const followAction = (action: 'follow' | 'unfollow') => async ({ params }: RouteContext) => {
    const handle = await accountHandle(params.id as string);
    if (!handle) return error('Record not found', 404);
    if (handle === 'me') return error('The publication cannot follow itself.', 422);
    await social[action](handle);
    const account = await social.account(handle).catch(() => null);
    const relationship = toRelationship(params.id as string, account);
    // Ghost may not have recorded the change by the time it is read back.
    return json({ ...relationship, following: action === 'follow' });
  };

  router.post('/api/v1/accounts/:id/follow', followAction('follow'));
  router.post('/api/v1/accounts/:id/unfollow', followAction('unfollow'));

  // Profile screens ask for these alongside the account. Ghost has none of them.
  router.get('/api/v1/accounts/:id/featured_tags', () => json([]));
  router.get('/api/v1/accounts/:id/lists', () => json([]));
  router.get('/api/v1/accounts/:id/identity_proofs', () => json([]));
  router.get('/api/v1/featured_tags', () => json([]));

  // --- statuses -------------------------------------------------------------

  router.get('/api/v1/statuses/:id', async ({ params }) => {
    const apId = issuedStatusId(params.id as string);
    if (!apId) return error('Record not found', 404);
    const post = await notFoundAsNull(social.post(apId));
    if (!post) return error('Record not found', 404);
    const [status] = await withAuthors([toStatus(post)]);
    return json(status);
  });

  // The thread under an opened post. A post Ghost cannot find a thread for is
  // shown on its own rather than as an error: the client already has the post,
  // and an error here reads as "this post was deleted".
  router.get('/api/v1/statuses/:id/context', async ({ params }) => {
    const apId = issuedStatusId(params.id as string);
    if (!apId) return error('Record not found', 404);
    const thread = await notFoundAsNull(social.thread(apId));
    if (!thread) return json({ ancestors: [], descendants: [] });
    const { ancestors, descendants } = toContext(thread);
    const statuses = await withAuthors([...ancestors, ...descendants]);
    return json({
      ancestors: statuses.slice(0, ancestors.length),
      descendants: statuses.slice(ancestors.length),
    });
  });

  // Ghost does not say who liked or boosted another server's post, only how
  // many did. An empty list keeps the client's counts screen from failing.
  router.get('/api/v1/statuses/:id/favourited_by', () => json([]));
  router.get('/api/v1/statuses/:id/reblogged_by', () => json([]));

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
    const cursor = pageCursor(url);
    if (cursor === 'end') return json([]);
    const page = await social.readerFeed({ limit: numberParam(url, 'limit', 20), ...cursor });
    const statuses = uniqueStatuses(page.items.map((post) => toStatus(post)));
    rememberPage(
      statuses.map((status) => status.id),
      page.next,
    );
    return json(await withAuthors(statuses), linkHeader(url, page.next, statuses.length));
  });

  router.get('/api/v1/timelines/public', async ({ url }) => {
    const cursor = pageCursor(url);
    if (cursor === 'end') return json([]);
    const page = await social.notesFeed({ limit: numberParam(url, 'limit', 20), ...cursor });
    const statuses = uniqueStatuses(page.items.map((post) => toStatus(post)));
    rememberPage(
      statuses.map((status) => status.id),
      page.next,
    );
    return json(await withAuthors(statuses), linkHeader(url, page.next, statuses.length));
  });

  // The publication's liked posts. Mastodon calls a like a favourite.
  router.get('/api/v1/favourites', async ({ url }) => {
    const cursor = pageCursor(url);
    if (cursor === 'end') return json([]);
    const page = await social.liked({ limit: numberParam(url, 'limit', 20), ...cursor });
    const statuses = uniqueStatuses(
      page.items.flatMap((post) => {
        try {
          return [toStatus(post)];
        } catch {
          return [];
        }
      }),
    );
    rememberPage(
      statuses.map((status) => status.id),
      page.next,
    );
    return json(await withAuthors(statuses), linkHeader(url, page.next, statuses.length));
  });

  router.get('/api/v1/bookmarks', () => json([]));

  router.get('/api/v1/notifications', async ({ url }) => {
    const cursor = pageCursor(url);
    if (cursor === 'end') return json([]);
    const page = await social.notifications({ limit: numberParam(url, 'limit', 20), ...cursor });
    const notifications = page.items.map(toNotification);
    rememberPage(
      notifications.map((notification) => notification.id as string),
      page.next,
    );
    const accounts = await fullAccounts(
      notifications.map((notification) => (notification.account as MastodonAccount).acct),
    );
    return json(
      notifications.map((notification) => {
        const account = accounts.get((notification.account as MastodonAccount).acct);
        return account ? { ...notification, account } : notification;
      }),
      linkHeader(url, page.next, notifications.length),
    );
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

/**
 * Mastodon clients page by following the Link header rather than a body field,
 * and Mastodon sends one with every page that has anything in it. The Android
 * app takes the next page's max_id from it alone: with no header it has no
 * max_id, so its next request is for the newest page, and the feed starts over
 * underneath what the reader has already scrolled past. So the last page of a
 * feed links on too, to a page that is always empty, which is how Mastodon
 * itself says "that was everything".
 */
function linkHeader(url: URL, next: string | null, count: number): ResponseInit {
  if (count === 0) return {};
  const target = new URL(url.toString());
  target.searchParams.set('max_id', next ?? END_OF_FEED);
  return { headers: { Link: `<${target.toString()}>; rel="next"` } };
}

/** The max_id of the always-empty page after the last one. Never a Ghost cursor. */
const END_OF_FEED = 'end';

/**
 * Ghost's feeds carry a row per repost, so a post boosted by two accounts the
 * publication follows arrives twice with one id. Clients key their lists by id
 * and show both, so only the first, newest, is kept.
 */
function uniqueStatuses(statuses: MastodonStatus[]): MastodonStatus[] {
  const seen = new Set<string>();
  return statuses.filter((status) => {
    if (seen.has(status.id)) return false;
    seen.add(status.id);
    return true;
  });
}

/** The ActivityPub id behind a status id, or null for one this bridge did not issue. */
function issuedStatusId(id: string): string | null {
  try {
    return decodeId(id);
  } catch {
    return null;
  }
}

/** Ghost's 404 as null, so a route can answer it as Mastodon would. */
async function notFoundAsNull<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch (thrown) {
    if (thrown instanceof SocialWebError && thrown.status === 404) return null;
    throw thrown;
  }
}

/** A status or account id this bridge handed out, as opposed to a Ghost cursor. */
function isIssuedId(value: string): boolean {
  try {
    decodeId(value);
    return true;
  } catch {
    return decodeAccountId(value) !== null;
  }
}

/** Last-item ids mapped to the cursor of the page that follows. Bounded. */
class CursorMemory {
  private readonly entries = new Map<string, string>();

  constructor(private readonly limit = 1000) {}

  get(id: string): string | undefined {
    return this.entries.get(id);
  }

  set(id: string, cursor: string): void {
    this.entries.delete(id);
    this.entries.set(id, cursor);
    if (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Mastodon supports PKCE with S256 only; anything else is refused, not ignored. */
function pkceChallenge(
  challenge: string | null | undefined,
  method: string | null | undefined,
): string | undefined {
  if (!challenge) return undefined;
  if (method !== 'S256') {
    throw new OAuthError('invalid_request', 'code_challenge_method must be S256.');
  }
  return challenge;
}

function loginPage(options: {
  app: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge?: string;
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
  ${options.codeChallenge ? hidden('code_challenge', options.codeChallenge) + hidden('code_challenge_method', 'S256') : ''}
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
