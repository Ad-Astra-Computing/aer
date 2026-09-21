// One id shared by every collector in a run.
//
// A process that spawns worker threads gets a collector per thread, and each
// signs its own record. Nothing joined them, so a reader saw several
// unrelated records for one run.

import { randomBytes } from 'node:crypto';
import { isMainThread, threadId } from 'node:worker_threads';

const RUN_ID_ENV = 'AER_RUN_ID';
const RUN_ID = /^[0-9a-f]{32}$/;

/**
 * The run id, minted once and exported so worker threads and child processes
 * inherit it. A value already in the environment is reused, unless it is not
 * one of ours: it comes from an environment we do not control and it ends up
 * in a signed record.
 */
export function resolveRunId(env: NodeJS.ProcessEnv = process.env): string {
  const existing = env[RUN_ID_ENV];
  if (typeof existing === 'string' && RUN_ID.test(existing)) return existing;
  const minted = randomBytes(16).toString('hex');
  try {
    env[RUN_ID_ENV] = minted;
  } catch {
    /* a frozen environment still gets a usable id, just not an inherited one */
  }
  return minted;
}

export interface ThreadIdentity {
  pid: number;
  thread_id: number;
  main_thread: boolean;
}

/** Where this collector sits in the process, so its record can be placed. */
export function threadIdentity(): ThreadIdentity {
  return { pid: process.pid, thread_id: threadId, main_thread: isMainThread };
}
