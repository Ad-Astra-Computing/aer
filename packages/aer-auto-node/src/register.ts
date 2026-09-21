// Side-effecting entry point. Load via:
//   node --import @adastracomputing/aer-auto-node/register agent.js
// or NODE_OPTIONS="--import @adastracomputing/aer-auto-node/register".
//
// All real work (and the AER_DISABLE kill switch) lives in bootstrap().
import { bootstrap } from './bootstrap.js';

// `--import` fully awaits this module, top-level await included, before the
// application entry loads. Awaiting the async adapter pass here is what makes
// the ESM copy of a dual-published SDK patched before any call can be made.
await bootstrap()?.ready;
