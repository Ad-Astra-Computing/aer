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

export interface ResolvedAuth {
  baseUrl: string;
  apiKey?: string | undefined;
  tenantId?: string | undefined;
  source: AuthSource;
  /** Set only when the credentials-file entry is present but past expires_at. */
  expired?: boolean;
}

export function resolveBaseUrl(input: Pick<ResolveAuthInput, 'env' | 'cfg' | 'baseUrlFlag' | 'defaultBaseUrl'>): string {
  return input.baseUrlFlag || input.env['AER_BASE_URL'] || input.cfg.base_url || input.defaultBaseUrl;
}

export function resolveAuth(input: ResolveAuthInput): ResolvedAuth {
  const baseUrl = resolveBaseUrl(input);

  if (input.apiKeyFlag) {
    return { baseUrl, apiKey: input.apiKeyFlag, tenantId: input.env['AER_TENANT_ID'] || input.cfg.tenant_id, source: 'flag' };
  }

  const envKey = input.env['AER_TENANT_API_KEY'] || input.env['AER_API_KEY'];
  if (envKey) {
    return { baseUrl, apiKey: envKey, tenantId: input.env['AER_TENANT_ID'] || input.cfg.tenant_id, source: 'env' };
  }

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
