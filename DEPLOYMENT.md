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
| Somewhere always on (a NAS, a VPS, a Pi) | Let Buffer own the schedule. See [Running it on a Synology NAS](#running-it-on-a-synology-nas), or [VPS.md](VPS.md) for a public box |
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
  [VPS.md](VPS.md) does this end to end on Ubuntu, with Caddy terminating TLS and
  renewing the certificate itself.
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

## Running it on a Synology NAS

A DS1821+ is x86-64, so the image builds and runs natively with nothing special.
DSM 7.2's Container Manager is Docker Compose underneath, and reads a
`docker-compose.yml` as a Project.

### One container, one writer

The compose file runs `shim --with-runner`, so the bridge serves clients and
drains the queue in the same process. That keeps the deployment to a single
service.

The store is safe for several processes regardless (it locks, and it re-reads
before every write, so `desk queue add` from a shell while the container is up
cannot lose a post). One writer is simply one fewer thing to reason about.

### Get the files onto the NAS

Put the repository in a shared folder, for example `/volume1/docker/fediverse-desk`.
Over SSH:

```bash
cd /volume1/docker
git clone https://github.com/scottmallinson/fediverse-desk.git
cd fediverse-desk
cp stack.env.example stack.env
chmod 600 stack.env
vi stack.env          # GHOST_URL, the staff token, SHIM_PUBLIC_URL, SHIM_PASSWORD
```

`stack.env` holds a token that is full admin on your site. It is gitignored, and
mode 600 is worth setting even so.

### Sign in to the registry

CI builds the image and publishes it to GitHub Container Registry. The repository
is private, so the package is too, and the NAS needs to authenticate once.

Create a personal access token with the `read:packages` scope, then:

```bash
echo "<token>" | sudo docker login ghcr.io -u scottmallinson --password-stdin
```

If you would rather not hold a token on the NAS, skip this and build locally
instead: `sudo docker compose up -d --build`. A DS1821+ builds this in well under
a minute, since the image installs no runtime dependencies.

### Create the project

In DSM: **Container Manager** -> **Project** -> **Create**, set the path to the
folder you just made, and it will pick up `docker-compose.yml`. Start it.

Or from SSH, which gives you the output when something goes wrong:

```bash
sudo docker compose pull
sudo docker compose up -d
sudo docker compose logs -f
```

You should see the bridge report the address it is serving, and the queue runner
report its interval.

The compose file names the published image and keeps a `build:` section, so both
routes work from the same file: `pull` fetches what CI built, `up --build` builds
the identical thing on the NAS.

### Check it from the NAS itself

```bash
curl -s http://127.0.0.1:4040/.well-known/nodeinfo
sudo docker inspect --format '{{.State.Health.Status}}' fediverse-desk
```

The health check calls `/.well-known/nodeinfo`, which needs neither a token nor a
reachable Ghost. So "healthy" means the process is serving, and nothing more:
credentials are checked by `desk status`, not by the probe.

### Run a CLI command against the running container

```bash
sudo docker exec -it fediverse-desk node dist/cli.js status
sudo docker exec -it fediverse-desk node dist/cli.js queue list
sudo docker exec -it fediverse-desk node dist/cli.js queue add "Later." --at +6h
```

These share the volume with the service, which is exactly the concurrent-writer
case the store's locking exists for.

### Expose it

The compose file binds to `127.0.0.1:4040` on purpose: the container is reachable
from the NAS, and not from the LAN or the internet. Put the tunnel on the NAS
alongside it and point it at that port.

The simplest arrangement is a second container in the same project:

```yaml
  tunnel:
    image: cloudflare/cloudflared:latest
    container_name: fediverse-desk-tunnel
    restart: unless-stopped
    command: tunnel run
    environment:
      - TUNNEL_TOKEN=${CLOUDFLARE_TUNNEL_TOKEN}
    depends_on:
      - desk
```

Add `CLOUDFLARE_TUNNEL_TOKEN` to `stack.env`, and configure the tunnel's public
hostname in the Cloudflare dashboard to point at `http://desk:4040`. Inside the
project the service name resolves, so the bridge never needs a published port at
all: you can drop the `ports:` block entirely once the tunnel is doing the work.

DSM's own reverse proxy plus Let's Encrypt is a reasonable alternative if you
would rather open a port on your router. A tunnel avoids that, which is why it is
the default here.

### Updating

```bash
cd /volume1/docker/fediverse-desk
git pull                      # for docker-compose.yml changes
sudo docker compose pull
sudo docker compose up -d
```

The volume survives, so the queue and the OAuth grants come back with it. Clients
stay logged in.

`latest` moves with `main`. To pin a known-good build instead, set the tag to a
release version or a commit: CI publishes `sha-<commit>` for every build, so
rolling back is editing one line and running the two commands again.

### Backups

`desk-data` is a named Docker volume, which Hyper Backup will not see. It holds
your pending queue and the client grants, and losing it means re-authorising
every client.

```bash
sudo docker run --rm -v fediverse-desk_desk-data:/data -v /volume1/backups:/backup   alpine tar czf /backup/desk-data.tar.gz -C /data .
```

Or bind-mount a shared folder instead of the named volume, and let Hyper Backup
handle it as ordinary files. If you do, the container runs as uid 1000 (`node`),
so the folder has to be writable by it.

## Keep it running elsewhere

If you are not using the container, systemd does the same job:

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
| Container is "unhealthy" | The process is not serving. `docker compose logs desk`. A missing `SHIM_PASSWORD` makes it exit at startup, on purpose |
| Container is healthy but `desk status` fails | The probe only proves the process is up. This is the credential, not the container |
| `Timed out waiting for ...json.lock` | A writer was killed mid-write and the lock outlived the stale window. If nothing else is running, delete the file the message names |

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
