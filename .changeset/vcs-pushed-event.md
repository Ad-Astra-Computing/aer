---
"@adastracomputing/aer-hooks": minor
---

Record git push outcome and before/after ref as a new vcs.pushed event.
Detects a plain, single-branch `git push [remote] [branch]`, runs a local
`git rev-parse` before and after the real push, and records the outcome
(accepted/rejected/unknown from the push command's own exit code) plus the
already-classified remote_class/branch_class. before_ref/after_ref are
validated bare git object ids only; anything that cannot be cleanly
resolved from argv (a bare push, remote-only push, multi-refspec, delete or
colon refspec) degrades to outcome unknown with no refs rather than guess.
