# Security policy

The bridge is an authenticated write endpoint for a publication, and the token
behind it is full admin access to a Ghost site. Security reports are taken
seriously and are the one kind of report that should not go in a public issue.

## Reporting a vulnerability

Report it privately through GitHub:
[**Report a vulnerability**](https://github.com/scottmallinson/fediverse-desk/security/advisories/new)
(the **Security** tab, then **Report a vulnerability**).

Please include:

- what an attacker could do, and what they need first (network access to the
  bridge, a client registration, a valid token, and so on)
- steps to reproduce, or a proof of concept
- the commit or image tag you tested
- whether it is already public anywhere

Leave real tokens, passwords and site addresses out of the report.

## What to expect

This is maintained by one person in their own time, so these are aims, not
guarantees:

- an acknowledgement within a week
- an assessment, and a fix or a plan, within thirty days for anything serious
- credit in the advisory, if you want it, once a fix is released

Please give a reasonable chance to fix the problem before disclosing it publicly.

## Supported versions

Only the latest commit on `main`, and the `latest` image built from it, receive
fixes. There are no maintained release branches.

## In scope

- the OAuth flow: client registration, the authorise page, codes, tokens,
  revocation
- authentication bypass on `/api/v1`, `/api/v2` or the remote-follow page
- password lockout bypass or timing leaks
- anything that leaks or stores a replayable credential: the Ghost staff token,
  identity tokens, client secrets, access tokens
- request handling that lets an unauthenticated caller post, delete, follow or
  read private data
- the container image and the example Caddy and Compose configuration

## Out of scope

- the risks the README already documents, such as the staff token being full
  admin access, which Ghost offers no narrower alternative to
- deployments that ignore the documented posture, for example binding to a
  public address with no TLS
- vulnerabilities in Ghost itself, in `@tryghost/ghst`, or in a Mastodon client.
  Report those to their own projects
- denial of service by sheer volume against a single self-hosted instance
