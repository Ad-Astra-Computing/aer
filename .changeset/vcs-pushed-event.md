---
"@adastracomputing/aer-hooks": minor
---

Record git push outcome and before/after ref as a new vcs.pushed event.
Detects a plain, single-branch `git push [remote] [branch]`, runs a local
`git rev-parse` before and after the real push, and records the outcome
(accepted/rejected/unknown from the push command's own exit code) plus the
already-classified remote_class/branch_class. before_ref/after_ref are
validated bare git object ids only. A bare push, remote-only push,
multi-refspec, delete, colon refspec or a push sharing its command line
with another invocation has no single resolvable ref: the event still
records with outcome unknown and no refs.
