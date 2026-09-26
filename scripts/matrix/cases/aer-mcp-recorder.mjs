/**
 * aer-mcp-recorder, driven through its installed bin exactly as a harness
 * would run it: a stdio MCP server wrapped by the proxy, with the same
 * JSON-RPC input fed to the server directly for comparison.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canaries, assertNoCanaries } from '../lib/harness.mjs';
import { deadPort } from '../lib/sink.mjs';

const PKG = '@adastracomputing/aer-mcp-recorder';

/**
 * A minimal line-delimited stdio MCP server. It answers initialize,
 * tools/list and tools/call deterministically (no clocks, no randomness), so
 * two runs over the same input must produce identical bytes. It exits with
 * the code given as its first argument once stdin ends.
 */
const SERVER = `
import { createInterface } from 'node:readline';
const exitCode = Number(process.argv[2] ?? 0);
const resultText = process.env.MX_RESULT ?? 'ok';
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mx-server', version: '9.9.9' } } });
  } else if (m.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'lookup', description: 'lookup', inputSchema: { type: 'object' } }] } });
  } else if (m.method === 'tools/call') {
    const isError = m.params?.name === 'fail';
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: resultText + ':' + JSON.stringify(m.params?.arguments ?? {}) }], isError } });
  } else {
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } });
  }
});
rl.on('close', () => process.exit(exitCode));
`;

