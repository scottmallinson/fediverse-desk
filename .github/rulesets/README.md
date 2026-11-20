# Repository rulesets

GitHub does not read rulesets from the repository, so these files are the record
of what is configured, not the configuration itself. Apply a change here to the
repository as well.

## `main.json`: Protect main

Applies to the default branch.

- No deletion and no force pushes.
- Changes land through a pull request, with one approving review from a code
  owner (see `../CODEOWNERS`). New commits dismiss earlier approvals, and every
  review thread has to be resolved.
- The `Test` and `Image` jobs from `.github/workflows/ci.yml` have to pass. The
  `integration_id` pins them to GitHub Actions, so nothing else can report a
  status with the same name.
- Repository admins can bypass the rules **on a pull request only**, so the
  maintainer can merge their own pull requests without a second reviewer, but
  cannot push straight to `main`.

If a CI job is renamed, rename it in `required_status_checks` too, or every pull
request will wait forever for a check that never reports.

### Applying it

In the browser: **Settings → Rules → Rulesets → New ruleset → Import a ruleset**,
and choose `main.json`.

Or with the GitHub CLI, as a repository admin:

```bash
gh api -X POST repos/scottmallinson/fediverse-desk/rulesets --input .github/rulesets/main.json
```

To update it later, find its id with `gh api repos/scottmallinson/fediverse-desk/rulesets`,
then `PUT` the same file to `repos/scottmallinson/fediverse-desk/rulesets/<id>`.
