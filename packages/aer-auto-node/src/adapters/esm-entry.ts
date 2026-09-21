// The ESM entry of an already-resolved package, read from its package.json.
//
// Needed because `import()` resolves a bare specifier against THIS module, not
// against the app, and `import.meta.resolve`'s parent argument is not usable
// without a flag. So the CJS resolution locates the package and this picks the
// ESM file inside it.

function pick(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  // A condition can nest, most specifically `types` before `default`.
  return pick(rec['import'] ?? rec['module'] ?? rec['default']);
}

/** A package-relative ESM entry path, or undefined when there is none. */
export function esmEntryOf(pkg: unknown): string | undefined {
  if (typeof pkg !== 'object' || pkg === null || Array.isArray(pkg)) return undefined;
  const rec = pkg as Record<string, unknown>;

  let entry: string | undefined;
  const exp = rec['exports'];
  if (typeof exp === 'object' && exp !== null && !Array.isArray(exp)) {
    const root = (exp as Record<string, unknown>)['.'];
    entry = pick(root !== undefined ? root : exp);
  }
  if (entry === undefined && typeof rec['module'] === 'string') entry = rec['module'];
  if (entry === undefined && rec['type'] === 'module' && typeof rec['main'] === 'string') {
    entry = rec['main'];
  }
  if (entry === undefined) return undefined;

  // Joined onto the package directory, so it must stay inside it.
  if (entry.startsWith('/') || entry.includes('..')) return undefined;
  return entry;
}
