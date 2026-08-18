import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { SocialWeb } from '../ghost/types.js';
import type { Queue, QueueItem } from './queue.js';

export interface RunnerOptions {
  maxAttempts?: number;
  /** Called for each item as it resolves, so the CLI can report without polling. */
  onResult?: (item: QueueItem, result: RunResult) => void;
}

export type RunResult =
  | { ok: true; postId: string; postUrl: string }
  | { ok: false; error: string; willRetry: boolean };

const MIME_BY_EXTENSION: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};

export class Runner {
  private readonly maxAttempts: number;

  constructor(
    private readonly queue: Queue,
    private readonly social: SocialWeb,
    private readonly options: RunnerOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 5;
  }

  /**
   * Publish everything that is due, one at a time.
   *
   * Sequential on purpose: these are posts to a timeline, and the order they were
   * queued in is the order they should appear. A failure does not stop the run,
   * it just leaves that item to be retried on the next tick.
   */
  async tick(now: Date = new Date()): Promise<{ sent: number; failed: number }> {
    const due = await this.queue.due(now);
    let sent = 0;
    let failed = 0;

    for (const item of due) {
      try {
        const post = await this.publish(item);
        await this.queue.markSent(item.id, post);
        sent += 1;
        this.options.onResult?.(item, { ok: true, postId: post.id, postUrl: post.url });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.queue.markAttemptFailed(item.id, message, this.maxAttempts);
        failed += 1;
        this.options.onResult?.(item, {
          ok: false,
          error: message,
          willRetry: item.attempts + 1 < this.maxAttempts,
        });
      }
    }

    return { sent, failed };
  }

  private async publish(item: QueueItem): Promise<{ id: string; url: string }> {
    const image = item.imagePath ? await this.uploadImage(item) : undefined;
    const input = image ? { content: item.content, image } : { content: item.content };

    const post =
      item.kind === 'reply' && item.replyTo
        ? await this.social.reply(item.replyTo, input)
        : await this.social.note(input);

    return { id: post.id, url: post.url };
  }

  private async uploadImage(
    item: QueueItem,
  ): Promise<{ url: string; altText?: string } | undefined> {
    if (!item.imagePath) return undefined;
    const bytes = await readFile(item.imagePath);
    const filename = basename(item.imagePath);
    const mimeType = MIME_BY_EXTENSION[extname(filename).toLowerCase()] ?? 'application/octet-stream';
    const url = await this.social.uploadImage(bytes, filename, mimeType);
    return item.imageAlt ? { url, altText: item.imageAlt } : { url };
  }
}

/**
 * Runs `tick` forever. Intended for `desk run --watch`; for a cron entry, use
 * `desk run --once` instead and let cron own the schedule.
 */
export async function watch(
  runner: Runner,
  intervalMs: number,
  signal?: AbortSignal,
): Promise<void> {
  while (!signal?.aborted) {
    await runner.tick();
    await sleep(intervalMs, signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
