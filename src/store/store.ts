import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * A tiny JSON-file store with atomic writes.
 *
 * Deliberately not SQLite. This holds a personal queue and a handful of OAuth
 * grants: tens of rows, one writer. A file that can be read with `cat` and fixed
 * with an editor is worth more here than indexes nobody needs.
 */
export class JsonStore<T> {
  private cache: T | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly initial: () => T,
  ) {}

  static in<T>(dataDir: string, filename: string, initial: () => T): JsonStore<T> {
    return new JsonStore<T>(join(dataDir, filename), initial);
  }

  async read(): Promise<T> {
    if (this.cache !== null) return this.cache;
    try {
      const raw = await readFile(this.path, 'utf8');
      this.cache = JSON.parse(raw) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.cache = this.initial();
    }
    return this.cache;
  }

  /**
   * Serialises mutations so two concurrent updates cannot lose one another, and
   * writes via a temporary file so an interrupted write cannot truncate state.
   */
  async update<R>(mutate: (state: T) => R | Promise<R>): Promise<R> {
    let result!: R;
    const next = this.writing.then(async () => {
      const state = await this.read();
      result = await mutate(state);
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
      this.cache = state;
    });
    this.writing = next.catch(() => undefined);
    await next;
    return result;
  }
}
