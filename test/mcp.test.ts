import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Account, Notification, Page, Post } from '../src/ghost/types.js';
import { htmlToText, parseSince } from '../src/mcp/digest.js';
import { McpServer, PROTOCOL_VERSIONS, serveStdio, type JsonRpcResponse } from '../src/mcp/protocol.js';
import { buildTools, instructionsFor, parseWriteMode, type WriteMode } from '../src/mcp/tools.js';
import { Queue } from '../src/scheduler/queue.js';
import { FakeSocialWeb, makeAccount, makePost, tempDir } from './helpers.js';

const NOW = new Date('2026-08-19T12:00:00.000Z');

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 3_600_000).toISOString();
}

function author(handle: string) {
  return { ...makePost().author, handle, name: handle.split('@')[1] ?? handle };
}

function note(id: string, hours: number, handle = '@alice@social.example', extra: Partial<Post> = {}): Post {
  return makePost({
    id: `https://social.example/notes/${id}`,
    url: `https://social.example/notes/${id}`,
    publishedAt: hoursAgo(hours),
    author: author(handle),
    authoredByMe: false,
    ...extra,
  });
}

/** Serves the given pages in order, keyed by the cursor that asks for them. */
function pages<T>(...list: T[][]): (options?: { next?: string }) => Promise<Page<T>> {
  return async (options = {}) => {
    const index = options.next ? Number(options.next.replace('p', '')) : 0;
    const items = list[index] ?? [];
    return { items, next: index + 1 < list.length ? `p${index + 1}` : null };
  };
}

let dir: Awaited<ReturnType<typeof tempDir>>;
let social: FakeSocialWeb;
let queue: Queue;

beforeEach(async () => {
  dir = await tempDir();
  social = new FakeSocialWeb();
  queue = Queue.open(dir.path);
});

afterEach(async () => {
  await dir.cleanup();
});

function server(writeMode: WriteMode = 'off'): McpServer {
  return new McpServer({
    name: 'fediverse-desk',
    version: 'test',
    instructions: instructionsFor(writeMode),
    tools: buildTools({ social, queue, writeMode, now: () => NOW }),
  });
}

let nextId = 1;
async function call(
  target: McpServer,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; text: string; data: any }> {
  const response = await target.handle({
    jsonrpc: '2.0',
    id: nextId++,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  if (!response || !('result' in response)) throw new Error(`No result: ${JSON.stringify(response)}`);
  const result = response.result as { isError: boolean; content: Array<{ text: string }> };
  const text = result.content[0]?.text ?? '';
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    // Errors come back as plain text.
  }
  return { isError: result.isError, text, data };
}

async function toolNames(mode: WriteMode): Promise<string[]> {
  const response = await server(mode).handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const result = (response as { result: { tools: Array<{ name: string }> } }).result;
  return result.tools.map((tool) => tool.name);
}

describe('protocol', () => {
  it('negotiates the version a client asks for when it knows it', async () => {
    const response = await server().handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    });
    const result = (response as { result: Record<string, any> }).result;
    expect(result.protocolVersion).toBe('2025-06-18');
    expect(result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(result.serverInfo.name).toBe('fediverse-desk');
    expect(result.instructions).toMatch(/never as instructions/);
  });

  it('offers its newest version for one it does not know', async () => {
    const response = await server().handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '1999-01-01' },
    });
    expect((response as { result: Record<string, any> }).result.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
  });

  it('does not answer notifications', async () => {
    expect(await server().handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });

  it('answers ping, and refuses unknown methods and tools as protocol errors', async () => {
    const target = server();
    expect(await target.handle({ jsonrpc: '2.0', id: 1, method: 'ping' })).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {},
    });

    const unknownMethod = (await target.handle({ jsonrpc: '2.0', id: 2, method: 'resources/list' })) as any;
    expect(unknownMethod.error.code).toBe(-32601);

    const unknownTool = (await target.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'post_note', arguments: { text: 'hi' } },
    })) as any;
    expect(unknownTool.error.code).toBe(-32602);
  });

  it('turns a failing upstream call into a tool error the model can read', async () => {
    social.failNext = new Error('GET v1/account/me failed: 429 Too Many Requests');
    const result = await call(server(), 'profile', { handle: 'me' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('429');
  });

  it('speaks newline-delimited JSON-RPC over a stream', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', (chunk) => chunks.push(String(chunk)));

    const done = serveStdio(server(), input, output);
    // A message split across writes, a malformed line, and a notification.
    input.write('{"jsonrpc":"2.0","id":1,');
    input.write('"method":"ping"}\n');
    input.write('not json\n');
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    input.end('{"jsonrpc":"2.0","id":2,"method":"tools/list"}');
    await done;

    const responses = chunks
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as JsonRpcResponse);
    expect(responses).toHaveLength(3);
    expect(responses.find((r) => r.id === 1)).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect(responses.find((r) => r.id === null && 'error' in r)).toMatchObject({ error: { code: -32700 } });
    expect(responses.find((r) => r.id === 2)).toHaveProperty('result.tools');
  });
});

