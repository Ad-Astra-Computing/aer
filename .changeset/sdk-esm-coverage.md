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

Security review before publishing found three more, all fixed here.

The collector crashed at startup on Node older than 22.15. It imported
`registerHooks` from `node:module` as a named import, and a missing named
export from a builtin is a link error rather than undefined, so the guard
beneath it never ran. The process died before the application loaded, and
before `AER_DISABLE` was read.

`spawn(line, [], { shell: true })` skipped the command reducer entirely,
because an argv array was read as proof that argv[0] was a program path. That
put the tail of the line back in the record: a redirect target, an scp target,
or whatever followed a semicolon. cross-spawn and execa both pass an array and
forward `shell`, so this was the common shape.

A record could assert instrumentation coverage a run did not have. Tearing the
collector down left every adapter listed as patched, so the closing report read
as a run that made no calls; a wrapper replaced after installation was not
noticed at all; and a provider host two adapters could both have called was
read as a contradiction against whichever one did not record it.
