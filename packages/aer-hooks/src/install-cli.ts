#!/usr/bin/env node
// aer-hooks — the installer CLI.
//
//   aer-hooks install claude-code|codex [--dir <path>]
//   aer-hooks uninstall claude-code|codex [--dir <path>]
//   aer-hooks status [--dir <path>]
//
// Unlike the per-event `aer-hook` binary, this is an interactive operator command:
// it prints to stdout and exits non-zero on a usage error or an aborted write.

import { install, uninstall, status, type Harness } from './install.js';
import { isInvokedDirectly } from './invoked-directly.js';

interface Parsed {
  cmd: string | undefined;
  harness: Harness | undefined;
  dir: string | undefined;
}

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  let dir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === '--dir') {
      dir = argv[i + 1];
      i++;
    } else if (a.startsWith('--dir=')) {
      dir = a.slice('--dir='.length);
    } else {
      positional.push(a);
    }
  }
  const cmd = positional[0];
  const rawHarness = positional[1];
  const harness =
    rawHarness === 'claude-code' || rawHarness === 'codex' ? rawHarness : undefined;
  return { cmd, harness, dir };
}

const USAGE = `aer-hooks — wire AER recording into a coding harness

Usage:
  aer-hooks install <claude-code|codex> [--dir <path>]
  aer-hooks uninstall <claude-code|codex> [--dir <path>]
  aer-hooks status [--dir <path>]
`;

export async function run(
  argv: string[] = process.argv.slice(2),
  out: (s: string) => void = (s) => process.stdout.write(s + '\n'),
  err: (s: string) => void = (s) => process.stderr.write(s + '\n'),
): Promise<number> {
  const { cmd, harness, dir } = parseArgs(argv);
  const opts = dir !== undefined ? { dir } : {};

  try {
    if (cmd === 'install') {
      if (!harness) {
        err('install requires a harness: claude-code | codex');
        return 2;
      }
      const r = await install(harness, opts);
      if (r.added.length > 0) {
        out(`Wired AER hooks for ${harness} into ${r.path}`);
        out(`  added: ${r.added.join(', ')}`);
        if (r.backupPath) out(`  backup: ${r.backupPath}`);
      } else {
        out(`AER hooks already present for ${harness} in ${r.path}; nothing to do.`);
      }
      return 0;
    }

    if (cmd === 'uninstall') {
      if (!harness) {
        err('uninstall requires a harness: claude-code | codex');
        return 2;
      }
      const r = await uninstall(harness, opts);
      if (r.removed.length > 0) {
        out(`Removed AER hooks for ${harness} from ${r.path}`);
        out(`  removed from: ${r.removed.join(', ')}`);
        if (r.backupPath) out(`  backup: ${r.backupPath}`);
      } else {
        out(`No AER hooks found for ${harness} in ${r.path}; nothing to do.`);
      }
      return 0;
    }

    if (cmd === 'status') {
      const entries = await status(opts);
      for (const e of entries) {
        const state = !e.exists
          ? 'no config'
          : e.wiredEvents.length > 0
            ? `wired: ${e.wiredEvents.join(', ')}`
            : 'config present, no AER hooks';
        out(`${e.harness.padEnd(12)} ${e.path}  (${state})`);
      }
      return 0;
    }

    out(USAGE);
    return cmd === undefined ? 0 : 2;
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

// Must resolve symlinks: npm invokes this through the `aer-hooks`
// node_modules/.bin symlink, whose name never matched the old
// endsWith('install-cli.js') check, so `install`/`uninstall` were silent no-ops.
if (isInvokedDirectly(import.meta.url)) {
  void run().then((code) => process.exit(code));
}
