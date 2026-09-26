---
'@adastracomputing/aer': patch
---

`aer --version` now reports the real version everywhere, including the nix
flake app, which previously printed "unknown" because it runs the built
entry file without a package.json next to it. The version is baked into the
bundle at build time instead of read from disk at startup.
