# Running it on a VPS

An Arsys VPS, or any Ubuntu box with a public address. TLS is terminated by
Caddy on the same machine, which gets a Let's Encrypt certificate on its own and
renews it without being asked.

This is the deployment [DEPLOYMENT.md](DEPLOYMENT.md) calls "a small VPS with a
reverse proxy": always on, so Buffer can own the schedule, and you own the whole
path from DNS to the process. Read [the shape of the problem](DEPLOYMENT.md#the-shape-of-the-problem)
there first if you have not: it explains why a public address is needed at all,
and it is the part that decides whether posts silently go missing.

Everything below is Ubuntu 24.04 or newer. The Arsys-specific parts are two
short sections at the end; the rest is ordinary Ubuntu and Docker.

## What you need before starting

| | |
|---|---|
| A VPS with a public IPv4 address | Any of Arsys's plans will do. 1 GB of RAM is enough to *run* this, but see [Building on a small plan](#building-on-a-small-plan) |
| SSH access to it | Key-based, ideally. Step 2 turns off passwords |
| A subdomain you control | `desk.example.com`. It gets its own name, not a path on your site |
| A Ghost **Owner or Administrator** staff access token | Ghost Admin, under your own profile. Nothing works without this, and no other credential substitutes. See [the auth table](README.md#how-it-authenticates-and-why-it-has-to) |

The token is full admin access to your site. It ends up in one file on this box,
at mode 600. That is the main thing to keep in mind while doing any of this.

## 1. Point the subdomain at the VPS

Create an `A` record for `desk.example.com` pointing at the VPS's IPv4 address.
If the VPS has IPv6, an `AAAA` record too.

**On Cloudflare, set the record to DNS only — the grey cloud, not the orange
one.** Proxying it puts Cloudflare in the path, which changes how the
certificate is issued and how the address behaves, and none of that is worth
debugging on the first pass. [Putting Cloudflare in front](#optional-putting-cloudflare-in-front)
below is the deliberate version of that, once the plain one works.

Check it resolves before going further, because step 6 fails in a confusing way
if it does not:

```bash
dig +short desk.example.com
```

That must print the VPS's address. DNS caches, so if you have just changed the
record, wait rather than pressing on.

## 2. Harden the box

Skip anything you have already done. As a user with sudo:

```bash
sudo apt update && sudo apt upgrade -y
```

If you are still logging in as root, make yourself an ordinary user with sudo
and use it from here on:

```bash
sudo adduser --disabled-password --gecos "" scott
sudo usermod -aG sudo scott
sudo rsync -a --chown=scott:scott ~/.ssh/authorized_keys /home/scott/.ssh/
```

Log out, log back in as that user, and confirm `sudo -v` works **before**
turning off password logins:

```bash
sudo sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PermitRootLogin .*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sudo sshd -t && sudo systemctl restart ssh
```

`sshd -t` checks the file parses. Restarting a broken sshd on a remote box is
the classic way to lock yourself out, and Arsys's console recovery is slower
than reading one line of output.

The firewall, and automatic security updates:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable

sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

> **What ufw does and does not protect here.** Docker publishes ports by writing
> its own iptables rules, which are consulted before ufw's, so a container's
> published port is reachable whether or not ufw allows it. The rules above
> protect SSH, which is a host process. What keeps the bridge itself off the
> internet is that it is published on `127.0.0.1:4040` and nowhere else — that
> is a Docker binding, not a firewall rule, which is why the compose file says
> so explicitly.

Last, check the clock. OAuth codes here expire in five minutes and TLS is
unforgiving about skew, so a wrong clock produces failures that look like
anything but a wrong clock:

```bash
timedatectl   # want: "System clock synchronized: yes"
```

## 3. Install Docker

Ubuntu's own packages work, but Docker's repository is newer and is what CI
builds against. Add it, checking first that it carries this release — a repo
that has not caught up with a brand new Ubuntu is the one thing that makes these
commands fail:

```bash
. /etc/os-release
curl -fsI "https://download.docker.com/linux/ubuntu/dists/$VERSION_CODENAME/Release" >/dev/null \
  && echo "docker's repo has $VERSION_CODENAME" \
  || echo "docker's repo does not have $VERSION_CODENAME yet — use the fallback below"
```

If it has this release:

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

If it does not, Ubuntu's own packages are a supported path and give you the same
`docker compose` command:

```bash
sudo apt install -y docker.io docker-compose-v2
```

Either way, let your user run Docker without sudo, then prove it:

```bash
sudo usermod -aG docker "$USER"
newgrp docker          # or log out and back in
docker compose version
```

## 4. Get the code onto the box

```bash
sudo mkdir -p /opt/fediverse-desk
sudo chown "$USER":"$USER" /opt/fediverse-desk
git clone https://github.com/scottmallinson/fediverse-desk.git /opt/fediverse-desk
cd /opt/fediverse-desk
```

## 5. Configure

Two environment files, deliberately separate: one holds the staff token and is
read by the bridge, the other holds the domain and is read by the proxy. The
proxy has no business being able to read a credential that can rewrite your
site.

```bash
cp stack.env.example stack.env
cp caddy.env.example caddy.env
chmod 600 stack.env
```

Generate the bridge password first, because you will want to paste it into both
`stack.env` and your password manager:

```bash
openssl rand -hex 32
```

`stack.env` — the bridge:

```ini
GHOST_URL=https://example.com
GHOST_STAFF_ACCESS_TOKEN=<id>:<secret>          # Owner or Administrator
SHIM_PUBLIC_URL=https://desk.example.com        # https, and the real subdomain
SHIM_PASSWORD=<the 64 hex characters you just generated>
```

`caddy.env` — the proxy:

```ini
DESK_DOMAIN=desk.example.com                    # no scheme, no trailing slash
ACME_EMAIL=you@example.com
```

`SHIM_PUBLIC_URL` and `DESK_DOMAIN` describe the same address and must agree.
The bridge advertises `SHIM_PUBLIC_URL` in nodeinfo and builds OAuth redirects
against it, so if it disagrees with the address a client actually used, discovery
sends the client somewhere wrong and the login fails without saying why. Note
the difference in form: one carries `https://`, the other does not.

## 6. Start it

The VPS overlay adds Caddy to the base compose file. Both files, every time —
the second is not a replacement, it is a layer:

```bash
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d
```

Typing that on every command gets old. Set it once for this shell, and add it to
`~/.bashrc` so it survives a reconnect:

```bash
echo 'export COMPOSE_FILE=docker-compose.yml:docker-compose.vps.yml' >> ~/.bashrc
source ~/.bashrc
docker compose ps          # now equivalent to the two -f flags
```

The image comes from GitHub Container Registry. The repository is private, so
the package is too, and the pull needs a personal access token with the
`read:packages` scope:

```bash
echo "<token>" | docker login ghcr.io -u scottmallinson --password-stdin
docker compose pull
```

If you would rather not keep a GitHub token on the VPS, build it here instead —
the image installs no runtime dependencies, so this is quick:

```bash
docker compose up -d --build
```

Then watch it come up. The first start is the interesting one, because it is
when the certificate is issued:

```bash
docker compose logs -f
```

You are looking for three things: the bridge reporting the address it serves,
the queue runner reporting its interval, and Caddy logging
`certificate obtained successfully`. Ctrl-C stops following the logs, not the
containers.

## 7. Check it, from the box and from outside

On the VPS, which tests the bridge without involving DNS, TLS or the proxy:

```bash
curl -s http://127.0.0.1:4040/.well-known/nodeinfo
docker compose ps          # desk should say (healthy)
```

The health check calls `/.well-known/nodeinfo`, which needs neither a token nor
a reachable Ghost. "Healthy" means the process is serving and nothing more.

From your laptop, which is the path a client will take:

```bash
curl -sI https://desk.example.com/.well-known/nodeinfo | head -1
curl -s https://desk.example.com/.well-known/nodeinfo
curl -s https://desk.example.com/nodeinfo/2.0 | grep -o '"name":"mastodon"'
```

The `href` in the first document must be your real subdomain. If it says
`desk.example.com` or a `127.0.0.1` address, `SHIM_PUBLIC_URL` is still the
example value, and no client will get past discovery.

The third command is the one that decides whether a client offers a Mastodon
login at all. No output means no.

Now the credential, which is a separate question from whether the process runs:

```bash
docker compose exec desk node dist/cli.js status
```

That prints the handle, the role on the identity token and how long it has left.
A 403 mentioning `/ghost/api/admin/identities/` means the token is not Owner or
Administrator — see [the auth table](README.md#how-it-authenticates-and-why-it-has-to).

## 8. Prove the whole flow before involving a client

Do not debug two systems at once. [The curl walkthrough in
DEPLOYMENT.md](DEPLOYMENT.md#prove-it-before-involving-a-client) drives the
entire OAuth flow exactly as a client would and ends by posting a real note.
Run it with `BASE=https://desk.example.com`. Ten minutes, and afterwards any
failure is the client's rather than yours.

Then [connect Buffer](DEPLOYMENT.md#connect-buffer): add a channel, choose
Mastodon, give it `desk.example.com` as the server.

## Living with it

### Updating

```bash
cd /opt/fediverse-desk
git pull                                    # compose files, Caddyfile, docs
docker compose pull && docker compose up -d # or: docker compose up -d --build
```

The volumes survive, so the queue and the OAuth grants come back with it and
clients stay logged in. `latest` moves with `main`; CI also publishes
`sha-<commit>` for every build, so pinning a known-good one is editing the tag
in `docker-compose.yml` and running those two commands again.

### Backups

`desk-data` is a named Docker volume holding your pending queue and every client
grant. Losing it means re-authorising every client. The staff token lives in
`stack.env`, which is not in the volume and not in git.

```bash
docker run --rm -v fediverse-desk_desk-data:/data -v /opt/backups:/backup \
  alpine tar czf /backup/desk-data.tar.gz -C /data .
```

Worth a weekly cron entry, and worth copying off the VPS: an Arsys snapshot of a
box you have lost access to is not a backup you can read.

### Running CLI commands

```bash
docker compose exec desk node dist/cli.js status
docker compose exec desk node dist/cli.js queue list
docker compose exec desk node dist/cli.js queue add "Later." --at +6h
```

These share the volume with the running service, which is the concurrent-writer
case the store's locking exists for.

Times are stored and shown as UTC ISO stamps, and the container's clock is UTC
regardless of the host's timezone. Relative forms (`+90m`, `+2h`, `+3d`) are
unambiguous and are what to reach for. A bare stamp like `2026-09-05T09:00` is
read as UTC, so if you mean nine in the morning in Madrid, write the offset:
`2026-09-05T09:00+02:00`.

### Monitoring

If you point an uptime monitor at this, **configure it to send `GET`, not
`HEAD`.** The bridge routes `GET` only, so a `HEAD` probe gets a 404 and the
monitor will report an outage that is not happening. Monitor
`https://desk.example.com/.well-known/nodeinfo`, which needs no credential.

### Building on a small plan

`docker compose pull` needs almost nothing. Building on the box is heavier: the
TypeScript compile wants roughly a gigabyte free, and on a 1 GB plan with no
swap it gets killed by the OOM killer, which reads as a mysterious failed build
rather than as running out of memory. Either pull the image, or add swap once:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## Arsys specifics

Almost none of this is Arsys-specific — it is an Ubuntu box with a public
address. Three things are worth knowing:

- **Check for a firewall in the Arsys panel as well as ufw.** Some of their
  plans put a network-level firewall in front of the VPS, and if yours does,
  ports 80 and 443 have to be open there too. A closed panel firewall looks
  exactly like a DNS problem from outside: the name resolves, nothing answers.
  If step 7 times out from your laptop while `curl` on the VPS itself works,
  this is the first thing to check.
- **Reverse DNS is theirs to set.** Not needed here — nothing sends mail — but
  it is a panel setting rather than a DNS record, if you ever want it.
- **Snapshots are not backups of the volume.** Take one before an upgrade by all
  means; keep the `tar` above as well.

Their panel changes often enough that naming menus here would age badly. Look
for the VPS's network or firewall settings, and everything else on this page is
done over SSH.

## Optional: putting Cloudflare in front

Once the plain deployment works, switching the DNS record to the orange cloud
buys one genuinely useful thing: **Cloudflare Access in front of
`/oauth/authorize`**, which adds a second factor to the only browser-driven
route without touching the machine-to-machine ones.

If you do it:

- Set the SSL/TLS mode to **Full (strict)**. Anything less and Cloudflare will
  talk to your origin over plain HTTP or accept any certificate, which throws
  away the thing you set up in step 6.
- Keep port 80 open. Caddy renews through it, and Cloudflare passes the ACME
  challenge path through even with Always Use HTTPS on.
- Put Access on `/oauth/authorize` **only**. `/api/*` and `/oauth/token` are
  called by Buffer's servers, not by a browser, and gating them breaks posting
  in a way that looks like an expired token.

Doing this before the plain version works means debugging two systems at once,
which is the thing this page is arranged to avoid.

## When it does not work

The general table in [DEPLOYMENT.md](DEPLOYMENT.md#when-it-does-not-work)
covers the bridge and the client. These are the ones specific to this setup:

| Symptom | Where to look |
|---|---|
| Caddy logs an ACME failure, no certificate | DNS. The name has to resolve to this VPS **before** Caddy starts. `dig +short desk.example.com` from elsewhere, then `docker compose restart caddy` |
| ACME failure mentioning a timeout on port 80 | Something is closing 80. ufw, the Arsys panel firewall, or another process already holding the port: `sudo ss -lntp \| grep ':80'` |
| `bind: address already in use` on startup | Apache or nginx came with the image and is holding 80. `sudo systemctl disable --now apache2 nginx` |
| Certificate issued, but clients still refuse the server | `SHIM_PUBLIC_URL`. Compare `curl -s https://desk.example.com/.well-known/nodeinfo` against the address you actually typed |
| Works on the VPS, times out from outside | Panel firewall, or the DNS record is proxied when you expected it not to be |
| `desk status` fails but the container is healthy | The probe only proves the process is serving. This is the credential |
| Too many failed authorizations from Let's Encrypt | Rate limited, for an hour. Fix the cause before restarting Caddy again — repeated restarts are what triggered it |
| Build killed with no error | Out of memory. See [Building on a small plan](#building-on-a-small-plan) |
| Uptime monitor reports a 404 | It is sending `HEAD`. Switch it to `GET` |