function input(cn) {
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mx-client', version: '1.0.0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lookup', arguments: { query: cn.args, secret: cn.secret, limit: 5 } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'fail', arguments: { path: cn.path } } },
    { jsonrpc: '2.0', id: 5, method: 'nope/unknown' },
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

function setup(c, cn) {
  const dir = c.tmp('mcp-');
  const server = join(dir, 'server.mjs');
  writeFileSync(server, SERVER);
  return { dir, server, input: input(cn) };
}

function recEnv(c, home, baseUrl, extra = {}) {
  return c.env(home, {
    AER_API_KEY: `mx_key_${randomUUID()}`,
    AER_TENANT_ID: randomUUID(),
    AER_AGENT_ID: randomUUID(),
    AER_ENV_ID: randomUUID(),
    AER_BASE_URL: baseUrl,
    MX_RESULT: extra.MX_RESULT,
    AER_CLOSE_TIMEOUT_MS: extra.AER_CLOSE_TIMEOUT_MS,
  });
}

async function direct(c, s, home, code, cn) {
  return c.run(process.execPath, [s.server, String(code)], {
    cwd: s.dir,
    env: c.env(home, { MX_RESULT: cn.result }),
    input: s.input,
    timeoutMs: 20_000,
  });
}

export default function register(registry) {
  const t = registry.suite('aer-mcp-recorder', PKG);

  t.case('proxied stdout is byte-identical to the unproxied server, sink up', async (c) => {
    const cn = canaries('REC');
    const s = setup(c, cn);
    const home = c.home();
    const sink = await c.sink();
    const plain = await direct(c, s, home, 0, cn);
    c.assert.exit(plain, 0, 'direct server');
    const proxied = await c.bin('aer-mcp-recorder', ['--', process.execPath, s.server, '0'], {
      cwd: s.dir, env: recEnv(c, home, sink.url, { MX_RESULT: cn.result }), input: s.input, timeoutMs: 30_000,
    });
    c.assert.exit(proxied, 0, 'proxied server');
    c.assert.ok(plain.stdoutBuf.length > 0, 'direct server produced no output');
    c.assert.ok(Buffer.compare(plain.stdoutBuf, proxied.stdoutBuf) === 0,
      `proxied stdout differs from direct (${plain.stdoutBuf.length} vs ${proxied.stdoutBuf.length} bytes)`);
    c.assert.ok(sink.find('POST', '/v1/sessions').length === 1, `expected one session open, saw ${sink.find('POST', '/v1/sessions').length}`);
    c.assert.ok(sink.find('POST', /\/complete$/).length === 1, 'session was not completed');
  });

  t.case('proxied stdout is byte-identical with the sink down, exit 0, no hang', async (c) => {
    const cn = canaries('REC');
    const s = setup(c, cn);
    const home = c.home();
    const port = await deadPort();
    const plain = await direct(c, s, home, 0, cn);
    const proxied = await c.bin('aer-mcp-recorder', ['--', process.execPath, s.server, '0'], {
      cwd: s.dir, env: recEnv(c, home, `http://127.0.0.1:${port}`, { MX_RESULT: cn.result }), input: s.input, timeoutMs: 30_000,
    });
    c.assert.ok(!proxied.timedOut, 'proxy hung with the sink down');
    c.assert.exit(proxied, 0, 'proxied server with sink down');
    c.assert.ok(Buffer.compare(plain.stdoutBuf, proxied.stdoutBuf) === 0, 'proxied stdout differs from direct with the sink down');
    c.note(`sink-down run took ${proxied.ms} ms; stderr: ${proxied.stderr.trim().slice(0, 200) || '(empty)'}`);
  });

  t.case('proxied stdout is byte-identical and nothing is sent when unconfigured', async (c) => {
    const cn = canaries('REC');
    const s = setup(c, cn);
    const home = c.home();
    const plain = await direct(c, s, home, 0, cn);
    const proxied = await c.bin('aer-mcp-recorder', ['--', process.execPath, s.server, '0'], {
      cwd: s.dir, env: c.env(home, { MX_RESULT: cn.result }), input: s.input, timeoutMs: 30_000,
    });
    c.assert.exit(proxied, 0, 'unconfigured proxy');
    c.assert.ok(Buffer.compare(plain.stdoutBuf, proxied.stdoutBuf) === 0, 'unconfigured proxied stdout differs');
  });

  for (const code of [3, 42]) {
    t.case(`child exit code ${code} is preserved, sink up and down`, async (c) => {
      const cn = canaries('REC');
      const s = setup(c, cn);
      const home = c.home();
      const sink = await c.sink();
      const up = await c.bin('aer-mcp-recorder', ['--', process.execPath, s.server, String(code)], {
        cwd: s.dir, env: recEnv(c, home, sink.url), input: s.input, timeoutMs: 30_000,
      });
      c.assert.exit(up, code, 'sink up');
      const port = await deadPort();
      const down = await c.bin('aer-mcp-recorder', ['--', process.execPath, s.server, String(code)], {
        cwd: s.dir, env: recEnv(c, home, `http://127.0.0.1:${port}`), input: s.input, timeoutMs: 30_000,
      });
      c.assert.exit(down, code, 'sink down');
    });
  }

  t.case('a child killed by a signal reports 128 + signal, never 0', async (c) => {
    const dir = c.tmp('sig-');
    const script = join(dir, 'die.mjs');
    writeFileSync(script, "process.stdin.resume(); setTimeout(() => process.kill(process.pid, 'SIGTERM'), 50);\n");
    const r = await c.bin('aer-mcp-recorder', ['--', process.execPath, script], { cwd: dir, env: c.env(c.home()), timeoutMs: 20_000 });
    c.assert.exit(r, 143, 'signal death');
  });

  t.case('a missing command exits 127 with one stderr line, sink up or not', async (c) => {
    const sink = await c.sink();
    for (const env of [c.env(c.home()), recEnv(c, c.home(), sink.url)]) {
      const r = await c.bin('aer-mcp-recorder', ['--', '/nonexistent/mx-no-such-binary', '--mx-arg'], { env, input: '', timeoutMs: 20_000 });
      c.assert.ok(!r.timedOut, 'hung on a missing command');
      c.assert.exit(r, 127, 'missing command');
      const lines = r.stderr.trim().split('\n');
      c.assert.equal(lines.length, 1, `stderr lines: ${r.stderr.trim()}`);
      c.assert.includes(lines[0], '/nonexistent/mx-no-such-binary', 'names the command');
      c.assert.excludes(r.stderr, '--mx-arg', 'printed an argument');
    }
  });

  t.case('a command that is not executable exits 126', async (c) => {
    const dir = c.tmp('noexec-');
    const file = join(dir, 'server.sh');
    writeFileSync(file, '#!/bin/sh\necho hi\n', { mode: 0o644 });
    const r = await c.bin('aer-mcp-recorder', ['--', file], { env: c.env(c.home()), input: '', timeoutMs: 20_000 });
    c.assert.exit(r, 126, 'non-executable command');
    c.assert.includes(r.stderr, file, 'names the command');
  });

  t.case('a clean exit whose record cannot be flushed in time exits 70 with one line', async (c) => {
    // The sink holds /complete open far past AER_CLOSE_TIMEOUT_MS. The wrapped
    // server exited 0, but the record may be incomplete, so the proxy must
    // not report a clean success.
    const cn = canaries('REC');
    const s = setup(c, cn);
    const home = c.home();
    const sink = await c.sink();
    sink.fault({ method: 'POST', path: /\/complete$/, delayMs: 20_000, status: 200 });
    const plain = await direct(c, s, home, 0, cn);
    const r = await c.bin('aer-mcp-recorder', ['--', process.execPath, s.server, '0'], {
      cwd: s.dir, env: recEnv(c, home, sink.url, { MX_RESULT: cn.result, AER_CLOSE_TIMEOUT_MS: '1500' }), input: s.input, timeoutMs: 30_000,
    });
    c.assert.exit(r, 70, 'exit after a timed-out flush');
    c.assert.ok(r.ms < 15_000, `took ${r.ms} ms; the close budget was 1500 ms`);
    c.assert.includes(r.stderr, 'may be incomplete', 'diagnostic');
    c.assert.ok(Buffer.compare(plain.stdoutBuf, r.stdoutBuf) === 0, 'proxied stdout differs');
    // A failing child still wins over the flush verdict.
    const failing = await c.bin('aer-mcp-recorder', ['--', process.execPath, s.server, '3'], {
      cwd: s.dir, env: recEnv(c, home, sink.url, { AER_CLOSE_TIMEOUT_MS: '1500' }), input: s.input, timeoutMs: 30_000,
    });
    c.assert.exit(failing, 3, 'child exit code with a timed-out flush');
  });

  t.case('bodies-off: argument values and result content never reach the sink', async (c) => {
    const cn = canaries('REC');
    const s = setup(c, cn);
    const home = c.home();
    const sink = await c.sink();
    const r = await c.bin('aer-mcp-recorder', ['--', process.execPath, s.server, '0'], {
      cwd: s.dir, env: recEnv(c, home, sink.url, { MX_RESULT: cn.result }), input: s.input, timeoutMs: 30_000,
    });
    c.assert.exit(r, 0, 'proxy');
    // The canaries really were in the stream the proxy saw.
    c.assert.includes(r.stdout, cn.result, 'server result in the forwarded stream');
    assertNoCanaries(sink.allText(), cn);
    c.assert.excludes(sink.allText(), cn.path, 'path argument value');
    const events = sink.events();
    const started = events.filter((e) => e.event_type === 'tool.started');
    const completed = events.filter((e) => e.event_type === 'tool.completed');
    c.assert.equal(started.length, 2, 'tool.started count');
    c.assert.equal(completed.length, 2, 'tool.completed count');
    const lookup = started.find((e) => e.payload?.tool === 'lookup');
    c.assert.ok(lookup, 'no tool.started for lookup');
    c.assert.equal(JSON.stringify([...(lookup.payload.arg_keys ?? [])].sort()), JSON.stringify(['limit', 'query', 'secret']), 'arg_keys');
    const fail = completed.find((e) => e.payload?.tool === 'fail');
    c.assert.equal(fail?.payload?.is_error, true, 'is_error on the failing call');
  });

  t.case('collector version in the record equals the package version', async (c) => {
    const cn = canaries('REC');
    const s = setup(c, cn);
    const home = c.home();
    const sink = await c.sink();
    const r = await c.bin('aer-mcp-recorder', ['--', process.execPath, s.server, '0'], {
      cwd: s.dir, env: recEnv(c, home, sink.url), input: s.input, timeoutMs: 30_000,
    });
    c.assert.exit(r, 0, 'proxy');
    const want = c.install.version(PKG);
    const report = sink.events().find((e) => e.event_type === 'mcp.recorder.report');
    c.assert.ok(report, 'no mcp.recorder.report event');
    c.assert.equal(report.payload?.recorder?.version, want, 'mcp.recorder.report recorder.version');
    c.assert.equal(report.payload?.recorder?.name, PKG, 'mcp.recorder.report recorder.name');
    const open = sink.find('POST', '/v1/sessions')[0];
    c.assert.equal(open?.json?.agent_version, `mcp-recorder/${want}`, 'default agent_version on session open');
    for (const e of sink.events()) c.assert.equal(e.source_type, 'wrapper', `source_type of ${e.event_type}`);
  });

  t.case('--version and -V print the version even with a command after them', async (c) => {
    const want = c.install.version(PKG);
    for (const args of [['--version'], ['-V'], ['--version', '--', 'node']]) {
      const r = await c.bin('aer-mcp-recorder', args, { env: c.env(c.home()), timeoutMs: 20_000 });
      c.assert.exit(r, 0, args.join(' '));
      c.assert.equal(r.stdout.trim(), want, args.join(' '));
    }
  });

  t.case('no arguments prints usage and exits 2', async (c) => {
    const r = await c.bin('aer-mcp-recorder', [], { env: c.env(c.home()), timeoutMs: 20_000 });
    c.assert.exit(r, 2, 'no arguments');
    c.assert.includes(r.stderr, 'Usage', 'usage on stderr');
  });
}
