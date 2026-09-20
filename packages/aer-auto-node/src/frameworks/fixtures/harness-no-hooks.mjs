// Node 20 has no registerHooks. The cache scan must carry on alone.
const { startFrameworkObserver } = await import('../../../dist/frameworks/observe.js');
const observer = startFrameworkObserver({ registerHooks: undefined });
await import(process.argv[2]);
process.stdout.write(`OBSERVED:${JSON.stringify(observer.observed())}\n`);
