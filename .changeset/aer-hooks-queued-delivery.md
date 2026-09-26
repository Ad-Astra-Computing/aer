---
'@adastracomputing/aer-hooks': minor
---

The hook no longer loses events when the AER API is slow, fails or has closed
the session.

- Events are queued on disk and leave the queue only once the API has accepted
  them. A failed or timed out send, a failed session open (such as a 503) or a
  hook cut off by its time budget leaves them for the next event to send,
  instead of dropping them. Previously the model calls read from a transcript
  were marked as read before they were sent, so a failed send lost them for
  good.
- Only one hook process at a time talks to the API for a harness session; the
  others queue their events and return immediately. Concurrent hooks from a
  lead agent and its subagents no longer wait on each other's network calls,
  drop subagent events, repeat event positions or open extra sessions.
- When the API has closed the session (for example after a long idle period),
  the next event opens a new one and sends what was queued, instead of every
  later event being refused for the rest of the day.
- A long interactive session that never sends its end event is now completed
  in parts: at the first turn end once the record is an hour old, and before
  the next event after an hour of quiet. It continues in a new record under
  the same session reference. `AER_HOOK_CHECKPOINT_MINUTES` changes the hour;
  `0` keeps one record.
- Every lifecycle report now carries the registered events, the event count
  and the drop counters, not only the opening or closing one.
- The first read of a transcript with existing history records at most its 50
  most recent model calls, sent in batches of at most 100 events.
- If the cache dir cannot be written, state is kept in the runtime dir or a
  private per-user directory under the temp dir, so the hook still records one
  session rather than dropping tool events.
