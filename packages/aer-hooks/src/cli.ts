#!/usr/bin/env node
// aer-hook - the per-event hook binary.
//
// A harness runs this with the hook event JSON on stdin. We read all of stdin,
// parse it tolerantly, normalize it (harness from --harness or auto-detected),
// emit it via sinkFromEnv() and close.
//
// FAIL-OPEN + NON-BLOCKING is the #1 property. A hook that errors, hangs or is
// misconfigured must NEVER break or slow the harness. Everything is wrapped in
// try/catch, total runtime is capped by a hard timeout after which we exit 0
// regardless, and we NEVER write to stdout (some harnesses interpret hook stdout).

import {
  createHttpSink,
  resolveSinkOptionsFromEnv,
  type EventSink,
  type HttpSinkOptions,
} from '@adastracomputing/aer-emit';
import { normalize, type Harness, type HookEvent } from './normalize.js';
import { emitHookEvent } from './core.js';
import { loadSession, saveSession, deleteSession, acquireSessionLock } from './session-store.js';
import { isInvokedDirectly } from './invoked-directly.js';

// Production POST /v1/sessions has been measured at 3-4s (see aer-hooks README
// and the tenant-key Argon2id verification cost noted in the project docs), so
// the default budget needs headroom over that, not just over a fast local call.
const DEFAULT_HARD_TIMEOUT_MS = 10000;

/**
 * Parse AER_HOOK_TIMEOUT_MS: a positive integer, in ms, or unset. An unset or
 * invalid value falls back to DEFAULT_HARD_TIMEOUT_MS; an invalid one is
 * reported once so a typo does not silently pick the default.
 */
export function parseHardTimeoutMs(env: NodeJS.ProcessEnv, warn: (message: string) => void): number | undefined {
  const raw = env['AER_HOOK_TIMEOUT_MS'];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    warn(`aer-hook: ignoring invalid AER_HOOK_TIMEOUT_MS=${JSON.stringify(raw)}; using the default`);
    return undefined;
  }
  return n;
}

function parseHarnessFlag(argv: string[]): Harness | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--harness') {
      const v = argv[i + 1];
      if (v === 'claude-code' || v === 'codex') return v;
    } else if (a === '--harness=claude-code') {
      return 'claude-code';
    } else if (a === '--harness=codex') {
      return 'codex';
    }
  }
  return undefined;
}

async function readStdin(): Promise<string> {
  // If stdin is a TTY there is no piped payload; return empty rather than hang.
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  return await new Promise<string>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    process.stdin.on('close', done);
  });
}

export interface RunHookDeps {
  /** Injectable stdin reader for tests. Defaults to reading process.stdin. */
  readInput?: () => Promise<string>;
  /** Injectable fetch for tests. */
  fetch?: typeof fetch;
  /** Injectable clock for the session-store TTL / createdAt. */
  now?: () => number;
}

/** Build the sink for one already-decided branch, emit the event, and close it. */
async function emitThrough(event: HookEvent, sink: EventSink, raw: unknown, env: NodeJS.ProcessEnv): Promise<void> {
  emitHookEvent(event, sink, { raw, env });
  await sink.close();
}

/**
 * Emit one hook event, correlating all invocations within a harness session into
 * ONE AER session via the cross-process session store. A harness runs this once
 * per event as a separate process, so:
 *  - session_start opens the AER session and persists it (does not complete);
 *  - tool/prompt events attach to the stored session (open+persist if none yet);
 *  - session_end attaches, completes the AER session, and clears the store.
 * A missing sessionRef falls back to a single-shot open-emit-complete.
 *
 * The read (loadSession) - decide - write (saveSession) sequence for "is there
 * already a session for this harness session id" is guarded by a per-id lock
 * (acquireSessionLock), held across the open + persist so a concurrent hook for
 * the SAME harness session id waits and then attaches instead of also opening a
 * new upstream session. Lock contention (or an unwritable store) degrades to a
 * single-shot session for this event, never to a thrown error.
 */
