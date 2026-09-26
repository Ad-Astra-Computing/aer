/**
 * The upgrade path: install the versions a customer already has, let them
 * write their config and state, then install the candidate over the top and
 * check that it still works. A fresh-install-only matrix once hid a migration
 * that never ran, because nothing had ever seeded the old state.
 *
 * Runs only with --upgrade-from <tag>. Each case gets its own project and
 * HOME, installs the old versions, seeds, then upgrades in place.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cleanEnv } from '../lib/proc.mjs';

const HOOKS = '@adastracomputing/aer-hooks';
const AUTO = '@adastracomputing/aer-auto-node';

/** The failing checks of an `aer doctor --json` run, for the report. */
function failingChecks(r) {
  try {
    return JSON.parse(r.stdout).checks.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`).join('; ') || 'none';
  } catch { return 'unparseable output'; }
}

function readJson(p) { return JSON.parse(readFileSync(p, 'utf8')); }

/** A project with the old versions installed and an env that runs its bins. */
async function oldProject(c, env) {
  const dir = c.tmp('project-');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'upgrade-probe',
    version: '1.0.0',
    private: true,
    type: 'module',
    scripts: { start: 'node agent.js' },
  }, null, 2));
  // The collector opens its session on the first captured event, and file
  // reads are not captured, so the probe agent spawns a process. A default
  // import: a named import binds before the patch and is not captured, as the
  // README documents.
  writeFileSync(join(dir, 'agent.js'), "import cp from 'node:child_process';\nawait new Promise((r) => cp.execFile(process.execPath, ['-e', '0'], () => r()));\nconsole.log('agent ran');\n");
  await env.installInto(dir, env.fromSpecs);
  const home = c.home();
  const binDir = join(dir, 'node_modules', '.bin');
  const mkEnv = (extra = {}) => cleanEnv(home, extra, [binDir]);
  return { dir, home, binDir, mkEnv };
}

async function upgradeInPlace(c, env, p) {
  await env.installInto(p.dir, env.specs);
  const problems = env.verifyInstalled(p.dir, env.specs, { local: env.opts.source === 'local' });
  c.assert.ok(problems.length === 0, `the upgraded install is not the candidate: ${problems.join('; ')}`);
}

const identity = (sink) => ({
  AER_BASE_URL: sink.url,
  AER_API_KEY: 'aer_test_matrix_key',
  AER_TENANT_ID: randomUUID(),
  // The agent must exist at the sink: doctor checks it against GET /v1/agents.
  AER_AGENT_ID: sink.agents[0].id,
  AER_ENV_ID: randomUUID(),
});

const hookPayload = (sessionId, cwd, event, extra = {}) => JSON.stringify({
  session_id: sessionId,
  transcript_path: join(cwd, 'no-transcript.jsonl'),
  cwd,
  hook_event_name: event,
  ...extra,
});

/** The aer-hook commands registered for one event in a harness config. */
function commandsFor(config, event) {
  return (config.hooks?.[event] ?? []).flatMap((g) => (g.hooks ?? []).map((h) => h.command)).filter(Boolean);
}

export default function register(registry, env) {
  const t = registry.suite('upgrade', 'all');
  if (!env.opts.upgradeFrom) {
    t.skip('upgrade path', 'runs only with --upgrade-from <tag>');
    return;
  }

  t.case('aer-hooks: old registrations are flagged, then updated in place', async (c) => {
    const p = await oldProject(c, env);
    // A hook of the user's own, which no install or upgrade may touch.
    const settingsPath = join(p.home, '.claude', 'settings.json');
    for (const h of ['claude-code', 'codex']) {
      const r = await c.run(join(p.binDir, 'aer-hooks'), ['install', h], { env: p.mkEnv(), cwd: p.dir });
      c.assert.exit(r, 0, `old aer-hooks install ${h}`);
    }
    const seeded = readJson(settingsPath);
    seeded.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'user-own-hook --keep-me' }] });
    seeded.theme = 'user-setting';
    writeFileSync(settingsPath, JSON.stringify(seeded, null, 2));

    await upgradeInPlace(c, env, p);

    const status = await c.run(join(p.binDir, 'aer-hooks'), ['status', '--json'], { env: p.mkEnv(), cwd: p.dir });
    c.assert.exit(status, 0, 'candidate aer-hooks status --json');
    const stale = JSON.parse(status.stdout).hooks?.stale_registrations ?? [];
    c.note(`stale before re-install: ${stale.map((s) => `${s.harness}:${s.reason}`).join(', ') || 'none'}`);
    const seededCmd = commandsFor(seeded, 'PreToolUse').find((x) => x.startsWith('aer-hook'));
    if (!/--lifecycle v2/.test(seededCmd ?? '')) {
      for (const h of ['claude-code', 'codex']) {
        c.assert.ok(stale.some((s) => s.harness === h), `status did not flag the old ${h} registration (${seededCmd})`);
      }
    }

    for (const h of ['claude-code', 'codex']) {
      const r = await c.run(join(p.binDir, 'aer-hooks'), ['install', h], { env: p.mkEnv(), cwd: p.dir });
      c.assert.exit(r, 0, `candidate aer-hooks install ${h}`);
    }
    const after = await c.run(join(p.binDir, 'aer-hooks'), ['status', '--json'], { env: p.mkEnv(), cwd: p.dir });
    c.assert.exit(after, 0, 'status after re-install');
    const staleAfter = JSON.parse(after.stdout).hooks?.stale_registrations ?? [];
    c.assert.equal(staleAfter.length, 0, `stale registrations after re-install: ${JSON.stringify(staleAfter)}`);

    const cfg = readJson(settingsPath);
    c.assert.equal(cfg.theme, 'user-setting', 'a user setting survived the upgrade');
    c.assert.ok(commandsFor(cfg, 'PreToolUse').includes('user-own-hook --keep-me'), 'the user\'s own hook survived the upgrade');
    for (const [event] of Object.entries(cfg.hooks)) {
      const ours = commandsFor(cfg, event).filter((x) => x.startsWith('aer-hook'));
      c.assert.ok(ours.length <= 1, `${event} has ${ours.length} aer-hook registrations: ${ours.join(' | ')}`);
    }
    const codexCfg = readJson(join(p.home, '.codex', 'hooks.json'));
    for (const event of Object.keys(codexCfg.hooks)) {
      const ours = commandsFor(codexCfg, event).filter((x) => x.startsWith('aer-hook'));
      c.assert.ok(ours.length <= 1, `codex ${event} has ${ours.length} aer-hook registrations`);
    }
  }, { timeoutMs: 600_000 });

  t.case('aer-hooks: re-registered hooks fire and complete a record', async (c) => {
    const p = await oldProject(c, env);
    const r0 = await c.run(join(p.binDir, 'aer-hooks'), ['install', 'claude-code'], { env: p.mkEnv(), cwd: p.dir });
    c.assert.exit(r0, 0, 'old install');
    await upgradeInPlace(c, env, p);
    const r1 = await c.run(join(p.binDir, 'aer-hooks'), ['install', 'claude-code'], { env: p.mkEnv(), cwd: p.dir });
    c.assert.exit(r1, 0, 'candidate install');

    const sink = await c.sink();
    const hookEnv = p.mkEnv(identity(sink));
    const cfg = readJson(join(p.home, '.claude', 'settings.json'));
    const sid = randomUUID();
    const fire = async (event, extra) => {
      const cmd = commandsFor(cfg, event).find((x) => x.startsWith('aer-hook'));
      c.assert.ok(cmd, `no aer-hook registered for ${event}`);
      // Run the registered command string exactly as the harness would.
      const r = await c.run('sh', ['-c', cmd], { env: hookEnv, cwd: p.dir, input: hookPayload(sid, p.dir, event, extra), timeoutMs: 30_000 });
      c.assert.exit(r, 0, `${event} hook`);
      c.assert.equal(r.stdout, '', `${event} hook stdout`);
    };
    await fire('SessionStart', { source: 'startup' });
    await fire('PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'a.txt' }, tool_use_id: 'toolu_1' });
    await fire('PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'a.txt' }, tool_response: { ok: true }, tool_use_id: 'toolu_1' });
    await fire('Stop', {});
    await fire('SessionEnd', { reason: 'exit' });

    c.assert.equal(sink.find('POST', '/v1/sessions').length, 1, 'session opens');
    c.assert.ok(sink.events().length >= 2, `events posted: ${sink.events().length}`);
    c.assert.equal(sink.find('POST', /\/complete$/).length, 1, '/complete calls');
    const collector = sink.find('POST', '/v1/sessions')[0].json?.collector;
    c.assert.equal(collector?.version, env.specs[HOOKS].version, 'collector version on the session open');
  }, { timeoutMs: 600_000 });

  t.case('aer-hooks: a session opened by the old hook is finished by the new one', async (c) => {
    const p = await oldProject(c, env);
    const r0 = await c.run(join(p.binDir, 'aer-hooks'), ['install', 'claude-code'], { env: p.mkEnv(), cwd: p.dir });
    c.assert.exit(r0, 0, 'old install');
    const cfg = readJson(join(p.home, '.claude', 'settings.json'));
    const cmd = commandsFor(cfg, 'PreToolUse').find((x) => x.startsWith('aer-hook'));

    const sink = await c.sink();
    const hookEnv = p.mkEnv(identity(sink));
    const sid = randomUUID();
    const fire = async (event, extra) => {
      const r = await c.run('sh', ['-c', cmd], { env: hookEnv, cwd: p.dir, input: hookPayload(sid, p.dir, event, extra), timeoutMs: 30_000 });
      c.assert.exit(r, 0, `${event} hook`);
      c.assert.equal(r.stdout, '', `${event} hook stdout`);
    };
    // Mid-session under the old version: the session is open and its state
    // (ingest token, sequence) sits in the hook's cache.
    await fire('SessionStart', { source: 'startup' });
    await fire('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_a' });
    const opensBefore = sink.find('POST', '/v1/sessions').length;
    c.assert.equal(opensBefore, 1, 'the old hook opened one session');
    const cacheDir = join(p.home, '.cache');
    c.note(`old cache files: ${existsSync(cacheDir) ? readdirSync(cacheDir, { recursive: true }).join(', ') : 'none'}`);

    // The package manager upgrades underneath a running harness session.
    await upgradeInPlace(c, env, p);
    await fire('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'x' }, tool_use_id: 'toolu_a' });
    await fire('Stop', {});

    const opens = sink.find('POST', '/v1/sessions');
    const sessionIds = new Set(sink.find('POST', /^\/v1\/sessions\/[^/]+\/events$/).map((r) => r.path.split('/')[3]));
    c.note(`session opens ${opens.length}; sessions that received events ${sessionIds.size}; completes ${sink.find('POST', /\/complete$/).length}`);
    c.assert.equal(sessionIds.size, 1, 'events after the upgrade went to a different session than before it');
    c.assert.equal(sink.find('POST', /\/complete$/).length, 1, 'the session was completed exactly once');
    const completed = sink.find('POST', /\/complete$/)[0].path.split('/')[3];
    c.assert.ok(sessionIds.has(completed), 'the completed session is the one the old hook opened');
  }, { timeoutMs: 600_000 });

  t.case('aer: a project wired by the old init passes doctor after the upgrade', async (c) => {
    const p = await oldProject(c, env);
    const sink = await c.sink();
    const ids = identity(sink);
    const initArgs = ['init', '--yes', '--json', '--tenant', ids.AER_TENANT_ID, '--agent', ids.AER_AGENT_ID, '--env', ids.AER_ENV_ID, '--base-url', sink.url];
    const oldInit = await c.run(join(p.binDir, 'aer'), initArgs, { env: p.mkEnv(), cwd: p.dir });
    c.assert.exit(oldInit, 0, 'old aer init');
    const manifestBefore = existsSync(join(p.dir, 'aer.integration.json')) ? readJson(join(p.dir, 'aer.integration.json')) : null;
    const startBefore = readJson(join(p.dir, 'package.json')).scripts.start;
    c.note(`old init wired start: ${startBefore}`);

    await upgradeInPlace(c, env, p);

    const runEnv = p.mkEnv({ AER_API_KEY: ids.AER_API_KEY, AER_BASE_URL: sink.url });
    const doctor = await c.run(join(p.binDir, 'aer'), ['doctor', '--json'], { env: runEnv, cwd: p.dir, timeoutMs: 60_000 });
    c.assert.exit(doctor, 0, `candidate aer doctor on the old wiring (failing checks: ${failingChecks(doctor)})`);

    const reinit = await c.run(join(p.binDir, 'aer'), initArgs, { env: p.mkEnv(), cwd: p.dir });
    c.assert.exit(reinit, 0, 'candidate aer init over the old wiring');
    const pkg = readJson(join(p.dir, 'package.json'));
    const imports = (pkg.scripts.start.match(/aer-auto-node\/register/g) ?? []).length;
    c.assert.equal(imports, 1, `start script wires the collector ${imports} times: ${pkg.scripts.start}`);
    const agents = readFileSync(join(p.dir, 'AGENTS.md'), 'utf8');
    const sections = agents.split('\n').filter((l) => /^#+ .*AER/.test(l)).length;
    c.assert.ok(sections <= 1, `AGENTS.md has ${sections} AER sections after re-running init`);
    const manifest = readJson(join(p.dir, 'aer.integration.json'));
    c.assert.equal(manifest.schema, manifestBefore?.schema ?? manifest.schema, 'manifest schema');

    const doctor2 = await c.run(join(p.binDir, 'aer'), ['doctor', '--json'], { env: runEnv, cwd: p.dir, timeoutMs: 60_000 });
    c.assert.exit(doctor2, 0, `doctor after re-init (failing checks: ${failingChecks(doctor2)})`);

    // The wired start script records through the upgraded collector.
    const start = await c.run('npm', ['run', '--silent', 'start'], { env: runEnv, cwd: p.dir, timeoutMs: 60_000 });
    c.note(`start script: ${pkg.scripts.start}; stderr: ${start.stderr.trim().slice(0, 600)}`);
    c.assert.exit(start, 0, 'npm start');
    c.assert.includes(start.stdout, 'agent ran', 'the agent ran');
    c.assert.ok(sink.find('POST', '/v1/sessions').length >= 1, 'the wired start script opened a session at the sink');
    c.assert.ok(sink.find('POST', /\/complete$/).length >= 1, 'the session was completed');
    // Last, so a wrong version does not hide the checks above.
    const col = sink.find('POST', '/v1/sessions').map((r) => r.json?.collector).find(Boolean);
    c.assert.ok(col, 'the session open carried no collector field');
    c.assert.equal(col.version, env.specs[AUTO].version, 'collector version the upgraded aer-auto-node reports');
  }, { timeoutMs: 600_000 });
}
