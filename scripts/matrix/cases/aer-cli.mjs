/**
 * The `aer` CLI, driven through its installed bin symlink against a per-case
 * capture sink. Every subcommand runs for real: a --help-only smoke once
 * shipped a CLI that exited 0 doing nothing.
 */
import { writeFileSync, readFileSync, existsSync, statSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { canaries, assertNoCanaries, AssertionError } from '../lib/harness.mjs';
import { mintEd25519 } from '../lib/keys.mjs';
import { deadPort } from '../lib/sink.mjs';

const PKG = '@adastracomputing/aer';
const AUTO = '@adastracomputing/aer-auto-node';
const DEFAULT_BASE_URL = 'https://api.aer.run';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Parse the whole of stdout as JSON, or fail the case with the output. */
function parseJson(c, r, what) {
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new AssertionError(`${what}: stdout is not JSON: ${r.stdout.slice(0, 300)} | stderr: ${r.stderr.slice(0, 300)}`);
  }
}

/** A tenant with agents shaped the way the real list endpoint returns them. */
function withTenant(sink, tenantId = randomUUID()) {
  const agents = [
    { agent_id: randomUUID(), tenant_id: tenantId, name: 'matrix-agent-one' },
    { agent_id: randomUUID(), tenant_id: tenantId, name: 'matrix-agent-two' },
  ];
  sink.route('GET', '/v1/agents', (req, res, ctx) => ctx.json(200, { agents }));
  sink.route('POST', '/v1/agents', (req, res, ctx) => {
    const a = { agent_id: randomUUID(), tenant_id: tenantId, name: req.json?.name ?? 'agent' };
    agents.push(a);
    ctx.json(201, a);
  });
  return { tenantId, agents };
}

const bearerOf = (req) => String(req.headers.authorization ?? '').replace(/^Bearer /, '');

/** A throwaway Node project, optionally with the collector installed by npm. */
async function makeProject(c, { install = false, home } = {}) {
  const dir = c.tmp('proj-');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'matrix-project',
    version: '1.0.0',
    private: true,
    type: 'module',
    scripts: { start: 'node agent.js', test: 'node --test' },
  }, null, 2));
  writeFileSync(join(dir, 'agent.js'), 'console.log("agent ran");\n');
  if (install) {
    const npmEnv = c.env(home ?? c.home(), { npm_config_cache: join(dirname(c.install.dir), 'npm-cache') });
    const r = await c.run('npm', ['install', '--no-audit', '--no-fund', c.install.spec(AUTO)], { cwd: dir, env: npmEnv, timeoutMs: 300_000 });
    c.assert.exit(r, 0, `npm install ${AUTO}`);
    const got = JSON.parse(readFileSync(join(dir, 'node_modules', AUTO, 'package.json'), 'utf8')).version;
    c.assert.equal(got, c.install.version(AUTO), 'installed collector version');
  }
  return dir;
}

function writeConfig(dir, cfg) {
  writeFileSync(join(dir, 'aer.config.json'), JSON.stringify({ schema: 'aer.config.v1', ...cfg }, null, 2));
}

/** Write a credentials file the way `aer login` does, for resolution tests. */
function storeCredential(home, baseUrl, cred) {
  const dir = join(home, '.config', 'aer');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'credentials.json');
  const all = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  all[baseUrl.replace(/\/+$/, '')] = {
    tenant_id: randomUUID(),
    key_id: randomUUID(),
    role: 'write',
    expires_at: new Date(Date.now() + 86400_000).toISOString(),
    ...cred,
  };
  writeFileSync(file, JSON.stringify(all, null, 2), { mode: 0o600 });
  return file;
}

/**
 * Build and sign an AER bundle with a fresh test key, canonicalized by the
 * INSTALLED aer-verify. With `commitment`, add a content commitment whose tags
 * the INSTALLED collector's commitment module computes.
 */
async function signedBundle(c, { aerId = randomUUID(), commitment } = {}) {
  const key = mintEd25519();
  const pkcs8 = key.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const r = await c.node(`
    import { canonicalHash, stripIntegrity, signingKeyIdFromPublicKeyHex } from '@adastracomputing/aer-verify';
    import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
    let input = '';
    for await (const ch of process.stdin) input += ch;
    const { pkcs8, aerId, commitment } = JSON.parse(input);
    const priv = createPrivateKey(pkcs8);
    const pubHex = Buffer.from(createPublicKey(priv).export({ format: 'jwk' }).x, 'base64url').toString('hex');
    const kid = await signingKeyIdFromPublicKeyHex(pubHex);
    const bundle = {
      schema: 'aer.v1',
      aer_id: aerId,
      agent_session_id: '${randomUUID()}',
      generated_at: new Date().toISOString(),
      events: [{ event_type: 'process.exec', payload: { command: 'git' } }],
    };
    let expected = null;
    if (commitment) {
      const m = await import('@adastracomputing/aer-auto-node/commitment');
      const k = m.commitmentKeyFromString(commitment.keyHex);
      const canon = m.canonicalizeRequest(commitment.provider, [commitment.request]);
      const promptTag = m.promptCanonTag(k, canon);
      const wireTag = m.wireBodyTag(k, commitment.request);
      bundle.content_commitments = [{ request_ref: 'req-1', kid: m.deriveKid(k), prompt_canon_tag: promptTag, wire: { canon: 'aer-canon.v1', tag: wireTag } }];
      expected = { promptTag, wireTag, kid: m.deriveKid(k) };
    }
    const hash = await canonicalHash(stripIntegrity(bundle));
    const signature = sign(null, Buffer.from(hash, 'hex'), priv).toString('base64');
    bundle.integrity = { hash, signature, signing_key_id: kid, anchored: false };
    console.log(JSON.stringify({ bundle, key: { signing_key_id: kid, sig_alg: 'ed25519', public_key_hex: pubHex }, expected }));
  `, { input: JSON.stringify({ pkcs8, aerId, commitment }) });
  c.assert.exit(r, 0, 'bundle generator');
  return r.json;
}

/** A Claude Code transcript with a canary in every body a transcript carries. */
function transcript(k, sessionId = randomUUID()) {
  const t0 = Date.now();
  const ts = (i) => new Date(t0 + i * 1000).toISOString();
  const lines = [
    { type: 'user', uuid: randomUUID(), sessionId, timestamp: ts(0), message: { role: 'user', content: `please fix it ${k.prompt}` } },
    {
      type: 'assistant', uuid: randomUUID(), sessionId, timestamp: ts(1),
      message: {
        id: 'msg_1', role: 'assistant', model: 'model-matrix-a',
        usage: { input_tokens: 120, output_tokens: 45 },
        content: [
          { type: 'thinking', thinking: `thinking about ${k.prompt}` },
          { type: 'text', text: `I will run ${k.result}` },
          { type: 'tool_use', id: 'tu_bash', name: 'Bash', input: { command: `curl -H "Authorization: Bearer ${k.secret}" https://example.com/${k.args}`, description: k.args } },
          { type: 'tool_use', id: 'tu_fetch', name: 'WebFetch', input: { url: `https://docs.example.org/${k.path}?q=${k.query}`, prompt: k.prompt } },
          { type: 'tool_use', id: 'tu_write', name: 'Write', input: { file_path: '/work/src/app.ts', content: `const x = "${k.file}";` } },
          { type: 'tool_use', id: 'tu_edit', name: 'Edit', input: { file_path: '/work/src/app.ts', old_string: k.file, new_string: k.args } },
          { type: 'tool_use', id: 'tu_read', name: 'Read', input: { file_path: '/work/README.md' } },
          { type: 'tool_use', id: 'tu_grep', name: 'Grep', input: { pattern: k.args, path: '/work' } },
        ],
      },
    },
    {
      type: 'user', uuid: randomUUID(), sessionId, timestamp: ts(2),
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_bash', content: `output ${k.result}`, is_error: false },
          { type: 'tool_result', tool_use_id: 'tu_grep', content: [{ type: 'text', text: k.file }], is_error: true },
        ],
      },
      toolUseResult: { stdout: k.result, file: { content: k.file } },
    },
    { type: 'file-history-snapshot', snapshot: { files: { '/work/src/app.ts': k.file } } },
    { type: 'system', content: `system note ${k.secret}`, timestamp: ts(3) },
  ];
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}

