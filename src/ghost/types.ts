/**
 * Shapes returned by /.ghost/activitypub/v1, transcribed from the DTO helpers in
 * TryGhost/ActivityPub. The API is private and unversioned for outside use, so
 * treat these as a best current reading rather than a contract: every field is
 * read defensively at the edges.
 */

export interface Author {
  id: string;
  name: string;
  handle: string;
  avatarUrl: string;
  url: string;
  followedByMe: boolean;
}

export interface Attachment {
  name: string;
  type: string;
  mediaType: string;
  url: string;
}

export interface Post {
  id: string;
  type: number | string;
  title: string;
  excerpt: string;
  summary: string | null;
  content: string;
  url: string;
  featureImageUrl: string | null;
  publishedAt: string;
  likeCount: number;
  likedByMe: boolean;
  replyCount: number;
  readingTimeMinutes: number;
  attachments: Attachment[];
  author: Author;
  authoredByMe: boolean;
  repostCount: number;
  repostedByMe: boolean;
  repostedBy: Author | null;
  metadata?: Record<string, unknown>;
}

export interface Account {
  id: string;
  apId: string;
  name: string;
  handle: string;
  avatarUrl: string | null;
  bio: string;
  url: string | null;
  bannerImageUrl: string | null;
  customFields: Record<string, string>;
  postCount: number;
  likedCount: number;
  followingCount: number;
  followerCount: number;
  followedByMe?: boolean;
  followsMe?: boolean;
  blockedByMe?: boolean;
  domainBlockedByMe?: boolean;
}

export interface Notification {
  id: string;
  createdAt: string;
  type: 'like' | 'repost' | 'reply' | 'follow' | 'mention';
  actor: Author;
  post: {
    id: string;
    type: 'article' | 'note';
    title: string;
    content: string;
    url: string;
    likeCount: number;
    replyCount: number;
    repostCount: number;
    likedByMe: boolean;
    repostedByMe: boolean;
    attachments: Attachment[];
  } | null;
  inReplyTo?: unknown;
}

export interface Page<T> {
  items: T[];
  next: string | null;
}

export interface ImageAttachment {
  url: string;
  altText?: string;
}

export interface NoteInput {
  content: string;
  image?: ImageAttachment;
}

/**
 * The one operation every part of this app needs. Two transports implement it:
 * a direct client, and one that shells out to @tryghost/ghst.
 */
export interface SocialWeb {
  me(): Promise<Account>;
  account(handle: string): Promise<Account>;
  note(input: NoteInput): Promise<Post>;
  reply(postId: string, input: NoteInput): Promise<Post>;
  deletePost(postId: string): Promise<void>;
  like(postId: string): Promise<void>;
  unlike(postId: string): Promise<void>;
  repost(postId: string): Promise<void>;
  derepost(postId: string): Promise<void>;
  follow(handle: string): Promise<void>;
  unfollow(handle: string): Promise<void>;
  readerFeed(options?: { limit?: number; next?: string }): Promise<Page<Post>>;
  notesFeed(options?: { limit?: number; next?: string }): Promise<Page<Post>>;
  /** One account's own posts. "me" is the publication's handle. */
  posts(handle: string, options?: { limit?: number; next?: string }): Promise<Page<Post>>;
  follows(
    handle: string,
    type: 'followers' | 'following',
    options?: { limit?: number; next?: string },
  ): Promise<Page<Account>>;
  notifications(options?: { limit?: number; next?: string }): Promise<Page<Notification>>;
  uploadImage(file: Uint8Array, filename: string, mimeType: string): Promise<string>;
  search(query: string): Promise<{ accounts: Account[] }>;
}
