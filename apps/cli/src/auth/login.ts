// `aer login`: run the device authorization flow and save the resulting
// tenant key to the local credentials file. See device-login.ts for the wire
// protocol and credentials-store.ts for where the result lands.

import { runDeviceLogin, formatUserCode, sanitizeHostname, DeviceLoginError, type DeviceStartResponse } from './device-login.js';
import { setCredential, getCredential, credentialsPaths } from './credentials-store.js';
import { revokeCliKey } from './logout.js';
import { sanitizeForTerminal } from '../cli-error.js';

export interface LoginOptions {
  baseUrlFlag?: string | undefined;
  noBrowser?: boolean;
}

export interface LoginDeps {
  env: Record<string, string | undefined>;
  defaultBaseUrl: string;
  clientVersion: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  print: (line: string) => void;
  printErr: (line: string) => void;
  hostname: () => string;
  hasDisplay: () => boolean;
  openBrowser: (url: string) => void;
}

export async function cmdLogin(opts: LoginOptions, deps: LoginDeps): Promise<number> {
  const baseUrl = opts.baseUrlFlag || deps.env['AER_BASE_URL'] || deps.defaultBaseUrl;
  const hostname = sanitizeHostname(deps.hostname());

  // P2-3: a repeated `aer login` for the same host otherwise piles up live
  // CLI keys server-side (eventually hitting cli_device_key_limit_reached).
  // Best-effort: a failure here never blocks the new login.
  const existing = getCredential(baseUrl, deps.env);
  if (existing) {
    await revokeCliKey(baseUrl, existing.api_key, deps.fetchImpl);
  }

  const onPrompt = (start: DeviceStartResponse): void => {
    deps.print('To finish signing in, open this page:');
    deps.print(`  ${sanitizeForTerminal(start.verification_uri)}`);
    deps.print('');
    deps.print('and enter this code (type it; the page will not fill it in for you):');
    deps.print(`  ${sanitizeForTerminal(formatUserCode(start.user_code))}`);
    deps.print('');
    if (!opts.noBrowser && deps.hasDisplay()) {
      try {
        deps.openBrowser(start.verification_uri);
      } catch {
        /* opening a browser is a convenience only; never block on it */
      }
    }
    deps.print('Waiting for approval...');
  };

  try {
    const result = await runDeviceLogin({
      baseUrl,
      client: `aer-cli/${deps.clientVersion}`,
      hostname,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      onPrompt,
    });

    try {
      setCredential(baseUrl, {
        tenant_id: result.tenant_id,
        api_key: result.api_key,
        key_id: result.key_id,
        role: result.role,
        expires_at: result.expires_at,
      }, deps.env);
    } catch (storeErr) {
      // P2-2: a key that was minted but never saved is orphaned and live on
      // the server with nothing local pointing at it. Revoke it rather than
      // leave it dangling, then report both failures.
      const revoked = await revokeCliKey(baseUrl, result.api_key, deps.fetchImpl);
      deps.printErr(`Could not save credentials: ${storeErr instanceof Error ? storeErr.message : String(storeErr)}`);
      deps.printErr(revoked
        ? 'The newly minted key was revoked.'
        : 'Could not revoke the newly minted key either; revoke it manually in Settings.');
      return 1;
    }

    const { file } = credentialsPaths(deps.env);
    deps.print(`Logged in to ${baseUrl} as tenant ${result.tenant_id} (role: ${result.role}).`);
    deps.print(`Credentials saved to ${file}.`);
    return 0;
  } catch (err) {
    if (err instanceof DeviceLoginError) {
      deps.printErr(err.message);
      return 1;
    }
    deps.printErr(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
