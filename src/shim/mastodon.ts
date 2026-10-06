import type { Account, Attachment, Notification, Post } from '../ghost/types.js';

/**
 * Ghost identifies posts and accounts by their ActivityPub URL. Mastodon ids are
 * opaque strings that clients put straight into a path segment, and a URL has
 * slashes in it, so every id crossing this boundary is base64url encoded.
 *
 * Clients that sort by id, or assume ids are snowflakes, will get this wrong.
 * That is a known and accepted limitation: the shim exists so publishing tools
 * can post, not so a timeline reader can page backwards through history.
 */
export function encodeId(apId: string): string {
  return Buffer.from(apId, 'utf8').toString('base64url');
}

export function decodeId(id: string): string {
  const decoded = Buffer.from(id, 'base64url').toString('utf8');
  if (!/^https?:\/\//.test(decoded)) {
    throw new Error(`"${id}" is not an id this shim issued.`);
  }
  return decoded;
}

/**
 * Account ids are encoded handles rather than ActivityPub URLs, because a handle
 * is the only thing Ghost's account and posts endpoints accept. A post's author
 * does not reliably carry its ActivityPub URL either: for some feed rows its id
 * is Ghost's internal row number, which would decode to nothing usable.
 */
export function encodeAccountId(handle: string): string {
  return Buffer.from(normaliseHandle(handle), 'utf8').toString('base64url');
}

/**
 * The "@user@host" handle an account id stands for, or the ActivityPub URL that
 * builds before handle ids issued instead. Null for anything else.
 */
