// Transparent stdio MCP proxy.
//
// Spawns the real MCP server as a child and wires the byte streams so the harness
// talks to the child as if the proxy were not there. Every byte the harness writes
// reaches the child unchanged and every byte the child writes reaches the harness
// unchanged. child.stderr is passed through untouched.
//
// FAIL-OPEN BYTE TRANSPARENCY: forwarding happens FIRST and independently of
// recording. Parsing and recording run in a try/catch AFTER the bytes are already
// on their way. A recorder or sink that throws on every observe does not affect
// forwarding or the child exit code.

import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { LineSplitter, parseJsonRpc } from './jsonrpc.js';
import type { McpRecorder } from './recorder.js';

/** Minimal shape of a spawned child we depend on. Lets tests inject a fake. */
export interface ProxyChild {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  pid?: number | undefined;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export type SpawnFn = (command: string, args: string[], env?: NodeJS.ProcessEnv) => ProxyChild;

export interface StdioProxyOptions {
  command: string;
  args: string[];
  recorder?: McpRecorder | null;
  env?: NodeJS.ProcessEnv;
  /** Injectable spawn for testing. Defaults to node:child_process spawn. */
  spawn?: SpawnFn;
  /** Injectable parent streams for testing. Default process.stdin/out. */
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  /** Max time (ms) to wait for the recorder to flush on child exit. Default 3000. */
  closeTimeoutMs?: number;
  /** Register process signal handlers. Default true; tests pass false. */
  handleSignals?: boolean;
}

export interface StdioProxyHandle {
  child: ProxyChild;
  /** Resolves with the child's exit code once it has fully exited and recording flushed. */
  done: Promise<number>;
}

const defaultSpawn: SpawnFn = (command, args, env) => {
  const child = nodeSpawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: env ?? process.env,
  }) as ChildProcessWithoutNullStreams;
  return child as unknown as ProxyChild;
};

/**
 * Start the transparent proxy. Returns immediately with a handle whose `done`
 * promise resolves to the child's exit code. The caller (CLI) exits with that code.
 */
export function createStdioProxy(opts: StdioProxyOptions): StdioProxyHandle {
  const spawnFn = opts.spawn ?? defaultSpawn;
  // Annotated: with @types/node >= 26 the raw union of the injected stream and
  // process.stdin has incompatible .on() overloads; the interface type is all we use.
  const parentIn: NodeJS.ReadableStream = opts.stdin ?? process.stdin;
  const parentOut: NodeJS.WritableStream = opts.stdout ?? process.stdout;
  const recorder = opts.recorder ?? null;
  const closeTimeoutMs = opts.closeTimeoutMs ?? 3000;
  const handleSignals = opts.handleSignals ?? true;

  const child = spawnFn(opts.command, opts.args, opts.env);

  const clientSplitter = new LineSplitter();
  const serverSplitter = new LineSplitter();

  // Harness -> child. Forward the raw chunk first, then tee a copy for recording.
  parentIn.on('data', (chunk: Buffer) => {
    try {
      child.stdin.write(chunk);
    } catch {
      /* child stdin may have closed; forwarding failure must not crash us */
    }
    tee(chunk, clientSplitter, (line) => recorder?.observeClientMessage(parseJsonRpc(line)));
  });
  parentIn.on('end', () => {
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
  });
  parentIn.on('error', () => {
    /* a broken parent stdin must not crash the proxy */
  });

  // Child -> harness. Forward the raw chunk first, then tee a copy for recording.
  child.stdout.on('data', (chunk: Buffer) => {
    try {
      parentOut.write(chunk);
    } catch {
      /* ignore */
    }
    tee(chunk, serverSplitter, (line) => recorder?.observeServerMessage(parseJsonRpc(line)));
  });
  child.stdout.on('error', () => {
    /* ignore */
  });

  // stderr passes through untouched (not parsed).
  child.stderr.on('data', (chunk: Buffer) => {
    try {
      process.stderr.write(chunk);
    } catch {
      /* ignore */
    }
  });
  child.stderr.on('error', () => {
    /* ignore */
  });

  child.on('error', () => {
    /* spawn/runtime error; the exit handler resolves done */
  });

  const forwardSignal = (sig: NodeJS.Signals): void => {
    try {
      child.kill(sig);
    } catch {
      /* ignore */
    }
  };
  const onSigint = (): void => forwardSignal('SIGINT');
  const onSigterm = (): void => forwardSignal('SIGTERM');
  if (handleSignals) {
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
  }

  const done = new Promise<number>((resolve) => {
    child.on('exit', (code) => {
      if (handleSignals) {
        process.removeListener('SIGINT', onSigint);
        process.removeListener('SIGTERM', onSigterm);
      }
      const exitCode = code ?? 0;
      // Best-effort, time-bounded recorder flush. Never let it block the exit code.
      void closeRecorder(recorder, closeTimeoutMs).finally(() => resolve(exitCode));
    });
  });

  return { child, done };
}

/** Forward a chunk copy into a splitter and hand complete lines to a sink callback. */
function tee(chunk: Buffer, splitter: LineSplitter, onLine: (line: string) => void): void {
  try {
    const lines = splitter.push(chunk);
    for (const line of lines) {
      if (line.length === 0) continue;
      try {
        onLine(line);
      } catch {
        /* recording is best-effort */
      }
    }
  } catch {
    /* framing must never affect forwarding */
  }
}

async function closeRecorder(recorder: McpRecorder | null, timeoutMs: number): Promise<void> {
  if (!recorder) return;
  try {
    await Promise.race([
      recorder.close(),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } catch {
    /* best-effort */
  }
}
