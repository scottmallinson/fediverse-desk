import type { Account, Author, Notification, Post } from '../ghost/types.js';

/**
 * Compact shapes for a model to read. Everything here exists to spend fewer
 * tokens: HTML becomes text, long bodies are cut, and fields a model cannot use
 * (avatars, banners, counters it was not asked about) are dropped.
 */

export interface PostDigest {
  id: string;
  url: string;
  kind: 'note' | 'article';
  publishedAt: string;
  title?: string;
  text: string;
  truncated?: true;
  likes: number;
  replies: number;
  reposts: number;
  likedByMe?: true;
  repostedByMe?: true;
  repostedBy?: string;
  images?: number;
}

export interface AuthoredPost extends PostDigest {
  author: { handle: string; name: string };
}

export interface AccountDigest {
  handle: string;
  name: string;
  bio: string;
  url: string | null;
  followers: number;
  following: number;
  posts: number;
  followsMe?: boolean;
  followedByMe?: boolean;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

/** Good enough for post bodies. Not a sanitiser: the output is only ever read. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (match, name: string) => {
      const lower = name.toLowerCase();
      if (ENTITIES[lower]) return ENTITIES[lower];
      if (lower.startsWith('#x')) return safeCodePoint(parseInt(lower.slice(2), 16), match);
      if (lower.startsWith('#')) return safeCodePoint(parseInt(lower.slice(1), 10), match);
      return match;
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function safeCodePoint(code: number, fallback: string): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

export function clip(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max).trimEnd()}…`, truncated: true };
}

export function postKind(post: Post): 'note' | 'article' {
  // Ghost's PostType: 0 is a note, 1 an article, 2 a tombstone.
  return post.type === 1 || post.type === 'article' ? 'article' : 'note';
}

export function isTombstone(post: Post): boolean {
  return post.type === 2 || post.type === 'tombstone';
}

/**
 * Notes are short enough to keep whole, almost always. Articles are not, so a
 * model gets the summary or the excerpt and the URL to fetch if it wants more.
 */
export function digestPost(post: Post, options: { maxChars?: number } = {}): PostDigest {
  const kind = postKind(post);
  const max = options.maxChars ?? (kind === 'article' ? 400 : 800);
  const source =
    kind === 'article'
      ? firstText(post.summary, post.excerpt, post.content)
      : firstText(post.content, post.excerpt);
  const { text, truncated } = clip(htmlToText(source), max);

  const digest: PostDigest = {
    id: post.id,
    url: typeof post.url === 'string' && post.url ? post.url : post.id,
    kind,
    publishedAt: post.publishedAt,
    text,
    likes: post.likeCount ?? 0,
    replies: post.replyCount ?? 0,
    reposts: post.repostCount ?? 0,
  };
  if (kind === 'article' && post.title) digest.title = post.title;
  if (truncated) digest.truncated = true;
  if (post.likedByMe) digest.likedByMe = true;
  if (post.repostedByMe) digest.repostedByMe = true;
  if (post.repostedBy?.handle) digest.repostedBy = post.repostedBy.handle;
  const images = (post.attachments ?? []).length;
  if (images > 0) digest.images = images;
  return digest;
}

export function digestAuthoredPost(post: Post, options: { maxChars?: number } = {}): AuthoredPost {
  return { ...digestPost(post, options), author: digestAuthor(post.author) };
}

export function digestAuthor(author: Author | null | undefined): { handle: string; name: string } {
  return { handle: author?.handle ?? 'unknown', name: author?.name ?? '' };
}

export function digestAccount(account: Account, options: { bioChars?: number } = {}): AccountDigest {
  const digest: AccountDigest = {
    handle: account.handle,
    name: account.name,
    bio: clip(htmlToText(account.bio ?? ''), options.bioChars ?? 280).text,
    url: account.url ?? null,
    followers: account.followerCount ?? 0,
    following: account.followingCount ?? 0,
    posts: account.postCount ?? 0,
  };
  if (typeof account.followsMe === 'boolean') digest.followsMe = account.followsMe;
  if (typeof account.followedByMe === 'boolean') digest.followedByMe = account.followedByMe;
  return digest;
}

export interface NotificationDigest {
  id: string;
  at: string;
  type: Notification['type'];
  from: { handle: string; name: string };
  post?: { id: string; url: string; text: string };
  inReplyTo?: { id: string; text: string };
}

export function digestNotification(notification: Notification): NotificationDigest {
  const digest: NotificationDigest = {
    id: notification.id,
    at: notification.createdAt,
    type: notification.type,
    from: digestAuthor(notification.actor),
  };
  if (notification.post) {
    const post = notification.post;
    digest.post = {
      id: post.id,
      url: post.url || post.id,
      text: clip(htmlToText(firstText(post.content, post.title)), 500).text,
    };
  }
  const parent = notification.inReplyTo;
  if (parent && typeof parent === 'object') {
    const record = parent as Record<string, unknown>;
    if (typeof record.id === 'string') {
      const content = typeof record.content === 'string' ? record.content : '';
      const title = typeof record.title === 'string' ? record.title : '';
      digest.inReplyTo = {
        id: record.id,
        text: clip(htmlToText(firstText(content, title)), 280).text,
      };
    }
  }
  return digest;
}

function firstText(...values: Array<string | null | undefined>): string {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0) ?? '';
}

const RELATIVE = /^[-+]?\s*(\d+)\s*(m|min|h|d|w)$/i;

/**
 * The start of a look-back window. Takes "24h", "90m", "3d", "1w" (with or
 * without a leading minus), or an ISO timestamp. The future is refused, because
 * "since tomorrow" is always a mistake.
 */
export function parseSince(input: string, now: Date = new Date()): Date {
  const value = input.trim();
  const relative = RELATIVE.exec(value);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = (relative[2] ?? 'h').toLowerCase();
    const minutes = { m: 1, min: 1, h: 60, d: 60 * 24, w: 60 * 24 * 7 }[unit] ?? 60;
    return new Date(now.getTime() - amount * minutes * 60_000);
  }

  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.getTime())) {
    throw new Error(`Could not read "${input}" as a time. Use "24h", "3d", "1w" or an ISO timestamp.`);
  }
  if (parsed.getTime() > now.getTime()) {
    throw new Error(`${parsed.toISOString()} is in the future.`);
  }
  return parsed;
}

/** Milliseconds since the epoch, or NaN for anything that is not a date. */
export function timeOf(value: unknown): number {
  return typeof value === 'string' || typeof value === 'number' ? new Date(value).getTime() : NaN;
}
