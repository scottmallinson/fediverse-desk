# Contributing

Thanks for looking. This is a small, personal project, but bug reports, fixes and
evidence from real Ghost sites are all welcome, and the last of those is worth the
most: see [What has not been verified](README.md#what-has-not-been-verified).

## Before you start

- **Found a security problem?** Do not open an issue. Follow [SECURITY.md](SECURITY.md).
- **Found a bug?** Open an issue with the bug template. Say which Ghost version,
  which transport (`ghst` or `direct`), and which client, if the bridge was
  involved.
- **Want to add something?** Open an issue first for anything bigger than a
  small fix, so we can agree it fits before you spend time on it. The scope is
  deliberately narrow: one Ghost publication, one handle, one account on the
  bridge. Multi-user support, signup, or a second identity are out of scope.

## Most useful of all: a real round trip

Nobody has yet run this against a real Ghost site with an Owner or Administrator
staff access token. If you have one, running `desk status`, posting a note, and
connecting a client through the bridge would settle questions no amount of
reading source can. Report what you saw in an issue, including any response
shapes that did not match what the code expects. **Redact tokens, cookies and
`Authorization` headers before you paste anything.**

## Setting up

Needs Node 22 or newer. There are no runtime dependencies, only dev ones.

```bash
npm ci
npm run typecheck
npm test
```

Both have to pass before a pull request can merge; CI runs them, then builds the
container image and smoke tests it. To check the image locally:

```bash
docker build -t fediverse-desk .
```

The tests use a fake `SocialWeb` and a fake `fetch`, so you do not need a Ghost
site or a token to work on almost anything here.

## Making a change

1. Fork the repository and branch from `main`.
2. Keep the change focused. One fix or one feature per pull request.
3. Add or update tests. A fake that returns what the code expects, rather than
   what Ghost actually sends, is how a real defect got past the suite once
   already, so base fixtures on real responses or on Ghost's source wherever you
   can, and say which.
4. Update the README, DEPLOYMENT.md or VPS.md if behaviour, configuration or an
   endpoint changes. The endpoint table in the README should stay accurate.
5. Run `npm run typecheck` and `npm test`.
6. Open a pull request against `main` and fill in the template.

`main` is protected: changes land through pull requests, CI has to pass, and a
maintainer reviews every one.

## Style

- TypeScript in strict mode, ES modules, two-space indent. `.editorconfig` covers
  the basics.
- Use node's standard library. Adding a runtime dependency needs a strong reason,
  because the image ships none today and that is part of the security story.
- Comments explain *why*, not what.
- Errors should say which step failed and what to check, in the way `desk status`
  does.
- Commit messages: a short summary in the imperative, then a body that explains
  the reason for the change if it is not obvious.

## Things to be careful with

- **Never commit secrets.** `.env`, `stack.env`, `caddy.env` and `data/` are
  ignored for a reason. Use the `*.example` files for anything new.
- **Credential handling.** Client secrets and access tokens are stored as
  digests, codes are single use, redirect URIs match exactly, and the bridge binds
  to loopback by default. A change that weakens any of those needs to say so, and
  why, in the pull request.
- **The Ghost API is private and undocumented.** Link the Ghost or
  `TryGhost/ActivityPub` source you relied on when you change how the code talks
  to it.

## Licence

By contributing, you agree that your contributions are licensed under the
[MIT licence](LICENSE) that covers the project.

## Conduct

Everyone taking part is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).
