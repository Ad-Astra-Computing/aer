---
"@adastracomputing/aer-auto-node": patch
---

Fixed a secret leak: a named import of `child_process.exec` (or
`promisify(exec)`) recorded the full, unredacted shell command in the signed
record instead of just the executable name. Command capture is now
path-independent, so every import style records only a basename and a
redacted argument count.

Also fixed `protected_resources` host matching: a bare host entry
(`api.example.com`) now matches that host only, not its subdomains. A
leading dot (`.api.example.com`) remains the only way to opt a resource into
subdomain matching, matching what the README already documented.
