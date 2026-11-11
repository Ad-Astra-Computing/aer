// Deterministic, local-only observation identity (design doc §5.4):
//   observation_id = HMAC(per-install key, "aer-local-obs-v1\0" + 4tuple + firstSeenTick)
//
// The local port and exact tick never leave the machine in plaintext; the id
// is deterministic across a retry (same connection, same tick -> same id),
// so a crash-and-replay of the outbox never double-reports under a new id.

import { createHmac } from 'node:crypto';
import type { ConnectionTuple } from './types.js';

const DOMAIN_PREFIX = 'aer-local-obs-v1\0';

function tupleString(t: ConnectionTuple): string {
  return `${t.localAddress}:${t.localPort}->${t.remoteAddress}:${t.remotePort}`;
}

/**
 * `firstSeenTick` is the poll-tick index (or epoch ms, truncated to the poll
 * interval) at which this connection was first observed - part of what makes
 * the id deterministic for a given connection without re-deriving it from a
 * live clock on every tick.
 */
export function computeObservationId(perInstallKey: Buffer, tuple: ConnectionTuple, firstSeenTick: number): string {
  const message = DOMAIN_PREFIX + tupleString(tuple) + String(firstSeenTick);
  return createHmac('sha256', perInstallKey).update(message, 'utf8').digest('hex');
}
