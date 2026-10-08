import type { Account } from '../ghost/types.js';
import type { Fetcher } from '../ghost/identity.js';

/**
 * Full accounts for the authors that statuses only name.
 *
 * Ghost hands a post's author over as a trimmed record with no counts. The
 * Mastodon Android app opens a profile straight from the account embedded in
 * the status it was tapped on and does not fetch it again, so a profile reached
 * from a timeline showed zero followers, zero posts and a 1970 join date. Each
 * author is looked up once and remembered for a while instead.
 *
 * Neither Ghost nor ActivityPub carries the date an account was created, and
 * most Mastodon servers refuse unsigned actor fetches. Their public lookup API
 * does answer, so the join date is asked of the account's own server. Anything
 * that is not Mastodon-compatible simply has no date to give.
 */
export class ProfileDirectory {
  private readonly accounts = new Expiring<Account | null>();
  private readonly joined = new Expiring<string | null>();

  constructor(
    private readonly lookup: (handle: string) => Promise<Account>,
    private readonly fetcher: Fetcher = fetch,
    private readonly options: { ttlMs?: number; failureTtlMs?: number; timeoutMs?: number } = {},
  ) {}

  /** The full account for a handle, or null when Ghost cannot produce one. */
  account(handle: string): Promise<Account | null> {
    return this.accounts.get(key(handle), () => this.lookup(handle), this.ttls());
  }

  /** Records an account fetched elsewhere, so a later status can reuse it. */
  remember(account: Account): void {
    this.accounts.set(key(account.handle), Promise.resolve(account), this.ttls().success);
  }

  /** When the account was created, as an ISO string, or null when unknown. */
  joinedAt(handle: string): Promise<string | null> {
    return this.joined.get(key(handle), () => this.fetchJoined(handle), this.ttls());
  }

  private ttls() {
    return {
      success: this.options.ttlMs ?? 10 * 60_000,
      failure: this.options.failureTtlMs ?? 60_000,
    };
  }

  private async fetchJoined(handle: string): Promise<string | null> {
    const [user, host] = key(handle).slice(1).split('@');
    if (!user || !host || !HOST.test(host)) return null;

    const url = new URL(`https://${host}/api/v1/accounts/lookup`);
    url.searchParams.set('acct', user);
    const response = await this.fetcher(url.toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
    });
    if (!response.ok) return null;

    const body = (await response.json()) as { created_at?: unknown };
    if (typeof body.created_at !== 'string') return null;
    const date = new Date(body.created_at);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
}

const HOST = /^[a-z0-9.-]+(:\d+)?$/;

function key(handle: string): string {
  return `@${handle.replace(/^@/, '').toLowerCase()}`;
}

/**
 * Resolves to `fallback` if `promise` has not settled within `ms`. The promise
 * keeps running, so whatever it was filling in is there for the next request.
 */
export function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise.catch(() => fallback), timeout]).finally(() =>
    clearTimeout(timer),
  );
}

/**
 * A bounded map of in-flight or settled lookups. Sharing the promise means a
 * page of twenty posts by one author asks once, not twenty times. Failures
 * become null and are kept briefly, so a dead server is not asked on every page.
 */
class Expiring<T> {
  private readonly entries = new Map<string, { expires: number; value: Promise<T> }>();

  constructor(private readonly limit = 500) {}

  get(
    id: string,
    load: () => Promise<T>,
    ttl: { success: number; failure: number },
  ): Promise<T | null> {
    const entry = this.entries.get(id);
    if (entry && entry.expires > Date.now()) return entry.value;

    const value: Promise<T | null> = load().then(
      (result) => {
        this.extend(id, value, ttl.success);
        return result;
      },
      () => {
        this.extend(id, value, ttl.failure);
        return null;
      },
    );
    // Held for as long as the slowest lookup could take, then trimmed to the
    // real lifetime once it settles.
    this.set(id, value as Promise<T>, ttl.success);
    return value;
  }

  set(id: string, value: Promise<T>, ttlMs: number): void {
    this.entries.delete(id);
    this.entries.set(id, { expires: Date.now() + ttlMs, value });
    if (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  private extend(id: string, value: Promise<unknown>, ttlMs: number): void {
    const entry = this.entries.get(id);
    if (entry?.value === value) entry.expires = Date.now() + ttlMs;
  }
}
