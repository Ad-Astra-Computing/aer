---
'@adastracomputing/aer': patch
---

Harden `aer login` and friends per security review. Refuse an env or flag
API key whose base URL came only from a cloned repo's `aer.config.json` and
differs from the default, unless `AER_BASE_URL` confirms it. Validate the
server's verification URL (https only, no embedded credentials) before
printing or opening it, and open a browser on Windows without going through
`cmd /c start`. Revoke a newly minted key if saving it fails, and revoke an
existing key before a repeated login replaces it. Never clobber a corrupt
credentials file: it is moved aside and refused instead. `aer logout --all`
logs out of every stored base URL; a plain `aer logout` in the wrong
directory now names where else you are logged in.
