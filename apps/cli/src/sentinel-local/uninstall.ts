import { readPushCredential, deletePushCredential, deletePerInstallKey } from './state.js';
import { detectSourcePlatform, controllerFor, type ExecFn, type SourcePlatform } from './platform-process.js';
import type { SentinelLocalApiClient } from './http-client.js';

export interface UninstallOptions {
  apiClient: SentinelLocalApiClient;
  execFn: ExecFn;
  env?: Record<string, string | undefined>;
  /** Whether to also erase this device's observations server-side. When
   * omitted, the caller (main.ts) is expected to have already resolved this
   * interactively or via a --erase flag - this function never prompts. */
  erase: boolean;
  platform?: SourcePlatform;
  print?: (line: string) => void;
}

export async function runUninstall(opts: UninstallOptions): Promise<void> {
  const print = opts.print ?? ((l: string) => console.log(l));
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? detectSourcePlatform(process.platform);
  if (!platform) throw new Error('sentinel-local is only supported on Linux and macOS');

  const credential = readPushCredential(env);

  const controller = controllerFor(platform, opts.execFn, env);
  try {
    await controller.disableAndStop();
  } catch {
    // A missing/broken unit must never block the rest of uninstall.
  }

  if (credential) {
    await opts.apiClient.disable(credential.sensorSourceId);
    if (opts.erase) {
      if (!credential.expectedClaimId) {
        print('Cannot erase observations: no claim id was captured at registration. Re-run install, or ask an operator to erase via the admin release route.');
      } else {
        await opts.apiClient.eraseObservations(credential.sensorSourceId, credential.expectedClaimId);
        print('Erased this device\'s stored observations.');
      }
    }
  } else {
    print('No push credential found; nothing to disable server-side.');
  }

  // device-id is NEVER deleted by uninstall (shared with other collectors).
  deletePushCredential(env);
  deletePerInstallKey(env);
  print('Uninstalled the local-poll daemon.');
}
