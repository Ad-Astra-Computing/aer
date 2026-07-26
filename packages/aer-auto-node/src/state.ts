// Process-global holder for the active collector. Kept behind a Symbol on
// globalThis so multiple copies of the package (duplicate installs, ESM/CJS
// interop) still share one collector and don't double-register.

import type { Collector } from './collector.js';

const KEY = Symbol.for('adastra.aer.auto.collector');

interface GlobalSlot { [KEY]?: Collector | null }

export function setActiveCollector(collector: Collector | null): void {
  (globalThis as GlobalSlot)[KEY] = collector;
}

export function getActiveCollector(): Collector | null {
  return (globalThis as GlobalSlot)[KEY] ?? null;
}
