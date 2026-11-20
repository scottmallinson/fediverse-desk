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
the app uses nothing outside node's standard library. [VPS.md](VPS.md) is the
same thing on a public Ubuntu box, with TLS.


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
you involve a client, and a table of what each failure means. [VPS.md](VPS.md)
is the step-by-step for a public VPS, where Caddy terminates TLS on the same box.
The OAuth login asks for `SHIM_PASSWORD` and nothing else:
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
| `GET /api/v1/accounts/:id`, `/accounts/lookup` | Any account Ghost can resolve by handle. Account ids are encoded `@user@host` handles |
| `GET /api/v1/accounts/:id/statuses` | An account's posts. The publication's own come from its outbox. `pinned=true` is always empty |
| `GET /api/v1/accounts/:id/{followers,following}`, `/accounts/relationships` | Follow lists and follow state |
| `POST /api/v1/accounts/:id/{follow,unfollow}` | Follow and unfollow |
| `POST /api/v1/statuses` | A note, or a reply when `in_reply_to_id` is set, or a queue entry when `scheduled_at` is |
| `GET /api/v1/statuses/:id`, `/statuses/:id/context` | One post, and the thread around it from Ghost's replies endpoint |
| `GET /api/v1/favourites` | Posts the publication has liked |
| `DELETE /api/v1/statuses/:id` | Delete |
| `POST /api/v1/statuses/:id/{favourite,unfavourite,reblog,unreblog}` | Like and repost |
| `POST /api/v1/media`, `/api/v2/media` | Image upload |
| `GET /api/v1/timelines/home`, `/timelines/public` | The reader and notes feeds |
| `GET /api/v1/notifications` | Notifications, with Mastodon's type names |
| `GET /api/v1/search`, `/api/v2/search` | Accounts by handle or profile URL, and posts by URL. Hashtags are always empty |
| `GET`/`POST /authorize_interaction` | Remote follow: another server sends a visitor here to follow an account as the publication |
| `GET /api/v1/{trends,trends/*,suggestions,followed_tags}`, `/api/v2/suggestions` | Empty. The Explore screen asks for all of these |
| `GET /api/v1/{filters,lists,announcements,markers,preferences,custom_emojis,bookmarks}` | Empty shapes, so clients do not treat the instance as broken |

### Following somebody from another server

A Mastodon profile's **Follow** button, pressed by somebody who is not signed in
there, asks for a handle and then sends the visitor back to their own server to
confirm. Which server that is comes from the handle, and the two handles here
are not interchangeable:

| Handle given | What happens |
|---|---|
| `scott@scottmallinson.com` | Goes to the Ghost site, which has no such page. **404** |
| `scott@desk.scottmallinson.com` | Goes to the bridge, which asks for the bridge password and makes the follow from the Ghost actor |

So give the **bridge** handle when a site asks where to send you, and the
publication's own handle everywhere else. Nothing here can change the first row:
the Ghost domain's webfinger is served by Ghost, and Ghost does not offer a
remote-follow page or advertise one.

Inside a logged-in client, following works the ordinary way and neither of these
pages is involved.

### Limits worth knowing before you rely on it

- **No search over posts, and no hashtags.** Ghost indexes neither. Search finds
  an account from a handle or a profile URL, and a post from its URL; everything
  else comes back empty rather than as an error.
- **Nothing trends and nothing is suggested.** Ghost computes neither, so the
  Explore screen is empty by design rather than broken.
- **One image per note.** Ghost's note API takes a single image. A status with
  two attachments is rejected with a 422 that says so, rather than silently
  dropping one.
- **Ids are encoded ActivityPub URLs** (statuses) and **encoded handles**
  (accounts), not snowflakes. Clients that sort by id will get it wrong. Paging
  forwards works whether a client follows the Link header or sends the last id
  it saw, as long as the bridge served that page since it last restarted.
- **`scheduled_at` is honoured by this app's own queue.** The status will not
  publish unless `desk run` is also running.
- **No streaming, no polls, no visibility other than public**, because Ghost has
  none of those.
- **Join dates come from the account's own server.** Ghost does not record when
  an account was created, so the bridge asks the account's server through the
  public Mastodon lookup API. Servers without that API, and the publication
  itself, show the Unix epoch instead.
- **Who favourited or boosted a post is not available.** Ghost keeps the counts
  but not the accounts, so those lists are always empty.

### Security posture

One password, no signup, and it is the only thing between the internet and
posting rights on your publication. So:

- Client secrets and access tokens are stored as SHA-256 digests. The state file
  never holds a credential that can be replayed.
- Authorisation codes are single use and expire in five minutes.
- Redirect URIs are compared exactly, never by prefix.
- Password checks are constant time, and five failures lock a client out for
  fifteen minutes. The remote-follow page has one lockout of its own, shared
  across every profile somebody might arrive from.
- Everything under `/api/v1` and `/api/v2` needs a token, bar the few paths a
  client has to read before it has one.
- Request bodies are capped at 12MB.
- Binds to `127.0.0.1` unless told otherwise, and says which it did.

None of that makes it safe to expose casually. Put it behind TLS, prefer a VPN
or an IP allow-list over the open internet, and remember what the token behind it
can do.

## Development

```bash
npm test          # 132 tests
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
- what `actions/search` returns for a term that is not a handle, which decides
  how much of search is Ghost's and how much is the direct handle lookup
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

## Contributing

Bug reports, fixes, and above all a report from a real round trip against a
Ghost site are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup and what
a pull request needs; [SECURITY.md](SECURITY.md) covers reporting a vulnerability
privately. Taking part means following the [code of conduct](CODE_OF_CONDUCT.md).

## Licence

[MIT](LICENSE).
