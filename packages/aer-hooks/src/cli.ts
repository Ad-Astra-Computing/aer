#!/usr/bin/env node
// aer-hook — the per-event hook binary.
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
import { loadSession, saveSession, deleteSession } from './session-store.js';
import { isInvokedDirectly } from './invoked-directly.js';

const HARD_TIMEOUT_MS = 2500;

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

/**
 * Emit one hook event, correlating all invocations within a harness session into
 * ONE AER session via the cross-process session store. A harness runs this once
 * per event as a separate process, so:
 *  - session_start opens the AER session and persists it (does not complete);
 *  - tool/prompt events attach to the stored session (open+persist if none yet);
 *  - session_end attaches, completes the AER session, and clears the store.
 * A missing sessionRef falls back to a single-shot open-emit-complete.
 */
function orchestrate(
  event: HookEvent,
  base: HttpSinkOptions,
  raw: unknown,
  env: NodeJS.ProcessEnv,
  now: number,
): EventSink | null {
  const ref = event.sessionRef;
  const persist = (info: { id: string; ingestToken: string }): void => {
    if (ref) {
      saveSession(ref, { aerSessionId: info.id, ingestToken: info.ingestToken, baseUrl: base.baseUrl, createdAt: now }, env);
    }
  };

  if (!ref) {
    // No correlation id: single-shot session (open + emit + complete on close).
    return createHttpSink(base);
  }

  const stored = loadSession(ref, env, now);

  if (event.kind === 'session_end') {
    if (stored) {
      deleteSession(ref, env);
      return createHttpSink({ ...base, session: { id: stored.aerSessionId, ingestToken: stored.ingestToken }, completeOnClose: true });
    }
    return createHttpSink(base); // never saw a start; single-shot
  }

  if (stored) {
    // Attach to the running AER session; do not complete it here.
    return createHttpSink({ ...base, session: { id: stored.aerSessionId, ingestToken: stored.ingestToken }, completeOnClose: false });
  }

  // First event for this harness session (session_start, or a tool event that
  // arrived before any start): open one, persist it, keep it running.
  return createHttpSink({ ...base, completeOnClose: false, onOpen: persist });
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
    const sink = orchestrate(event, base, payload, env, now);
    if (!sink) return;
    emitHookEvent(event, sink, { raw: payload, env });
    await sink.close();
  } catch {
    /* fail open: never surface an error to the harness */
  }
}

/** Entry point: run the hook but never exceed the hard timeout, then exit 0. */
export async function main(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  deps: RunHookDeps = {},
): Promise<void> {
  const timeout = new Promise<void>((resolve) => {
    const t = setTimeout(resolve, HARD_TIMEOUT_MS);
    // Do not keep the event loop alive solely for the timeout.
    if (typeof t.unref === 'function') t.unref();
  });
  try {
    await Promise.race([runHook(argv, env, deps), timeout]);
  } catch {
    /* fail open */
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
