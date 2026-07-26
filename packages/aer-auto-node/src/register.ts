// Side-effecting entry point. Load via:
//   node --import @adastracomputing/aer-auto-node/register agent.js
// or NODE_OPTIONS="--import @adastracomputing/aer-auto-node/register".
//
// All real work (and the AER_DISABLE kill switch) lives in bootstrap().
import { bootstrap } from './bootstrap.js';

bootstrap();
