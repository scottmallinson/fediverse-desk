import { describe, expect, it } from 'vitest';
import { DirectSocialWeb, SocialWebError } from '../src/ghost/direct.js';
import { GhstSocialWeb, GhstError, type Runner } from '../src/ghost/ghst.js';
import { IdentityProvider } from '../src/ghost/identity.js';
import { makeAccount, makePost } from './helpers.js';

const ID = 'a1b2c3d4e5f60718293a4b5c';
const SECRET = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

interface Seen {
  url: string;
  method: string;
  authorization: string | null;
  body: unknown;
}

function directClient(respond: (seen: Seen) => Response): {
  client: DirectSocialWeb;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const identityToken = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(
    JSON.stringify({ sub: 'scott@example.com', role: 'Owner', exp: 9_999_999_999 }),
  ).toString('base64url')}.sig`;

  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/ghost/api/admin/identities/')) {
      return new Response(JSON.stringify({ identities: [{ token: identityToken }] }));
    }

    const record: Seen = {
      url,
      method: init?.method ?? 'GET',
      authorization: new Headers(init?.headers).get('authorization'),
      body: init?.body,
    };
    seen.push(record);
    return respond(record);
  }) as typeof fetch;

  const identity = new IdentityProvider('https://example.com', `${ID}:${SECRET}`, fetcher);
  return { client: new DirectSocialWeb('https://example.com', identity, fetcher), seen };
}

describe('DirectSocialWeb', () => {
  it('posts a note with the identity token as a bearer', async () => {
    const { client, seen } = directClient(() =>
      new Response(JSON.stringify({ post: makePost() })),
    );

    const post = await client.note({ content: 'hello' });

    expect(seen[0]?.url).toBe('https://example.com/.ghost/activitypub/v1/actions/note');
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.authorization).toMatch(/^Bearer /);
    expect(JSON.parse(String(seen[0]?.body))).toEqual({ content: 'hello' });
    expect(post.url).toBe('https://example.com/notes/1');
  });

  it('includes the alt text only when there is one', async () => {
    const { client, seen } = directClient(() =>
      new Response(JSON.stringify({ post: makePost() })),
    );

    await client.note({ content: 'a', image: { url: 'https://s.example/x.png' } });
    await client.note({
      content: 'b',
      image: { url: 'https://s.example/x.png', altText: 'a picture' },
    });

    expect(JSON.parse(String(seen[0]?.body)).image).toEqual({ url: 'https://s.example/x.png' });
    expect(JSON.parse(String(seen[1]?.body)).image).toEqual({
      url: 'https://s.example/x.png',
      altText: 'a picture',
    });
  });

  it('encodes an ActivityPub id into the path rather than splitting it', async () => {
    const { client, seen } = directClient(() => new Response(null, { status: 204 }));
    await client.like('https://other.example/users/alice/statuses/1');

    expect(seen[0]?.url).toBe(
      'https://example.com/.ghost/activitypub/v1/actions/like/https%3A%2F%2Fother.example%2Fusers%2Falice%2Fstatuses%2F1',
    );
  });

  it('normalises a feed into items and a cursor', async () => {
    const { client } = directClient(() =>
      new Response(JSON.stringify({ posts: [makePost()], next: 'cursor-2' })),
    );

    const page = await client.readerFeed({ limit: 5 });
    expect(page.items).toHaveLength(1);
    expect(page.next).toBe('cursor-2');
  });

  it('treats a missing posts array as an empty page, not a crash', async () => {
    const { client } = directClient(() => new Response(JSON.stringify({})));
    expect(await client.notesFeed()).toEqual({ items: [], next: null });
  });

  it('surfaces the status and body when Ghost refuses', async () => {
    const { client } = directClient(() =>
      new Response(JSON.stringify({ error: 'Forbidden', code: 'ROLE_MISSING' }), { status: 403 }),
    );

    await expect(client.me()).rejects.toBeInstanceOf(SocialWebError);
    await expect(client.me()).rejects.toThrow(/403.*ROLE_MISSING/s);
  });

  it('reads the profile from the "me" keyword', async () => {
    const { client, seen } = directClient(() => new Response(JSON.stringify(makeAccount())));
    await client.me();
    expect(seen[0]?.url).toBe('https://example.com/.ghost/activitypub/v1/account/me');
  });

  it('reads an account\'s posts and follows by handle', async () => {
    const { client, seen } = directClient((record) =>
      new Response(
        JSON.stringify(
          record.url.includes('/follows/')
            ? { accounts: [makeAccount()], next: null }
            : { posts: [makePost()], next: '2026-08-18T10:00:00.000Z' },
        ),
      ),
    );

    const posts = await client.posts('@alice@social.example', { limit: 5 });
    await client.posts('me');
    const follows = await client.follows('me', 'followers');

    expect(seen[0]?.url).toBe(
      'https://example.com/.ghost/activitypub/v1/posts/%40alice%40social.example?limit=5',
    );
    expect(seen[1]?.url).toBe('https://example.com/.ghost/activitypub/v1/posts/me');
    expect(seen[2]?.url).toBe(
      'https://example.com/.ghost/activitypub/v1/account/me/follows/followers',
    );
    expect(posts.next).toBe('2026-08-18T10:00:00.000Z');
    expect(follows.items).toHaveLength(1);
  });
  it('reads liked posts from the publication\'s liked feed', async () => {
    const { client, seen } = directClient(() =>
      new Response(JSON.stringify({ posts: [makePost()], next: null })),
    );
    await client.liked({ limit: 10 });
    expect(seen[0]?.url).toBe('https://example.com/.ghost/activitypub/v1/posts/me/liked?limit=10');
  });

  it('fetches a post Ghost has no thread for, then asks for the thread again', async () => {
    const apId = 'https://social.example/users/stu/statuses/1';
    let threadAsks = 0;
    const thread = {
      ancestors: { chain: [], hasMore: false },
      post: makePost({ id: apId }),
      children: [],
      next: null,
    };
    const { client, seen } = directClient((record) => {
      if (record.url.includes('/v1/replies/')) {
        threadAsks += 1;
        return threadAsks === 1
          ? new Response(null, { status: 404 })
          : new Response(JSON.stringify(thread));
      }
      return new Response(JSON.stringify(makePost({ id: apId })));
    });

    expect((await client.thread(apId)).post.id).toBe(apId);
    const encoded = encodeURIComponent(apId);
    expect(seen.map((record) => record.url)).toEqual([
      `https://example.com/.ghost/activitypub/v1/replies/${encoded}`,
      `https://example.com/.ghost/activitypub/v1/post/${encoded}`,
      `https://example.com/.ghost/activitypub/v1/replies/${encoded}`,
    ]);
  });
});

