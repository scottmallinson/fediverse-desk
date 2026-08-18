import { createAdminToken, decodeJwtPayload } from './admin-token.js';
import { parseStaffToken } from '../config.js';

export class GhostAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface Identity {
  token: string;
  subject: string | null;
  role: string | null;
  expiresAt: number;
}

export type Fetcher = typeof fetch;

/**
 * Bootstraps the short-lived identity token that Ghost's ActivityPub service
 * accepts, and holds on to it until shortly before it expires.
 *
 * The chain is: staff access token -> Ghost Admin API -> an RS256 identity token
 * signed with the site key and carrying a role claim -> Bearer against
 * /.ghost/activitypub. Nothing else can mint that middle token, which is why a
 * custom integration key gets a 403 here no matter what permissions it is given.
 */
export class IdentityProvider {
  private cached: Identity | null = null;
  private inFlight: Promise<Identity> | null = null;

  constructor(
    private readonly ghostUrl: string,
    private readonly staffToken: string,
    private readonly fetcher: Fetcher = fetch,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Refresh with 30s of headroom: the token only lives five minutes. */
  private isFresh(identity: Identity | null): identity is Identity {
    return identity !== null && identity.expiresAt - 30_000 > this.clock();
  }

  async get(): Promise<Identity> {
    if (this.isFresh(this.cached)) return this.cached;
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.fetchIdentity()
      .then((identity) => {
        this.cached = identity;
        return identity;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  private async fetchIdentity(): Promise<Identity> {
    const { id, secret } = parseStaffToken(this.staffToken);
    const adminToken = createAdminToken(id, secret, { now: this.clock() });

    const response = await this.fetcher(`${this.ghostUrl}/ghost/api/admin/identities/`, {
      headers: {
        Authorization: `Ghost ${adminToken}`,
        'Accept-Version': 'v6.0',
      },
    });

    if (response.status === 403) {
      throw new GhostAuthError(
        'Ghost refused to issue an identity token. The social web bridge needs a staff ' +
          'access token belonging to an Owner or Administrator: a custom integration key ' +
          'cannot reach this endpoint.',
        403,
      );
    }

    if (!response.ok) {
      throw new GhostAuthError(
        `Could not read /ghost/api/admin/identities/: ${response.status} ${await safeText(response)}`,
        response.status,
      );
    }

    const body = (await response.json()) as { identities?: Array<{ token?: string }> };
    const token = body.identities?.[0]?.token;
    if (!token) {
      throw new GhostAuthError('Ghost returned no identity token.');
    }

    const claims = decodeJwtPayload(token) ?? {};
    const exp = typeof claims.exp === 'number' ? claims.exp * 1000 : this.clock() + 300_000;

    return {
      token,
      subject: typeof claims.sub === 'string' ? claims.sub : null,
      role: typeof claims.role === 'string' ? claims.role : null,
      expiresAt: exp,
    };
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return '';
  }
}
