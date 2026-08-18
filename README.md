# fediverse-desk

A personal desk for one Ghost publication's Fediverse handle.

Ghost 6 publishes to the social web, so `@scott@scottmallinson.com` is a real
ActivityPub actor. What Ghost does not have is a client API anybody else can log
into: there is no Mastodon-compatible surface and no OAuth, so Buffer, Ivory,
Mixpost and everything like them cannot authenticate as the handle. Ghost Admin
is the only client, and it has no queue.

This fills both gaps:

- **A scheduler.** Queue notes and replies, publish them when they are due.
- **A Mastodon-compatible bridge.** Enough of the Mastodon client API that a
  publishing tool can complete an OAuth login and post, with every note landing
  on the real Ghost handle.

> The bridge is a control plane, not an identity. A client that logs in sees an
> account at the bridge's domain, but the notes it posts federate from the Ghost
> actor on your site. Followers, replies and reputation stay on the one handle.
> Nothing here creates a second account.

## How it authenticates, and why it has to

Ghost's ActivityPub service lives at `/.ghost/activitypub/` on your own domain.
Its private API wants `Authorization: Bearer <jwt>`, verifies that token against
`/ghost/.well-known/jwks.json`, and requires an `Owner` or `Administrator` role
claim. Only Ghost can mint such a token, at `GET /ghost/api/admin/identities/`,
and it lives five minutes.

The consequence is the one thing to understand before setting this up:

| Credential | Works? |
|---|---|
| Custom integration Admin API key | **No.** The identity endpoint reads the authenticated *user*, and `Read identities` is granted to `Administrator` alone. An integration has no user, so it gets a 403 |
| Staff access token, Contributor to Editor | **No.** Wrong role |
| Staff access token, **Owner or Administrator** | **Yes** |

So the chain is: staff access token, then an identity token, then a Bearer call.
This app does that and caches the identity token until just before it expires.

**That staff access token is full admin access to your site.** It is not scoped
to the Fediverse, because Ghost offers no narrower credential. Treat it like the
site password: that is the strongest argument for running this on your own
machine rather than hosting it.

## Setup

Needs Node 22 or newer. To run it as a container instead, skip to
[DEPLOYMENT.md](DEPLOYMENT.md): the image carries no runtime dependencies, because
the app uses nothing outside node's standard library.


```bash
npm install
npm run build
cp .env.example .env
```

Fill in `.env`. Issue the staff access token from Ghost Admin, under your own
profile, and revoke it from the same page if it ever leaks.

```bash
node dist/cli.js status
```

That prints the handle, the role on the identity token, and how long the token
has left. If it fails, it fails here, with a message that says which of the two
steps broke.

## The scheduler

```bash
# Post now
desk note "A short thought about silent failures."

# Queue for later. --at takes "now", "+90m", "+2h", "+3d", "+1w", or an ISO stamp
desk queue add "Something for the morning." --at +14h
desk queue add "A reply, when I have thought about it." --at +1h \
  --reply-to https://mastodon.social/users/alice/statuses/123

# With an image
desk queue add "New post is up." --at +2h --image ./card.png --alt "Post title card"

desk queue list          # pending
desk queue list --all    # including sent, failed and cancelled
desk queue rm <id>       # cancel a pending item
desk queue retry <id>    # put a failed item back
```

Publishing is a separate step, so the queue survives the machine being asleep:

```bash
desk run --once                  # publish what is due, then exit. For cron
desk run --interval 60           # loop, for a long-running service
```

A cron entry is the sane default:

```cron
*/5 * * * * cd /path/to/fediverse-desk && /usr/bin/node dist/cli.js run --once >> desk.log 2>&1
```

Items are published in the order they were queued, one at a time, because that
is the order they should appear in a timeline. A failure does not stop the run:
the item stays pending and is retried on the next tick, up to five attempts,
after which `desk queue retry` is a deliberate decision rather than an automatic
one.

### Why it goes through ghst

