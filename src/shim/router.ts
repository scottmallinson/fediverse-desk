export type Handler = (context: RouteContext) => Promise<Response> | Response;

export interface RouteContext {
  request: Request;
  url: URL;
  params: Record<string, string>;
}

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

/**
 * A router small enough to read in one sitting. Patterns support ":name"
 * segments and nothing else, which is all the Mastodon surface needs.
 */
export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({
      method: method.toUpperCase(),
      segments: split(pattern),
      handler,
    });
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: Handler): this {
    return this.add('POST', pattern, handler);
  }

  delete(pattern: string, handler: Handler): this {
    return this.add('DELETE', pattern, handler);
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = split(pathname);
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue;
      if (route.segments.length !== parts.length) continue;

      const params: Record<string, string> = {};
      let matched = true;
      for (let index = 0; index < route.segments.length; index += 1) {
        const expected = route.segments[index] as string;
        const actual = parts[index] as string;
        if (expected.startsWith(':')) {
          params[expected.slice(1)] = decodeURIComponent(actual);
        } else if (expected !== actual) {
          matched = false;
          break;
        }
      }
      if (matched) return { handler: route.handler, params };
    }
    return null;
  }
}

function split(pathname: string): string[] {
  return pathname.split('/').filter((segment) => segment.length > 0);
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(init.headers ?? {}) },
  });
}

export function error(message: string, status = 400, extra: Record<string, unknown> = {}): Response {
  return json({ error: message, ...extra }, { status });
}

export function html(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    ...init,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...(init.headers ?? {}) },
  });
}

export type Params = Record<string, string | string[]>;

/**
 * Mastodon clients are inconsistent about how they encode a request body: JSON,
 * form-urlencoded and multipart all show up in the wild, sometimes from the same
 * client on different endpoints. Read whichever arrived.
 */
export async function readParams(request: Request): Promise<Params> {
  const contentType = request.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const params: Params = {};
    for (const [key, value] of Object.entries(body ?? {})) {
      if (Array.isArray(value)) {
        params[key] = value.map(String);
      } else if (value !== null && value !== undefined) {
        params[key] = String(value);
      }
    }
    return params;
  }

  const form = await request.formData().catch(() => new FormData());
  const params: Params = {};
  for (const [rawKey, value] of form.entries()) {
    if (typeof value !== 'string') continue;
    // Both "media_ids[]" and repeated "media_ids" mean the same list.
    const key = rawKey.endsWith('[]') ? rawKey.slice(0, -2) : rawKey;
    const existing = params[key];
    if (existing === undefined) {
      params[key] = rawKey.endsWith('[]') ? [value] : value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      params[key] = [existing, value];
    }
  }
  return params;
}

export function one(params: Params, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

export function many(params: Params, key: string): string[] {
  const value = params[key];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
