import { IdentityProvider, type Fetcher } from './identity.js';
import { extractReplyApId, extractWrappedPost, synthesisePost } from './reply.js';
import type {
  Account,
  Notification,
  NoteInput,
  Page,
  Post,
  SocialWeb,
} from './types.js';

export class SocialWebError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
  }
}

/**
 * Talks to /.ghost/activitypub/v1 directly.
 *
 * The shim uses this rather than the ghst transport: a long-running server
 * should not spawn a CLI process for every request a client makes.
 */
export class DirectSocialWeb implements SocialWeb {
  constructor(
    private readonly ghostUrl: string,
    private readonly identity: IdentityProvider,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    options: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      expectEmpty?: boolean;
    } = {},
  ): Promise<T> {
    const { token } = await this.identity.get();
    const url = new URL(`/.ghost/activitypub/${path.replace(/^\//, '')}`, this.ghostUrl);

    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/activity+json',
    };

    let body: string | FormData | undefined;
    if (options.body instanceof FormData) {
      body = options.body;
    } else if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    const response = await this.fetcher(url.toString(), { method, headers, body });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new SocialWebError(
        `${method} ${path} failed: ${response.status}${text ? ` ${text.slice(0, 300)}` : ''}`,
        response.status,
        text,
      );
    }

    if (options.expectEmpty || response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  me(): Promise<Account> {
    return this.request<Account>('GET', 'v1/account/me');
  }

  account(handle: string): Promise<Account> {
    return this.request<Account>('GET', `v1/account/${encodeURIComponent(handle)}`);
  }

  async note(input: NoteInput): Promise<Post> {
    const body = await this.request<{ post: Post }>('POST', 'v1/actions/note', {
      body: toNoteBody(input),
    });
    return body.post;
  }

  async reply(postId: string, input: NoteInput): Promise<Post> {
    const body = await this.request<unknown>(
      'POST',
      `v1/actions/reply/${encodeURIComponent(postId)}`,
      { body: toNoteBody(input) },
    );

    // Past this line the reply is published. Nothing below may throw, or the
    // scheduler will retry an item that already went out.
    const wrapped = extractWrappedPost(body);
    if (wrapped) return wrapped;

    const apId = extractReplyApId(body);
    if (!apId) return synthesisePost(body, '', input.content);

    try {
      return await this.post(apId);
    } catch {
      return synthesisePost(body, apId, input.content);
    }
  }

  /** The canonical post, by its ActivityPub id. Returns a bare PostDTO. */
  post(apId: string): Promise<Post> {
    return this.request<Post>('GET', `v1/post/${encodeURIComponent(apId)}`);
  }

  deletePost(postId: string): Promise<void> {
    return this.request('DELETE', `v1/post/${encodeURIComponent(postId)}`, { expectEmpty: true });
  }

  like(postId: string): Promise<void> {
    return this.action(`v1/actions/like/${encodeURIComponent(postId)}`);
  }

  unlike(postId: string): Promise<void> {
    return this.action(`v1/actions/unlike/${encodeURIComponent(postId)}`);
  }

  repost(postId: string): Promise<void> {
    return this.action(`v1/actions/repost/${encodeURIComponent(postId)}`);
  }

  derepost(postId: string): Promise<void> {
    return this.action(`v1/actions/derepost/${encodeURIComponent(postId)}`);
  }

  follow(handle: string): Promise<void> {
    return this.action(`v1/actions/follow/${encodeURIComponent(handle)}`);
  }

  unfollow(handle: string): Promise<void> {
    return this.action(`v1/actions/unfollow/${encodeURIComponent(handle)}`);
  }

  private async action(path: string): Promise<void> {
    await this.request('POST', path, { expectEmpty: true });
  }

  async readerFeed(options: { limit?: number; next?: string } = {}): Promise<Page<Post>> {
    return this.feed('v1/feed/reader', options);
  }

  async notesFeed(options: { limit?: number; next?: string } = {}): Promise<Page<Post>> {
    return this.feed('v1/feed/notes', options);
  }

  private async feed(
    path: string,
    options: { limit?: number; next?: string },
  ): Promise<Page<Post>> {
    const body = await this.request<{ posts?: Post[]; next?: string | null }>('GET', path, {
      query: { limit: options.limit, next: options.next },
    });
    return { items: body.posts ?? [], next: body.next ?? null };
  }

  async notifications(
    options: { limit?: number; next?: string } = {},
  ): Promise<Page<Notification>> {
    const body = await this.request<{ notifications?: Notification[]; next?: string | null }>(
      'GET',
      'v1/notifications',
      { query: { limit: options.limit, next: options.next } },
    );
    return { items: body.notifications ?? [], next: body.next ?? null };
  }

  async uploadImage(file: Uint8Array, filename: string, mimeType: string): Promise<string> {
    const form = new FormData();
    form.set('file', new Blob([file], { type: mimeType }), filename);
    const body = await this.request<{ fileUrl: string }>('POST', 'v1/upload/image', {
      body: form,
    });
    return body.fileUrl;
  }

  search(query: string): Promise<{ accounts: Account[] }> {
    return this.request('GET', 'v1/actions/search', { query: { query } });
  }
}

function toNoteBody(input: NoteInput): Record<string, unknown> {
  const body: Record<string, unknown> = { content: input.content };
  if (input.image) {
    body.image = input.image.altText
      ? { url: input.image.url, altText: input.image.altText }
      : { url: input.image.url };
  }
  return body;
}