function ghstClient(respond: (args: string[]) => { stdout: string; code?: number }): {
  client: GhstSocialWeb;
  invocations: Array<{ args: string[]; env: NodeJS.ProcessEnv }>;
} {
  const invocations: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const runner: Runner = async (_command, args, env) => {
    invocations.push({ args, env });
    const result = respond(args);
    return { stdout: result.stdout, stderr: '', code: result.code ?? 0 };
  };

  return {
    client: new GhstSocialWeb({
      ghostUrl: 'https://example.com',
      staffToken: `${ID}:${SECRET}`,
      runner,
    }),
    invocations,
  };
}

describe('GhstSocialWeb', () => {
  it('calls ghst with the flags its command table declares', async () => {
    const { client, invocations } = ghstClient(() => ({
      stdout: JSON.stringify({ post: makePost() }),
    }));

    await client.note({
      content: 'hello',
      image: { url: 'https://s.example/x.png', altText: 'alt' },
    });

    expect(invocations[0]?.args).toEqual([
      'socialweb',
      'note',
      '--content',
      'hello',
      '--image-url',
      'https://s.example/x.png',
      '--image-alt',
      'alt',
      '--json',
    ]);
  });

  it('passes credentials through the environment, never on the command line', async () => {
    const { client, invocations } = ghstClient(() => ({
      stdout: JSON.stringify({ post: makePost() }),
    }));

    await client.note({ content: 'hello' });

    expect(invocations[0]?.env.GHOST_STAFF_ACCESS_TOKEN).toBe(`${ID}:${SECRET}`);
    expect(invocations[0]?.args.join(' ')).not.toContain(SECRET);
  });

  it('opts in to destructive actions for a delete, as ghst requires', async () => {
    const { client, invocations } = ghstClient(() => ({ stdout: '' }));
    await client.deletePost('https://example.com/note/1');

    expect(invocations[0]?.args).toEqual([
      '--enable-destructive-actions',
      'socialweb',
      'delete',
      'https://example.com/note/1',
      '--yes',
      '--json',
    ]);
  });

  it('reports a non-zero exit rather than parsing whatever came out', async () => {
    const { client } = ghstClient(() => ({ stdout: '', code: 4 }));
    await expect(client.me()).rejects.toBeInstanceOf(GhstError);
    await expect(client.me()).rejects.toThrow(/exited 4/);
  });

  it('reports unparseable output clearly', async () => {
    const { client } = ghstClient(() => ({ stdout: 'command not found' }));
    await expect(client.me()).rejects.toThrow(/did not return JSON/);
  });

  it('normalises a feed the same way the direct client does', async () => {
    const { client } = ghstClient(() => ({
      stdout: JSON.stringify({ posts: [makePost()], next: 'cursor-2' }),
    }));

    expect(await client.readerFeed({ limit: 5 })).toMatchObject({ next: 'cursor-2' });
  });

  it('writes an upload to a temporary file and cleans it up afterwards', async () => {
    let seenPath = '';
    const { client } = ghstClient((args) => {
      seenPath = args[2] as string;
      return { stdout: JSON.stringify({ fileUrl: 'https://s.example/card.png' }) };
    });

    const url = await client.uploadImage(new Uint8Array([1, 2, 3]), 'card.png', 'image/png');
    expect(url).toBe('https://s.example/card.png');
    expect(seenPath).toMatch(/card\.png$/);

    const { access } = await import('node:fs/promises');
    await expect(access(seenPath)).rejects.toThrow();
  });

  it('keeps a hostile filename inside the temporary directory', async () => {
    let seenPath = '';
    const { client } = ghstClient((args) => {
      seenPath = args[2] as string;
      return { stdout: JSON.stringify({ fileUrl: 'https://s.example/x.png' }) };
    });

    await client.uploadImage(new Uint8Array([1]), '../../etc/passwd', 'image/png');

    // The property that matters is containment, not the absence of dots: the
    // separators are gone, so the name cannot climb out of the directory.
    const { dirname, resolve } = await import('node:path');
    expect(resolve(seenPath)).toBe(seenPath);
    expect(dirname(seenPath)).toMatch(/desk-upload-/);
    expect(seenPath).not.toContain('/etc/passwd');
  });
});

