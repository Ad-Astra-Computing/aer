// Bundle the CLI into a single self-contained ESM file for npm publishing.
// The CLI's only runtime dependencies are workspace packages (@aer/schemas,
// @adastracomputing/aer-verify, @adastracomputing/aer-auto-node/commitment);
// inlining them means the published @adastracomputing/aer has no unpublished
// deps and `npx @adastracomputing/aer init` resolves with nothing else to fetch.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: 'dist/main.js',
  // Node built-ins stay external automatically on platform:node; everything
  // else (the workspace packages) is inlined. The entry hashbang is preserved.
  logLevel: 'info',
});
