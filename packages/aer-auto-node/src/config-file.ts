import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Load aer.config.json from a directory. Returns null if absent or unparseable
// (the collector then runs on env + defaults; `doctor` flags missing identity).
export function loadConfigFile(
  cwd: string,
  readFile: (p: string) => string = (p) => readFileSync(p, 'utf8'),
): Record<string, unknown> | null {
  try {
    const raw = readFile(join(cwd, 'aer.config.json'));
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
