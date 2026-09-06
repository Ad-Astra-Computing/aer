# Security policy

Report vulnerabilities privately to security@adastracomputing.com.

Please do not open public issues for security reports. We acknowledge new
reports within 3 business days and will keep you updated as we work on a fix.

## Shipping a fix

Every package here is pre-1.0, so a release publishes to the `next` dist-tag
and `latest` does not move on its own. An unpinned `npm install` and the
`npx` commands in our documentation both resolve `latest`, so a security fix
is not delivered until it is promoted:

```
pnpm promote @adastracomputing/<package> --yes
```

Promotion is part of the fix, not a follow-up. Confirm it afterwards with
`npm view @adastracomputing/<package> dist-tags`.
