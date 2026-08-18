import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Account,
  Notification,
  NoteInput,
  Page,
  Post,
  SocialWeb,
} from '../src/ghost/types.js';

export async function tempDir(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), 'desk-test-'));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

export function makePost(overrides: Partial<Post> = {}): Post {
  return {
    id: 'https://example.com/.ghost/activitypub/note/1',
    type: 0,
    title: '',
    excerpt: '',
    summary: null,
    content: 'Hello fediverse',
    url: 'https://example.com/notes/1',
    featureImageUrl: null,
    publishedAt: '2026-08-18T10:00:00.000Z',
    likeCount: 2,
    likedByMe: false,
    replyCount: 1,
    readingTimeMinutes: 0,
    attachments: [],
    author: {
      id: 'https://example.com/.ghost/activitypub/users/index',
      name: 'Scott Mallinson',
      handle: '@scott@example.com',
      avatarUrl: 'https://example.com/avatar.png',
      url: 'https://example.com/',
      followedByMe: false,
    },
    authoredByMe: true,
    repostCount: 0,
    repostedByMe: false,
    repostedBy: null,
    ...overrides,
  };
}

export function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: '1',
    apId: 'https://example.com/.ghost/activitypub/users/index',
    name: 'Scott Mallinson',
    handle: '@scott@example.com',
    avatarUrl: 'https://example.com/avatar.png',
    bio: 'Engineering notes, written slowly.',
    url: 'https://example.com/',
    bannerImageUrl: null,
    customFields: {},
    postCount: 40,
    likedCount: 3,
    followingCount: 5,
    followerCount: 2,
    ...overrides,
  };
}

export interface FakeCall {
  method: string;
  args: unknown[];
}

/** A SocialWeb that records what it was asked to do and never touches a network. */
export class FakeSocialWeb implements SocialWeb {
  readonly calls: FakeCall[] = [];
  failNext: Error | null = null;
  notes: Post[] = [];

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
  }

  async me(): Promise<Account> {
    this.record('me');
    return makeAccount();
  }

  async account(handle: string): Promise<Account> {
    this.record('account', handle);
    return makeAccount({ handle });
  }

  async note(input: NoteInput): Promise<Post> {
    this.record('note', input);
    const post = makePost({
      content: input.content,
      id: `https://example.com/.ghost/activitypub/note/${this.notes.length + 1}`,
    });
    this.notes.push(post);
    return post;
  }

  async reply(postId: string, input: NoteInput): Promise<Post> {
    this.record('reply', postId, input);
    return makePost({ content: input.content });
  }

  async deletePost(postId: string): Promise<void> {
    this.record('deletePost', postId);
  }

  async like(postId: string): Promise<void> {
    this.record('like', postId);
  }

  async unlike(postId: string): Promise<void> {
    this.record('unlike', postId);
  }

  async repost(postId: string): Promise<void> {
    this.record('repost', postId);
  }

  async derepost(postId: string): Promise<void> {
    this.record('derepost', postId);
  }

  async follow(handle: string): Promise<void> {
    this.record('follow', handle);
  }

  async unfollow(handle: string): Promise<void> {
    this.record('unfollow', handle);
  }

  async readerFeed(): Promise<Page<Post>> {
    this.record('readerFeed');
    return { items: [makePost()], next: 'cursor-2' };
  }

  async notesFeed(): Promise<Page<Post>> {
    this.record('notesFeed');
    return { items: [makePost()], next: null };
  }

  async notifications(): Promise<Page<Notification>> {
    this.record('notifications');
    return {
      items: [
        {
          id: 'n1',
          createdAt: '2026-08-18T10:00:00.000Z',
          type: 'like',
          actor: makePost().author,
          post: null,
        },
      ],
      next: null,
    };
  }

  async uploadImage(file: Uint8Array, filename: string, mimeType: string): Promise<string> {
    this.record('uploadImage', filename, mimeType, file.byteLength);
    return `https://storage.example.com/images/${filename}`;
  }

  async search(query: string): Promise<{ accounts: Account[] }> {
    this.record('search', query);
    return { accounts: [makeAccount()] };
  }
}
