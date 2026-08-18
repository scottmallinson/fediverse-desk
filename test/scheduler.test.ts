import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Queue, parseWhen } from '../src/scheduler/queue.js';
import { Runner } from '../src/scheduler/runner.js';
import { FakeSocialWeb, tempDir } from './helpers.js';

describe('parseWhen', () => {
  const now = new Date('2026-08-18T10:00:00.000Z');

  it('reads "now" and an empty value as now', () => {
    expect(parseWhen('now', now)).toEqual(now);
    expect(parseWhen('  ', now)).toEqual(now);
  });

  it('reads relative offsets', () => {
    expect(parseWhen('+30m', now).toISOString()).toBe('2026-08-18T10:30:00.000Z');
    expect(parseWhen('+2h', now).toISOString()).toBe('2026-08-18T12:00:00.000Z');
    expect(parseWhen('+3d', now).toISOString()).toBe('2026-08-21T10:00:00.000Z');
    expect(parseWhen('+1w', now).toISOString()).toBe('2026-08-25T10:00:00.000Z');
  });

  it('reads an ISO timestamp', () => {
    expect(parseWhen('2026-09-01T09:00:00Z', now).toISOString()).toBe('2026-09-01T09:00:00.000Z');
  });

  it('refuses the past, rather than firing on the next tick', () => {
    expect(() => parseWhen('2026-08-17T10:00:00Z', now)).toThrow(/in the past/);
  });

  it('refuses something that is not a time', () => {
    expect(() => parseWhen('tomorrow-ish', now)).toThrow(/Could not read/);
  });
});

describe('Queue', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let queue: Queue;

  beforeEach(async () => {
    dir = await tempDir();
    queue = Queue.open(dir.path);
  });

  afterEach(async () => {
    await dir.cleanup();
  });

  it('rejects an empty note', async () => {
    await expect(queue.add({ content: '   ', publishAt: new Date() })).rejects.toThrow(/empty/);
  });

  it('records a reply as a reply', async () => {
    const item = await queue.add({
      content: 'yes',
      publishAt: new Date(),
      replyTo: 'https://example.com/note/9',
    });
    expect(item.kind).toBe('reply');
    expect(item.replyTo).toBe('https://example.com/note/9');
  });

  it('only returns items that are actually due', async () => {
    const now = new Date('2026-08-18T10:00:00.000Z');
    await queue.add({ content: 'past', publishAt: new Date('2026-08-18T09:00:00.000Z') });
    await queue.add({ content: 'future', publishAt: new Date('2026-08-18T11:00:00.000Z') });

    const due = await queue.due(now);
    expect(due.map((item) => item.content)).toEqual(['past']);
  });

  it('lists pending by default and everything with --all', async () => {
    const item = await queue.add({ content: 'one', publishAt: new Date() });
    await queue.cancel(item.id);

    expect(await queue.list()).toHaveLength(0);
    expect(await queue.list({ all: true })).toHaveLength(1);
  });

  it('matches an id by prefix, the way the CLI prints it', async () => {
    const item = await queue.add({ content: 'one', publishAt: new Date() });
    const found = await queue.get(item.id.slice(0, 8));
    expect(found?.id).toBe(item.id);
  });

  it('persists across instances', async () => {
    await queue.add({ content: 'survives', publishAt: new Date() });
    const reopened = Queue.open(dir.path);
    expect((await reopened.list()).map((item) => item.content)).toEqual(['survives']);
  });

  it('serialises concurrent writes without losing any', async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        queue.add({ content: `note ${index}`, publishAt: new Date() }),
      ),
    );
    expect(await queue.list()).toHaveLength(12);
  });

  it('gives up after the attempt limit and can be put back by hand', async () => {
    const item = await queue.add({ content: 'one', publishAt: new Date() });
    await queue.markAttemptFailed(item.id, 'boom', 2);
    expect((await queue.get(item.id))?.status).toBe('pending');

    await queue.markAttemptFailed(item.id, 'boom', 2);
    expect((await queue.get(item.id))?.status).toBe('failed');

    await queue.retry(item.id);
    const retried = await queue.get(item.id);
    expect(retried?.status).toBe('pending');
    expect(retried?.attempts).toBe(0);
  });
});

