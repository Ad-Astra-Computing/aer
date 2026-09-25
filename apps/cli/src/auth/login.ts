// `aer login`: run the device authorization flow and save the resulting
// tenant key to the local credentials file. See device-login.ts for the wire
// protocol and credentials-store.ts for where the result lands.

import { runDeviceLogin, formatUserCode, sanitizeHostname, DeviceLoginError, type DeviceStartResponse } from './device-login.js';
import { setCredential, credentialsPaths } from './credentials-store.js';

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

  const onPrompt = (start: DeviceStartResponse): void => {
    deps.print('To finish signing in, open this page:');
    deps.print(`  ${start.verification_uri}`);
    deps.print('');
    deps.print('and enter this code (type it; the page will not fill it in for you):');
    deps.print(`  ${formatUserCode(start.user_code)}`);
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

    setCredential(baseUrl, {
      tenant_id: result.tenant_id,
      api_key: result.api_key,
      key_id: result.key_id,
      role: result.role,
      expires_at: result.expires_at,
    }, deps.env);

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
