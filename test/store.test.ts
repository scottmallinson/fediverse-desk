import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JsonStore } from '../src/store/store.js';
import { Queue } from '../src/scheduler/queue.js';
import { tempDir } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));

function runWriter(dataDir: string, label: string, count: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(here, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        join(here, 'fixtures', 'writer.ts'),
        dataDir,
        label,
        String(count),
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`writer ${label} exited ${code}: ${stderr}`));
      else resolve(code);
    });
  });
}

describe('JsonStore', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;

  beforeEach(async () => {
    dir = await tempDir();
  });

  afterEach(async () => {
    await dir.cleanup();
  });

  it('starts from the initial value when there is no file yet', async () => {
    const store = new JsonStore<{ items: string[] }>(join(dir.path, 'x.json'), () => ({
      items: [],
    }));
    expect(await store.read()).toEqual({ items: [] });
  });

  it('sees a write made by something else, having no cache to go stale', async () => {
    const path = join(dir.path, 'x.json');
    const store = new JsonStore<{ items: string[] }>(path, () => ({ items: [] }));

    await store.update((state) => {
      state.items.push('mine');
    });

    // Stand in for another process writing the same file.
    await writeFile(path, JSON.stringify({ items: ['theirs'] }));

    expect(await store.read()).toEqual({ items: ['theirs'] });
  });

  it('writes with owner-only permissions', async () => {
    const path = join(dir.path, 'x.json');
    const store = new JsonStore<{ items: string[] }>(path, () => ({ items: [] }));
    await store.update((state) => state.items.push('one'));

    const { stat } = await import('node:fs/promises');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('leaves no lock file behind after a successful write', async () => {
    const path = join(dir.path, 'x.json');
    const store = new JsonStore<{ items: string[] }>(path, () => ({ items: [] }));
    await store.update((state) => state.items.push('one'));

    const { access } = await import('node:fs/promises');
    await expect(access(`${path}.lock`)).rejects.toThrow();
  });

  it('releases the lock when the mutation throws', async () => {
    const path = join(dir.path, 'x.json');
    const store = new JsonStore<{ items: string[] }>(path, () => ({ items: [] }));

    await expect(
      store.update(() => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');

    // If the lock leaked, this second write would hang until the timeout.
    await store.update((state) => state.items.push('after'));
    expect((await store.read()).items).toEqual(['after']);
  });

  it('breaks a stale lock rather than blocking forever', async () => {
    const path = join(dir.path, 'x.json');
    const store = new JsonStore<{ items: string[] }>(path, () => ({ items: [] }));

    // A lock left behind by a process that died, backdated past the stale window.
    await writeFile(`${path}.lock`, '999999');
    const { utimes } = await import('node:fs/promises');
    const longAgo = new Date(Date.now() - 60_000);
    await utimes(`${path}.lock`, longAgo, longAgo);

    await store.update((state) => state.items.push('recovered'));
    expect((await store.read()).items).toEqual(['recovered']);
  });

  it('does not lose writes from four concurrent processes', async () => {
    // The deployment this guards: the bridge, the runner and a shell all
    // touching queue.json at once.
    await Promise.all([
      runWriter(dir.path, 'a', 5),
      runWriter(dir.path, 'b', 5),
      runWriter(dir.path, 'c', 5),
      runWriter(dir.path, 'd', 5),
    ]);

    const items = await Queue.open(dir.path).list();
    expect(items).toHaveLength(20);

    const contents = items.map((item) => item.content).sort();
    expect(new Set(contents).size).toBe(20);

    // And the file is still valid JSON, not an interleaved mess.
    const raw = await readFile(join(dir.path, 'queue.json'), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  }, 30_000);
});
