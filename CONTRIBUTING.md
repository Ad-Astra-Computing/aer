# Contributing

Bug reports and small fixes are welcome. Opening an issue first is the fastest
way to get a change in.

These packages are developed alongside the AER service, and accepted changes
are released through that process. A pull request may therefore land as a
separate commit rather than a direct merge, with credit in the changelog.

Before submitting a change, run:

```sh
pnpm install
pnpm test
```

For anything security related, see [SECURITY.md](./SECURITY.md).

## Before a release

The installed-package matrix tests every client package the way a customer
gets it: packed or downloaded, installed with npm into a throwaway directory
and driven through its installed binaries against a local capture server. It
never contacts the AER service.

```sh
pnpm matrix                                           # local tarballs
pnpm matrix --source registry --tag next              # what is on npm
pnpm matrix --source registry --tag next --upgrade-from latest
```

The matrix must pass against `--source local` before a release pull request
merges, and against `--source registry --tag next`, with the upgrade run from
`latest`, before `pnpm promote` moves `latest`. A known issue is reported as
KNOWN rather than hidden; any FAIL blocks. Run `pnpm matrix --help` for the
filters and the JSON report.
