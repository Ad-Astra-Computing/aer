// `pause`/`resume`: LOCAL daemon stop/start only. Never calls any server
// route - the server's `enabled` column is untouched by these, by design
// (design doc: pause/resume is a client-only concept).

import { detectSourcePlatform, controllerFor, type ExecFn, type SourcePlatform } from './platform-process.js';

export interface PauseResumeOptions {
  execFn: ExecFn;
  env?: Record<string, string | undefined>;
  platform?: SourcePlatform;
}

export async function runPause(opts: PauseResumeOptions): Promise<void> {
  const platform = opts.platform ?? detectSourcePlatform(process.platform);
  if (!platform) throw new Error('sentinel-local is only supported on Linux and macOS');
  await controllerFor(platform, opts.execFn, opts.env ?? process.env).stop();
}

export async function runResume(opts: PauseResumeOptions): Promise<void> {
  const platform = opts.platform ?? detectSourcePlatform(process.platform);
  if (!platform) throw new Error('sentinel-local is only supported on Linux and macOS');
  await controllerFor(platform, opts.execFn, opts.env ?? process.env).start();
}
