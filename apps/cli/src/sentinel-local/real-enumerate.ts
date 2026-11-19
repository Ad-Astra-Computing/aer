// Wires the platform backends (linux-backend.ts / macos-backend.ts) into the
// NormalizedCandidate[] shape poll-tick.ts consumes, using the real
// filesystem/subprocess calls. This is the one module daemon.ts's real
// `run-daemon` entry point depends on; every backend module underneath it
// stays independently unit-testable with injected deps.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { enumerateLinuxCandidates, readLinuxArgv, readLinuxCwd } from './linux-backend.js';
import { enumerateMacCandidates } from './macos-backend.js';
import { classifyProcess } from './classify.js';
import { KNOWN_INTERPRETERS } from './interpreter-tool-table.js';
import type { NormalizedCandidate } from './poll-tick.js';

const execFileAsync = promisify(execFile);

async function macExecFn(cmd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

export async function enumerateLinux(): Promise<NormalizedCandidate[]> {
  const candidates = enumerateLinuxCandidates();
  const out: NormalizedCandidate[] = [];
  for (const candidate of candidates) {
    // Only read /proc/<pid>/cmdline for interpreter basenames, where argv is
    // needed to find the real tool (classify.ts ignores argv for every
    // other basename anyway). A browser process's cmdline routinely
    // contains URLs; the consent disclosure promises it is never read.
    const argv = KNOWN_INTERPRETERS.has(candidate.comm)
      ? (readLinuxArgv(candidate.pid) ?? [candidate.comm])
      : [candidate.comm];
    const classification = classifyProcess(candidate.comm, argv);
    if (!classification || classification.processClass !== 'known_ai_cli' || !classification.tool) continue;
    const cwd = readLinuxCwd(candidate.pid);
    out.push({
      tool: classification.tool,
      cwd,
      sockets: candidate.sockets.map((s) => ({
        localAddress: s.localAddress,
        localPort: s.localPort,
        remoteAddress: s.remoteAddress,
        remotePort: s.remotePort,
      })),
    });
  }
  return out;
}

export async function enumerateMacos(): Promise<NormalizedCandidate[]> {
  const candidates = await enumerateMacCandidates(macExecFn);
  const out: NormalizedCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.classification || candidate.classification.processClass !== 'known_ai_cli' || !candidate.classification.tool) continue;
    out.push({
      tool: candidate.classification.tool,
      cwd: candidate.cwd,
      sockets: candidate.sockets.map((s) => ({
        localAddress: s.localAddress,
        localPort: s.localPort,
        remoteAddress: s.remoteAddress,
        remotePort: s.remotePort,
      })),
    });
  }
  return out;
}

export function enumerateForPlatform(platform: NodeJS.Platform = process.platform): () => Promise<NormalizedCandidate[]> {
  if (platform === 'linux') return enumerateLinux;
  if (platform === 'darwin') return enumerateMacos;
  throw new Error('sentinel-local is only supported on Linux and macOS');
}
