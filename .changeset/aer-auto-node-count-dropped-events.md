---
'@adastracomputing/aer-auto-node': patch
---

When a batch of events cannot be delivered to the AER API (refused, failed
or timed out), the final `collector.report` now counts its events in
`events_dropped_budget`, so the record says it is short instead of looking
complete. A batch that timed out may still have arrived, so the count is an
upper bound. The field is absent when every batch arrived.
