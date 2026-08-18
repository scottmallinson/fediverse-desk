# Deploying the bridge

How to get from a working checkout to Buffer posting on your Ghost handle.

The scheduler needs none of this: `desk queue add` and a cron entry running
`desk run --once` work on a laptop with no inbound network at all. Everything
below is only for the Mastodon bridge, because a hosted client has to be able to
reach it.

## The shape of the problem

Buffer is hosted software. Its servers call `POST /oauth/token` and
`POST /api/v1/statuses` directly, so the bridge needs a public HTTPS address.
Only the `/oauth/authorize` step happens in your browser. That is the whole
reason any of this is more involved than `desk shim`.

A client connects in this order, and each step has to work before the next one is
attempted:

1. `GET /.well-known/nodeinfo`, then the `2.0` document it points at. This is how
   the client decides the domain runs Mastodon and offers a login at all.
2. `GET /api/v1/instance` for the name and limits.
3. `POST /api/v1/apps` to register itself.
4. Your browser, at `/oauth/authorize`, with the bridge password.
5. `POST /oauth/token`, server to server, to swap the code for a token.
6. `POST /api/v1/statuses` from then on.

Steps one, two, three and five come from the client's servers, not your browser.

## Decide where it runs first

This is the decision that shapes the rest, and getting it wrong produces posts
that silently never appear.

**Buffer publishes on its own schedule.** If the bridge is asleep when Buffer
fires, the post is lost, and you will find out late. So pick one:

| Where the bridge runs | What to do |
|---|---|
| Somewhere always on (a VPS, a home server, a Pi) | Let Buffer own the schedule. You do not need `desk run` at all |
| Your laptop | Do **not** let Buffer schedule to it. Queue Fediverse posts with `desk queue add` and leave Buffer to the channels it already handles |

The second row is not a lesser option. The bridge is still worth running on a
laptop for a mobile client, or for composing into Buffer and letting this app do
the publishing.

## Expose it

### Cloudflare Tunnel

No inbound port, TLS terminated at Cloudflare, and the origin stays on a machine
you control.

```bash
cloudflared tunnel login
cloudflared tunnel create fedi-desk
cloudflared tunnel route dns fedi-desk desk.example.com
cloudflared tunnel run --url http://127.0.0.1:4040 fedi-desk
```

Leave the bridge itself on loopback. The tunnel is what reaches it.

### Alternatives

- **A small VPS** with a reverse proxy. Ordinary, and you own the whole path.
- **Tailscale Funnel** for a public name without a server, or plain Tailscale if
  only your own devices need to reach it. Plain Tailscale is enough for a mobile
  client and not enough for Buffer.

Whatever you choose, TLS is not optional: the bridge password crosses it.

## Configure

```bash
# .env
GHOST_URL=https://example.com
GHOST_STAFF_ACCESS_TOKEN=<id>:<secret>     # Owner or Administrator
DESK_DATA_DIR=/var/lib/fediverse-desk

SHIM_HOST=127.0.0.1
SHIM_PORT=4040
SHIM_PUBLIC_URL=https://desk.example.com   # the address clients will use
SHIM_PASSWORD=<32 random bytes>
```

`SHIM_PUBLIC_URL` matters more than it looks. It is what the bridge advertises in
nodeinfo and what OAuth redirects are built against, so if it does not match the
address the client actually used, discovery points somewhere wrong and the login
fails in a way that is hard to read.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Check the credential before anything else:

```bash
node dist/cli.js status
```

## Prove it before involving a client

Do not debug two systems at once. This drives the whole flow with curl, exactly
as a client would, and ends by posting a real note. Ten minutes, and it tells you
whether a later failure is yours or the client's.

```bash
BASE=https://desk.example.com
PASSWORD='...'                       # SHIM_PASSWORD
CB=urn:ietf:wg:oauth:2.0:oob

# 1. discovery, in the order a client probes it
curl -s $BASE/.well-known/nodeinfo
curl -s "$(curl -s $BASE/.well-known/nodeinfo | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).links[0].href')"
curl -s $BASE/api/v1/instance | head -c 200

# 2. register a client
APP=$(curl -s -X POST $BASE/api/v1/apps \
  --data-urlencode "client_name=curl" --data-urlencode "redirect_uris=$CB")
CID=$(echo "$APP" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).client_id')
CSEC=$(echo "$APP" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).client_secret')

# 3. authorise, and read the code off the page
CODE=$(curl -s -X POST $BASE/oauth/authorize \
  --data-urlencode "client_id=$CID" --data-urlencode "redirect_uri=$CB" \
  --data-urlencode "password=$PASSWORD" | sed -n 's/.*<pre[^>]*>\(.*\)<\/pre>.*/\1/p')

# 4. swap it for a token
TOKEN=$(curl -s -X POST $BASE/oauth/token \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "client_id=$CID" --data-urlencode "client_secret=$CSEC" \
  --data-urlencode "code=$CODE" --data-urlencode "redirect_uri=$CB" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).access_token')

# 5. who am I
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/v1/accounts/verify_credentials \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).acct'

# 6. post for real. This federates from your Ghost handle
curl -s -X POST -H "Authorization: Bearer $TOKEN" $BASE/api/v1/statuses \
  --data-urlencode "status=Posted through the bridge." \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).url'
```

