import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { JsonStore } from '../store/store.js';

export interface OAuthApp {
  id: string;
  name: string;
  website: string | null;
  redirectUris: string[];
  clientId: string;
  clientSecretHash: string;
  scopes: string;
  createdAt: string;
}

export interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  /** PKCE S256 challenge, when the client supplied one. */
  codeChallenge?: string;
  expiresAt: number;
}

export interface AccessToken {
  tokenHash: string;
  clientId: string;
  scope: string;
  createdAt: number;
}

export interface OAuthState {
  version: 1;
  apps: OAuthApp[];
  codes: AuthCode[];
  tokens: AccessToken[];
}

export const OOB_REDIRECT = 'urn:ietf:wg:oauth:2.0:oob';

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function secret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time comparison that does not leak length through an early return. */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * Just enough of Mastodon's OAuth for a publishing client to log in.
 *
 * One human, one password, and no signup. Secrets and access tokens are stored
 * as SHA-256 digests so the state file never holds a live credential: if it
 * leaks, nothing in it can be replayed against the shim.
 */
export class OAuthServer {
  constructor(
    private readonly store: JsonStore<OAuthState>,
    private readonly password: string,
    private readonly clock: () => number = Date.now,
  ) {}

  static open(dataDir: string, password: string): OAuthServer {
    return new OAuthServer(
      JsonStore.in<OAuthState>(dataDir, 'oauth.json', () => ({
        version: 1,
        apps: [],
        codes: [],
        tokens: [],
      })),
      password,
    );
  }

  async registerApp(input: {
    name: string;
    redirectUris: string[];
    scopes?: string;
    website?: string | null;
  }): Promise<{ app: OAuthApp; clientSecret: string }> {
    if (!input.name.trim()) throw new OAuthError('invalid_request', 'client_name is required.');
    if (input.redirectUris.length === 0) {
      throw new OAuthError('invalid_request', 'redirect_uris is required.');
    }

    const clientSecret = secret();
    const app: OAuthApp = {
      id: String(this.clock()),
      name: input.name.trim(),
      website: input.website ?? null,
      redirectUris: input.redirectUris,
      clientId: secret(24),
      clientSecretHash: hash(clientSecret),
      scopes: input.scopes?.trim() || 'read',
      createdAt: new Date(this.clock()).toISOString(),
    };

    await this.store.update((state) => {
      state.apps.push(app);
    });

    return { app, clientSecret };
  }

  async findApp(clientId: string): Promise<OAuthApp | undefined> {
    const state = await this.store.read();
    return state.apps.find((app) => app.clientId === clientId);
  }

  /**
   * Redirect URIs are compared exactly, never by prefix. A prefix match is how
   * open redirects get built, and there is no client here worth the risk.
   */
  async checkRedirect(clientId: string, redirectUri: string): Promise<OAuthApp> {
    const app = await this.findApp(clientId);
    if (!app) throw new OAuthError('invalid_client', 'Unknown client_id.', 401);
    // Apps registered before redirect_uris was split on whitespace hold several
    // URIs in one entry. Clients such as Buffer register once and reuse the
    // client_id for good, so split here too rather than strand them. Each URI
    // is still compared exactly.
    const registered = app.redirectUris.flatMap((uri) => uri.split(/\s+/)).filter(Boolean);
    if (!registered.includes(redirectUri)) {
      throw new OAuthError('invalid_grant', 'redirect_uri does not match this client.');
    }
    return app;
  }

  checkPassword(candidate: string): boolean {
    if (!this.password) return false;
    return safeEqual(candidate, this.password);
  }

  async issueCode(
    clientId: string,
    redirectUri: string,
    scope: string,
    codeChallenge?: string,
  ): Promise<string> {
    const code = secret();
    await this.store.update((state) => {
      state.codes = state.codes.filter((entry) => entry.expiresAt > this.clock());
      state.codes.push({
        code: hash(code),
        clientId,
        redirectUri,
        scope,
        ...(codeChallenge ? { codeChallenge } : {}),
        expiresAt: this.clock() + 5 * 60_000,
      });
    });
    return code;
  }

  /** Codes are single use: consumed whether or not the exchange then succeeds. */
  async exchangeCode(input: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    codeVerifier?: string;
  }): Promise<{ accessToken: string; scope: string }> {
    const app = await this.authenticateClient(input.clientId, input.clientSecret);

    const codeHash = hash(input.code);
    const entry = await this.store.update((state) => {
      const index = state.codes.findIndex((candidate) => candidate.code === codeHash);
      if (index === -1) return undefined;
      const [found] = state.codes.splice(index, 1);
      return found;
    });

    if (!entry) throw new OAuthError('invalid_grant', 'Unknown or already used code.');
    if (entry.expiresAt <= this.clock()) throw new OAuthError('invalid_grant', 'Code expired.');
    if (entry.clientId !== input.clientId) {
      throw new OAuthError('invalid_grant', 'Code was issued to a different client.');
    }
    if (entry.redirectUri !== input.redirectUri) {
      throw new OAuthError('invalid_grant', 'redirect_uri does not match the code.');
    }

    if (entry.codeChallenge) {
      const challenge = createHash('sha256')
        .update(input.codeVerifier ?? '')
        .digest('base64url');
      if (!input.codeVerifier || !safeEqual(challenge, entry.codeChallenge)) {
        throw new OAuthError('invalid_grant', 'code_verifier does not match the code_challenge.');
      }
    }

    return { accessToken: await this.issueToken(app.clientId, entry.scope), scope: entry.scope };
  }

  async authenticateClient(clientId: string, clientSecret: string): Promise<OAuthApp> {
    const app = await this.findApp(clientId);
    if (!app || !safeEqual(hash(clientSecret), app.clientSecretHash)) {
      throw new OAuthError('invalid_client', 'Client authentication failed.', 401);
    }
    return app;
  }

  async issueToken(clientId: string, scope: string): Promise<string> {
    const token = secret();
    await this.store.update((state) => {
      state.tokens.push({
        tokenHash: hash(token),
        clientId,
        scope,
        createdAt: this.clock(),
      });
    });
    return token;
  }

  async verifyToken(token: string): Promise<AccessToken | undefined> {
    const state = await this.store.read();
    const digest = hash(token);
    return state.tokens.find((entry) => entry.tokenHash === digest);
  }

  async revokeToken(token: string): Promise<void> {
    const digest = hash(token);
    await this.store.update((state) => {
      state.tokens = state.tokens.filter((entry) => entry.tokenHash !== digest);
    });
  }
}

/**
 * Slows down password guessing against the one endpoint that accepts a password.
 * In memory on purpose: a restart clearing the counter is fine when the window
 * is measured in minutes.
 */
export class LoginThrottle {
  private readonly attempts = new Map<string, { count: number; until: number }>();

  constructor(
    private readonly maxAttempts = 5,
    private readonly windowMs = 15 * 60_000,
    private readonly clock: () => number = Date.now,
  ) {}

  isLocked(key: string): boolean {
    const entry = this.attempts.get(key);
    if (!entry) return false;
    if (entry.until <= this.clock()) {
      this.attempts.delete(key);
      return false;
    }
    return entry.count >= this.maxAttempts;
  }

  recordFailure(key: string): void {
    const entry = this.attempts.get(key);
    if (!entry || entry.until <= this.clock()) {
      this.attempts.set(key, { count: 1, until: this.clock() + this.windowMs });
      return;
    }
    entry.count += 1;
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }
}
