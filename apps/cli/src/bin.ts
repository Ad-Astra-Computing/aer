#!/usr/bin/env node
/**
 * The published entry point. Nothing here decides whether to run.
 *
 * This file exists only to be executed, and the package exposes no `main` or
 * `exports`, so it cannot be imported. An entry-point guard in the shipped
 * bundle could therefore only ever produce one outcome: deciding wrongly that
 * it was not the entry point, then exiting 0 in silence. That is exactly what
 * shipped in 0.1.1, where the guard compared `import.meta.url` against an
 * unresolved `process.argv[1]` and was false for every installed copy.
 *
 * The guard belongs in tests, which import `main` directly. It does not belong
 * in the artifact.
 */
import { main } from './main.js';
import { formatCliError } from './cli-error.js';

main().catch((err: unknown) => {
  console.error(formatCliError(err));
  process.exit(1);
});
