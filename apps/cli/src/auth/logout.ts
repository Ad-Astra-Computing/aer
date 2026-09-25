// `aer logout`: revoke the CLI-minted key server-side (POST /v1/cli/logout,
// Bearer auth), then remove the local credentials-file entry regardless of
// whether the server call succeeded. A stored key that `aer login` did not
// create (source != cli_device) comes back 403 not_a_cli_key: the local
// entry is still removed, but the server key itself is left alone, since
// only the account owner can decide to revoke a key aer login never made.

import { getCredential, removeCredential, listCredentialBaseUrls } from './credentials-store.js';

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

/** Best-effort server-side revoke of a CLI key. Never throws: a caller using
 * this for cleanup (login re-run, an orphaned mint) only needs to know
 * whether it worked, not why it did not. */
export async function revokeCliKey(baseUrl: string, apiKey: string, fetchImpl?: typeof fetch): Promise<boolean> {
  const f = fetchImpl ?? fetch;
  try {
    const res = await f(`${trimUrl(baseUrl)}/v1/cli/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function logoutOne(baseUrl: string, deps: LogoutDeps): Promise<void> {
  const cred = getCredential(baseUrl, deps.env);
  if (!cred) {
    deps.print(`Not logged in to ${baseUrl}.`);
    return;
  }

  const f = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`${trimUrl(baseUrl)}/v1/cli/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cred.api_key}` },
    });
  } catch {
    removeCredential(baseUrl, deps.env);
    deps.printErr(`Could not reach ${baseUrl}; removed the local credentials anyway.`);
    return;
  }

  if (res.ok) {
    removeCredential(baseUrl, deps.env);
    deps.print(`Logged out of ${baseUrl}.`);
    return;
  }

  if (res.status === 403 && (await readErrorCode(res)) === 'not_a_cli_key') {
    removeCredential(baseUrl, deps.env);
    deps.print(`That key for ${baseUrl} was not created by \`aer login\`; removed it locally. Revoke it in Settings if you no longer want it active.`);
    return;
  }

  removeCredential(baseUrl, deps.env);
  deps.printErr(`Logout request to ${baseUrl} failed (HTTP ${res.status}); removed the local credentials anyway.`);
}

export async function cmdLogout(opts: { baseUrl: string; all?: boolean }, deps: LogoutDeps): Promise<number> {
  if (opts.all) {
    const urls = listCredentialBaseUrls(deps.env);
    if (urls.length === 0) {
      deps.print('Not logged in anywhere.');
      return 0;
    }
    for (const url of urls) await logoutOne(url, deps);
    return 0;
  }

  const cred = getCredential(opts.baseUrl, deps.env);
  if (!cred) {
    deps.print(`Not logged in to ${opts.baseUrl}.`);
    // P3: a repo pointing at a different base URL than the one the person is
    // actually logged into otherwise looks identical to "not logged in at
    // all", with no hint that anything is stored elsewhere.
    const others = listCredentialBaseUrls(deps.env).filter((u) => u !== opts.baseUrl);
    if (others.length > 0) {
      deps.print(`Logged in elsewhere: ${others.join(', ')}. Use --base-url <url> or --all.`);
    }
    return 0;
  }

  await logoutOne(opts.baseUrl, deps);
  return 0;
}