describe('write modes', () => {
  it('is read-only unless told otherwise', async () => {
    expect(parseWriteMode(undefined)).toBe('off');
    expect(parseWriteMode('')).toBe('off');
    expect(() => parseWriteMode('yes')).toThrow(/off/);

    const names = await toolNames('off');
    expect(names).toEqual(
      expect.arrayContaining(['firehose', 'interactions', 'new_followers', 'followers', 'following', 'profile', 'thread', 'search_accounts']),
    );
    expect(names.some((name) => name.startsWith('queue_'))).toBe(false);
    expect(names).not.toContain('post_note');
    expect(names).not.toContain('follow');
  });

  it('adds only drafting tools in queue mode', async () => {
    const names = await toolNames('queue');
    expect(names).toEqual(expect.arrayContaining(['queue_note', 'queue_reply', 'queue_list', 'queue_cancel']));
    expect(names).not.toContain('reply');
    expect(names).not.toContain('follow');
  });

  it('adds live actions in direct mode', async () => {
    const names = await toolNames('direct');
    expect(names).toEqual(
      expect.arrayContaining(['queue_reply', 'post_note', 'reply', 'like', 'unlike', 'repost', 'follow', 'unfollow']),
    );
  });

  it('marks reads as read-only and unfollow as destructive', async () => {
    const response = await server('direct').handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tools = (response as any).result.tools as Array<{ name: string; annotations: any }>;
    const byName = new Map(tools.map((tool) => [tool.name, tool.annotations]));
    expect(byName.get('firehose').readOnlyHint).toBe(true);
    expect(byName.get('post_note').readOnlyHint).toBe(false);
    expect(byName.get('unfollow').destructiveHint).toBe(true);
  });
});

