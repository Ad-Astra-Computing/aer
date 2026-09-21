---
"@adastracomputing/aer-hooks": minor
---

hooks: one record per run, and what the run actually did

`Stop` fires once per assistant turn, and completing the record there split a
single conversation across several signed AERs. It is now a turn marker and
`SessionEnd` ends the run. Re-run `aer-hooks install <harness>`: an entry
written by an earlier release is brought up to date in place, and until it is,
the old behaviour is kept rather than silently recording nothing.

Every event now carries the harness, the model, the permission mode, the turn,
the tool-call id and, on Claude Code, the reasoning effort, plus a position so
a gap in a record is visible. A shell call is recorded as the program it ran,
a fetch as the host it reached and a read or write as the file it touched,
which is the reduction the transcript importer already did. Metadata values
must be identifier-shaped or they are dropped, so a harness putting a sentence
in a `reason` field cannot put it in a record.

The session markers now declare what the collector was registered for and how
much of it arrived, so a reader can tell a quiet session from a broken one.

Codex skips a hook it has not been told to trust, and skips it silently. The
installer, `aer-hooks status` and the README now say to run `/hooks` in Codex
and approve the entry.
