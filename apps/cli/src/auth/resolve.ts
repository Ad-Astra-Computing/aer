// Resolution order for every tenant command: flag, then env
// (AER_TENANT_API_KEY / AER_API_KEY), then aer.config.json, then the
// credentials file `aer login` wrote. An explicit env key always wins over
// a stored one.

import { getCredential, isExpired } from './credentials-store.js';

export interface ProjectConfigLike {
  tenant_id?: string;
  agent_id?: string;
  env_id?: string;
  base_url?: string;
}

export interface ResolveAuthInput {
  env: Record<string, string | undefined>;
  cfg: ProjectConfigLike;
  baseUrlFlag?: string | undefined;
  apiKeyFlag?: string | undefined;
  defaultBaseUrl: string;
}

export type AuthSource = 'flag' | 'env' | 'credentials' | 'none';
export type BaseUrlSource = 'flag' | 'env' | 'cfg' | 'default';

export interface ResolvedBaseUrl {
  baseUrl: string;
  source: BaseUrlSource;
}

export interface ResolvedAuth {
  baseUrl: string;
  apiKey?: string | undefined;
  tenantId?: string | undefined;
  source: AuthSource;
  /** Set only when the credentials-file entry is present but past expires_at. */
  expired?: boolean;
  /**
   * Set (with a ready-to-print message) when the API key came from a flag or
   * the environment but the base URL came only from a cloned repo's
   * aer.config.json and differs from the default: sending a real credential
   * to a host an untrusted checkout chose is refused rather than attempted.
   * Callers must check this before using `apiKey`.
   */
  baseUrlMismatch?: string;
}

export function resolveBaseUrlWithSource(
  input: Pick<ResolveAuthInput, 'env' | 'cfg' | 'baseUrlFlag' | 'defaultBaseUrl'>,
): ResolvedBaseUrl {
  if (input.baseUrlFlag) return { baseUrl: input.baseUrlFlag, source: 'flag' };
  if (input.env['AER_BASE_URL']) return { baseUrl: input.env['AER_BASE_URL'] as string, source: 'env' };
  if (input.cfg.base_url) return { baseUrl: input.cfg.base_url, source: 'cfg' };
  return { baseUrl: input.defaultBaseUrl, source: 'default' };
}

export function resolveBaseUrl(input: Pick<ResolveAuthInput, 'env' | 'cfg' | 'baseUrlFlag' | 'defaultBaseUrl'>): string {
  return resolveBaseUrlWithSource(input).baseUrl;
}

function mismatchMessage(baseUrl: string, defaultBaseUrl: string): string {
  return `Refusing to send your API key to ${baseUrl}, taken from aer.config.json in this directory: it differs from the default ${defaultBaseUrl}. If you mean to use this API, set AER_BASE_URL=${baseUrl} to confirm.`;
}

export function resolveAuth(input: ResolveAuthInput): ResolvedAuth {
  const { baseUrl, source: baseUrlSource } = resolveBaseUrlWithSource(input);
  const untrustedBaseUrl = baseUrlSource === 'cfg' && baseUrl !== input.defaultBaseUrl;

  if (input.apiKeyFlag) {
    return {
      baseUrl,
      apiKey: input.apiKeyFlag,
      tenantId: input.env['AER_TENANT_ID'] || input.cfg.tenant_id,
      source: 'flag',
      ...(untrustedBaseUrl ? { baseUrlMismatch: mismatchMessage(baseUrl, input.defaultBaseUrl) } : {}),
    };
  }

  const envKey = input.env['AER_TENANT_API_KEY'] || input.env['AER_API_KEY'];
  if (envKey) {
    return {
      baseUrl,
      apiKey: envKey,
      tenantId: input.env['AER_TENANT_ID'] || input.cfg.tenant_id,
      source: 'env',
      ...(untrustedBaseUrl ? { baseUrlMismatch: mismatchMessage(baseUrl, input.defaultBaseUrl) } : {}),
    };
  }

  // The credentials file is keyed by (and only ever read for) the resolved
  // base URL itself, so there is no cross-host leak risk here even when that
  // URL came from aer.config.json: a stored entry only exists if the person
  // ran `aer login` against this exact host.
  const cred = getCredential(baseUrl, input.env);
  if (cred) {
    return {
      baseUrl,
      apiKey: cred.api_key,
      tenantId: cred.tenant_id,
      source: 'credentials',
      expired: isExpired(cred),
    };
  }

  return { baseUrl, source: 'none' };
}
