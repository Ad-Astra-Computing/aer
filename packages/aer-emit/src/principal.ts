// Principal resolution, matching @adastracomputing/aer-auto-node semantics.
//
// A Principal is the human or service on whose behalf an agent ran. It is always
// optional. `id` is capped at 128 chars and `display` at 64 to match the AER API,
// so an oversized value is rejected up front rather than by the server. `kind`
// defaults to 'user' when absent or not one of the closed set, so a misconfigured
// kind never blocks a run or ships an invalid value.

export type PrincipalKind = 'user' | 'service' | 'ci';

export interface Principal {
  id: string;
  kind?: PrincipalKind | undefined;
  display?: string | undefined;
}

const PRINCIPAL_KINDS: readonly PrincipalKind[] = ['user', 'service', 'ci'];

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Build a Principal from raw values. Returns undefined when no id is given, or when
 * the id is longer than 128 chars. `kind` defaults to 'user' when absent or invalid.
 * An oversized `display` (>64) is dropped but the principal is still returned.
 */
export function resolvePrincipal(id: unknown, kind: unknown, display: unknown): Principal | undefined {
  const pid = asString(id);
  if (!pid || pid.length > 128) return undefined;
  const pkind = PRINCIPAL_KINDS.includes(kind as PrincipalKind) ? (kind as PrincipalKind) : 'user';
  const pdisplay = asString(display);
  return {
    id: pid,
    kind: pkind,
    ...(pdisplay && pdisplay.length <= 64 ? { display: pdisplay } : {}),
  };
}