export default function register(registry) {
  const t = registry.suite('aer', PKG);

  // ---- basics ---------------------------------------------------------------

  t.case('no arguments prints usage and exits 64', async (c) => {
    const r = await c.bin('aer', [], { env: c.env(c.home()) });
    c.assert.exit(r, 64, 'aer');
    c.assert.includes(r.stderr, 'Usage:', 'usage text');
  });

  t.case('--help after a command writes nothing and sends nothing', async (c) => {
    const sink = await c.sink();
    const dir = await makeProject(c);
    const home = c.home();
    const env = c.env(home, { AER_BASE_URL: sink.url, AER_TENANT_API_KEY: 'k' });
    for (const args of [['init', '--yes', '--help'], ['login', '--help'], ['agents', 'list', '-h'], ['smoke', '--help']]) {
      const r = await c.bin('aer', args, { cwd: dir, env });
      c.assert.exit(r, 0, `aer ${args.join(' ')}`);
      c.assert.includes(r.stdout, 'Usage:', `aer ${args.join(' ')} stdout`);
    }
    c.assert.ok(!existsSync(join(dir, 'aer.config.json')), 'init --help wrote aer.config.json');
    c.assert.equal(sink.requests.length, 0, 'requests sent while printing help');
  });

  // ---- init -----------------------------------------------------------------

  t.case('init --dry-run --json prints the plan and writes nothing', async (c) => {
    const dir = await makeProject(c);
    const before = readdirSync(dir).sort().join(',');
    const pj = readFileSync(join(dir, 'package.json'), 'utf8');
    const r = await c.bin('aer', ['init', '--dry-run', '--json'], { cwd: dir, env: c.env(c.home()) });
    c.assert.exit(r, 0, 'init --dry-run --json');
    const plan = parseJson(c, r, 'init --dry-run --json');
    c.assert.equal(plan.manifest?.schema, 'aer.integration.v1', 'manifest schema');
    c.assert.equal(JSON.stringify(plan.manifest.entrypoints), '["start"]', 'entrypoints');
    c.assert.equal(plan.manifest.instrumentation.register, `${AUTO}/register`, 'register path');
    c.assert.equal(JSON.stringify(plan.manifest.env_required), '["AER_API_KEY"]', 'env_required');
    const paths = plan.files.map((f) => f.path.split('/').pop()).sort();
    for (const f of ['.env.example', 'AER_INTEGRATION.md', 'AGENTS.md', 'aer.config.json', 'aer.integration.json']) {
      c.assert.ok(paths.includes(f), `plan lacks ${f}: ${paths.join(', ')}`);
    }
    c.assert.ok(plan.files.every((f) => f.action === 'create'), 'fresh project plan should be all create');
    c.assert.equal(plan.scriptChanges[0]?.script, 'start', 'script change');
    c.assert.equal(readdirSync(dir).sort().join(','), before, 'dry run changed the directory');
    c.assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), pj, 'dry run changed package.json');
  });

  t.case('init --dry-run without --json reports on stderr and writes nothing', async (c) => {
    const dir = await makeProject(c);
    const r = await c.bin('aer', ['init', '--dry-run'], { cwd: dir, env: c.env(c.home()) });
    c.assert.exit(r, 0, 'init --dry-run');
    c.assert.includes(r.stderr, 'dry run', 'dry run banner');
    c.assert.equal(r.stdout, '', 'stdout');
    c.assert.ok(!existsSync(join(dir, 'aer.config.json')), 'aer.config.json written by a dry run');
  });

  t.case('init --yes --json wires the project and is idempotent', async (c) => {
    const dir = await makeProject(c);
    const tenant = randomUUID();
    const agent = randomUUID();
    const env = c.env(c.home(), { AER_API_KEY: 'aer_secret_should_not_be_written' });
    const r = await c.bin('aer', ['init', '--yes', '--json', '--tenant', tenant, '--agent', agent], { cwd: dir, env });
    c.assert.exit(r, 0, 'init --yes --json');
    const manifest = parseJson(c, r, 'init --yes --json');
    c.assert.equal(manifest.schema, 'aer.integration.v1', 'manifest schema');
    const cfg = JSON.parse(readFileSync(join(dir, 'aer.config.json'), 'utf8'));
    c.assert.equal(cfg.tenant_id, tenant, 'tenant_id');
    c.assert.equal(cfg.agent_id, agent, 'agent_id');
    c.assert.match(cfg.env_id, UUID_RE, 'generated env_id');
    c.assert.equal(cfg.base_url, DEFAULT_BASE_URL, 'default base_url');
    const onDisk = JSON.parse(readFileSync(join(dir, 'aer.integration.json'), 'utf8'));
    c.assert.equal(JSON.stringify(onDisk), JSON.stringify(manifest), 'aer.integration.json equals the printed manifest');
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    c.assert.equal(pkg.scripts.start, `NODE_OPTIONS="--import ${AUTO}/register" node agent.js`, 'start script');
    c.assert.equal(pkg.scripts.test, 'node --test', 'a non-runnable script must be left alone');
    c.assert.includes(readFileSync(join(dir, '.env.example'), 'utf8'), 'AER_API_KEY=', '.env.example');
    for (const f of readdirSync(dir)) {
      if (f === 'node_modules') continue;
      c.assert.excludes(readFileSync(join(dir, f), 'utf8'), 'aer_secret_should_not_be_written', `${f} contains the API key`);
    }
    const agentsMd = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    const again = await c.bin('aer', ['init', '--yes', '--json'], { cwd: dir, env });
    c.assert.exit(again, 0, 'second init');
    const pkg2 = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    c.assert.equal(pkg2.scripts.start, pkg.scripts.start, 'second init changed the start script');
    c.assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), agentsMd, 'second init changed AGENTS.md');
    c.assert.equal(JSON.parse(readFileSync(join(dir, 'aer.config.json'), 'utf8')).env_id, cfg.env_id, 'second init replaced env_id');
  });

  t.case('init preserves an existing AGENTS.md and appends once', async (c) => {
    const dir = await makeProject(c);
    writeFileSync(join(dir, 'AGENTS.md'), '# Mine\n\nKeep this line.\n');
    const env = c.env(c.home());
    for (let i = 0; i < 2; i++) c.assert.exit(await c.bin('aer', ['init', '--yes'], { cwd: dir, env }), 0, `init run ${i + 1}`);
    const md = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    c.assert.includes(md, 'Keep this line.', 'existing content');
    c.assert.equal(md.split('## AER auto-instrumentation').length - 1, 1, 'AER section count');
  });

  t.case('init rejects a bad --session and a missing --entry', async (c) => {
    const dir = await makeProject(c);
    const env = c.env(c.home());
    const s = await c.bin('aer', ['init', '--yes', '--session', 'tsak'], { cwd: dir, env });
    c.assert.exit(s, 64, 'init --session tsak');
    const e = await c.bin('aer', ['init', '--yes', '--entry', 'nope'], { cwd: dir, env });
    c.assert.nonZero(e, 'init --entry nope');
    c.assert.includes(e.stderr, 'nope', 'error names the entry');
    c.assert.ok(!existsSync(join(dir, 'aer.config.json')), 'a rejected init wrote files');
  });

  // ---- doctor ---------------------------------------------------------------

  t.case('doctor --json exits 1 on a broken setup', async (c) => {
    const dir = await makeProject(c);
    const env = c.env(c.home());
    c.assert.exit(await c.bin('aer', ['init', '--yes'], { cwd: dir, env }), 0, 'init');
    const r = await c.bin('aer', ['doctor', '--json'], { cwd: dir, env, timeoutMs: 60_000 });
    c.assert.exit(r, 1, 'doctor on a placeholder config');
    const rep = parseJson(c, r, 'doctor --json');
    c.assert.equal(rep.ok, false, 'ok');
    const by = Object.fromEntries(rep.checks.map((x) => [x.name, x.ok]));
    c.assert.equal(by.package_installed, false, 'package_installed');
    c.assert.equal(by.register_wired, true, 'register_wired');
    c.assert.equal(by.config_present, false, 'config_present');
    c.assert.equal(by.api_key_present, false, 'api_key_present');
    c.assert.ok(Array.isArray(rep.hooks?.stale_registrations), 'hooks.stale_registrations array');
  });

  t.case('doctor --json exits 1 when the API rejects the key', async (c) => {
    const sink = await c.sink();
    sink.route('GET', '/v1/agents', (req, res, ctx) => ctx.json(401, { error: 'unauthorized' }));
    const home = c.home();
    const dir = await makeProject(c, { install: true, home });
    c.assert.exit(await c.bin('aer', ['init', '--yes', '--tenant', randomUUID(), '--agent', randomUUID()], { cwd: dir, env: c.env(home) }), 0, 'init');
    const r = await c.bin('aer', ['doctor', '--json'], { cwd: dir, env: c.env(home, { AER_API_KEY: 'bad', AER_BASE_URL: sink.url }), timeoutMs: 60_000 });
    c.assert.exit(r, 1, 'doctor with a rejected key');
    const rep = parseJson(c, r, 'doctor --json');
    c.assert.equal(rep.checks.find((x) => x.name === 'tenant auth')?.ok, false, 'tenant auth check');
  });

  t.case('doctor --json exits 0 on a good setup and checks the live API', async (c) => {
    const sink = await c.sink();
    const { tenantId, agents } = withTenant(sink);
    const home = c.home();
    const dir = await makeProject(c, { install: true, home });
    const agent = agents[0].agent_id;
    c.assert.exit(await c.bin('aer', ['init', '--yes', '--tenant', tenantId, '--agent', agent, '--base-url', sink.url], { cwd: dir, env: c.env(home) }), 0, 'init');
    const env = c.env(home, { AER_API_KEY: 'aer_doctor_key', AER_BASE_URL: sink.url });
    const r = await c.bin('aer', ['doctor', '--json'], { cwd: dir, env, timeoutMs: 60_000 });
    c.assert.exit(r, 0, 'doctor');
    const rep = parseJson(c, r, 'doctor --json');
    c.assert.equal(rep.ok, true, 'ok');
    c.assert.equal(rep.checks.find((x) => x.name === 'agent_id')?.ok, true, 'agent_id check');
    c.assert.ok(sink.find('GET', '/readyz').length >= 1, 'doctor did not probe /readyz');
    const authed = sink.find('GET', '/v1/agents');
    c.assert.ok(authed.length >= 1 && authed.every((q) => bearerOf(q) === 'aer_doctor_key'), 'GET /v1/agents with the key');
    const human = await c.bin('aer', ['doctor'], { cwd: dir, env, timeoutMs: 60_000 });
    c.assert.exit(human, 0, 'doctor (human)');
    c.assert.includes(human.stderr, 'OK', 'human verdict');
    c.assert.equal(JSON.stringify(rep.warnings), '[]', 'warnings outside an agent shell');

    // In a Claude Code tool shell the collector stays off: doctor still
    // passes, but says so and names the opt-in.
    const shell = { ...env, CLAUDECODE: '1' };
    const inShell = parseJson(c, await c.bin('aer', ['doctor', '--json'], { cwd: dir, env: shell, timeoutMs: 60_000 }), 'doctor --json in an agent shell');
    c.assert.equal(inShell.ok, true, 'ok in an agent shell');
    c.assert.includes(JSON.stringify(inShell.warnings), 'AER_RECORD_IN_AGENT_SHELL=1', 'agent shell warning');
    const optedIn = parseJson(c, await c.bin('aer', ['doctor', '--json'], { cwd: dir, env: { ...shell, AER_RECORD_IN_AGENT_SHELL: '1' }, timeoutMs: 60_000 }), 'doctor --json opted in');
    c.assert.equal(JSON.stringify(optedIn.warnings), '[]', 'warnings after opting in');
  });

  t.case('doctor refuses to send an env key to a base URL only aer.config.json names', async (c) => {
    const sink = await c.sink();
    const dir = await makeProject(c);
    writeConfig(dir, { tenant_id: randomUUID(), agent_id: randomUUID(), env_id: randomUUID(), base_url: sink.url });
    const r = await c.bin('aer', ['doctor', '--json'], { cwd: dir, env: c.env(c.home(), { AER_API_KEY: 'aer_must_not_leak' }), timeoutMs: 60_000 });
    c.assert.exit(r, 64, 'doctor with an untrusted base URL');
    c.assert.includes(r.stderr, 'Refusing', 'refusal message');
    c.assert.excludes(sink.allText(), 'aer_must_not_leak', 'the key reached the untrusted host');
  });

  // ---- smoke ----------------------------------------------------------------

  t.case('smoke runs an instrumented workload that records to the sink', async (c) => {
    const sink = await c.sink();
    const { tenantId, agents } = withTenant(sink);
    const home = c.home();
    const dir = await makeProject(c, { install: true, home });
    c.assert.exit(await c.bin('aer', ['init', '--yes', '--tenant', tenantId, '--agent', agents[0].agent_id, '--base-url', sink.url], { cwd: dir, env: c.env(home) }), 0, 'init');
    const r = await c.bin('aer', ['smoke'], { cwd: dir, env: c.env(home, { AER_API_KEY: 'aer_smoke_key', AER_BASE_URL: sink.url }), timeoutMs: 90_000 });
    c.assert.exit(r, 0, 'smoke');
    const opens = sink.find('POST', '/v1/sessions');
    c.assert.ok(opens.length >= 1, `smoke opened no session; requests: ${sink.requests.map((q) => `${q.method} ${q.path}`).join(', ')}`);
    c.assert.equal(bearerOf(opens[0]), 'aer_smoke_key', 'session open bearer');
    c.assert.equal(opens[0].json?.tenant_id, tenantId, 'session tenant_id');
    const types = sink.events().map((e) => e.event_type);
    c.assert.ok(types.some((x) => x.startsWith('http.')), `no http event in ${types.join(', ')}`);
    c.assert.ok(sink.find('POST', /\/complete$/).length >= 1, 'no /complete');
    c.note(`smoke recorded: ${types.join(', ')}`);
  });

  t.case('smoke records the subprocess its workload runs', async (c) => {
    // The smoke workload is documented as one fetch plus one subprocess. It
    // runs the subprocess with spawnSync, which the collector does not patch
    // (spawn, exec, execFile and fork only), so no process.exec can appear.
    const sink = await c.sink();
    const { tenantId, agents } = withTenant(sink);
    const home = c.home();
    const dir = await makeProject(c, { install: true, home });
    c.assert.exit(await c.bin('aer', ['init', '--yes', '--tenant', tenantId, '--agent', agents[0].agent_id, '--base-url', sink.url], { cwd: dir, env: c.env(home) }), 0, 'init');
    const r = await c.bin('aer', ['smoke'], { cwd: dir, env: c.env(home, { AER_API_KEY: 'aer_smoke_key', AER_BASE_URL: sink.url }), timeoutMs: 90_000 });
    c.assert.exit(r, 0, 'smoke');
    const types = sink.events().map((e) => e.event_type);
    c.assert.ok(types.includes('process.exec'), `no process.exec event in ${types.join(', ')}`);
  });

  t.case('smoke refuses an untrusted base URL from aer.config.json', async (c) => {
    const sink = await c.sink();
    const home = c.home();
    const dir = await makeProject(c, { install: true, home });
    c.assert.exit(await c.bin('aer', ['init', '--yes', '--tenant', randomUUID(), '--agent', randomUUID(), '--base-url', sink.url], { cwd: dir, env: c.env(home) }), 0, 'init');
    const r = await c.bin('aer', ['smoke'], { cwd: dir, env: c.env(home, { AER_API_KEY: 'aer_must_not_leak' }), timeoutMs: 90_000 });
    c.assert.exit(r, 64, 'smoke with an untrusted base URL');
    c.assert.equal(sink.requests.length, 0, 'requests reached the untrusted host');
  });

  t.case('smoke refuses to run before doctor passes', async (c) => {
    const dir = await makeProject(c);
    const env = c.env(c.home());
    c.assert.exit(await c.bin('aer', ['init', '--yes'], { cwd: dir, env }), 0, 'init');
    const r = await c.bin('aer', ['smoke'], { cwd: dir, env, timeoutMs: 60_000 });
    c.assert.exit(r, 1, 'smoke on an unconfigured project');
    c.assert.includes(r.stderr, 'doctor', 'points at doctor');
  });

  t.case('smoke with only AER_TENANT_API_KEY records or fails, never a silent success', async (c) => {
    // doctor accepts AER_TENANT_API_KEY in place of AER_API_KEY, so smoke
    // proceeds; the collector it launches must then have a key too.
    const sink = await c.sink();
    const { tenantId, agents } = withTenant(sink);
    const home = c.home();
    const dir = await makeProject(c, { install: true, home });
    c.assert.exit(await c.bin('aer', ['init', '--yes', '--tenant', tenantId, '--agent', agents[0].agent_id, '--base-url', sink.url], { cwd: dir, env: c.env(home) }), 0, 'init');
    const r = await c.bin('aer', ['smoke'], { cwd: dir, env: c.env(home, { AER_TENANT_API_KEY: 'aer_tenant_only', AER_BASE_URL: sink.url }), timeoutMs: 90_000 });
    const recorded = sink.find('POST', '/v1/sessions').length > 0;
    c.assert.ok(recorded || r.code !== 0, `smoke exited ${r.code} and reported "${r.stderr.trim().split('\n').pop()}" but nothing reached the API`);
  });

  // ---- ingest ---------------------------------------------------------------

  t.case('ingest posts a JSONL file in batches and counts parse errors', async (c) => {
    const sink = await c.sink();
    const session = randomUUID();
    const token = `ingest_${randomUUID()}`;
    sink.sessions.set(session, { id: session, status: 'running', tokens: [token], body: {}, events: [] });
    const dir = c.tmp();
    const ev = (i) => JSON.stringify({ event_id: randomUUID(), agent_session_id: session, timestamp_observed: new Date().toISOString(), source_type: 'sdk', event_type: 'tool.selected', payload: { tool: `t${i}` } });
    const file = join(dir, 'events.jsonl');
    writeFileSync(file, [ev(1), ev(2), '{not json', '', ev(3)].join('\n'));
    const env = c.env(c.home(), { AER_BASE_URL: sink.url, AER_SESSION_ID: session, AER_INGEST_TOKEN: token, AER_BATCH_SIZE: '2' });
    const r = await c.bin('aer', ['ingest', file], { env });
    c.assert.exit(r, 0, 'ingest');
    const s = parseJson(c, r, 'ingest');
    c.assert.equal(s.accepted, 3, 'accepted');
    c.assert.equal(s.parseErrors, 1, 'parseErrors');
    c.assert.equal(s.batches, 2, 'batches');
    const posts = sink.find('POST', `/v1/sessions/${session}/events`);
    c.assert.equal(posts.length, 2, 'event posts');
    c.assert.ok(posts.every((p) => bearerOf(p) === token), 'ingest token bearer');
    const fromStdin = await c.bin('aer', ['ingest', '-'], { env, input: `${ev(4)}\n` });
    c.assert.exit(fromStdin, 0, 'ingest -');
    c.assert.equal(parseJson(c, fromStdin, 'ingest -').accepted, 1, 'stdin accepted');
  });

  t.case('ingest exits non-zero on a server error and on missing env', async (c) => {
    const sink = await c.sink();
    sink.fault({ path: /\/events$/, status: 500 });
    const dir = c.tmp();
    const file = join(dir, 'e.jsonl');
    writeFileSync(file, `${JSON.stringify({ event_type: 'x' })}\n`);
    const r = await c.bin('aer', ['ingest', file], { env: c.env(c.home(), { AER_BASE_URL: sink.url, AER_SESSION_ID: randomUUID(), AER_INGEST_TOKEN: 't' }) });
    c.assert.exit(r, 1, 'ingest against a 500');
    const m = await c.bin('aer', ['ingest', file], { env: c.env(c.home(), { AER_BASE_URL: sink.url }) });
    c.assert.exit(m, 64, 'ingest without a session');
  });

  // ---- import claude-code ---------------------------------------------------

  t.case('import claude-code is bodies-off and completes the session', async (c) => {
    const sink = await c.sink();
    const k = canaries('CLI');
    const dir = c.tmp();
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, transcript(k));
    const tenant = randomUUID();
    const env = c.env(c.home(), {
      AER_BASE_URL: sink.url, AER_TENANT_API_KEY: 'aer_import_key', AER_TENANT_ID: tenant,
      AER_AGENT_ID: randomUUID(), AER_ENV_ID: randomUUID(),
    });
    const r = await c.bin('aer', ['import', 'claude-code', file], { cwd: dir, env });
    c.assert.exit(r, 0, 'import claude-code');
    const summary = parseJson(c, r, 'import');
    const open = sink.find('POST', '/v1/sessions');
    c.assert.equal(open.length, 1, 'session opens');
    c.assert.equal(bearerOf(open[0]), 'aer_import_key', 'tenant key bearer');
    c.assert.equal(open[0].json.tenant_id, tenant, 'tenant_id');
    c.assert.equal(summary.session_id, sink.sessions.values().next().value.id, 'summary session_id');
    const events = sink.events();
    const types = events.map((e) => e.event_type);
    for (const want of ['llm.completed', 'process.exec', 'http.requested', 'file.written', 'file.opened', 'tool.selected', 'tool.completed', 'process.exit']) {
      c.assert.ok(types.includes(want), `no ${want} in ${types.join(', ')}`);
    }
    c.assert.ok(events.every((e) => e.source_type === 'import'), 'source_type import');
    c.assert.equal(events.find((e) => e.event_type === 'process.exec').payload.command, 'curl', 'command reduced to its executable');
    c.assert.equal(events.find((e) => e.event_type === 'http.requested').payload.host, 'docs.example.org', 'URL reduced to its host');
    c.assert.equal(events.find((e) => e.event_type === 'llm.completed').payload.input_tokens, 120, 'token count');
    c.assert.ok(sink.find('POST', /\/complete$/).length === 1, 'no /complete');
    assertNoCanaries(sink.allText(), k, 'sink');
    assertNoCanaries(r.stdout + r.stderr, k, 'CLI output');
  });

  t.case('import claude-code refuses a file with no session activity', async (c) => {
    const sink = await c.sink();
    const dir = c.tmp();
    const file = join(dir, 'history.jsonl');
    writeFileSync(file, `${JSON.stringify({ display: 'hello', timestamp: Date.now(), project: '/x' })}\n`);
    const env = c.env(c.home(), { AER_BASE_URL: sink.url, AER_TENANT_API_KEY: 'k', AER_TENANT_ID: randomUUID(), AER_AGENT_ID: randomUUID(), AER_ENV_ID: randomUUID() });
    const r = await c.bin('aer', ['import', 'claude-code', file], { cwd: dir, env });
    c.assert.nonZero(r, 'import of prompt history');
    c.assert.equal(sink.find('POST', '/v1/sessions').length, 0, 'a session was opened for an empty file');
  });

  t.case('import claude-code names missing variables and reads ids from aer.config.json', async (c) => {
    const sink = await c.sink();
    const dir = c.tmp();
    const file = join(dir, 's.jsonl');
    writeFileSync(file, transcript(canaries('CLI')));
    const miss = await c.bin('aer', ['import', 'claude-code', file], { cwd: dir, env: c.env(c.home(), { AER_BASE_URL: sink.url, AER_TENANT_API_KEY: 'k' }) });
    c.assert.exit(miss, 64, 'import without ids');
    for (const v of ['AER_TENANT_ID', 'AER_AGENT_ID', 'AER_ENV_ID']) c.assert.includes(miss.stderr, v, 'missing variable named');
    c.assert.equal(sink.requests.length, 0, 'requests sent without ids');
    const agent = randomUUID();
    writeConfig(dir, { tenant_id: randomUUID(), agent_id: agent, env_id: randomUUID() });
    const ok = await c.bin('aer', ['import', 'claude-code', file], { cwd: dir, env: c.env(c.home(), { AER_BASE_URL: sink.url, AER_TENANT_API_KEY: 'k' }) });
    c.assert.exit(ok, 0, 'import with ids from aer.config.json');
    c.assert.equal(sink.find('POST', '/v1/sessions')[0]?.json?.agent_id, agent, 'agent_id from config');
    const nofile = await c.bin('aer', ['import', 'claude-code'], { cwd: dir, env: c.env(c.home()) });
    c.assert.exit(nofile, 64, 'import without a file');
    c.assert.includes(nofile.stderr, '.claude/projects', 'transcript hint');
  });

  // ---- verify, download, badge ---------------------------------------------

  t.case('verify checks hash and signature and fails closed on an unpinned key', async (c) => {
    const sink = await c.sink();
    const { bundle, key } = await signedBundle(c);
    sink.aers.set(bundle.aer_id, { bundle });
    sink.keys.set(key.signing_key_id, key);
    const env = c.env(c.home(), { AER_BASE_URL: sink.url });
    const r = await c.bin('aer', ['verify', bundle.aer_id], { env });
    const res = parseJson(c, r, 'verify');
    c.assert.equal(res.hash_match, true, 'hash_match');
    c.assert.equal(res.signature_valid, true, 'signature_valid');
    // The CLI pins the production AER keys; a test key must not verify.
    c.assert.equal(res.verified, false, 'verified with an unpinned key');
    c.assert.equal(res.reason, 'key_not_pinned', 'reason');
    c.assert.exit(r, 1, 'verify exit');
    c.note('a verified:true verdict needs a production-pinned key; the CLI has no trust-root override, so only the fail-closed path is reachable with a test key');

    const tampered = JSON.parse(JSON.stringify(bundle));
    tampered.aer_id = randomUUID();
    tampered.events[0].payload.command = 'rm';
    sink.aers.set(tampered.aer_id, { bundle: tampered });
    const t2 = await c.bin('aer', ['verify', tampered.aer_id], { env });
    c.assert.exit(t2, 1, 'verify tampered');
    const tr = parseJson(c, t2, 'verify tampered');
    c.assert.equal(tr.hash_match, false, 'tampered hash_match');
    c.assert.equal(tr.verified, false, 'tampered verified');

    const missing = await c.bin('aer', ['verify', randomUUID()], { env });
    c.assert.exit(missing, 1, 'verify of an unknown id');
    c.assert.excludes(missing.stderr, '    at ', 'stack trace printed');
  });

  t.case('download and badge fetch the public bundle without a key', async (c) => {
    const sink = await c.sink();
    const { bundle } = await signedBundle(c);
    sink.aers.set(bundle.aer_id, { bundle });
    sink.route('HEAD', /^\/v1\/aers\/[^/]+\/canonical$/, (req, res, ctx) => {
      res.writeHead(sink.aers.has(decodeURIComponent(req.path.split('/')[3])) ? 200 : 404);
      res.end();
    });
    const env = c.env(c.home(), { AER_BASE_URL: sink.url });
    const d = await c.bin('aer', ['download', bundle.aer_id, '-o', '-'], { env });
    c.assert.exit(d, 0, 'download -o -');
    c.assert.equal(JSON.parse(d.stdout).integrity.hash, bundle.integrity.hash, 'downloaded bundle');
    const dir = c.tmp();
    const f = await c.bin('aer', ['download', bundle.aer_id, '--out', join(dir, 'b.json')], { env });
    c.assert.exit(f, 0, 'download --out');
    c.assert.ok(existsSync(join(dir, 'b.json')), 'downloaded file');
    const b = await c.bin('aer', ['badge', bundle.aer_id], { env });
    c.assert.exit(b, 0, 'badge');
    c.assert.includes(b.stdout, `/v1/aers/${bundle.aer_id}/badge.svg`, 'badge url');
    const nb = await c.bin('aer', ['badge', randomUUID()], { env });
    c.assert.exit(nb, 2, 'badge of an unknown id');
    c.assert.ok(sink.requests.every((q) => !q.headers.authorization), 'public endpoints were sent a credential');
  });

  // ---- commitments verify ---------------------------------------------------

  t.case('commitments verify recomputes tags offline and fails closed on an unpinned key', async (c) => {
    const k = canaries('CMT');
    const keyHex = randomBytes(32).toString('hex');
    const request = { model: 'model-matrix-b', messages: [{ role: 'user', content: k.prompt }] };
    const { bundle, key, expected } = await signedBundle(c, { commitment: { keyHex, provider: 'openai', request } });
    const dir = c.tmp();
    writeFileSync(join(dir, 'bundle.json'), JSON.stringify(bundle));
    writeFileSync(join(dir, 'key.json'), JSON.stringify(key));
    writeFileSync(join(dir, 'requests.json'), JSON.stringify([{ provider: 'openai', request }]));
    const env = c.env(c.home(), { AER_COMMITMENT_KEY: keyHex });
    const r = await c.bin('aer', ['commitments', 'verify', '--requests', join(dir, 'requests.json'), '--bundle', join(dir, 'bundle.json'), '--key', join(dir, 'key.json')], { env });
    const res = parseJson(c, r, 'commitments verify');
    c.assert.equal(res.key_kid, expected.kid, 'key_kid');
    c.assert.equal(res.key_kid_matches_bundle, true, 'kid matches the bundle');
    c.assert.equal(res.results[0].prompt_canon_tag, expected.promptTag, 'recomputed prompt tag');
    c.assert.equal(res.results[0].wire_canon_tag, expected.wireTag, 'recomputed wire tag');
    c.assert.equal(res.bundle_signature.hash_match, true, 'bundle hash_match');
    c.assert.equal(res.bundle_signature.signature_valid, true, 'bundle signature_valid');
    c.assert.equal(res.bundle_verified, false, 'bundle_verified with an unpinned key');
    c.assert.equal(res.results[0].matched, false, 'matched against an untrusted bundle');
    c.assert.exit(r, 1, 'fail-closed exit');
    assertNoCanaries(r.stdout + r.stderr, k, 'CLI output');
    c.assert.excludes(r.stdout + r.stderr, keyHex, 'the commitment key was printed');
    c.note('a matched verdict needs a production-pinned signing key; only the fail-closed path is reachable with a test key');

    const wrong = await c.bin('aer', ['commitments', 'verify', '--requests', join(dir, 'requests.json'), '--bundle', join(dir, 'bundle.json'), '--key', join(dir, 'key.json')], { env: c.env(c.home(), { AER_COMMITMENT_KEY: randomBytes(32).toString('hex') }) });
    c.assert.exit(wrong, 1, 'wrong commitment key');
    c.assert.equal(parseJson(c, wrong, 'wrong key').key_kid_matches_bundle, false, 'wrong key kid');
  });

  t.case('commitments verify refuses without a key source or a commitment key', async (c) => {
    const dir = c.tmp();
    writeFileSync(join(dir, 'bundle.json'), '{}');
    writeFileSync(join(dir, 'requests.json'), '[]');
    const base = ['commitments', 'verify', '--requests', join(dir, 'requests.json'), '--bundle', join(dir, 'bundle.json')];
    const nokey = await c.bin('aer', base, { env: c.env(c.home(), { AER_COMMITMENT_KEY: randomBytes(32).toString('hex') }) });
    c.assert.nonZero(nokey, 'no --key and no AER_BASE_URL');
    c.assert.includes(nokey.stderr, '--key', 'names --key');
    const nocommit = await c.bin('aer', base, { env: c.env(c.home()) });
    c.assert.nonZero(nocommit, 'no AER_COMMITMENT_KEY');
    c.assert.includes(nocommit.stderr, 'AER_COMMITMENT_KEY', 'names the variable');
  });

  // ---- login, whoami, link, logout -----------------------------------------

  t.case('login, whoami, link, a tenant command and logout through the device flow', async (c) => {
    const sink = await c.sink();
    const { agents } = withTenant(sink, sink.device.tenantId);
    const home = c.home();
    const env = c.env(home, { AER_BASE_URL: sink.url });
    const r = await c.bin('aer', ['login', '--no-browser'], { env, timeoutMs: 60_000 });
    c.assert.exit(r, 0, 'login');
    c.assert.includes(r.stdout, 'MXAB-CDEF', 'user code shown');
    c.assert.includes(r.stdout, `${sink.url}/cli/activate`, 'verification URL shown');
    c.assert.excludes(r.stdout, 'code=MXAB', 'prefilled verification_uri_complete shown');
    c.assert.excludes(r.stdout + r.stderr, sink.device.apiKey, 'login printed the key');
    const start = sink.find('POST', '/v1/cli/device')[0];
    c.assert.equal(start.json?.client, `aer-cli/${c.install.version(PKG)}`, 'client version sent');
    const file = join(home, '.config', 'aer', 'credentials.json');
    c.assert.ok(existsSync(file), 'credentials file');
    c.assert.equal(statSync(file).mode & 0o777, 0o600, 'credentials file mode');
    c.assert.equal(statSync(dirname(file)).mode & 0o777, 0o700, 'credentials dir mode');
    const stored = JSON.parse(readFileSync(file, 'utf8'))[sink.url];
    c.assert.equal(stored?.api_key, sink.device.apiKey, 'stored key');

    const who = await c.bin('aer', ['whoami'], { env });
    c.assert.exit(who, 0, 'whoami');
    c.assert.includes(who.stdout, sink.device.tenantId, 'whoami tenant');
    c.assert.includes(who.stdout, sink.device.apiKey.slice(0, 12), 'whoami key prefix');
    c.assert.excludes(who.stdout, sink.device.apiKey, 'whoami printed the whole key');

    const proj = c.tmp('proj-');
    writeFileSync(join(proj, 'aer.config.json'), JSON.stringify({ keep_me: 1 }));
    const link = await c.bin('aer', ['link', '--agent', agents[1].agent_id], { cwd: proj, env });
    c.assert.exit(link, 0, 'link --agent');
    const cfg = JSON.parse(readFileSync(join(proj, 'aer.config.json'), 'utf8'));
    c.assert.equal(cfg.agent_id, agents[1].agent_id, 'linked agent');
    c.assert.equal(cfg.tenant_id, sink.device.tenantId, 'linked tenant');
    c.assert.equal(cfg.keep_me, 1, 'unknown field preserved');
    c.assert.match(cfg.env_id, UUID_RE, 'env_id');
    c.assert.ok(!('api_key' in cfg), 'link wrote the key');
    const created = await c.bin('aer', ['link', '--create-agent', 'made-by-link'], { cwd: proj, env });
    c.assert.exit(created, 0, 'link --create-agent');
    c.assert.equal(JSON.parse(readFileSync(join(proj, 'aer.config.json'), 'utf8')).env_id, cfg.env_id, 'link kept env_id');
    const nontty = await c.bin('aer', ['link'], { cwd: proj, env });
    c.assert.exit(nontty, 64, 'link without --agent outside a terminal');

    const list = await c.bin('aer', ['agents', 'list'], { cwd: proj, env: c.env(home) });
    c.assert.exit(list, 0, 'agents list from stored credentials');
    const lastList = sink.find('GET', '/v1/agents').pop();
    c.assert.equal(bearerOf(lastList), sink.device.apiKey, 'stored key used');

    const out = await c.bin('aer', ['logout'], { env });
    c.assert.exit(out, 0, 'logout');
    const lo = sink.find('POST', '/v1/cli/logout');
    c.assert.equal(lo.length, 1, 'logout requests');
    c.assert.equal(bearerOf(lo[0]), sink.device.apiKey, 'logout bearer');
    c.assert.ok(!(sink.url in JSON.parse(readFileSync(file, 'utf8'))), 'credential still stored after logout');
    c.assert.exit(await c.bin('aer', ['whoami'], { env }), 1, 'whoami after logout');
  });

  t.case('login a second time revokes the previous key; a denied login stores nothing', async (c) => {
    const sink = await c.sink();
    const home = c.home();
    const env = c.env(home, { AER_BASE_URL: sink.url });
    c.assert.exit(await c.bin('aer', ['login', '--no-browser'], { env, timeoutMs: 60_000 }), 0, 'first login');
    const first = sink.device.apiKey;
    sink.device.apiKey = `aer_cli_${randomUUID().replace(/-/g, '')}`;
    sink.device.polls = 0;
    c.assert.exit(await c.bin('aer', ['login', '--no-browser'], { env, timeoutMs: 60_000 }), 0, 'second login');
    const revokes = sink.find('POST', '/v1/cli/logout');
    c.assert.equal(revokes.length, 1, 'revocations');
    c.assert.equal(bearerOf(revokes[0]), first, 'the previous key was revoked');

    const home2 = c.home();
    sink.device.deny = true;
    const denied = await c.bin('aer', ['login', '--no-browser'], { env: c.env(home2, { AER_BASE_URL: sink.url }), timeoutMs: 60_000 });
    c.assert.exit(denied, 1, 'denied login');
    c.assert.includes(denied.stderr, 'denied', 'denial message');
    c.assert.ok(!existsSync(join(home2, '.config', 'aer', 'credentials.json')), 'a denied login stored a credential');
  });

  t.case('login refuses a non-https verification URL from the server', async (c) => {
    const sink = await c.sink();
    sink.route('POST', '/v1/cli/device', (req, res, ctx) => ctx.json(200, {
      device_code: 'dc', user_code: 'ABCD-EFGH', verification_uri: 'http://phish.example/cli', expires_in: 60, interval: 1,
    }));
    const r = await c.bin('aer', ['login', '--no-browser'], { env: c.env(c.home(), { AER_BASE_URL: sink.url }), timeoutMs: 30_000 });
    c.assert.exit(r, 1, 'login with an http verification URL');
    c.assert.excludes(r.stdout, 'phish.example', 'the URL was shown');
    c.assert.equal(sink.find('POST', '/v1/cli/device/token').length, 0, 'polled after refusing');
  });

  t.case('logout with the API down removes the local credential anyway', async (c) => {
    const home = c.home();
    const url = `http://127.0.0.1:${await deadPort()}`;
    const file = storeCredential(home, url, { api_key: 'aer_cli_dead' });
    const r = await c.bin('aer', ['logout'], { env: c.env(home, { AER_BASE_URL: url }), timeoutMs: 30_000 });
    c.assert.exit(r, 0, 'logout with the API down');
    c.assert.ok(!(url in JSON.parse(readFileSync(file, 'utf8'))), 'credential still stored');
  });

  // ---- tenant commands ------------------------------------------------------

  t.case('agents, sessions, findings, aers, baseline and audit commands', async (c) => {
    const sink = await c.sink();
    const { tenantId, agents } = withTenant(sink);
    const sid = randomUUID();
    sink.sessions.set(sid, { id: sid, status: 'completed', tokens: [], body: {}, events: [] });
    const aerId = randomUUID();
    sink.route('GET', /^\/v1\/aers\/[^/]+$/, (req, res, ctx) => ctx.json(200, { aer_id: aerId, verification_status: 'verified' }));
    sink.route('GET', /^\/v1\/agents\/[^/]+\/baseline$/, (req, res, ctx) => ctx.json(200, { baseline: { version: 1 } }));
    sink.route('POST', /^\/v1\/agents\/[^/]+\/baseline\/retrain$/, (req, res, ctx) => ctx.json(200, { retrained: true, body: req.json }));
    sink.route('GET', '/v1/aers', (req, res, ctx) => ctx.json(200, { aers: [{ aer_id: aerId, generated_at: new Date().toISOString(), anchored: false, verification_status: 'signed' }], next_cursor: null }));
    const env = c.env(c.home(), { AER_BASE_URL: sink.url, AER_TENANT_API_KEY: 'aer_tenant_key' });
    const cmds = [
      [['agents', 'list'], 'GET', '/v1/agents'],
      [['agents', 'create', 'new-agent', '--framework', 'custom'], 'POST', '/v1/agents'],
      [['sessions', 'list', '--agent', agents[0].agent_id, '--limit', '5'], 'GET', '/v1/sessions'],
      [['sessions', 'get', sid], 'GET', `/v1/sessions/${sid}`],
      [['findings', 'recent', '--limit', '3', '--severity', 'high'], 'GET', '/v1/findings'],
      [['findings', 'rollup', '--days', '7'], 'GET', '/v1/findings/rollup'],
      [['aers', 'list', '--limit', '2'], 'GET', '/v1/aers'],
      [['aers', 'get', aerId], 'GET', `/v1/aers/${aerId}`],
      [['baseline', 'show', agents[0].agent_id], 'GET', `/v1/agents/${agents[0].agent_id}/baseline`],
      [['baseline', 'retrain', agents[0].agent_id, '--last-n', '5'], 'POST', `/v1/agents/${agents[0].agent_id}/baseline/retrain`],
    ];
    for (const [args, method, path] of cmds) {
      const before = sink.requests.length;
      const r = await c.bin('aer', args, { env });
      c.assert.exit(r, 0, `aer ${args.join(' ')}`);
      parseJson(c, r, `aer ${args.join(' ')}`);
      const hit = sink.requests.slice(before).find((q) => q.method === method && q.path === path);
      c.assert.ok(hit, `aer ${args.join(' ')} did not call ${method} ${path}`);
      c.assert.equal(bearerOf(hit), 'aer_tenant_key', `aer ${args.join(' ')} bearer`);
    }
    c.assert.equal(sink.find('GET', '/v1/sessions')[0].query.limit, '5', 'sessions --limit');
    c.assert.equal(sink.find('GET', '/v1/findings')[0].query.severity, 'high', 'findings --severity');
    c.assert.equal(sink.find('POST', /retrain$/)[0].json?.tenant_id, tenantId, 'retrain tenant_id');
    const table = await c.bin('aer', ['aers', 'list', '--table'], { env });
    c.assert.exit(table, 0, 'aers list --table');
    c.assert.includes(table.stdout, aerId, 'table row');
    const bare = await c.bin('aer', ['agents'], { env });
    c.assert.exit(bare, 64, 'aer agents without a subcommand');
    c.assert.includes(bare.stderr, 'aer agents list', 'names the subcommand');
    const err = await c.bin('aer', ['sessions', 'get', randomUUID()], { env });
    c.assert.exit(err, 1, 'sessions get of an unknown id');
    c.assert.includes(err.stderr, '404', 'error names the status');
  });

  t.case('audit and audit --limit, as the usage text documents them', async (c) => {
    // Usage documents `aer audit [--limit N]`. The subcommand guard added for
    // agents/sessions/findings also catches audit, which has no subcommand.
    const sink = await c.sink();
    const env = c.env(c.home(), { AER_BASE_URL: sink.url, AER_TENANT_API_KEY: 'aer_audit_key' });
    const listed = await c.bin('aer', ['audit', 'list', '--limit', '4'], { env });
    c.assert.exit(listed, 0, 'aer audit list --limit 4 (undocumented form)');
    for (const args of [['audit'], ['audit', '--limit', '4']]) {
      const r = await c.bin('aer', args, { env });
      c.assert.exit(r, 0, `aer ${args.join(' ')}`);
    }
    c.assert.equal(sink.find('GET', '/v1/audit').pop()?.query.limit, '4', 'audit --limit');
  });

  t.case('webhooks list, create, test, rotate, deliveries and delete', async (c) => {
    const sink = await c.sink();
    const hooks = [];
    sink.route('POST', '/v1/webhooks', (req, res, ctx) => {
      const h = { webhook_id: randomUUID(), url: req.json?.url, description: req.json?.description, event_types: req.json?.event_types, secret: 'whsec_x' };
      hooks.push(h);
      ctx.json(201, h);
    });
    sink.route('GET', '/v1/webhooks', (req, res, ctx) => ctx.json(200, { webhooks: hooks }));
    sink.route('POST', /^\/v1\/webhooks\/[^/]+\/test$/, (req, res, ctx) => ctx.json(200, { delivered: true, status: 200 }));
    sink.route('POST', /^\/v1\/webhooks\/[^/]+\/rotate-secret$/, (req, res, ctx) => ctx.json(200, { secret: 'whsec_y' }));
    sink.route('GET', /^\/v1\/webhooks\/[^/]+\/deliveries$/, (req, res, ctx) => ctx.json(200, { deliveries: [] }));
    sink.route('DELETE', /^\/v1\/webhooks\/[^/]+$/, (req, res) => { res.writeHead(204); res.end(); });
    const env = c.env(c.home(), { AER_BASE_URL: sink.url, AER_TENANT_API_KEY: 'aer_wh_key' });
    const mk = await c.bin('aer', ['webhooks', 'create', 'https://hooks.example.com/aer', 'mine', '--events', 'findings.created,session.completed'], { env });
    c.assert.exit(mk, 0, 'webhooks create');
    const id = parseJson(c, mk, 'webhooks create').webhook_id;
    const body = sink.find('POST', '/v1/webhooks')[0].json;
    c.assert.equal(body.url, 'https://hooks.example.com/aer', 'create url');
    c.assert.ok(JSON.stringify(body).includes('session.completed'), `create event types: ${JSON.stringify(body)}`);
    for (const [args, method, path] of [
      [['webhooks', 'list'], 'GET', '/v1/webhooks'],
      [['webhooks', 'test', id], 'POST', `/v1/webhooks/${id}/test`],
      [['webhooks', 'rotate', id], 'POST', `/v1/webhooks/${id}/rotate-secret`],
      [['webhooks', 'deliveries', id, '--limit', '3'], 'GET', `/v1/webhooks/${id}/deliveries`],
      [['webhooks', 'delete', id], 'DELETE', `/v1/webhooks/${id}`],
    ]) {
      const r = await c.bin('aer', args, { env });
      c.assert.exit(r, 0, `aer ${args.join(' ')}`);
      const hit = sink.find(method, path);
      c.assert.ok(hit.length === 1 && bearerOf(hit[0]) === 'aer_wh_key', `aer ${args.join(' ')} -> ${method} ${path}`);
    }
    const nokey = await c.bin('aer', ['webhooks', 'list'], { env: c.env(c.home(), { AER_BASE_URL: sink.url }) });
    c.assert.exit(nokey, 64, 'webhooks list without a key');
  });

  // ---- credential resolution ------------------------------------------------

  t.case('credential resolution: env beats stored, AER_TENANT_API_KEY beats AER_API_KEY', async (c) => {
    const sink = await c.sink();
    withTenant(sink);
    const home = c.home();
    storeCredential(home, sink.url, { api_key: 'aer_stored' });
    const run = async (extra) => {
      const before = sink.requests.length;
      const r = await c.bin('aer', ['agents', 'list'], { env: c.env(home, { AER_BASE_URL: sink.url, ...extra }) });
      c.assert.exit(r, 0, `agents list with ${JSON.stringify(Object.keys(extra))}`);
      return bearerOf(sink.requests.slice(before).find((q) => q.path === '/v1/agents'));
    };
    c.assert.equal(await run({}), 'aer_stored', 'stored credential when no env key');
    c.assert.equal(await run({ AER_API_KEY: 'aer_api' }), 'aer_api', 'AER_API_KEY over stored');
    c.assert.equal(await run({ AER_TENANT_API_KEY: 'aer_tenant' }), 'aer_tenant', 'AER_TENANT_API_KEY over stored');
    c.assert.equal(await run({ AER_TENANT_API_KEY: 'aer_tenant', AER_API_KEY: 'aer_api' }), 'aer_tenant', 'AER_TENANT_API_KEY over AER_API_KEY');
  });

  t.case('credential resolution: a base URL from aer.config.json needs confirmation for an env key', async (c) => {
    const sink = await c.sink();
    withTenant(sink);
    const home = c.home();
    const dir = c.tmp('proj-');
    writeConfig(dir, { tenant_id: randomUUID(), agent_id: randomUUID(), env_id: randomUUID(), base_url: sink.url });
    const refused = await c.bin('aer', ['agents', 'list'], { cwd: dir, env: c.env(home, { AER_TENANT_API_KEY: 'aer_must_not_leak' }) });
    c.assert.exit(refused, 64, 'env key toward a config-only base URL');
    c.assert.includes(refused.stderr, `AER_BASE_URL=${sink.url}`, 'refusal names the fix');
    c.assert.equal(sink.requests.length, 0, 'requests sent to the untrusted host');
    const confirmed = await c.bin('aer', ['agents', 'list'], { cwd: dir, env: c.env(home, { AER_TENANT_API_KEY: 'aer_ok', AER_BASE_URL: sink.url }) });
    c.assert.exit(confirmed, 0, 'confirmed with AER_BASE_URL');
    // A key stored by aer login FOR that host is not refused.
    storeCredential(home, sink.url, { api_key: 'aer_stored_for_host' });
    const stored = await c.bin('aer', ['agents', 'list'], { cwd: dir, env: c.env(home) });
    c.assert.exit(stored, 0, 'stored credential for the config base URL');
    c.assert.equal(bearerOf(sink.find('GET', '/v1/agents').pop()), 'aer_stored_for_host', 'stored key used');
  });

  t.case('credential resolution: an expired stored credential is refused', async (c) => {
    const sink = await c.sink();
    const home = c.home();
    storeCredential(home, sink.url, { api_key: 'aer_old', expires_at: new Date(Date.now() - 60_000).toISOString() });
    const r = await c.bin('aer', ['agents', 'list'], { env: c.env(home, { AER_BASE_URL: sink.url }) });
    c.assert.exit(r, 1, 'expired credential');
    c.assert.includes(r.stderr, 'expired', 'expiry message');
    c.assert.equal(sink.requests.length, 0, 'an expired key was sent');
  });

  t.case('a corrupt credentials file is moved aside, never clobbered', async (c) => {
    const sink = await c.sink();
    const home = c.home();
    const dir = join(home, '.config', 'aer');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'credentials.json'), '{not json', { mode: 0o600 });
    const r = await c.bin('aer', ['whoami'], { env: c.env(home, { AER_BASE_URL: sink.url }) });
    c.assert.nonZero(r, 'whoami with a corrupt file');
    const moved = readdirSync(dir).filter((f) => f.startsWith('credentials.json.corrupt-'));
    c.assert.equal(moved.length, 1, 'quarantined copies');
    c.assert.equal(readFileSync(join(dir, moved[0]), 'utf8'), '{not json', 'quarantined content');
  });

  // ---- coverage added after the first run -----------------------------------

  t.case('smoke fails when the session never reaches the API', async (c) => {
    // A workload exits 0 whether or not anything was recorded; smoke must ask
    // the API, not trust the exit code.
    const sink = await c.sink();
    const { tenantId, agents } = withTenant(sink);
    sink.fault({ method: 'POST', path: /^\/v1\/sessions$/, status: 500 });
    const home = c.home();
    const dir = await makeProject(c, { install: true, home });
    c.assert.exit(await c.bin('aer', ['init', '--yes', '--tenant', tenantId, '--agent', agents[0].agent_id, '--base-url', sink.url], { cwd: dir, env: c.env(home) }), 0, 'init');
    const r = await c.bin('aer', ['smoke'], { cwd: dir, env: c.env(home, { AER_API_KEY: 'aer_smoke_key', AER_BASE_URL: sink.url }), timeoutMs: 120_000 });
    c.assert.exit(r, 1, 'smoke with every session open refused');
    c.assert.includes(r.stderr, 'no session reached', 'says nothing was recorded');
  }, { timeoutMs: 240_000 });

  t.case('smoke records from an agent tool shell, since running it is an explicit request', async (c) => {
    const sink = await c.sink();
    const { tenantId, agents } = withTenant(sink);
    const home = c.home();
    const dir = await makeProject(c, { install: true, home });
    c.assert.exit(await c.bin('aer', ['init', '--yes', '--tenant', tenantId, '--agent', agents[0].agent_id, '--base-url', sink.url], { cwd: dir, env: c.env(home) }), 0, 'init');
    const r = await c.bin('aer', ['smoke'], { cwd: dir, env: c.env(home, { AER_API_KEY: 'aer_smoke_key', AER_BASE_URL: sink.url, CLAUDECODE: '1' }), timeoutMs: 120_000 });
    c.assert.exit(r, 0, 'smoke in an agent shell');
    c.assert.ok(sink.find('POST', /\/complete$/).length === 1, 'no completed session');
  }, { timeoutMs: 240_000 });

  t.case('commitments verify never reports an unsigned anchoring claim as anchored', async (c) => {
    const { bundle, key } = await signedBundle(c);
    bundle.integrity.anchored = true; // outside the signed hash: anyone can flip it
    const dir = c.tmp();
    writeFileSync(join(dir, 'bundle.json'), JSON.stringify(bundle));
    writeFileSync(join(dir, 'key.json'), JSON.stringify(key));
    writeFileSync(join(dir, 'requests.json'), '[]');
    const r = await c.bin('aer', ['commitments', 'verify', '--requests', join(dir, 'requests.json'), '--bundle', join(dir, 'bundle.json'), '--key', join(dir, 'key.json')], { env: c.env(c.home(), { AER_COMMITMENT_KEY: randomBytes(32).toString('hex') }) });
    const res = parseJson(c, r, 'commitments verify');
    c.assert.equal(res.bundle_signature.hash_match, true, 'the flip does not break the hash');
    c.assert.equal(res.bundle_signature.anchored, false, 'anchored from an unsigned claim');
    c.assert.equal(res.bundle_signature.anchor_status, 'claimed', 'anchor_status');
  });

  t.case('login backs off on slow_down and on 429, then completes', async (c) => {
    const sink = await c.sink();
    const polls = [];
    const answers = [
      [400, { error: 'slow_down' }],
      [429, { error: 'rate_limited' }],
    ];
    sink.route('POST', '/v1/cli/device/token', (req, res, ctx) => {
      polls.push(Date.now());
      const next = answers.shift();
      if (next) return ctx.json(next[0], next[1]);
      return false; // the default route mints the key
    });
    sink.device.pendingPolls = 0;
    const home = c.home();
    const r = await c.bin('aer', ['login', '--no-browser'], { env: c.env(home, { AER_BASE_URL: sink.url }), timeoutMs: 90_000 });
    c.assert.exit(r, 0, 'login');
    c.assert.equal(polls.length, 3, 'polls');
    const gaps = [polls[1] - polls[0], polls[2] - polls[1]];
    // interval 1 s; each slow_down or 429 adds 5 s, so about 6 s then 11 s.
    c.assert.ok(gaps[0] >= 5500 && gaps[1] >= 10500 && gaps[1] > gaps[0], `poll gaps ${gaps.join(' ms, ')} ms`);
    const stored = JSON.parse(readFileSync(join(home, '.config', 'aer', 'credentials.json'), 'utf8'))[sink.url];
    c.assert.equal(stored?.api_key, sink.device.apiKey, 'stored key');
    c.note(`poll gaps ${gaps.join(' ms, ')} ms`);
  }, { timeoutMs: 120_000 });

  t.case('login opens the verification page in a browser when a display is present', async (c) => {
    // The opener is stubbed on PATH: the CLI runs xdg-open (open on macOS)
    // with the URL as its own argument, never through a shell.
    const sink = await c.sink();
    const bin = c.tmp('opener-');
    const log = join(bin, 'opened.log');
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    writeFileSync(join(bin, opener), `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(log)}\n`, { mode: 0o755 });
    const home = c.home();
    const base = c.env(home, { AER_BASE_URL: sink.url, DISPLAY: ':99' });
    const r = await c.bin('aer', ['login'], { env: { ...base, PATH: `${bin}:${base.PATH}` }, timeoutMs: 60_000 });
    c.assert.exit(r, 0, 'login');
    const deadline = Date.now() + 5000;
    while (!existsSync(log) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
    c.assert.ok(existsSync(log), 'the browser opener was never run');
    c.assert.equal(readFileSync(log, 'utf8').trim(), `${sink.url}/cli/activate`, 'opened URL');

    const log2 = join(bin, 'opened.log');
    writeFileSync(log2, '');
    sink.device.polls = 0;
    const nb = await c.bin('aer', ['login', '--no-browser'], { env: { ...base, PATH: `${bin}:${base.PATH}` }, timeoutMs: 60_000 });
    c.assert.exit(nb, 0, 'login --no-browser');
    await new Promise((res) => setTimeout(res, 300));
    c.assert.equal(readFileSync(log2, 'utf8'), '', '--no-browser still opened a browser');
  });

  t.case('logout --all revokes and removes every stored credential', async (c) => {
    const a = await c.sink();
    const b = await c.sink();
    const home = c.home();
    storeCredential(home, a.url, { api_key: 'aer_cli_all_a' });
    const file = storeCredential(home, b.url, { api_key: 'aer_cli_all_b' });
    const r = await c.bin('aer', ['logout', '--all'], { env: c.env(home), timeoutMs: 30_000 });
    c.assert.exit(r, 0, 'logout --all');
    c.assert.equal(bearerOf(a.find('POST', '/v1/cli/logout')[0] ?? { headers: {} }), 'aer_cli_all_a', 'first host revoked');
    c.assert.equal(bearerOf(b.find('POST', '/v1/cli/logout')[0] ?? { headers: {} }), 'aer_cli_all_b', 'second host revoked');
    c.assert.equal(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).length, 0, 'credentials left behind');
    const again = await c.bin('aer', ['logout', '--all'], { env: c.env(home) });
    c.assert.exit(again, 0, 'logout --all with nothing stored');
    c.assert.includes(again.stdout, 'Not logged in anywhere', 'message');
  });

  t.case('link without flags in a terminal offers a picker and writes the chosen agent', async (c) => {
    // The picker runs only when stdin and stdout are a TTY, so this runs the
    // CLI under a pseudo-terminal from util-linux script(1) and answers the
    // prompt on its stdin.
    const probe = await c.run('script', ['--version'], { env: c.env(c.home()) }).catch(() => null);
    if (!probe || probe.code !== 0 || !/util-linux/.test(probe.stdout + probe.stderr)) return { skip: 'needs util-linux script(1) for a pseudo-terminal' };
    const sink = await c.sink();
    const { tenantId, agents } = withTenant(sink);
    const home = c.home();
    storeCredential(home, sink.url, { api_key: 'aer_cli_link', tenant_id: tenantId });
    const proj = c.tmp('proj-');
    const env = c.env(home, { AER_BASE_URL: sink.url, TERM: 'dumb' });
    const cmd = `${join(c.install.binDir, 'aer')} link`;
    const r = await c.run('script', ['-qec', cmd, '/dev/null'], { cwd: proj, env, input: '1\n', timeoutMs: 60_000 });
    c.assert.exit(r, 0, `aer link under a pty; output: ${r.stdout.slice(-300)}`);
    c.assert.includes(r.stdout, 'Pick an agent', 'picker shown');
    c.assert.includes(r.stdout, agents[1].agent_id, 'agents listed');
    const cfg = JSON.parse(readFileSync(join(proj, 'aer.config.json'), 'utf8'));
    c.assert.equal(cfg.agent_id, agents[1].agent_id, 'chosen agent');
    c.assert.equal(cfg.tenant_id, tenantId, 'tenant');

    const proj2 = c.tmp('proj-');
    const bad = await c.run('script', ['-qec', cmd, '/dev/null'], { cwd: proj2, env, input: 'nope\n', timeoutMs: 60_000 });
    c.assert.nonZero(bad, 'an answer that is not a number');
    c.assert.ok(!existsSync(join(proj2, 'aer.config.json')), 'a config was written without a choice');
  });
}