By default the scheduler shells out to [`@tryghost/ghst`](https://github.com/TryGhost/ghst),
TryGhost's own CLI, which speaks this API under `ghst socialweb`. The API is
private and undocumented, so when it moves, somebody else has already absorbed
the change. Install it with `npm install -g @tryghost/ghst`.

Set `DESK_TRANSPORT=direct`, or pass `--transport direct`, to skip ghst and call
the API from here instead. The bridge always uses `direct`, because spawning a
CLI process per inbound HTTP request would be a strange thing to do.

## The Mastodon bridge

```bash
desk shim                  # bridge only
desk shim --with-runner    # bridge, and drain the queue in the same process
```

It refuses to start without `SHIM_PASSWORD`, binds to loopback by default, and
says which of those two things it did on startup.

`--with-runner` is what an always-on deployment wants: one service rather than
two, and one long-running writer. The store locks and re-reads before every
write, so running `desk queue add` from a shell against a live bridge is safe
either way.

To let a real client reach it, put a TLS proxy in front on a subdomain, set
`SHIM_PUBLIC_URL` to that address, and point the client at it as if it were a
Mastodon instance. [DEPLOYMENT.md](DEPLOYMENT.md) walks through that end to end:
a Cloudflare Tunnel, a systemd unit, a curl script that proves the flow before
you involve a client, and a table of what each failure means. The OAuth login asks for `SHIM_PASSWORD` and nothing else:
there is one account and no signup.

Connecting Buffer, for example, means adding a Mastodon channel and giving it
your bridge's domain as the server.

### What it implements

| Endpoint | Behaviour |
|---|---|
| `GET /.well-known/nodeinfo`, `/nodeinfo/2.0` | Software discovery. Probed **before** anything else: a client decides whether to offer a Mastodon login on the strength of this |
| `GET /.well-known/webfinger` | Handle resolution, answered by pointing at the **Ghost** actor rather than at the bridge. There is no actor here to point at |
| `GET /api/v1/instance`, `/api/v2/instance` | Instance metadata. Public, because a client needs it before it can log in |
| `POST /api/v1/apps` | Client registration |
| `GET`/`POST /oauth/authorize` | Password login, then a code. Supports the out-of-band redirect |
| `POST /oauth/token`, `/oauth/revoke` | Authorization code and client credentials grants |
| `GET /api/v1/accounts/verify_credentials` | The Ghost profile |
| `POST /api/v1/statuses` | A note, or a reply when `in_reply_to_id` is set, or a queue entry when `scheduled_at` is |
| `DELETE /api/v1/statuses/:id` | Delete |
| `POST /api/v1/statuses/:id/{favourite,unfavourite,reblog,unreblog}` | Like and repost |
| `POST /api/v1/media`, `/api/v2/media` | Image upload |
| `GET /api/v1/timelines/home`, `/timelines/public` | The reader and notes feeds |
| `GET /api/v1/notifications` | Notifications, with Mastodon's type names |
| `GET /api/v1/{filters,lists,announcements,markers,preferences,custom_emojis}` | Empty shapes, so clients do not treat the instance as broken |

### Limits worth knowing before you rely on it

- **One image per note.** Ghost's note API takes a single image. A status with
  two attachments is rejected with a 422 that says so, rather than silently
  dropping one.
- **Ids are encoded ActivityPub URLs**, not snowflakes. Clients that sort by id
  or page backwards through history will get it wrong. Posting works; being a
  good timeline reader is not what this is for.
- **`scheduled_at` is honoured by this app's own queue.** The status will not
  publish unless `desk run` is also running.
- **No streaming, no polls, no visibility other than public**, because Ghost has
  none of those.

### Security posture

One password, no signup, and it is the only thing between the internet and
posting rights on your publication. So:

- Client secrets and access tokens are stored as SHA-256 digests. The state file
  never holds a credential that can be replayed.
- Authorisation codes are single use and expire in five minutes.
- Redirect URIs are compared exactly, never by prefix.
- Password checks are constant time, and five failures lock a client out for
  fifteen minutes.
- Request bodies are capped at 12MB.
- Binds to `127.0.0.1` unless told otherwise, and says which it did.

None of that makes it safe to expose casually. Put it behind TLS, prefer a VPN
or an IP allow-list over the open internet, and remember what the token behind it
can do.

## Development

```bash
npm test          # 110 tests
npm run typecheck
```

CI (`.github/workflows/ci.yml`) runs both on every push and pull request, then
builds the image and publishes it to GitHub Container Registry as
`ghcr.io/scottmallinson/fediverse-desk`. Pull requests build the image but do not
publish it.

The build is followed by a smoke test that starts the container and checks the
three things a broken image would break silently: that it serves nodeinfo, that
nodeinfo names mastodon (without which no client offers a login), and that an
unauthenticated write is still refused.

The tests use a fake `SocialWeb` and a fake `fetch`, so almost all of it runs
offline; the store's concurrency test spawns real processes. The OAuth flow, discovery, the id encoding, both transports, the scheduler's
retry behaviour and the store's behaviour under concurrent writers are all
covered.

## What has not been verified

The API surface, the auth chain, the error codes and the token lifetime were all
read from the live site and from the source of `TryGhost/ActivityPub`, Ghost core
and `ghst`. The OAuth flow and the request mapping are tested here end to end
over a real socket.

**What has not happened is a single authenticated round trip against a real Ghost
site**, because that needs an Owner or Administrator staff access token. Until
someone runs `desk status` with one, these remain unconfirmed:

- the exact response shape of `actions/note` and `feed/reader` against real data
- whether `upload/image` accepts the same MIME set as Ghost's own uploader
- whether any rate limit applies on Ghost Pro, which proxies this service

`desk status` is the ten-minute check that settles all three, and the curl
walkthrough in [DEPLOYMENT.md](DEPLOYMENT.md) settles them against the bridge.

No real client has completed the connect flow yet either. Discovery now matches
what a live Mastodon instance serves, which was the most likely thing to block
it, but that is reasoning rather than evidence.

This is not a hypothetical worry. Reading Ghost's source closely enough to write
the reply path turned up a real defect in this client: `actions/note` returns
`{post}` but `actions/reply` returns the federated Create activity, and reading
`.post` off that produced undefined. Every reply would have failed. Nothing in
the test suite caught it, because the fakes returned what the code expected
rather than what Ghost sends. Assume there are more of those until a real token
has been through the whole surface.

## Licence

MIT.
