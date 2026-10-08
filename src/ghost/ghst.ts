import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractReplyApId, extractWrappedPost, synthesisePost } from './reply.js';
import type {
  Account,
  Notification,
  NoteInput,
  Page,
  Post,
  SocialWeb,
  Thread,
} from './types.js';

export class GhstError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(message);
  }
}

export interface GhstOptions {
  ghostUrl: string;
  staffToken: string;
  /** Override the binary. Defaults to `ghst` on PATH, then `npx @tryghost/ghst`. */
  bin?: string;
  timeoutMs?: number;
  runner?: Runner;
}

export type Runner = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) => Promise<{ stdout: string; stderr: string; code: number }>;

const defaultRunner: Runner = (command, args, env, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new GhstError(`ghst timed out after ${timeoutMs}ms`, -1, stderr));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 0 });
    });
  });

/**
 * Drives @tryghost/ghst as the transport.
 *
 * The point is not that it is faster than calling the API. It is that ghst is
 * TryGhost's own client for an API they do not document, so when the endpoints
 * move, somebody else has already absorbed it. The scheduler defaults to this;
 * the shim does not, because spawning a process per inbound request is silly.
 */
export class GhstSocialWeb implements SocialWeb {
  private readonly bin: string;
  private readonly usesNpx: boolean;
  private readonly timeoutMs: number;
  private readonly runner: Runner;

  constructor(private readonly options: GhstOptions) {
    this.bin = options.bin ?? process.env.DESK_GHST_BIN ?? 'ghst';
    this.usesNpx = this.bin === 'npx';
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.runner = options.runner ?? defaultRunner;
  }

  private async run<T>(args: string[]): Promise<T> {
    const argv = this.usesNpx ? ['--yes', '@tryghost/ghst', ...args] : args;
    const { stdout, stderr, code } = await this.runner(
      this.bin,
      [...argv, '--json'],
      {
        GHOST_URL: this.options.ghostUrl,
        GHOST_STAFF_ACCESS_TOKEN: this.options.staffToken,
        NO_COLOR: '1',
      },
      this.timeoutMs,
    );

    if (code !== 0) {
      throw new GhstError(
        `ghst ${args.join(' ')} exited ${code}: ${stderr.trim().slice(0, 400)}`,
        code,
        stderr,
      );
    }

    const trimmed = stdout.trim();
    if (!trimmed) return undefined as T;

    try {
      return JSON.parse(trimmed) as T;
    } catch {
      throw new GhstError(
        `ghst ${args.join(' ')} did not return JSON: ${trimmed.slice(0, 200)}`,
        code,
        stderr,
      );
    }
  }

  me(): Promise<Account> {
    return this.run<Account>(['socialweb', 'profile']);
  }

  account(handle: string): Promise<Account> {
    return this.run<Account>(['socialweb', 'profile', handle]);
  }

  async note(input: NoteInput): Promise<Post> {
    const body = await this.run<{ post: Post }>([
      'socialweb',
      'note',
      '--content',
      input.content,
      ...imageArgs(input),
    ]);
    return body.post;
  }

  async reply(postId: string, input: NoteInput): Promise<Post> {
    const body = await this.run<unknown>([
      'socialweb',
      'reply',
      postId,
      '--content',
      input.content,
      ...imageArgs(input),
    ]);

    // ghst passes the endpoint's response through untouched, so this is the
    // same Create activity the direct transport has to unpick. Same rule after
    // this line: the reply is out, so nothing here may throw.
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

  async deletePost(postId: string): Promise<void> {
    await this.run(['--enable-destructive-actions', 'socialweb', 'delete', postId, '--yes']);
  }

  async like(postId: string): Promise<void> {
    await this.run(['socialweb', 'like', postId]);
  }

  async unlike(postId: string): Promise<void> {
    await this.run(['socialweb', 'unlike', postId]);
  }

  async repost(postId: string): Promise<void> {
    await this.run(['socialweb', 'repost', postId]);
  }

  async derepost(postId: string): Promise<void> {
    await this.run(['socialweb', 'derepost', postId]);
  }

  async follow(handle: string): Promise<void> {
    await this.run(['socialweb', 'follow', handle]);
  }

  async unfollow(handle: string): Promise<void> {
    await this.run(['socialweb', 'unfollow', handle]);
  }

  readerFeed(options: { limit?: number; next?: string } = {}): Promise<Page<Post>> {
    return this.feed('reader', options);
  }

  notesFeed(options: { limit?: number; next?: string } = {}): Promise<Page<Post>> {
    return this.feed('notes', options);
  }

  posts(handle: string, options: { limit?: number; next?: string } = {}): Promise<Page<Post>> {
    return this.feed('posts', options, [handle]);
  }

  liked(options: { limit?: number; next?: string } = {}): Promise<Page<Post>> {
    return this.feed('likes', options);
  }

  post(apId: string): Promise<Post> {
    return this.run<Post>(['socialweb', 'post', apId]);
  }

  /** ghst already retries through the post fetch when Ghost lacks the thread. */
  thread(apId: string): Promise<Thread> {
    return this.run<Thread>(['socialweb', 'thread', apId]);
  }

  async follows(
    handle: string,
    type: 'followers' | 'following',
    options: { limit?: number; next?: string } = {},
  ): Promise<Page<Account>> {
    const body = await this.run<{ accounts?: Account[]; next?: string | null }>([
      'socialweb',
      type,
      handle,
      ...paginationArgs(options),
    ]);
    return { items: body.accounts ?? [], next: body.next ?? null };
  }

  private async feed(
    command: string,
    options: { limit?: number; next?: string },
    extra: string[] = [],
  ): Promise<Page<Post>> {
    const body = await this.run<{ posts?: Post[]; next?: string | null }>([
      'socialweb',
      command,
      ...extra,
      ...paginationArgs(options),
    ]);
    return { items: body.posts ?? [], next: body.next ?? null };
  }

  async notifications(
    options: { limit?: number; next?: string } = {},
  ): Promise<Page<Notification>> {
    const body = await this.run<{ notifications?: Notification[]; next?: string | null }>([
      'socialweb',
      'notifications',
      ...paginationArgs(options),
    ]);
    return { items: body.notifications ?? [], next: body.next ?? null };
  }

  /**
   * ghst uploads from a path, so bytes have to touch the disk. The temporary
   * file is removed even when the upload throws.
   */
  async uploadImage(file: Uint8Array, filename: string, _mimeType: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'desk-upload-'));
    const path = join(dir, sanitiseFilename(filename));
    try {
      await writeFile(path, file);
      const body = await this.run<{ fileUrl: string }>(['socialweb', 'upload', path]);
      return body.fileUrl;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  search(query: string): Promise<{ accounts: Account[] }> {
    return this.run(['socialweb', 'search', query]);
  }
}

function imageArgs(input: NoteInput): string[] {
  if (!input.image) return [];
  const args = ['--image-url', input.image.url];
  if (input.image.altText) args.push('--image-alt', input.image.altText);
  return args;
}

function paginationArgs(options: { limit?: number; next?: string }): string[] {
  const args: string[] = [];
  if (options.limit !== undefined) args.push('--limit', String(options.limit));
  if (options.next) args.push('--next', options.next);
  return args;
}

function sanitiseFilename(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned || 'upload';
}
