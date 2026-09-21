// The whole path: collector loads first (as --import does), the agent imports
// a framework, and the collector.report carries it.
const { createCollector } = await import(process.env.AER_COLLECTOR_MODULE);
const { resolveConfig } = await import(process.env.AER_CONFIG_MODULE);
const events = [];
const transport = {
  async open() {},
  async emit(batch) { events.push(...batch); },
  async complete() {},
  async abort() {},
};
await import(process.argv[2]);
const collector = createCollector(resolveConfig({ env: {} }), {
  transport, patchInstaller: false, adapterInstaller: false,
});
collector.capture({ event_type: 'http.requested', payload: { host: 'x', method: 'GET' } });
await collector.session.flush();
const report = events.find((e) => e.event_type === 'collector.report');
process.stdout.write(`REPORT:${JSON.stringify(report?.payload?.frameworks ?? null)}\n`);
