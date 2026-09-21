---
"@adastracomputing/aer-auto-node": patch
---

Record LLM calls from an ESM agent, and stop claiming adapters that recorded nothing

Three faults, found by testing the collector against the real SDKs in a real
install rather than against objects shaped like them.

**A project with the Vercel AI SDK installed crashed at startup.** `ai` is ESM
and an ESM module namespace is frozen, so writing the patch marker to it threw,
uncaught, out through the register entry point before the application ran a
line. Adapter installation is now isolated per adapter and a target that cannot
be patched is reported rather than thrown.

**The OpenAI and Anthropic adapters recorded nothing in an ESM agent.** Both
packages are dual-published: `index.mjs` and `index.js` are different classes
with different prototypes. The collector reached the SDK with `createRequire`,
so it patched the CJS copy while the application imported the other one. The
signed record carried no model and no token counts, while its own
`collector.report` listed both adapters as active. Resolution is now anchored to
the application, and every copy the application could use is patched before its
first call. `enabled` now means patched rather than present, so the report stops
naming an adapter that records nothing.

**The Vercel AI SDK was not instrumented at all.** It is now recorded at the
provider layer: one `doGenerate` is one real model call, with the model id and
the token counts. Streaming records the call but not its counts, which arrive in
a stream part this release does not read.

If you run an ESM agent, records produced before this release are missing their
`llm.requested` and `llm.completed` events. Those records are signed and are not
rewritten; new sessions are complete.
