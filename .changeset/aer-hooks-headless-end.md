---
'@adastracomputing/aer-hooks': patch
---

A session run headless, such as `claude -p`, now ends with a completed record.
Claude Code gives SessionEnd hooks 1.5 seconds unless the entry sets a timeout,
and in print mode cancels the hook and everything it started when that runs
out, so against a real API the closing report and the completion were cut off
and the session stayed open until the server closed it hours later, without a
summary. At the end of a session the hook now starts a small worker outside
the harness's reach, delivers what it can in under a second itself and returns;
the worker sends the rest, completes the record and exits within a minute. It
writes nothing to the terminal; its notes go to `drain.log` in the state
directory. The same applies to Codex and Antigravity, which also bound how long
a SessionEnd hook may run.
