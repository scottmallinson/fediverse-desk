import type { Post } from './types.js';

/**
 * Ghost's two publish endpoints do not answer alike.
 *
 * `actions/note` returns `{post: PostDTO}`. `actions/reply/:id` returns the
 * JSON-LD Create activity it federated, with the new Note embedded as `object`
 * and no PostDTO anywhere. Reading `.post` off that gives undefined, and the
 * first property access downstream throws.
 *
 * So a reply is a two-step: post it, pull the new Note's ActivityPub id out of
 * the activity, then read the canonical post back.
 */
export function extractReplyApId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;

  const activity = body as Record<string, unknown>;

  // Defensive: if Ghost ever returns the same shape as actions/note, take it.
  const wrapped = activity.post as Record<string, unknown> | undefined;
  if (wrapped && typeof wrapped.id === 'string') return wrapped.id;

  const object = activity.object;
  if (typeof object === 'string') return object;

  if (object && typeof object === 'object') {
    const id = (object as Record<string, unknown>).id;
    if (typeof id === 'string') return id;
  }

  return null;
}

export function extractWrappedPost(body: unknown): Post | null {
  if (!body || typeof body !== 'object') return null;
  const post = (body as Record<string, unknown>).post;
  if (post && typeof post === 'object' && typeof (post as Post).id === 'string') {
    return post as Post;
  }
  return null;
}

/**
 * Last resort, built from the activity itself.
 *
 * Reached only when the reply has already been published and the follow-up read
 * failed. Throwing here would be the wrong call: the scheduler would count the
 * item as failed and post it again on the next tick, so a transient read error
 * would turn into a duplicate reply. Returning something the caller can record
 * is strictly better than that, even with counts it had to invent.
 */
export function synthesisePost(body: unknown, apId: string, content: string): Post {
  const activity = (body ?? {}) as Record<string, unknown>;
  const object = (
    activity.object && typeof activity.object === 'object' ? activity.object : {}
  ) as Record<string, unknown>;

  const url =
    typeof object.url === 'string' && object.url
      ? object.url
      : apId;

  return {
    id: apId,
    type: 'Note',
    title: '',
    excerpt: '',
    summary: null,
    content: typeof object.content === 'string' ? object.content : content,
    url,
    featureImageUrl: null,
    publishedAt:
      typeof object.published === 'string' ? object.published : new Date().toISOString(),
    likeCount: 0,
    likedByMe: false,
    replyCount: 0,
    readingTimeMinutes: 0,
    attachments: [],
    author: {
      id: typeof activity.actor === 'string' ? activity.actor : '',
      name: '',
      handle: '',
      avatarUrl: '',
      url: typeof activity.actor === 'string' ? activity.actor : '',
      followedByMe: false,
    },
    authoredByMe: true,
    repostCount: 0,
    repostedByMe: false,
    repostedBy: null,
  };
}
