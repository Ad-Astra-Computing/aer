// `aer whoami`: shows what `aer login` stored for a base URL, never the key
// itself. Exits 1 when there is nothing stored, so it is safe to script.

import { getCredential, isExpired } from './credentials-store.js';

export interface WhoamiDeps {
  env: Record<string, string | undefined>;
  now?: () => number;
  print: (line: string) => void;
  printErr: (line: string) => void;
}

const KEY_PREFIX_LEN = 12;

export function cmdWhoami(opts: { baseUrl: string }, deps: WhoamiDeps): number {
  const cred = getCredential(opts.baseUrl, deps.env);
  if (!cred) {
    deps.printErr(`Not logged in to ${opts.baseUrl}. Run \`aer login\`.`);
    return 1;
  }

  const expired = isExpired(cred, deps.now);
  deps.print(`Base URL: ${opts.baseUrl}`);
  deps.print(`Tenant:   ${cred.tenant_id}`);
  deps.print(`Role:     ${cred.role}`);
  deps.print(`Key:      ${cred.api_key.slice(0, KEY_PREFIX_LEN)}...`);
  deps.print(`Expires:  ${cred.expires_at}${expired ? ' (expired, run `aer login` again)' : ''}`);
  return 0;
}
