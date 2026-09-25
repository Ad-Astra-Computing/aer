// `aer logout`: revoke the CLI-minted key server-side (POST /v1/cli/logout,
// Bearer auth), then remove the local credentials-file entry regardless of
// whether the server call succeeded. A stored key that `aer login` did not
// create (source != cli_device) comes back 403 not_a_cli_key: the local
// entry is still removed, but the server key itself is left alone, since
// only the account owner can decide to revoke a key aer login never made.

import { getCredential, removeCredential } from './credentials-store.js';

export interface LogoutDeps {
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  print: (line: string) => void;
  printErr: (line: string) => void;
}

function trimUrl(u: string): string {
  return u.replace(/\/+$/, '');
}

async function readErrorCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : undefined;
  } catch {
    return undefined;
  }
}

export async function cmdLogout(opts: { baseUrl: string }, deps: LogoutDeps): Promise<number> {
  const cred = getCredential(opts.baseUrl, deps.env);
  if (!cred) {
    deps.print(`Not logged in to ${opts.baseUrl}.`);
    return 0;
  }

  const f = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`${trimUrl(opts.baseUrl)}/v1/cli/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cred.api_key}` },
    });
  } catch {
    removeCredential(opts.baseUrl, deps.env);
    deps.printErr('Could not reach the API; removed the local credentials anyway.');
    return 0;
  }

  if (res.ok) {
    removeCredential(opts.baseUrl, deps.env);
    deps.print('Logged out.');
    return 0;
  }

  if (res.status === 403 && (await readErrorCode(res)) === 'not_a_cli_key') {
    removeCredential(opts.baseUrl, deps.env);
    deps.print('That key was not created by `aer login`; removed it locally. Revoke it in Settings if you no longer want it active.');
    return 0;
  }

  removeCredential(opts.baseUrl, deps.env);
  deps.printErr(`Logout request failed (HTTP ${res.status}); removed the local credentials anyway.`);
  return 0;
}
