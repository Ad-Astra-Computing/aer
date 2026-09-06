---
"@adastracomputing/aer": patch
---

Publish an entry point that cannot decline to run. The bundle previously
contained a guard deciding whether it was the process entry, which in a
bin-only package could produce exactly one failure: deciding wrongly and
exiting 0 in silence. That is what shipped in 0.1.1. The published bundle now
starts from a wrapper that simply runs, and the guard lives only in the source
the tests import. Covered by tests that install the packed tarball and run the
installed binary.
