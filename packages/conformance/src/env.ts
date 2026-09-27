// A child environment with nothing of the developer's machine in it.
//
// These tests spawn agents that read AER_* configuration. Inheriting the
// ambient environment made them pass for the wrong reason on a machine that
// happened to have AER_ENV_ID set, and pointed one run at the real API. The
// environment a conformance test asserts against has to be the one it states.

const AER_PREFIX = 'AER_';
// Set by an AI coding agent's tool shell. The collector stays off under them,
// so a suite run from such a shell would fail for a reason that is not the
// code under test.
const AGENT_SHELL_MARKERS = new Set(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']);

/** Every non-AER variable a child still needs, plus the ones given here. */
export function cleanEnv(vars: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith(AER_PREFIX) && !AGENT_SHELL_MARKERS.has(k) && v !== undefined) out[k] = v;
  }
  return { ...out, ...vars };
}