describe('Runner', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let queue: Queue;
  let social: FakeSocialWeb;

  beforeEach(async () => {
    dir = await tempDir();
    queue = Queue.open(dir.path);
    social = new FakeSocialWeb();
  });

  afterEach(async () => {
    await dir.cleanup();
  });

  it('publishes due notes and records where they landed', async () => {
    const item = await queue.add({ content: 'hello', publishAt: new Date('2026-01-01') });
    const result = await new Runner(queue, social).tick();

    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(social.calls).toEqual([{ method: 'note', args: [{ content: 'hello' }] }]);

    const stored = await queue.get(item.id);
    expect(stored?.status).toBe('sent');
    expect(stored?.postUrl).toBe('https://example.com/notes/1');
  });

  it('leaves items that are not due alone', async () => {
    await queue.add({ content: 'later', publishAt: new Date('2099-01-01') });
    expect(await new Runner(queue, social).tick()).toEqual({ sent: 0, failed: 0 });
    expect(social.calls).toHaveLength(0);
  });

  it('routes a reply through reply rather than note', async () => {
    await queue.add({
      content: 'agreed',
      publishAt: new Date('2026-01-01'),
      replyTo: 'https://example.com/note/9',
    });
    await new Runner(queue, social).tick();

    expect(social.calls[0]).toEqual({
      method: 'reply',
      args: ['https://example.com/note/9', { content: 'agreed' }],
    });
  });

  it('uploads an image first and attaches the returned URL', async () => {
    const imagePath = join(dir.path, 'card.png');
    await writeFile(imagePath, Buffer.from([1, 2, 3]));

    await queue.add({
      content: 'with a picture',
      publishAt: new Date('2026-01-01'),
      imagePath,
      imageAlt: 'a picture',
    });
    await new Runner(queue, social).tick();

    expect(social.calls[0]).toEqual({
      method: 'uploadImage',
      args: ['card.png', 'image/png', 3],
    });
    expect(social.calls[1]).toEqual({
      method: 'note',
      args: [
        {
          content: 'with a picture',
          image: { url: 'https://storage.example.com/images/card.png', altText: 'a picture' },
        },
      ],
    });
  });

  it('keeps a failed item pending so the next tick retries it', async () => {
    const item = await queue.add({ content: 'flaky', publishAt: new Date('2026-01-01') });
    social.failNext = new Error('502 from Ghost');

    const result = await new Runner(queue, social).tick();
    expect(result).toEqual({ sent: 0, failed: 1 });

    const stored = await queue.get(item.id);
    expect(stored?.status).toBe('pending');
    expect(stored?.attempts).toBe(1);
    expect(stored?.lastError).toBe('502 from Ghost');

    expect(await new Runner(queue, social).tick()).toEqual({ sent: 1, failed: 0 });
  });

  it('gives up once attempts run out', async () => {
    const item = await queue.add({ content: 'doomed', publishAt: new Date('2026-01-01') });
    const runner = new Runner(queue, social, { maxAttempts: 1 });
    social.failNext = new Error('nope');

    await runner.tick();
    expect((await queue.get(item.id))?.status).toBe('failed');
  });

  it('publishes in queued order and does not stop at the first failure', async () => {
    await queue.add({ content: 'first', publishAt: new Date('2026-01-01T00:00:00Z') });
    await queue.add({ content: 'second', publishAt: new Date('2026-01-01T01:00:00Z') });
    social.failNext = new Error('first one fails');

    const result = await new Runner(queue, social).tick();
    expect(result).toEqual({ sent: 1, failed: 1 });
    expect(social.notes.map((post) => post.content)).toEqual(['second']);
  });
});