export function decodeAccountId(id: string): { handle: string } | { apId: string } | null {
  const decoded = Buffer.from(id, 'base64url').toString('utf8');
  if (HANDLE.test(decoded)) return { handle: decoded };
  if (/^https?:\/\//.test(decoded)) return { apId: decoded };
  return null;
}

const HANDLE = /^@[^@\s/]+@[^@\s/]+$/;

function normaliseHandle(handle: string): string {
  return `@${handle.replace(/^@/, '')}`;
}

export interface MastodonAccount {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  locked: boolean;
  bot: boolean;
  discoverable: boolean;
  group: boolean;
  created_at: string;
  note: string;
  url: string;
  avatar: string;
  avatar_static: string;
  header: string;
  header_static: string;
  followers_count: number;
  following_count: number;
  statuses_count: number;
  last_status_at: string | null;
  emojis: never[];
  fields: Array<{ name: string; value: string; verified_at: string | null }>;
}

const BLANK_IMAGE = '';

export function toAccount(account: Account): MastodonAccount {
  const handle = account.handle.replace(/^@/, '');
  const username = handle.split('@')[0] ?? handle;
  const avatar = account.avatarUrl ?? BLANK_IMAGE;
  const header = account.bannerImageUrl ?? BLANK_IMAGE;

  return {
    id: encodeAccountId(handle),
    username,
    acct: handle,
    display_name: account.name ?? '',
    locked: false,
    bot: false,
    discoverable: true,
    group: false,
    created_at: new Date(0).toISOString(),
    note: account.bio ?? '',
    url: account.url ?? '',
    avatar,
    avatar_static: avatar,
    header,
    header_static: header,
    followers_count: account.followerCount ?? 0,
    following_count: account.followingCount ?? 0,
    statuses_count: account.postCount ?? 0,
    last_status_at: null,
    emojis: [],
    fields: Object.entries(account.customFields ?? {}).map(([name, value]) => ({
      name,
      value,
      verified_at: null,
    })),
  };
}

/**
 * A post's author arrives as the trimmed AuthorDTO, which has no counts and no
 * bio. Filling those with zeroes is correct: they are unknown, not zero, but
 * every client treats a missing number as a crash and a zero as "not shown".
 */
function authorToAccount(author: Post['author']): MastodonAccount {
  const handle = (author.handle ?? '').replace(/^@/, '');
  return {
    id: encodeAccountId(handle),
    username: handle.split('@')[0] ?? handle,
    acct: handle,
    display_name: author.name ?? '',
    locked: false,
    bot: false,
    discoverable: true,
    group: false,
    created_at: new Date(0).toISOString(),
    note: '',
    url: linkHref(author.url) ?? '',
    avatar: author.avatarUrl || BLANK_IMAGE,
    avatar_static: author.avatarUrl || BLANK_IMAGE,
    header: BLANK_IMAGE,
    header_static: BLANK_IMAGE,
    followers_count: 0,
    following_count: 0,
    statuses_count: 0,
    last_status_at: null,
    emojis: [],
    fields: [],
  };
}

/** Mastodon's Relationship entity, from what Ghost says about one account. */
export function toRelationship(id: string, account: Account | null): Record<string, unknown> {
  return {
    id,
    following: account?.followedByMe ?? false,
    showing_reblogs: true,
    notifying: false,
    languages: null,
    followed_by: account?.followsMe ?? false,
    blocking: account?.blockedByMe ?? false,
    blocked_by: false,
    muting: false,
    muting_notifications: false,
    requested: false,
    requested_by: false,
    domain_blocking: account?.domainBlockedByMe ?? false,
    endorsed: false,
    note: '',
  };
}

export interface MastodonMedia {
  id: string;
  type: 'image' | 'unknown';
  url: string;
  preview_url: string;
  remote_url: string | null;
  text_url: null;
  description: string | null;
  blurhash: null;
  meta: Record<string, never>;
}

export function toMedia(url: string, description?: string | null): MastodonMedia {
  return {
    id: encodeId(url),
    type: 'image',
    url,
    preview_url: url,
    remote_url: null,
    text_url: null,
    description: description ?? null,
    blurhash: null,
    meta: {},
  };
}

/**
 * Posts from another server's outbox reach us as that server's ActivityPub JSON,
 * passed through by Ghost with little normalisation. Compacted JSON-LD collapses
 * a one-item list to the item itself, a url can be a Link object or a list of
 * them, and mediaType is optional. Any of those used to throw, and one bad post
 * took the whole profile down with it.
 */
function attachmentsOf(post: Post): MastodonMedia[] {
  const media: MastodonMedia[] = [];
  for (const attachment of asArray<Partial<Attachment> | string>(post.attachments)) {
    const item = typeof attachment === 'string' ? { url: attachment } : attachment;
    const url = linkHref(item?.url);
    if (!url) continue;
    const entry = toMedia(url, typeof item.name === 'string' && item.name ? item.name : null);
    const mediaType = typeof item.mediaType === 'string' ? item.mediaType : '';
    if (mediaType ? !mediaType.startsWith('image/') : item.type !== 'Image') {
      entry.type = 'unknown';
    }
    media.push(entry);
  }
  return media;
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** The first usable URL from a string, a Link object, or a list of either. */
function linkHref(value: unknown): string | null {
  for (const candidate of asArray(value as unknown)) {
    if (typeof candidate === 'string' && candidate) return candidate;
    if (candidate && typeof candidate === 'object') {
      const href = (candidate as { href?: unknown }).href ?? (candidate as { url?: unknown }).url;
      if (typeof href === 'string' && href) return href;
    }
  }
  return null;
}

function isoDate(value: unknown): string {
  const date = new Date(typeof value === 'string' || typeof value === 'number' ? value : Date.now());
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

export interface MastodonStatus {
  id: string;
  uri: string;
  url: string;
  created_at: string;
  account: MastodonAccount;
  content: string;
  visibility: 'public';
  sensitive: boolean;
  spoiler_text: string;
  media_attachments: MastodonMedia[];
  mentions: never[];
  tags: never[];
  emojis: never[];
  reblogs_count: number;
  favourites_count: number;
  replies_count: number;
  favourited: boolean;
  reblogged: boolean;
  muted: boolean;
  bookmarked: boolean;
  pinned: boolean;
  in_reply_to_id: string | null;
  in_reply_to_account_id: string | null;
  reblog: null;
  application: { name: string; website: null } | null;
  language: string | null;
  text: null;
  card: null;
  poll: null;
}

export function toStatus(post: Post, options: { inReplyTo?: string | null } = {}): MastodonStatus {
  const content = [post.content, post.excerpt, post.title].find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  ) ?? '';

  return {
    id: encodeId(post.id),
    uri: post.id,
    url: linkHref(post.url) ?? post.id,
    created_at: isoDate(post.publishedAt),
    account: authorToAccount(post.author),
    content,
    visibility: 'public',
    sensitive: false,
    spoiler_text: '',
    media_attachments: attachmentsOf(post),
    mentions: [],
    tags: [],
    emojis: [],
    reblogs_count: post.repostCount ?? 0,
    favourites_count: post.likeCount ?? 0,
    replies_count: post.replyCount ?? 0,
    favourited: post.likedByMe ?? false,
    reblogged: post.repostedByMe ?? false,
    muted: false,
    bookmarked: false,
    pinned: false,
    in_reply_to_id: options.inReplyTo ? encodeId(options.inReplyTo) : null,
    in_reply_to_account_id: null,
    reblog: null,
    application: null,
    language: null,
    text: null,
    card: null,
    poll: null,
  };
}

const NOTIFICATION_TYPES = {
  like: 'favourite',
  repost: 'reblog',
  reply: 'mention',
  mention: 'mention',
  follow: 'follow',
} as const;

export function toNotification(notification: Notification): Record<string, unknown> {
  const post = notification.post;
  return {
    id: notification.id,
    type: NOTIFICATION_TYPES[notification.type] ?? 'mention',
    created_at: isoDate(notification.createdAt),
    account: authorToAccount(notification.actor),
    status: post
      ? {
          ...toStatus({
            id: post.id,
            type: post.type,
            title: post.title,
            excerpt: '',
            summary: null,
            content: post.content,
            url: post.url,
            featureImageUrl: null,
            publishedAt: notification.createdAt,
            likeCount: post.likeCount,
            likedByMe: post.likedByMe,
            replyCount: post.replyCount,
            readingTimeMinutes: 0,
            attachments: post.attachments ?? [],
            author: notification.actor,
            authoredByMe: false,
            repostCount: post.repostCount,
            repostedByMe: post.repostedByMe,
            repostedBy: null,
          }),
        }
      : null,
  };
}

export function toInstance(options: {
  publicUrl: string;
  account: MastodonAccount | null;
  version: string;
}): Record<string, unknown> {
  const host = new URL(options.publicUrl).host;
  return {
    uri: host,
    title: options.account?.display_name || host,
    short_description: 'A private bridge to one Ghost publication on the social web.',
    description: 'A private bridge to one Ghost publication on the social web.',
    email: '',
    // Clients gate features on this. Claiming a modern Mastodon keeps them from
    // falling back to behaviour this shim does not implement, and the suffix
    // keeps it honest about what is actually answering.
    version: `4.2.0 (compatible; fediverse-desk ${options.version})`,
    urls: {},
    stats: {
      user_count: 1,
      status_count: options.account?.statuses_count ?? 0,
      domain_count: 0,
    },
    thumbnail: options.account?.avatar || null,
    languages: ['en'],
    registrations: false,
    approval_required: true,
    invites_enabled: false,
    configuration: {
      statuses: {
        max_characters: 5000,
        max_media_attachments: 1,
        characters_reserved_per_url: 23,
      },
      media_attachments: {
        supported_mime_types: [
          'image/jpeg',
          'image/png',
          'image/gif',
          'image/webp',
          'image/avif',
        ],
        image_size_limit: 10 * 1024 * 1024,
      },
      polls: { max_options: 0 },
    },
    contact_account: options.account,
  };
}

/**
 * /api/v2/instance is a different document, not the v1 one at a new path.
 * Clients that see a 4.x version ask for v2 first and parse it with a strict
 * model: the Mastodon Android app, for one, rejects the whole server if
 * `thumbnail` is a string rather than an object, and reports it as "doesn't
 * appear to be a Mastodon server". So the shapes have to match Mastodon's.
 */
export function toInstanceV2(options: {
  publicUrl: string;
  account: MastodonAccount | null;
  version: string;
}): Record<string, unknown> {
  const v1 = toInstance(options);
  const host = new URL(options.publicUrl).host;
  const configuration = v1.configuration as Record<string, unknown>;
  return {
    domain: host,
    title: v1.title,
    version: v1.version,
    source_url: 'https://github.com/scottmallinson/fediverse-desk',
    description: v1.description,
    usage: { users: { active_month: 1 } },
    thumbnail: { url: options.account?.avatar || '' },
    languages: v1.languages,
    configuration: {
      urls: { streaming: '' },
      accounts: { max_featured_tags: 0 },
      ...configuration,
      translation: { enabled: false },
    },
    registrations: { enabled: false, approval_required: true, message: null },
    contact: { email: '', account: options.account },
    rules: [],
  };
}

/**
 * Instance detection happens before login, and it does not go through
 * /api/v1/instance: a client resolves /.well-known/nodeinfo first to find out
 * what software a domain runs, and only offers a Mastodon login if it likes the
 * answer. Without this the connect flow fails before it ever reaches the API,
 * with an error that just says the server could not be reached.
 *
 * So software.name has to read "mastodon". That is a compatibility claim, not a
 * boast, and the truth about what is actually answering lives in metadata where
 * a human looking at the document will find it.
 */
export function toNodeInfoLinks(publicUrl: string): Record<string, unknown> {
    return {
        links: [
            {
                rel: 'http://nodeinfo.diaspora.software/ns/schema/2.0',
                href: `${publicUrl.replace(/\/+$/, '')}/nodeinfo/2.0`,
            },
        ],
    };
}

export function toNodeInfo(options: {
    account: MastodonAccount | null;
    version: string;
    ghostUrl: string;
}): Record<string, unknown> {
    return {
        version: '2.0',
        software: { name: 'mastodon', version: '4.2.0' },
        protocols: ['activitypub'],
        services: { inbound: [], outbound: [] },
        usage: {
            users: { total: 1, activeMonth: 1, activeHalfyear: 1 },
            localPosts: options.account?.statuses_count ?? 0,
        },
        openRegistrations: false,
        metadata: {
            nodeName: options.account?.display_name || 'fediverse-desk',
            nodeDescription:
                'A private bridge to one Ghost publication on the social web. Posts made ' +
                'through this bridge federate from the Ghost actor, not from here.',
            software: `fediverse-desk ${options.version}`,
            upstream: options.ghostUrl,
        },
    };
}

/**
 * Webfinger for the bridge's domain, answered by pointing at the real thing.
 *
 * A client that resolves acct:scott@desk.example.com should not discover an
 * actor here, because there is no actor here: the bridge has no inbox and no
 * signing key. It discovers the Ghost actor instead, which is the identity that
 * actually federates. A remote server following that link lands on
 * scottmallinson.com and its canonical handle, which is the correct outcome and
 * the reason this is safe to serve.
 */
export function toWebfinger(account: Account, resource: string): Record<string, unknown> {
    const links: Array<Record<string, string>> = [
        {
            rel: 'self',
            type: 'application/activity+json',
            href: account.apId,
        },
    ];

    if (account.url) {
        links.push({
            rel: 'http://webfinger.net/rel/profile-page',
            type: 'text/html',
            href: account.url,
        });
    }

    if (account.avatarUrl) {
        links.push({ rel: 'http://webfinger.net/rel/avatar', href: account.avatarUrl });
    }

    return {
        subject: resource,
        aliases: [account.apId, account.url].filter((value): value is string => Boolean(value)),
        links,
    };
}

export interface ParsedResource {
    username: string;
    host: string;
}

/**
 * Accepts the forms that turn up in the wild: "acct:user@host", a bare
 * "user@host", and the https URL some implementations send instead.
 */
export function parseWebfingerResource(resource: string): ParsedResource | null {
    const value = resource.trim();
    if (!value) return null;

    if (value.startsWith('http://') || value.startsWith('https://')) {
        try {
            const url = new URL(value);
            const last = url.pathname.split('/').filter(Boolean).pop();
            if (!last) return null;
            return { username: last.replace(/^@/, ''), host: url.host.toLowerCase() };
        } catch {
            return null;
        }
    }

    const withoutScheme = value.startsWith('acct:') ? value.slice(5) : value;
    const at = withoutScheme.lastIndexOf('@');
    if (at <= 0) return null;

    const username = withoutScheme.slice(0, at).replace(/^@/, '');
    const host = withoutScheme.slice(at + 1).toLowerCase();
    if (!username || !host) return null;

    return { username, host };
}
