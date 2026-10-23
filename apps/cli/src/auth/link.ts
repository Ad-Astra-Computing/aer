// `aer link`: writes/updates aer.config.json in the current directory using
// the tenant from `aer login`. Never writes the API key: aer.config.json is
// non-secret identity, read by every other command via aer.config.json + the
// credentials file, not by holding a key itself.

import { join } from 'node:path';
import { getCredential } from './credentials-store.js';
import { resolveBaseUrl } from './resolve.js';
import { sanitizeForTerminal } from '../cli-error.js';
import { assertUncompressed } from '../http-guard.js';

export interface LinkOptions {
  agentId?: string | undefined;
  createAgentName?: string | undefined;
  envId?: string | undefined;
  baseUrlFlag?: string | undefined;
}

export interface AgentSummary {
  agent_id: string;
  name?: string;
}

export interface EnvironmentSummary {
  environment_id: string;
  session_count: number;
}

export interface LinkDeps {
  cwd: string;
  env: Record<string, string | undefined>;
  defaultBaseUrl: string;
  fetchImpl?: typeof fetch;
  isTTY: boolean;
  print: (line: string) => void;
  printErr: (line: string) => void;
  readFile: (path: string) => string | null;
  writeFile: (path: string, content: string) => void;
  randomUUID: () => string;
  /** Only invoked on a TTY with neither --agent nor --create-agent given. */
  promptChoice?: (agents: AgentSummary[]) => Promise<number>;
  /** Only invoked on a TTY when --env was not given and no env_id is already
   * stored in aer.config.json. Nothing issues or registers an environment id;
   * this just offers the ones already seen so a user names a real place
   * ("laptop", "ci") instead of getting a silently-minted uuid. A blank
   * return falls back to the generated id, same as not wiring this at all. */
  promptEnvName?: (environments: EnvironmentSummary[]) => Promise<string>;
}

function trimUrl(u: string): string {
  return u.replace(/\/+$/, '');
}

const RESPONSE_TEXT_CAP = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Truncated, control-character-free response text: an error body is
 * untrusted and unbounded server output, never printed raw. */
async function safeResponseText(res: Response): Promise<string> {
  try {
    return sanitizeForTerminal(await res.text(), RESPONSE_TEXT_CAP);
  } catch {
    return '';
  }
}

async function createAgent(baseUrl: string, apiKey: string, name: string, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(`${trimUrl(baseUrl)}/v1/agents`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  await assertUncompressed(res);
  if (!res.ok) throw new Error(`could not create agent "${name}" (HTTP ${res.status}): ${await safeResponseText(res)}`);
  const body = (await res.json()) as { agent_id?: string };
  if (!body.agent_id || !UUID_RE.test(body.agent_id)) {
    throw new Error('agent create response did not include a valid agent_id');
  }
  return body.agent_id;
}

async function listAgents(baseUrl: string, apiKey: string, fetchImpl: typeof fetch): Promise<AgentSummary[]> {
  const res = await fetchImpl(`${trimUrl(baseUrl)}/v1/agents`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  await assertUncompressed(res);
  if (!res.ok) throw new Error(`could not list agents (HTTP ${res.status}): ${await safeResponseText(res)}`);
  const body = (await res.json()) as { agents?: AgentSummary[] };
  return body.agents ?? [];
}

async function listEnvironments(baseUrl: string, apiKey: string, fetchImpl: typeof fetch): Promise<EnvironmentSummary[]> {
  const res = await fetchImpl(`${trimUrl(baseUrl)}/v1/environments`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  await assertUncompressed(res);
  if (!res.ok) throw new Error(`could not list environments (HTTP ${res.status}): ${await safeResponseText(res)}`);
  const body = (await res.json()) as { environments?: unknown };
  const rows = Array.isArray(body.environments) ? body.environments : [];
  return rows
    .filter((r): r is { environment_id: unknown; session_count: unknown } => !!r && typeof r === 'object')
    .filter((r) => typeof r.environment_id === 'string')
    .map((r) => ({ environment_id: r.environment_id as string, session_count: Number(r.session_count) || 0 }));
}

function readExistingConfig(deps: LinkDeps): Record<string, unknown> {
  const raw = deps.readFile(join(deps.cwd, 'aer.config.json'));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function cmdLink(opts: LinkOptions, deps: LinkDeps): Promise<number> {
  const existing = readExistingConfig(deps);
  const existingBaseUrl = typeof existing['base_url'] === 'string' ? (existing['base_url'] as string) : undefined;
  const baseUrl = resolveBaseUrl({
    env: deps.env,
    cfg: { ...(existingBaseUrl ? { base_url: existingBaseUrl } : {}) },
    baseUrlFlag: opts.baseUrlFlag,
    defaultBaseUrl: deps.defaultBaseUrl,
  });

  const cred = getCredential(baseUrl, deps.env);
  if (!cred) {
    deps.printErr(`Not logged in to ${baseUrl}. Run \`aer login\` first.`);
    return 1;
  }

  const fetchImpl = deps.fetchImpl ?? fetch;

  // Resolved before the agent (which --create-agent can mutate server state
  // for), so an aborted or rejected env prompt never leaves an orphan agent
  // created with nothing to show for it.
  const existingEnvId = typeof existing['env_id'] === 'string' ? (existing['env_id'] as string) : undefined;
  let envId: string;
  if (opts.envId) {
    envId = opts.envId;
  } else if (existingEnvId) {
    envId = existingEnvId;
  } else if (deps.isTTY && deps.promptEnvName) {
    let environments: EnvironmentSummary[] = [];
    try {
      environments = await listEnvironments(baseUrl, cred.api_key, fetchImpl);
    } catch {
      // A read-only convenience list; a failure here should not block
      // linking, same spirit as the generated-id fallback below.
      environments = [];
    }
    try {
      const named = (await deps.promptEnvName(environments)).trim();
      envId = named || deps.randomUUID();
    } catch (err) {
      deps.printErr(err instanceof Error ? err.message : String(err));
      return 1;
    }
  } else {
    envId = deps.randomUUID();
  }

  let agentId: string;

  try {
    if (opts.agentId) {
      agentId = opts.agentId;
    } else if (opts.createAgentName) {
      agentId = await createAgent(baseUrl, cred.api_key, opts.createAgentName, fetchImpl);
    } else if (deps.isTTY) {
      const agents = await listAgents(baseUrl, cred.api_key, fetchImpl);
      if (agents.length === 0) {
        deps.printErr('No agents exist for this tenant yet. Use --create-agent <name> to make one.');
        return 1;
      }
      if (!deps.promptChoice) {
        deps.printErr('aer link needs --agent <id> or --create-agent <name>.');
        return 64;
      }
      const index = await deps.promptChoice(agents);
      const chosen = agents[index];
      if (index < 0 || !chosen) {
        deps.printErr('No agent selected.');
        return 1;
      }
      agentId = chosen.agent_id;
    } else {
      deps.printErr('aer link needs --agent <id> or --create-agent <name> when not running in a terminal.');
      return 64;
    }
  } catch (err) {
    deps.printErr(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const merged: Record<string, unknown> = {
    ...existing,
    tenant_id: cred.tenant_id,
    agent_id: agentId,
    env_id: envId,
    base_url: baseUrl,
  };
  delete merged['api_key'];

  deps.writeFile(join(deps.cwd, 'aer.config.json'), JSON.stringify(merged, null, 2) + '\n');
  deps.print(`Wrote aer.config.json: tenant ${cred.tenant_id}, agent ${agentId}, env ${envId}.`);
  return 0;
}
