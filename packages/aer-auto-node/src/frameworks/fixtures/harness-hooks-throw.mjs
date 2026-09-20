// registerHooks present but refusing. Registration failure must not propagate.
const { startFrameworkObserver } = await import('../../../dist/frameworks/observe.js');
const observer = startFrameworkObserver({
  registerHooks: () => { throw new Error('hooks unavailable'); },
});
await import(process.argv[2]);
process.stdout.write(`OBSERVED:${JSON.stringify(observer.observed())}\n`);