async function orchestrateAndEmit(
  event: HookEvent,
  base: HttpSinkOptions,
  raw: unknown,
  env: NodeJS.ProcessEnv,
  now: number,
): Promise<void> {
  const ref = event.sessionRef;
  if (!ref) {
    // No correlation id: single-shot session (open + emit + complete on close).
    return emitThrough(event, createHttpSink(base), raw, env);
  }

  const lock = await acquireSessionLock(ref, env);
  if (!lock) {
    // Could not converge with a concurrent hook for this harness session in
    // time (or the store is unwritable): degrade to single-shot rather than
    // risk reading a half-written entry or waiting indefinitely.
    return emitThrough(event, createHttpSink(base), raw, env);
  }

  try {
    const stored = loadSession(ref, env, now);

    if (event.kind === 'session_end') {
      const sink = stored
        ? createHttpSink({ ...base, session: { id: stored.aerSessionId, ingestToken: stored.ingestToken }, completeOnClose: true })
        : createHttpSink(base); // never saw a start; single-shot
      if (stored) deleteSession(ref, env);
      await emitThrough(event, sink, raw, env);
      return;
    }

    if (stored) {
      // Attach to the running AER session; do not complete it here.
      const sink = createHttpSink({ ...base, session: { id: stored.aerSessionId, ingestToken: stored.ingestToken }, completeOnClose: false });
      await emitThrough(event, sink, raw, env);
      return;
    }

    // First event for this harness session (session_start, or a tool event
    // that arrived before any start): open one, persist it as soon as it is
    // known, then emit, all while still holding the lock so a concurrent
    // caller waiting on it sees the saved session once we release.
    const persist = (info: { id: string; ingestToken: string }): void => {
      saveSession(ref, { aerSessionId: info.id, ingestToken: info.ingestToken, baseUrl: base.baseUrl, createdAt: now }, env);
    };
    const sink = createHttpSink({ ...base, completeOnClose: false, onOpen: persist });
    await emitThrough(event, sink, raw, env);
  } finally {
    lock.release();
  }
}

/**
 * Run one hook. Resolves normally on every path. Exported for tests so the exit-0
 * guarantee can be exercised without spawning a process.
 */
export async function runHook(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  deps: RunHookDeps = {},
): Promise<void> {
  try {
    const harness = parseHarnessFlag(argv);
    const overrides = deps.fetch ? { fetch: deps.fetch } : {};
    const base = resolveSinkOptionsFromEnv(env, overrides);
    // Unconfigured: do nothing, touch no network.
    if (!base) return;

    const input = await (deps.readInput ?? readStdin)();
    if (!input.trim()) return;
    let payload: unknown;
    try {
      payload = JSON.parse(input);
    } catch {
      // Malformed payload: fail open, nothing to record.
      return;
    }
    const now = (deps.now ?? Date.now)();
    const event = normalize(payload, harness, env);
    await orchestrateAndEmit(event, base, payload, env, now);
  } catch {
    /* fail open: never surface an error to the harness */
  }
}

/**
 * Entry point: run the hook but never exceed the hard timeout, then return so the
 * caller can exit 0 regardless. If the budget is exceeded, writes one stderr line
 * (never a token) so a slow/hanging AER endpoint is visible without ever blocking
 * or failing the harness's tool.
 */
export async function main(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  deps: RunHookDeps = {},
): Promise<void> {
  const hardTimeoutMs = parseHardTimeoutMs(env, (message) => {
    try {
      process.stderr.write(message + '\n');
    } catch {
      /* stderr may already be gone; never throw from a diagnostic */
    }
  }) ?? DEFAULT_HARD_TIMEOUT_MS;

  let timedOut = false;
  const timeout = new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      timedOut = true;
      resolve();
    }, hardTimeoutMs);
    // Do not keep the event loop alive solely for the timeout.
    if (typeof t.unref === 'function') t.unref();
  });
  try {
    await Promise.race([runHook(argv, env, deps), timeout]);
  } catch {
    /* fail open */
  }
  if (timedOut) {
    try {
      process.stderr.write(`aer-hook: timed out after ${hardTimeoutMs}ms; the AER record for this event may be incomplete\n`);
    } catch {
      /* stderr may already be gone; never throw from a diagnostic */
    }
  }
}

// Only run when executed as a binary, not when imported by tests. Must resolve
// symlinks: the harness runs this through the `aer-hook` node_modules/.bin
// symlink, whose name never matched the old endsWith('cli.js') check.
if (isInvokedDirectly(import.meta.url)) {
  void main().finally(() => {
    // Always exit 0 quickly, whatever happened above.
    process.exit(0);
  });
}
