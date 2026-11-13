import { unlinkSync } from 'node:fs';
import {
  readPushCredential, deletePushCredential, deletePerInstallKey,
  deleteSentinelLocalConfig, deleteOutbox,
} from './state.js';
import { detectSourcePlatform, controllerFor, systemdUnitPath, launchdPlistPath, type ExecFn, type SourcePlatform } from './platform-process.js';
import { SentinelLocalApiError, type SentinelLocalApiClient } from './http-client.js';

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

function removeIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone: nothing to do */
  }
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
    try {
      await opts.apiClient.disable(credential.sensorSourceId);
    } catch (err) {
      // A failed server-side disable (a 403 from an admin reassignment, or
      // no network) must never block local cleanup below: leaving the
      // unit/plist behind is worse, since launchd's KeepAlive resurrects
      // the daemon at next login with nothing left able to disable it.
      print(`Warning: could not disable this sensor server-side (${err instanceof Error ? err.message : String(err)}). Continuing with local cleanup.`);
    }
    if (opts.erase) {
      // §10.4: the claim id is NEVER cached from install time - fetch the
      // CURRENT one now. An admin reassignment since install mints a new
      // claim; a stale cached one must 409, not silently "succeed" against
      // the wrong (now-previous) owner's data.
      const sensors = await opts.apiClient.getSensors();
      const row = sensors.find((s) => s.sensor_source_id === credential.sensorSourceId);
      if (!row || !row.claim_id) {
        print('Cannot erase observations: no current claim id found for this sensor (it may already be released). Ask an operator to erase via the admin release route if needed.');
      } else {
        try {
          await opts.apiClient.eraseObservations(credential.sensorSourceId, row.claim_id);
          print('Erased this device\'s stored observations.');
        } catch (err) {
          if (err instanceof SentinelLocalApiError && err.status === 409) {
            // A real error, surfaced to the caller - never a silent retry.
            // This device was reassigned to a different claim since the
            // claim id above was fetched (a race, or an admin acted in
            // between): erasing now would be against the wrong owner.
            throw new Error(
              'erase refused (409 device_release_conflict): this device was reassigned to a ' +
              'different owner. Ask an operator, or re-run `aer sentinel-local uninstall --erase` ' +
              'to retry against the current owner.',
            );
          }
          throw err;
        }
      }
    }
  } else {
    print('No push credential found; nothing to disable server-side.');
  }

  // Remove every artifact this sensor's `install` created: the unit/plist
  // (an un-deleted launchd plist with RunAtLoad+KeepAlive resurrects the
  // daemon at next login even after uninstall), the push credential, the
  // install-time config (sentinel-local.json - `status` reads this to
  // decide `installed`), and the outbox. device-id is NEVER deleted (shared
  // with other collectors).
  const unitOrPlistPath = platform === 'linux' ? systemdUnitPath(env) : launchdPlistPath(env);
  removeIfExists(unitOrPlistPath);
  deletePushCredential(env);
  deletePerInstallKey(env);
  deleteSentinelLocalConfig(env);
  deleteOutbox(env);
  print('Uninstalled the local-poll daemon.');
}
