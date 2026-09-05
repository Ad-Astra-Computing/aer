# Releasing

npm publishing is automated. PyPI is not used: the Python SDK ships from this
repository only, installed with pip from git or through the flake's dev shell.

## How a release happens

1. Land a change on `main` with a changeset (`pnpm changeset`).
2. The Release workflow opens or updates a "release: version packages" pull
   request that applies the version bumps and changelogs.
3. Merging that pull request runs the workflow again, which builds,
   typechecks, tests, then publishes every changed public package to npm.

Nothing publishes without that merge, so the version pull request is the
release gate.

## One-time npm setup

The workflow publishes without a long-lived token: it requests an OIDC
identity from GitHub (`id-token: write`) and npm trades it for a short-lived
credential. That requires registering this workflow as a trusted publisher on
npm, once per package:

For each of the nine public packages under the `@adastracomputing` scope, open
its page on npmjs.com, then Settings, then Trusted publishers, and add a GitHub
Actions publisher with:

- Organization or user: `Ad-Astra-Computing`
- Repository: `aer`
- Workflow filename: `release.yml`

Until that is done the publish step fails with an authentication error. It does
not fall back to a token, which is deliberate: no npm credential is stored in
this repository or in GitHub secrets.

## Provenance

npm provenance attestations are not enabled, because npm can only generate them
for packages published from a public repository. When this repository goes
public, add `NPM_CONFIG_PROVENANCE: true` to the publish step's environment and
every published tarball will carry a signed link back to the commit and workflow
run that built it.

## Python

`packages/sdk-py` is deliberately unpublished. Its README documents the two
supported installs, pip from git and `nix develop`. If that ever changes, the
decision to publish is the owner's, not a workflow's.