If step six prints a URL on your site, the bridge is working. Delete the note
from Ghost Admin afterwards, or with `desk` if you kept the id.

## Connect Buffer

Add a channel, choose Mastodon, and give it `desk.example.com` as the server. You
will get the bridge's login page. Enter `SHIM_PASSWORD`, and Buffer lands back on
its own callback.

Buffer will show the account as living at `desk.example.com`. That is cosmetic:
every note it posts federates from the Ghost actor on your real site, and
replies, follows and reputation all accrue to the one handle. Nothing here
creates a second account.

The workflow this actually buys you is one composer for several channels at once,
not scheduling. If the only thing you wanted was scheduling, `desk queue` already
does it without exposing anything.

## Connect a mobile client

Ivory, Tusky, Elk and similar use an in-app browser with a custom-scheme or
out-of-band redirect, both of which the bridge supports. They do not need a
public address, so Tailscale or your own network is enough.

Expect rough edges. These are timeline readers, and status ids here are encoded
ActivityPub URLs rather than sortable snowflakes, so scrolling back through
history will misbehave. Composing and replying are the parts that work.

## Keep it running

```ini
# /etc/systemd/system/fediverse-desk.service
[Unit]
Description=fediverse-desk bridge
After=network-online.target

[Service]
Type=simple
User=fedidesk
WorkingDirectory=/opt/fediverse-desk
EnvironmentFile=/etc/fediverse-desk.env
ExecStart=/usr/bin/node dist/cli.js shim
Restart=on-failure
RestartSec=5

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/fediverse-desk

[Install]
WantedBy=multi-user.target
```

Keep `/etc/fediverse-desk.env` at mode 600 and owned by root. It holds a token
that is full admin on your site.

If you are also using the queue, cron owns that half:

```cron
*/5 * * * * cd /opt/fediverse-desk && /usr/bin/node dist/cli.js run --once >> /var/log/desk.log 2>&1
```

## Security

The bridge is an authenticated write endpoint for your publication, protected by
one password, holding a credential that can do anything to your site. Ghost has
no narrower token to offer, so the mitigations are all around it rather than in
it.

- **Put Cloudflare Access in front of `/oauth/authorize` only.** That is the
  browser-driven route, so gating it adds a second factor to the login without
  breaking anything. Do not put Access in front of `/api/*` or `/oauth/token`:
  those are called by the client's servers and will break.
- **Prefer an IP allow-list** if the client publishes its egress ranges.
- **Rotate `SHIM_PASSWORD`** by editing the environment and restarting. Existing
  client tokens survive, since they were issued against the app, not the
  password.
- **Revoke a client** by deleting its entry from `oauth.json` and restarting.
- **Practise the kill switch once, deliberately.** Revoke the staff access token
  in Ghost Admin under your profile, confirm `desk status` now fails, then issue
  a new one. Knowing this works is worth the five minutes.

## When it does not work

| Symptom | Where to look |
|---|---|
| Client says the server could not be reached, before any login page | Discovery. `curl $BASE/.well-known/nodeinfo` from outside your network. A wrong `SHIM_PUBLIC_URL` sends the client to the wrong host |
| Login page appears, password rejected | `SHIM_PASSWORD` in the running process, not the file. Five failures lock a client out for fifteen minutes |
| Redirects to the wrong place after authorising | `SHIM_PUBLIC_URL` does not match the address the client used |
| `invalid_grant` on token exchange | The code was already spent or is over five minutes old. Codes are single use |
| `401 The access token is invalid` | The token was revoked, or `oauth.json` was replaced |
| `500` mentioning `/ghost/api/admin/identities/` with a 403 | The staff token is not Owner or Administrator, or it is an integration key. See the README's auth table |
| Everything works but a post never appears | The bridge was down when the client fired. See "Decide where it runs first" |
| Status with two images rejected | Ghost takes one image per note. This is deliberate: it refuses rather than dropping one silently |

## Still unverified

The auth chain, endpoints and error codes were read from the live site and the
source of `TryGhost/ActivityPub`, Ghost core and `ghst`. The OAuth flow,
discovery and request mapping are tested here and exercised over a real socket.

Two things have not happened:

- **An authenticated round trip against a real Ghost site.** It needs an Owner or
  Administrator staff access token. `desk status` and step six above are the
  checks that settle it.
- **A connection from Buffer itself.** The discovery chain now matches what a
  real Mastodon instance serves, which was the most likely thing to block it, but
  no client has actually completed this flow yet. If Buffer refuses, the curl
  walkthrough tells you whether the bridge or the client is at fault.
