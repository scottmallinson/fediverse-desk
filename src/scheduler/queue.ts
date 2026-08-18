import { randomUUID } from 'node:crypto';
import { JsonStore } from '../store/store.js';

export type ItemStatus = 'pending' | 'sent' | 'failed' | 'cancelled';

export interface QueueItem {
  id: string;
  kind: 'note' | 'reply';
  content: string;
  /** ActivityPub id of the post being replied to. Set only when kind is "reply". */
  replyTo?: string;
  imagePath?: string;
  imageAlt?: string;
  publishAt: string;
  status: ItemStatus;
  attempts: number;
  createdAt: string;
  lastError?: string;
  /** Set once published: the note's own ActivityPub id and public URL. */
  postId?: string;
  postUrl?: string;
}

export interface QueueState {
  version: 1;
  items: QueueItem[];
}

export interface AddInput {
  content: string;
  publishAt: Date;
  replyTo?: string;
  imagePath?: string;
  imageAlt?: string;
}

export class Queue {
  constructor(private readonly store: JsonStore<QueueState>) {}

  static open(dataDir: string): Queue {
    return new Queue(
      JsonStore.in<QueueState>(dataDir, 'queue.json', () => ({ version: 1, items: [] })),
    );
  }

  async add(input: AddInput): Promise<QueueItem> {
    const content = input.content.trim();
    if (!content) throw new Error('Cannot queue an empty note.');

    const item: QueueItem = {
      id: randomUUID(),
      kind: input.replyTo ? 'reply' : 'note',
      content,
      publishAt: input.publishAt.toISOString(),
      status: 'pending',
      attempts: 0,
      createdAt: new Date().toISOString(),
    };
    if (input.replyTo) item.replyTo = input.replyTo;
    if (input.imagePath) item.imagePath = input.imagePath;
    if (input.imageAlt) item.imageAlt = input.imageAlt;

    await this.store.update((state) => {
      state.items.push(item);
      state.items.sort((a, b) => a.publishAt.localeCompare(b.publishAt));
    });

    return item;
  }

  async list(options: { all?: boolean } = {}): Promise<QueueItem[]> {
    const state = await this.store.read();
    const items = [...state.items].sort((a, b) => a.publishAt.localeCompare(b.publishAt));
    return options.all ? items : items.filter((item) => item.status === 'pending');
  }

  async get(id: string): Promise<QueueItem | undefined> {
    const state = await this.store.read();
    return state.items.find((item) => item.id === id || item.id.startsWith(id));
  }

  async cancel(id: string): Promise<QueueItem | undefined> {
    return this.store.update((state) => {
      const item = state.items.find(
        (candidate) => candidate.id === id || candidate.id.startsWith(id),
      );
      if (!item || item.status !== 'pending') return item;
      item.status = 'cancelled';
      return item;
    });
  }

  /** Pending items whose time has come, oldest first. */
  async due(now: Date = new Date()): Promise<QueueItem[]> {
    const state = await this.store.read();
    return state.items
      .filter((item) => item.status === 'pending' && new Date(item.publishAt) <= now)
      .sort((a, b) => a.publishAt.localeCompare(b.publishAt));
  }

  async markSent(id: string, post: { id: string; url: string }): Promise<void> {
    await this.store.update((state) => {
      const item = state.items.find((candidate) => candidate.id === id);
      if (!item) return;
      item.status = 'sent';
      item.attempts += 1;
      item.postId = post.id;
      item.postUrl = post.url;
      delete item.lastError;
    });
  }

  async markAttemptFailed(id: string, error: string, maxAttempts: number): Promise<void> {
    await this.store.update((state) => {
      const item = state.items.find((candidate) => candidate.id === id);
      if (!item) return;
      item.attempts += 1;
      item.lastError = error.slice(0, 500);
      if (item.attempts >= maxAttempts) item.status = 'failed';
    });
  }

  async retry(id: string): Promise<QueueItem | undefined> {
    return this.store.update((state) => {
      const item = state.items.find(
        (candidate) => candidate.id === id || candidate.id.startsWith(id),
      );
      if (!item || item.status !== 'failed') return item;
      item.status = 'pending';
      item.attempts = 0;
      delete item.lastError;
      return item;
    });
  }
}

const RELATIVE = /^\+(\d+)\s*(m|h|d|w)$/i;

/**
 * Accepts "now", a relative offset such as "+90m" or "+2h", or anything Date can
 * parse. Rejects the past, because a queue that silently fires on the next tick
 * is worse than an error.
 */
export function parseWhen(input: string, now: Date = new Date()): Date {
  const value = input.trim();
  if (!value || value.toLowerCase() === 'now') return now;

  const relative = RELATIVE.exec(value);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = (relative[2] ?? 'm').toLowerCase();
    const minutes = { m: 1, h: 60, d: 60 * 24, w: 60 * 24 * 7 }[unit] ?? 1;
    return new Date(now.getTime() + amount * minutes * 60_000);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Could not read "${input}" as a time. Try an ISO timestamp or "+2h".`);
  }
  if (parsed.getTime() < now.getTime() - 60_000) {
    throw new Error(`${parsed.toISOString()} is in the past.`);
  }
  return parsed;
}
