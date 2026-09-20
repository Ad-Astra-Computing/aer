import { generateText } from 'ai';
const { getActiveCollector } = await import('@adastracomputing/aer-auto-node');
const c = getActiveCollector();
console.log('APP-STARTED');
console.log('ADAPTERS:' + JSON.stringify(c ? [...c.enabledAdapters] : null));
console.log('PATCHES:' + JSON.stringify(c ? [...c.enabledPatches] : null));
