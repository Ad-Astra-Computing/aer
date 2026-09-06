# Agent guide

## AER auto-instrumentation

This project uses `@adastracomputing/aer-auto-node`. The collector loads via
`--import @adastracomputing/aer-auto-node/register` (wired into the run scripts).
Set `AER_API_KEY` (the only secret); identity is in `aer.config.json`.
Verify with `npx @adastracomputing/aer doctor`. Do not add manual `emit()` calls -
capture is automatic.