/**
 * The shape Ghost's actions/reply actually returns: the federated Create
 * activity, with the new Note embedded and no PostDTO anywhere. Transcribed
 * from the Note/Create construction in TryGhost/ActivityPub's post controller.
 */
function createActivity(noteId: string) {
  return {
    '@context': ['https://www.w3.org/ns/activitystreams'],
    type: 'Create',
    id: 'https://example.com/.ghost/activitypub/create/abc-123',
    actor: 'https://example.com/.ghost/activitypub/users/index',
    object: {
      type: 'Note',
      id: noteId,
      content: 'agreed',
      published: '2026-08-18T10:00:00.000Z',
      inReplyTo: 'https://other.example/users/alice/statuses/1',
    },
    to: ['https://www.w3.org/ns/activitystreams#Public'],
  };
}

describe('replying', () => {
  const NOTE_ID = 'https://example.com/.ghost/activitypub/note/99';

  it('reads the new note back, because the reply endpoint returns an activity', async () => {
    const { client, seen } = directClient((request) =>
      request.method === 'POST'
        ? new Response(JSON.stringify(createActivity(NOTE_ID)))
        : new Response(JSON.stringify(makePost({ id: NOTE_ID, content: 'agreed' }))),
    );

    const post = await client.reply('https://other.example/users/alice/statuses/1', {
      content: 'agreed',
    });

    // Two calls: publish, then fetch the canonical post by its ActivityPub id.
    expect(seen).toHaveLength(2);
    expect(seen[1]?.url).toBe(
      `https://example.com/.ghost/activitypub/v1/post/${encodeURIComponent(NOTE_ID)}`,
    );
    expect(post.id).toBe(NOTE_ID);
    expect(post.url).toBe('https://example.com/notes/1');
  });

  it('never throws once the reply is out, so the queue cannot double post', async () => {
    const { client } = directClient((request) =>
      request.method === 'POST'
        ? new Response(JSON.stringify(createActivity(NOTE_ID)))
        : // The read back fails. The reply is already published.
          new Response('nope', { status: 500 }),
    );

    const post = await client.reply('https://other.example/users/alice/statuses/1', {
      content: 'agreed',
    });

    expect(post.id).toBe(NOTE_ID);
    expect(post.url).toBe(NOTE_ID);
    expect(post.content).toBe('agreed');
  });

  it('still works if Ghost ever switches to the note endpoint shape', async () => {
    const { client, seen } = directClient(
      () => new Response(JSON.stringify({ post: makePost({ id: NOTE_ID }) })),
    );

    const post = await client.reply('https://other.example/users/alice/statuses/1', {
      content: 'agreed',
    });

    expect(seen).toHaveLength(1);
    expect(post.id).toBe(NOTE_ID);
  });

  it('does the same two steps through ghst', async () => {
    const calls: string[][] = [];
    const { client } = ghstClient((args) => {
      calls.push(args);
      return args[1] === 'reply'
        ? { stdout: JSON.stringify(createActivity(NOTE_ID)) }
        : { stdout: JSON.stringify(makePost({ id: NOTE_ID })) };
    });

    const post = await client.reply('https://other.example/users/alice/statuses/1', {
      content: 'agreed',
    });

    expect(calls[1]).toEqual(['socialweb', 'post', NOTE_ID, '--json']);
    expect(post.id).toBe(NOTE_ID);
  });
});
