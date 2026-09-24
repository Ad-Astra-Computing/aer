// Node before 22.15 has no registerHooks. The cache scan must carry on alone.
const { startFrameworkObserver } = await import(process.env.AER_OBSERVE_MODULE);
const observer = startFrameworkObserver({ registerHooks: undefined });
await import(process.argv[2]);
process.stdout.write(`OBSERVED:${JSON.stringify(observer.observed())}\n`);
