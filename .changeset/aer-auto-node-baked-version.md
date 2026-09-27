---
'@adastracomputing/aer-auto-node': patch
---

The collector now declares its real version when it opens a session and in
its closing report. The version was a hand-written number that had fallen
behind the package, so 0.4.0 reported itself as 0.3.0. It is now read from
the package at build time.
