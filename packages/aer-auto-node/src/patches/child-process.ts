// Patch node:child_process spawn/exec/execFile/fork -> process.exec / process.exit.
//
// Records the command basename and a redacted arg count (never the argument
// values). Completion is observed via the ChildProcess 'exit'/'error' events.
// Idempotent, restores originals, never throws into the host.

import cp from 'node:child_process';
import { basename } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { CollectorEvent } from '../session.js';
import { redactArgs } from '../redaction.js';

type Capture = (event: CollectorEvent) => void;

const PATCHED = Symbol.for('adastra.aer.patched.child_process');
interface PatchSlot { [PATCHED]?: { restore: () => void } }
const noop = (): void => undefined;

type CmdKind = 'spawn' | 'exec' | 'execFile' | 'fork';

// A leading `VAR=value` shell env assignment. Skipped when picking the exec
// command token so an inline secret (e.g. `API_KEY=sk-… mybin`) is never
// captured as the command.
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Reentrancy guard: Node's own `exec()` internally invokes
// `module.exports.execFile` under the hood. Once execFile is patched, that
// internal call goes through OUR wrapper too, producing a second
// process.exec capture for the same logical call - and that second capture
// takes the non-exec (array-args) code path, where `basename()` is applied
// to the WHOLE exec command string (so trailing flags/secrets survive) and
// `args[1]` is an options object, not an argv array (so redaction sees
// nothing to redact). A single module-level flag is sufficient because the
// nested execFile call happens SYNCHRONOUSLY inside `original.apply` below
// (Node builds the child_process object before returning), so there is no
// window for a concurrent, unrelated call to slip in between set and clear.
let inWrappedCall = false;

export function installChildProcessPatch(capture: Capture): () => void {
  const slot = globalThis as unknown as PatchSlot;
  if (slot[PATCHED]) return noop;

  const originals = {
    spawn: cp.spawn, exec: cp.exec, execFile: cp.execFile, fork: cp.fork,
  };

  const wrap = (original: (...a: never[]) => unknown, kind: CmdKind) =>
    function wrapped(this: unknown, ...args: unknown[]): unknown {
      if (inWrappedCall) {
        // Nested call from inside another wrapped call (e.g. exec -> execFile
        // internally) - already captured at the outer level. Just pass through.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (original as any).apply(this, args);
      }
      const meta = safeExtract(kind, args);
      const start = Date.now();
      safeCapture(capture, {
        event_type: 'process.exec',
        payload: { command: meta.command, args_redacted: meta.argsRedacted },
      });
      let child: ChildProcess;
      inWrappedCall = true;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        child = (original as any).apply(this, args) as ChildProcess;
      } finally {
        inWrappedCall = false;
      }
      try {
        child.once?.('exit', (code: number | null) => {
          safeCapture(capture, {
            event_type: 'process.exit',
            payload: {
              ...(child.pid !== undefined ? { pid: child.pid } : {}),
              exit_code: code ?? -1,
              duration_ms: Date.now() - start,
            },
          });
        });
        child.once?.('error', () => {
          safeCapture(capture, {
            event_type: 'process.exit',
            payload: { error: true, duration_ms: Date.now() - start },
          });
        });
      } catch {
        // listener attach failure must not break the spawn
      }
      return child;
    };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cp.spawn = wrap(originals.spawn as any, 'spawn') as typeof cp.spawn;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cp.exec = wrap(originals.exec as any, 'exec') as typeof cp.exec;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cp.execFile = wrap(originals.execFile as any, 'execFile') as typeof cp.execFile;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cp.fork = wrap(originals.fork as any, 'fork') as typeof cp.fork;

  const restore = (): void => {
    cp.spawn = originals.spawn;
    cp.exec = originals.exec;
    cp.execFile = originals.execFile;
    cp.fork = originals.fork;
  };
  slot[PATCHED] = { restore };

  return function uninstall(): void {
    const s = (globalThis as unknown as PatchSlot)[PATCHED];
    if (s) s.restore();
    delete (globalThis as unknown as PatchSlot)[PATCHED];
  };
}

interface ExecMeta { command: string; argsRedacted: string }

function safeExtract(kind: CmdKind, args: unknown[]): ExecMeta {
  try {
    const first = typeof args[0] === 'string' ? (args[0] as string) : String(args[0]);
    if (kind === 'exec') {
      // Shell string: the binary is the leading token; everything else is redacted.
      // Skip any leading `VAR=value` env assignments first so their (possibly
      // secret) values never land in `command`.
      const tokens = first.trim().split(/\s+/).filter(Boolean);
      let i = 0;
      while (i < tokens.length && ENV_ASSIGN_RE.test(tokens[i]!)) i += 1;
      const leading = tokens[i];
      const rest = tokens.slice(i + 1);
      return { command: leading ? basename(leading) : 'env', argsRedacted: redactArgs(rest) };
    }
    // spawn / execFile / fork: args[1] is the arg array when present.
    const list = Array.isArray(args[1]) ? (args[1] as string[]) : [];
    return { command: basename(first), argsRedacted: redactArgs(list) };
  } catch {
    return { command: 'unknown', argsRedacted: redactArgs([]) };
  }
}

function safeCapture(capture: Capture, event: CollectorEvent): void {
  try { capture(event); } catch { /* never break the host */ }
}