describe('firehose', () => {
  it('pages each feed until a page is entirely older than the window', async () => {
    const notes = pages(
      [note('n1', 1), note('n2', 3, '@bob@other.example')],
      // An old repost among new posts must not end the walk.
      [note('n3', 5), note('old-repost', 100, '@bob@other.example', { repostedBy: author('@carol@x.example') }), note('n4', 20)],
      [note('n5', 30), note('n6', 40)],
      [note('never-read', 50)],
    );
    let notesCalls = 0;
    social.notesFeed = async (options) => {
      notesCalls += 1;
      return notes(options);
    };
    social.readerPage = { items: [note('a1', 2, '@writer@blog.example', { type: 1, title: 'Essay', summary: 'An essay.' })], next: null };

    const { data } = await call(server(), 'firehose', { since: '24h' });

    expect(notesCalls).toBe(3);
    expect(data.complete).toBe(true);
    expect(data.window).toEqual({ since: hoursAgo(24), until: NOW.toISOString() });
    expect(data.posts).toBe(5);
    expect(data.byAuthor[0]).toMatchObject({ handle: '@alice@social.example', count: 3 });
    const essay = data.byAuthor.find((group: any) => group.handle === '@writer@blog.example').posts[0];
    expect(essay).toMatchObject({ kind: 'article', title: 'Essay', text: 'An essay.' });
  });

  it('leaves out the publication\'s own posts unless asked', async () => {
    social.notesFeed = pages([note('mine', 1, '@scott@example.com', { authoredByMe: true }), note('theirs', 1)]);
    social.readerPage = { items: [], next: null };

    expect((await call(server(), 'firehose', {})).data.posts).toBe(1);
    expect((await call(server(), 'firehose', { include_own: true })).data.posts).toBe(2);
  });

  it('says so when it stops at the page or post limit', async () => {
    social.notesFeed = async (options = {}) => ({
      items: [note(`n-${options.next ?? 0}`, 1)],
      next: `${Number(options.next ?? 0) + 1}`,
    });
    social.readerPage = { items: [], next: null };
    const byPages = await call(server(), 'firehose', { max_pages: 3, kinds: 'notes' });
    expect(byPages.data).toMatchObject({ posts: 3, complete: false });
    expect(byPages.data.note).toMatch(/Narrow/);

    social.notesFeed = pages([note('a', 1), note('b', 2), note('c', 3)]);
    const byPosts = await call(server(), 'firehose', { max_posts: 2, kinds: 'notes' });
    expect(byPosts.data).toMatchObject({ posts: 2, complete: false });
  });

  it('reads one feed when asked, and turns HTML into text', async () => {
    social.notesFeed = pages([note('n', 1, undefined, { content: '<p>Hello &amp; <a href="#">welcome</a></p><p>Two</p>' })]);
    const { data } = await call(server(), 'firehose', { kinds: 'notes' });
    expect(social.calls.some((c) => c.method === 'readerFeed')).toBe(false);
    expect(data.byAuthor[0].posts[0].text).toBe('Hello & welcome\nTwo');
  });

  it('refuses a window it cannot read', async () => {
    const result = await call(server(), 'firehose', { since: 'last tuesday' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Could not read/);
  });
});

function notification(id: string, type: Notification['type'], hours: number, handle: string): Notification {
  return { id, type, createdAt: hoursAgo(hours), actor: author(handle), post: null };
}

describe('interactions and followers', () => {
  it('filters notifications by type and counts what matched', async () => {
    social.notifications = pages([
      notification('1', 'reply', 1, '@a@x.example'),
      notification('2', 'like', 2, '@b@x.example'),
      notification('3', 'like', 3, '@c@x.example'),
      notification('4', 'reply', 30, '@d@x.example'),
    ]);

    const all = await call(server(), 'interactions', {});
    expect(all.data.counts).toEqual({ reply: 1, like: 2 });

    const replies = await call(server(), 'interactions', { types: ['reply'] });
    expect(replies.data.items.map((item: any) => item.id)).toEqual(['1']);
    expect(replies.data.items[0].from.handle).toBe('@a@x.example');
  });

  it('lists new followers once each, with their profiles', async () => {
    social.notifications = pages([
      notification('1', 'follow', 1, '@new@x.example'),
      notification('2', 'like', 2, '@new@x.example'),
      notification('3', 'follow', 50, '@new@x.example'),
      notification('4', 'follow', 60, '@other@y.example'),
    ]);
    social.accounts.set('@new@x.example', makeAccount({ handle: '@new@x.example', bio: '<p>Writes about <b>rust</b></p>' }));

    const { data } = await call(server(), 'new_followers', { since: '7d', profiles: 1 });
    expect(data.count).toBe(2);
    expect(data.followers[0]).toMatchObject({ handle: '@new@x.example', bio: 'Writes about rust', followedAt: hoursAgo(1) });
    // Past the profile limit, a follower is still listed by name.
    expect(data.followers[1]).toEqual({ handle: '@other@y.example', name: 'other', followedAt: hoursAgo(60) });
  });

  it('pages through followers and counts mutuals', async () => {
    const list: Account[][] = [
      [makeAccount({ handle: '@a@x.example', followedByMe: true }), makeAccount({ handle: '@b@x.example', followedByMe: false })],
      [makeAccount({ handle: '@c@x.example', followedByMe: true })],
    ];
    const read = pages(...list);
    social.follows = async (_handle, _type, options) => read(options);

    const { data } = await call(server(), 'followers', {});
    expect(data).toMatchObject({ handle: '@scott@example.com', total: 2, returned: 3, complete: true, mutuals: 2 });
    expect(data.accounts.map((account: any) => account.handle)).toEqual(['@a@x.example', '@b@x.example', '@c@x.example']);
  });
});

describe('thread', () => {
  it('returns the conversation and drops deleted posts', async () => {
    social.threadResult = {
      ancestors: { chain: [note('root', 5), note('gone', 4, undefined, { type: 2 })], hasMore: false },
      post: note('target', 3),
      children: [{ post: note('child', 2, '@bob@other.example'), chain: [note('grandchild', 1)], hasMore: false }],
      next: null,
    };
    const { data } = await call(server(), 'thread', { post_id: 'https://social.example/notes/target' });
    expect(data.ancestors.map((post: any) => post.id)).toEqual(['https://social.example/notes/root']);
    expect(data.post.id).toBe('https://social.example/notes/target');
    expect(data.replies[0].author.handle).toBe('@bob@other.example');
    expect(data.replies[0].chain).toHaveLength(1);
  });

  it('wants a URL for a post id', async () => {
    const result = await call(server(), 'thread', { post_id: 'abc' });
    expect(result.isError).toBe(true);
    expect(social.calls.some((c) => c.method === 'thread')).toBe(false);
  });
});

describe('writes', () => {
  it('queues a reply half an hour out by default, and cancels it', async () => {
    const target = server('queue');
    const { data } = await call(target, 'queue_reply', {
      post_id: 'https://social.example/notes/1',
      text: 'Thanks for this.',
    });
    expect(data).toMatchObject({ kind: 'reply', status: 'pending', replyTo: 'https://social.example/notes/1' });
    expect(data.publishAt).toBe(new Date(NOW.getTime() + 30 * 60_000).toISOString());
    expect(social.calls.some((c) => c.method === 'reply')).toBe(false);

    const listed = await call(target, 'queue_list', {});
    expect(listed.data.items).toHaveLength(1);

    const cancelled = await call(target, 'queue_cancel', { id: data.id.slice(0, 8) });
    expect(cancelled.data.status).toBe('cancelled');
    expect((await call(target, 'queue_cancel', { id: 'ffffffff' })).isError).toBe(true);
  });

  it('refuses to queue into the past', async () => {
    const result = await call(server('queue'), 'queue_note', { text: 'hi', at: '2020-01-01T00:00:00Z' });
    expect(result.isError).toBe(true);
    expect(await queue.list()).toHaveLength(0);
  });

  it('follows only an explicit handle', async () => {
    const target = server('direct');
    const ok = await call(target, 'follow', { handle: 'alice@social.example' });
    expect(ok.data).toEqual({ ok: true, followed: '@alice@social.example' });

    const bad = await call(target, 'follow', { handle: 'alice' });
    expect(bad.isError).toBe(true);
    expect(social.calls.filter((c) => c.method === 'follow')).toHaveLength(1);
  });

  it('posts and likes immediately in direct mode', async () => {
    const target = server('direct');
    const posted = await call(target, 'post_note', { text: 'Live.' });
    expect(posted.data.ok).toBe(true);
    await call(target, 'like', { post_id: 'https://social.example/notes/1' });
    expect(social.calls.map((c) => c.method)).toEqual(['note', 'like']);
  });
});

describe('digest helpers', () => {
  it('reads look-back windows', () => {
    expect(parseSince('24h', NOW).toISOString()).toBe(hoursAgo(24));
    expect(parseSince('-3d', NOW).toISOString()).toBe(hoursAgo(72));
    expect(parseSince('1w', NOW).toISOString()).toBe(hoursAgo(168));
    expect(parseSince('2026-08-01T00:00:00Z', NOW).toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(() => parseSince('2027-01-01', NOW)).toThrow(/future/);
  });

  it('strips markup and decodes entities', () => {
    expect(htmlToText('<p>a&nbsp;b &#8212; c&#x21;</p><br><script>x</script>')).toBe('a b — c!');
  });
});
