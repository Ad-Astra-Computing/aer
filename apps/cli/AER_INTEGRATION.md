# AER integration

This project is instrumented with the AER auto-collector. It records what the
agent actually does (network, LLM turns, tool calls, processes, dependencies)
with zero manual `emit()`.

## How it runs

Instrumentation loads via `--import @adastracomputing/aer-auto-node/register` (wired into your run scripts as `NODE_OPTIONS`).

## Configure

1. Set the only secret: `export AER_API_KEY=<key>` (see `.env.example`).
2. Fill identity in `aer.config.json` (tenant_id / agent_id / env_id). Base URL: https://api.aer.run.
3. Verify: `npx @adastracomputing/aer doctor`.

## Detected

- package manager: unknown
- session strategy: process
- SDK adapters: none detected
- transport patches: fetch, http, https, child_process

## Note

Patch-based capture observes `globalThis.fetch` and default-import property
access (`import cp from 'node:child_process'; cp.spawn(...)`). Named imports
are not captured in v1.
