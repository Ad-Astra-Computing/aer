/**
 * aer-hooks: the installer (`aer-hooks`) and the per-event hook (`aer-hook`),
 * driven through the installed bin symlinks in a temporary HOME.
 *
 * Payload shapes follow what Claude Code and Codex CLI actually send on stdin
 * (hook_event_name, session_id, transcript_path, cwd, tool_name, tool_input,
 * tool_response). Every run of the hook must exit 0 with an EMPTY stdout,
 * because a harness reads hook stdout and a non-zero exit fails its tool.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, symlinkSync, chmodSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { canaries, assertNoCanaries } from '../lib/harness.mjs';
import { deadPort } from '../lib/sink.mjs';

const PKG = '@adastracomputing/aer-hooks';
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop', 'SessionEnd'];
const V2 = ['--harness', 'claude-code', '--lifecycle', 'v2'];
const CODEX_V2 = ['--harness', 'codex', '--lifecycle', 'v2'];

/** The identity every hook case configures. The key is a fake. */
function identity() {
  return {
    AER_API_KEY: `aer_matrix_${randomUUID().replace(/-/g, '')}`,
    AER_TENANT_ID: randomUUID(),
    AER_AGENT_ID: randomUUID(),
    AER_ENV_ID: randomUUID(),
  };
}

/**
 * A clean env whose PATH holds no aer binary except the installed ones. A
 * machine with AER already on PATH (a nix profile, a global npm install)
 * would otherwise lend its own aer-hook to the installer's PATH lookup and
 * to the doctor's version probe, and the case would test that copy instead.
 */
function envFor(c, home, extra = {}) {
  const e = c.env(home, extra);
  const aerBins = ['aer-hook', 'aer-hooks', 'aer', 'aer-mcp-recorder'];
  const dirs = e.PATH.split(delimiter).filter((d) => d === c.install.binDir || !aerBins.some((b) => existsSync(join(d, b))));
  e.PATH = [...dirs, dirname(process.execPath)].join(delimiter);
  return e;
}

function hookEnv(c, home, baseUrl, extra = {}) {
  return envFor(c, home, { ...identity(), AER_BASE_URL: baseUrl, AER_HOOK_TIMEOUT_MS: '8000', ...extra });
}

/** Run the installed aer-hook once with `payload` on stdin; assert the hook contract. */
async function fire(c, env, payload, args = V2, { timeoutMs = 20_000, cwd } = {}) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const r = await c.bin('aer-hook', args, { env, input, timeoutMs, cwd });
  c.assert.ok(!r.timedOut, `aer-hook hung on ${payload?.hook_event_name ?? 'input'}`);
  c.assert.exit(r, 0, `aer-hook ${payload?.hook_event_name ?? 'input'}`);
  c.assert.equal(r.stdout, '', `aer-hook ${payload?.hook_event_name ?? 'input'} stdout must be empty`);
  return r;
}

const opens = (sink) => sink.find('POST', '/v1/sessions');
const completes = (sink) => sink.find('POST', /^\/v1\/sessions\/[^/]+\/complete$/);
const byType = (sink, t) => sink.events().filter((e) => e.event_type === t);
const phases = (sink) => byType(sink, 'collector.report').map((e) => e.payload?.phase);

/** A Claude Code transcript with one assistant message carrying model and usage. */
function writeTranscript(path, cn) {
  const lines = [
    { type: 'user', uuid: randomUUID(), message: { role: 'user', content: `please ${cn.prompt}` } },
    {
      type: 'assistant',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      message: {
        id: `msg_${randomUUID().slice(0, 8)}`,
        model: 'claude-matrix-1',
        role: 'assistant',
        content: [{ type: 'text', text: `reply ${cn.result}` }, { type: 'tool_use', name: 'Bash', input: { command: `echo ${cn.args}` } }],
        usage: { input_tokens: 1234, output_tokens: 56 },
      },
    },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

/** The realistic Claude Code run, with canaries in every body a harness hands over. */
function claudeRun(sid, cwd, transcript, cn) {
  const base = { session_id: sid, transcript_path: transcript, cwd };
  const turn = { ...base, prompt_id: 'pr_1', permission_mode: 'default', effort: { level: 'medium' } };
  return [
    { ...base, hook_event_name: 'SessionStart', source: 'startup' },
    { ...turn, hook_event_name: 'UserPromptSubmit', prompt: `do the thing ${cn.prompt}` },
    { ...turn, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `git status # ${cn.args}`, description: cn.args }, tool_use_id: 'toolu_1' },
    { ...turn, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: `git status # ${cn.args}` }, tool_response: { stdout: cn.result, stderr: '', interrupted: false }, tool_use_id: 'toolu_1', duration_ms: 12 },
    { ...turn, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(cwd, 'notes.txt'), content: cn.file }, tool_use_id: 'toolu_2' },
    { ...turn, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: join(cwd, 'notes.txt'), content: cn.file }, tool_response: { success: true, content: cn.file }, tool_use_id: 'toolu_2' },
    { ...turn, hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url: `https://example.com/${cn.path}?q=${cn.query}`, prompt: cn.prompt }, tool_use_id: 'toolu_3' },
    { ...turn, hook_event_name: 'PostToolUse', tool_name: 'WebFetch', tool_input: { url: `https://example.com/${cn.path}?q=${cn.query}` }, tool_response: { result: cn.result }, tool_use_id: 'toolu_3' },
    { ...turn, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: cn.result },
    { ...base, prompt_id: 'pr_1', hook_event_name: 'SessionEnd', reason: 'other' },
  ];
}

function readJson(p) { return JSON.parse(readFileSync(p, 'utf8')); }

/** Every command string wired under `hooks` in a harness config. */
function wiredCommands(cfg) {
  const out = {};
  for (const [ev, groups] of Object.entries(cfg.hooks ?? {})) {
    out[ev] = (groups ?? []).flatMap((g) => (g.hooks ?? []).map((h) => h));
  }
  return out;
}

/** A directory that is NOT an ephemeral node_modules/.bin, holding an aer-hook link. */
function persistentBin(c, home, target) {
  const dir = join(home, 'bin');
  mkdirSync(dir, { recursive: true });
  symlinkSync(target, join(dir, 'aer-hook'));
  return dir;
}

/** A stand-in aer-hook that prints `version` for --version (nothing when empty). */
function fakeHook(home, version) {
  const dir = join(home, 'fakebin');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'aer-hook');
  writeFileSync(p, version ? `#!/bin/sh\necho ${version}\n` : '#!/bin/sh\nexit 0\n');
  chmodSync(p, 0o755);
  return dir;
}

export default function register(registry) {
  const t = registry.suite('aer-hooks', PKG);

  // ── installer ─────────────────────────────────────────────────────────────

  for (const harness of ['claude-code', 'codex']) {
    const cfgRel = harness === 'claude-code' ? ['.claude', 'settings.json'] : ['.codex', 'hooks.json'];

    t.case(`install ${harness}: wires all eight lifecycle v2 events, keeps foreign entries`, async (c) => {
      const home = c.home();
      const cfgPath = join(home, ...cfgRel);
      mkdirSync(join(cfgPath, '..'), { recursive: true });
      const foreign = { type: 'command', command: '/usr/local/bin/my-own-hook --flag' };
      writeFileSync(cfgPath, JSON.stringify({ theme: 'dark', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [foreign] }] } }, null, 2));
      const env = envFor(c, home);
      const r = await c.bin('aer-hooks', ['install', harness], { env, cwd: home });
      c.assert.exit(r, 0, `aer-hooks install ${harness}`);
      c.assert.includes(r.stdout, 'Wired AER hooks', 'install output');
      if (harness === 'codex') c.assert.includes(r.stdout, '/hooks', 'codex trust note');
      c.assert.ok(existsSync(`${cfgPath}.bak`), 'no .bak backup written');
      const cfg = readJson(cfgPath);
      c.assert.equal(cfg.theme, 'dark', 'unrelated config key');
      const wired = wiredCommands(cfg);
      for (const ev of EVENTS) {
        const ours = (wired[ev] ?? []).filter((h) => /--harness/.test(h.command));
        c.assert.equal(ours.length, 1, `AER entries on ${ev}`);
        c.assert.includes(ours[0].command, `--harness ${harness} --lifecycle v2`, `${ev} command`);
      }
      c.assert.ok(wired.PreToolUse.some((h) => h.command === foreign.command), 'foreign PreToolUse hook was removed');
      const end = wired.SessionEnd.find((h) => /--harness/.test(h.command));
      if (harness === 'claude-code') c.assert.equal(end.timeout, 15, 'SessionEnd timeout');
      else c.assert.equal(end.timeout, undefined, 'codex SessionEnd must not carry a timeout key');
      // Installed from node_modules/.bin, which the harness never sees, so the
      // command must be pinned to an absolute path that exists.
      const cmd = wired.PreToolUse.find((h) => /--harness/.test(h.command)).command;
      c.assert.match(cmd, /^node '\/.+\/aer-hooks\/dist\/cli\.js' --harness/, 'pinned command');
      c.assert.ok(existsSync(cmd.match(/^node '([^']+)'/)[1]), 'pinned cli.js does not exist');

      // Idempotent.
      const again = await c.bin('aer-hooks', ['install', harness], { env, cwd: home });
      c.assert.exit(again, 0, 'second install');
      c.assert.includes(again.stdout, 'already present', 'second install output');
      c.assert.equal(JSON.stringify(readJson(cfgPath)), JSON.stringify(cfg), 'second install changed the config');

      // status reads it back as wired and resolving.
      const st = await c.bin('aer-hooks', ['status', '--json'], { env, cwd: home });
      c.assert.exit(st, 0, 'status --json');
      const entry = JSON.parse(st.stdout).hooks.entries.find((e) => e.harness === harness);
      c.assert.equal(entry.wiredEvents.length, 8, 'status wiredEvents');
      c.assert.equal(entry.resolves, true, 'status resolves');

      // Uninstall removes ours and only ours.
      const un = await c.bin('aer-hooks', ['uninstall', harness], { env, cwd: home });
      c.assert.exit(un, 0, 'uninstall');
      c.assert.includes(un.stdout, 'Removed AER hooks', 'uninstall output');
      const after = readJson(cfgPath);
      c.assert.excludes(JSON.stringify(after), '--harness', 'uninstall left an AER entry');
      c.assert.includes(JSON.stringify(after), foreign.command, 'uninstall removed a foreign hook');
      c.assert.equal(after.theme, 'dark', 'uninstall lost an unrelated key');
      const un2 = await c.bin('aer-hooks', ['uninstall', harness], { env, cwd: home });
      c.assert.exit(un2, 0, 'second uninstall');
      c.assert.includes(un2.stdout, 'nothing to do', 'second uninstall output');
    });

    t.case(`install ${harness}: the command it wires records end to end`, async (c) => {
      const home = c.home();
      const sink = await c.sink();
      const inst = await c.bin('aer-hooks', ['install', harness], { env: envFor(c, home), cwd: home });
      c.assert.exit(inst, 0, 'install');
      const cfg = readJson(join(home, ...cfgRel));
      const cmd = wiredCommands(cfg).SessionStart.find((h) => /--harness/.test(h.command)).command;
      const env = hookEnv(c, home, sink.url);
      const sid = randomUUID();
      const proj = c.tmp('proj-');
      for (const ev of ['SessionStart', 'SessionEnd']) {
        const r = await c.run('/bin/sh', ['-c', cmd], { env, input: JSON.stringify({ session_id: sid, cwd: proj, transcript_path: join(proj, 't.jsonl'), hook_event_name: ev }), timeoutMs: 20_000 });
        c.assert.exit(r, 0, `wired command on ${ev}`);
        c.assert.equal(r.stdout, '', `wired command stdout on ${ev}`);
      }
      c.assert.equal(opens(sink).length, 1, 'sessions opened by the wired command');
      c.assert.equal(completes(sink).length, 1, 'sessions completed by the wired command');
      const start = byType(sink, 'collector.report').find((e) => e.payload?.phase === 'session_start');
      c.assert.ok(start, 'no session_start marker');
      c.assert.equal(start.payload.harness, harness, 'harness on the marker');
      c.assert.ok(Array.isArray(start.payload.events_registered) && start.payload.events_registered.length === 8, `events_registered ${JSON.stringify(start.payload.events_registered)}`);
      // The server reads the last report it holds, so the closing one must carry it too.
      const end = byType(sink, 'collector.report').find((e) => e.payload?.phase === 'session_end');
      c.assert.equal(JSON.stringify(end?.payload?.events_registered), JSON.stringify(start.payload.events_registered), 'events_registered on the closing report');
    });

    t.case(`install ${harness}: refuses a malformed config and leaves it untouched`, async (c) => {
      const home = c.home();
      const cfgPath = join(home, ...cfgRel);
      mkdirSync(join(cfgPath, '..'), { recursive: true });
      const bad = '{ "hooks": { oops ';
      writeFileSync(cfgPath, bad);
      const r = await c.bin('aer-hooks', ['install', harness], { env: envFor(c, home), cwd: home });
      c.assert.nonZero(r, 'install over malformed JSON');
      c.assert.includes(r.stderr, 'malformed', 'error message');
      c.assert.equal(readFileSync(cfgPath, 'utf8'), bad, 'malformed config was modified');
    });
  }

  t.case('install: bare aer-hook when it resolves on a persistent PATH', async (c) => {
    const home = c.home();
    const dir = persistentBin(c, home, join(c.install.binDir, 'aer-hook'));
    const env = envFor(c, home);
    env.PATH = `${dir}:${env.PATH}`;
    const r = await c.bin('aer-hooks', ['install', 'claude-code'], { env, cwd: home });
    c.assert.exit(r, 0, 'install');
    const cmd = wiredCommands(readJson(join(home, '.claude', 'settings.json'))).PreToolUse[0].command;
    c.assert.equal(cmd, 'aer-hook --harness claude-code --lifecycle v2', 'wired command');
  });

  t.case('install: a v1 registration is upgraded to lifecycle v2 and flagged before', async (c) => {
    const home = c.home();
    const cfgPath = join(home, '.claude', 'settings.json');
    mkdirSync(join(cfgPath, '..'), { recursive: true });
    const v1 = { hooks: {} };
    for (const ev of ['PreToolUse', 'PostToolUse', 'Stop']) v1.hooks[ev] = [{ matcher: '*', hooks: [{ type: 'command', command: 'aer-hook --harness claude-code' }] }];
    writeFileSync(cfgPath, JSON.stringify(v1));
    const env = envFor(c, home);
    const st = await c.bin('aer-hooks', ['status', '--json'], { env, cwd: home });
    c.assert.exit(st, 0, 'status --json');
    const stale = JSON.parse(st.stdout).hooks.stale_registrations;
    c.assert.ok(stale.some((s) => s.reason === 'missing_lifecycle_v2' && s.harness === 'claude-code'), `stale ${JSON.stringify(stale)}`);
    const plain = await c.bin('aer-hooks', ['status'], { env, cwd: home });
    c.assert.includes(plain.stdout, 'WARN:', 'plain status warns');
    const r = await c.bin('aer-hooks', ['install', 'claude-code'], { env, cwd: home });
    c.assert.exit(r, 0, 'install');
    c.assert.includes(r.stdout, 'brought up to date', 'install output');
    const wired = wiredCommands(readJson(cfgPath));
    for (const ev of EVENTS) {
      const ours = (wired[ev] ?? []).filter((h) => /--harness/.test(h.command));
      c.assert.equal(ours.length, 1, `entries on ${ev} after upgrade`);
      c.assert.includes(ours[0].command, '--lifecycle v2', `${ev} after upgrade`);
    }
    const st2 = await c.bin('aer-hooks', ['status', '--json'], { env, cwd: home });
    c.assert.ok(!JSON.parse(st2.stdout).hooks.stale_registrations.some((s) => s.reason === 'missing_lifecycle_v2'), 'still stale after install');
  });

  t.case('install: usage errors exit non-zero', async (c) => {
    const home = c.home();
    const env = envFor(c, home);
    const a = await c.bin('aer-hooks', ['install'], { env, cwd: home });
    c.assert.equal(a.code, 2, 'install with no harness');
    const b = await c.bin('aer-hooks', ['install', 'vscode'], { env, cwd: home });
    c.assert.equal(b.code, 2, 'install with an unknown harness');
    const d = await c.bin('aer-hooks', ['frobnicate'], { env, cwd: home });
    c.assert.equal(d.code, 2, 'unknown command');
    c.assert.ok(!existsSync(join(home, '.claude', 'settings.json')), 'a usage error wrote a config');
  });

  t.case('install --dir: writes under the given base, not HOME', async (c) => {
    const home = c.home();
    const base = c.tmp('base-');
    const r = await c.bin('aer-hooks', ['install', 'codex', '--dir', base], { env: envFor(c, home), cwd: home });
    c.assert.exit(r, 0, 'install --dir');
    c.assert.ok(existsSync(join(base, '.codex', 'hooks.json')), 'config not written under --dir');
    c.assert.ok(!existsSync(join(home, '.codex')), 'install --dir also wrote under HOME');
  });

  // ── doctor: version report ────────────────────────────────────────────────

  t.case('status --json: an aer-hook that prints no version is reported unreadable', async (c) => {
    const home = c.home();
    const env = envFor(c, home);
    await c.bin('aer-hooks', ['install', 'claude-code'], { env, cwd: home });
    env.PATH = `${fakeHook(home, '')}:${env.PATH}`;
    const st = await c.bin('aer-hooks', ['status', '--json'], { env, cwd: home });
    c.assert.exit(st, 0, 'status --json');
    const f = JSON.parse(st.stdout).hooks.stale_registrations.find((s) => s.reason === 'outdated_collector');
    c.assert.ok(f, `no outdated_collector finding: ${st.stdout}`);
    c.assert.includes(f.detail, 'could not read the version of the wired aer-hooks', 'unreadable detail');
    c.assert.ok(f.fix.length > 0, 'no fix command');
  });

  t.case('status --json: an older aer-hook on PATH is reported with its version', async (c) => {
    const home = c.home();
    const env = envFor(c, home);
    env.PATH = `${fakeHook(home, '0.3.0')}:${env.PATH}`;
    const st = await c.bin('aer-hooks', ['status', '--json'], { env, cwd: home });
    const f = JSON.parse(st.stdout).hooks.stale_registrations.find((s) => s.reason === 'outdated_collector');
    c.assert.ok(f, `no outdated_collector finding: ${st.stdout}`);
    c.assert.includes(f.detail, 'the aer-hooks on PATH is 0.3.0', 'older detail (not wired)');
  });

  t.case('status --json: the current aer-hook on PATH raises no version finding', async (c) => {
    const home = c.home();
    const env = envFor(c, home);
    env.PATH = `${persistentBin(c, home, join(c.install.binDir, 'aer-hook'))}:${env.PATH}`;
    await c.bin('aer-hooks', ['install', 'claude-code'], { env, cwd: home });
    const st = await c.bin('aer-hooks', ['status', '--json'], { env, cwd: home });
    c.assert.exit(st, 0, 'status --json');
    const stale = JSON.parse(st.stdout).hooks.stale_registrations;
    c.assert.equal(stale.length, 0, `unexpected findings ${JSON.stringify(stale)}`);
  });

  // ── the hook: Claude Code ─────────────────────────────────────────────────

  t.case('aer-hook claude-code: a full v2 run is one record, completed at SessionEnd, bodies-off', async (c) => {
    const home = c.home();
    const sink = await c.sink();
    const env = hookEnv(c, home, sink.url);
    const cn = canaries('HK');
    const proj = c.tmp('proj-');
    const transcript = join(proj, 'transcript.jsonl');
    writeTranscript(transcript, cn);
    writeFileSync(join(proj, 'notes.txt'), cn.file);
    const sid = randomUUID();
    const run = claudeRun(sid, proj, transcript, cn);
    for (const p of run) {
      await fire(c, env, p);
      if (p.hook_event_name === 'Stop') c.assert.equal(completes(sink).length, 0, 'Stop completed the record under lifecycle v2');
      if (p.hook_event_name === 'SessionStart') {
        // The store holds an ingest token: owner-only.
        const dir = join(home, '.cache', 'aer-hooks');
        const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
        c.assert.ok(files.length > 0, 'no session store file');
        for (const f of files) {
          const mode = statSync(join(dir, f)).mode & 0o777;
          c.assert.ok((mode & 0o077) === 0, `${f} is mode ${mode.toString(8)}`);
        }
      }
    }
    c.assert.equal(opens(sink).length, 1, 'sessions opened');
    c.assert.equal(completes(sink).length, 1, 'sessions completed');
    const open = opens(sink)[0].json;
    c.assert.match(open.client_ref ?? '', /^v1:[0-9a-f]{48}$/, 'client_ref on open');
    c.assert.equal(open.collector?.name, 'aer-hooks', 'collector name');
    c.assert.equal(open.collector?.version, c.install.version(PKG), 'collector version on open');
    const want = createHash('sha256').update(`aer-client-ref.v1\nclaude-code\n${sid}\n${env.AER_AGENT_ID}`).digest('hex').slice(0, 48);
    c.assert.equal(open.client_ref, `v1:${want}`, 'client_ref derivation');

    const ph = phases(sink);
    for (const p of ['session_start', 'turn_start', 'turn_end', 'session_end']) c.assert.ok(ph.includes(p), `phase ${p} missing (${ph})`);
    const started = byType(sink, 'tool.started').map((e) => e.payload.tool);
    c.assert.equal(started.join(','), 'Bash,Write,WebFetch', 'tool.started');
    c.assert.equal(byType(sink, 'tool.completed').length, 3, 'tool.completed');
    const exec = byType(sink, 'process.exec')[0];
    c.assert.equal(exec?.payload?.command, 'git', 'process.exec is the executable name only');
    const fetched = byType(sink, 'network.connect').find((e) => e.payload?.tool === 'WebFetch');
    c.assert.equal(fetched?.payload?.host, 'example.com', 'a fetch is the host only');
    c.assert.equal(fetched?.payload?.method, undefined, 'a fetch claims a method the hook never saw');
    c.assert.ok(byType(sink, 'file.written').length === 1, 'file.written');
    const bashStart = byType(sink, 'tool.started')[0];
    c.assert.equal(JSON.stringify(bashStart.payload.arg_keys), JSON.stringify(['command', 'description']), 'arg_keys');

    // Every event lands on the one session and carries a contiguous seq.
    const sessionIds = new Set(sink.find('POST', /\/events$/).map((r) => r.path.split('/')[3]));
    c.assert.equal(sessionIds.size, 1, 'events spread over sessions');
    const seqs = sink.events().filter((e) => typeof e.payload?.seq === 'number').map((e) => e.payload.seq).sort((a, b) => a - b);
    c.assert.equal(seqs.join(','), seqs.map((_, i) => i + 1).join(','), 'seq is not contiguous from 1');

    // Model and tokens from the transcript, never its content.
    const llm = byType(sink, 'llm.completed');
    c.assert.equal(llm.length, 1, 'llm.completed from the transcript');
    c.assert.equal(llm[0].payload.model, 'claude-matrix-1', 'llm model');
    c.assert.equal(llm[0].payload.input_tokens, 1234, 'input tokens');

    const end = byType(sink, 'collector.report').find((e) => e.payload?.phase === 'session_end');
    c.assert.equal(end.payload.tools_unresolved, 0, 'tools_unresolved');
    c.assert.equal(end.payload.version, c.install.version(PKG), 'version on the closing marker');

    assertNoCanaries(sink.allText(), cn);
    // The store entry, which holds the ingest token, is gone after completion.
    const left = readdirSync(join(home, '.cache', 'aer-hooks')).filter((f) => f.endsWith('.json') && readFileSync(join(home, '.cache', 'aer-hooks', f), 'utf8').includes('ingest_'));
    c.assert.equal(left.length, 0, `ingest token still on disk after completion: ${left}`);
  });

  t.case('aer-hook claude-code: a lost store reopens with the same client_ref and the server reuses the session', async (c) => {
    const home = c.home();
    const sink = await c.sink();
    const env = hookEnv(c, home, sink.url);
    const sid = randomUUID();
    const proj = c.tmp('proj-');
    await fire(c, env, { session_id: sid, cwd: proj, hook_event_name: 'SessionStart', source: 'startup' });
    // A second hook process whose cache is empty (wiped, another machine
    // profile): it must reopen with the identical client_ref, not a new one.
    const env2 = { ...env, XDG_CACHE_HOME: c.tmp('cache2-') };
    await fire(c, env2, { session_id: sid, cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(proj, 'a.txt') }, tool_use_id: 't1' });
    const o = opens(sink);
    c.assert.equal(o.length, 2, 'opens');
    c.assert.equal(o[0].json.client_ref, o[1].json.client_ref, 'client_ref differs between opens');
    c.assert.equal(sink.sessions.size, 1, 'the server saw two sessions');
    const ids = new Set(sink.find('POST', /\/events$/).map((r) => r.path.split('/')[3]));
    c.assert.equal(ids.size, 1, 'events landed on different sessions');
    c.assert.ok(byType(sink, 'tool.started').length === 1, 'tool event lost');
  });

  t.case('aer-hook claude-code: without --lifecycle v2, Stop completes the record', async (c) => {
    const home = c.home();
    const sink = await c.sink();
    const env = hookEnv(c, home, sink.url);
    const sid = randomUUID();
    const proj = c.tmp('proj-');
    const v1 = ['--harness', 'claude-code'];
    await fire(c, env, { session_id: sid, cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't1' }, v1);
    await fire(c, env, { session_id: sid, cwd: proj, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: '' }, tool_use_id: 't1' }, v1);
    await fire(c, env, { session_id: sid, cwd: proj, hook_event_name: 'Stop' }, v1);
    c.assert.equal(opens(sink).length, 1, 'opens');
    c.assert.equal(completes(sink).length, 1, 'Stop did not complete the v1 record');
  });

  t.case('aer-hook claude-code: subagent events join the lead session', async (c) => {
    const home = c.home();
    const sink = await c.sink();
    const env = hookEnv(c, home, sink.url);
    const lead = randomUUID();
    const proj = c.tmp('proj-');
    await fire(c, env, { session_id: lead, cwd: proj, hook_event_name: 'SessionStart', source: 'startup' });
    // Payload already carries the lead's session id.
    await fire(c, env, { session_id: lead, cwd: proj, hook_event_name: 'SubagentStart', agent_id: 'agent-1', agent_type: 'Explore' });
    await fire(c, env, { session_id: lead, cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'x' }, tool_use_id: 's1', agent_id: 'agent-1', agent_type: 'Explore' });
    // A subagent with its own session id finds the lead through the env the
    // harness exports.
    const subEnv = { ...env, CLAUDE_CODE_SESSION_ID: lead };
    await fire(c, subEnv, { session_id: randomUUID(), cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Glob', tool_input: { pattern: '*' }, tool_use_id: 's2', agent_id: 'agent-2' });
    // --root-session overrides both.
    await fire(c, env, { session_id: randomUUID(), cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'LS', tool_input: { path: proj }, tool_use_id: 's3', agent_id: 'agent-3' }, [...V2, '--root-session', lead]);
    await fire(c, env, { session_id: lead, cwd: proj, hook_event_name: 'SubagentStop', agent_id: 'agent-1' });
    await fire(c, env, { session_id: lead, cwd: proj, hook_event_name: 'SessionEnd', reason: 'other' });
    c.assert.equal(opens(sink).length, 1, 'a subagent opened its own session');
    c.assert.equal(completes(sink).length, 1, 'completes');
    const tools = byType(sink, 'tool.started');
    c.assert.equal(tools.map((e) => e.payload.tool).join(','), 'Grep,Glob,LS', 'subagent tool events');
    c.assert.ok(tools.every((e) => typeof e.payload.harness_agent_id === 'string'), 'harness_agent_id missing on a subagent event');
    const ids = new Set(sink.find('POST', /\/events$/).map((r) => r.path.split('/')[3]));
    c.assert.equal(ids.size, 1, 'subagent events landed on another session');
  });

  t.case('aer-hook claude-code: an orphan subagent event never opens a session', async (c) => {
    const home = c.home();
    const sink = await c.sink();
    const env = hookEnv(c, home, sink.url);
    await fire(c, env, { session_id: randomUUID(), cwd: c.tmp('proj-'), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'o1', agent_id: 'agent-9' });
    c.assert.equal(sink.requests.length, 0, `orphan subagent reached the API: ${sink.requests.map((r) => r.path)}`);
  });

  // ── the hook: Codex ───────────────────────────────────────────────────────

  t.case('aer-hook codex: a full v2 run is one record, bodies-off', async (c) => {
    const home = c.home();
    const sink = await c.sink();
    const env = hookEnv(c, home, sink.url);
    const cn = canaries('CX');
    const sid = randomUUID();
    const proj = c.tmp('proj-');
    const base = { session_id: sid, transcript_path: join(proj, 'rollout.jsonl'), cwd: proj, model: 'model-matrix-c', permission_mode: 'bypassPermissions' };
    const turn = { ...base, turn_id: randomUUID() };
    const run = [
      { ...base, hook_event_name: 'SessionStart', source: 'startup' },
      { ...turn, hook_event_name: 'UserPromptSubmit', prompt: cn.prompt },
      { ...turn, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `curl -s https://example.org/${cn.path} -d ${cn.args}` }, tool_use_id: 'call_1' },
      { ...turn, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: `curl -s https://example.org/${cn.path}` }, tool_response: `${cn.result}`, tool_use_id: 'call_1' },
      { ...turn, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: cn.result },
      { ...turn, hook_event_name: 'SessionEnd', reason: 'other' },
    ];
    for (const p of run) await fire(c, env, p, CODEX_V2);
    c.assert.equal(opens(sink).length, 1, 'opens');
    c.assert.equal(completes(sink).length, 1, 'completes');
    const start = byType(sink, 'collector.report').find((e) => e.payload?.phase === 'session_start');
    c.assert.equal(start?.payload?.harness, 'codex', 'harness');
    c.assert.equal(start?.payload?.model, 'model-matrix-c', 'model');
    c.assert.equal(byType(sink, 'process.exec')[0]?.payload?.command, 'curl', 'process.exec command');
    c.assert.equal(byType(sink, 'network.connect')[0]?.payload?.host, 'example.org', 'the host curl was pointed at');
    c.assert.equal(byType(sink, 'tool.completed').length, 1, 'tool.completed');
    assertNoCanaries(sink.allText(), cn);
  });

  // ── fail-open ─────────────────────────────────────────────────────────────

  t.case('aer-hook: sink down, every event exits 0 fast with empty stdout', async (c) => {
    const home = c.home();
    const env = hookEnv(c, home, `http://127.0.0.1:${await deadPort()}`);
    const proj = c.tmp('proj-');
    const cn = canaries('DN');
    for (const p of claudeRun(randomUUID(), proj, join(proj, 't.jsonl'), cn)) {
      const r = await fire(c, env, p);
      c.assert.ok(r.ms < 8_000 + 3_000, `took ${r.ms} ms with the sink down`);
    }
  });

  t.case('aer-hook: a hanging API is cut off at AER_HOOK_TIMEOUT_MS, exit 0', async (c) => {
    const home = c.home();
    const sink = await c.sink();
    sink.fault({ path: /^\/v1\/sessions/, delayMs: 60_000, destroy: true });
    const env = hookEnv(c, home, sink.url, { AER_HOOK_TIMEOUT_MS: '1500' });
    const r = await fire(c, env, { session_id: randomUUID(), cwd: c.tmp('proj-'), hook_event_name: 'SessionStart', source: 'startup' });
    c.assert.ok(r.ms < 1500 + 2500, `took ${r.ms} ms against a 1500 ms budget`);
    // The hook gives up on the call before its budget runs out, so it can say
    // what happened to the event rather than being cut off mid-request.
    c.assert.match(r.stderr, /events are queued and will be sent with a later event|timed out after 1500ms/, 'a note on stderr');
    c.assert.excludes(r.stderr, env.AER_API_KEY, 'stderr leaked the API key');
  });

  t.case('aer-hook: 5xx on open, exit 0, and the next event still records', async (c) => {
    const home = c.home();
    const sink = await c.sink();
    sink.fault({ method: 'POST', path: /^\/v1\/sessions$/, status: 503, times: 1 });
    const env = hookEnv(c, home, sink.url);
    const sid = randomUUID();
    const proj = c.tmp('proj-');
    await fire(c, env, { session_id: sid, cwd: proj, hook_event_name: 'SessionStart', source: 'startup' });
    const r2 = await fire(c, env, { session_id: sid, cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't1' });
    c.assert.ok(byType(sink, 'tool.started').length === 1, `tool event after a failed open was lost; requests: ${sink.requests.map((r) => `${r.method} ${r.path}`).join(', ')}; the hook took ${r2.ms} ms`);
    // The SessionStart that failed to open was queued, not dropped, and the
    // next event did not wait out a marker the failed open left behind.
    c.assert.ok(phases(sink).includes('session_start'), 'the queued session_start never arrived');
    c.assert.ok(r2.ms < 3_000, `the next event took ${r2.ms} ms after a failed open`);
    const ids = new Set(sink.find('POST', /\/events$/).map((r) => r.path.split('/')[3]));
    c.assert.equal(ids.size, 1, 'events spread over sessions');
  });

  t.case('aer-hook: unconfigured, malformed or empty input touches no network', async (c) => {
    const home = c.home();
    const sink = await c.sink();
    const proj = c.tmp('proj-');
    const good = { session_id: randomUUID(), cwd: proj, hook_event_name: 'SessionStart' };
    // Unconfigured: no key.
    const bare = envFor(c, home, { AER_BASE_URL: sink.url, AER_TENANT_ID: randomUUID(), AER_AGENT_ID: randomUUID() });
    await fire(c, bare, good);
    const env = hookEnv(c, home, sink.url);
    for (const input of ['', 'not json', '[1,2,3]', '{"hook_event_name":42}', 'null']) await fire(c, env, input);
    c.assert.equal(opens(sink).length, 0, `opened a session: ${sink.requests.map((r) => r.path)}`);
    c.assert.equal(sink.events().length, 0, 'posted events');
  });

  t.case('aer-hook: store unwritable, events still record (README fallback)', async (c) => {
    // README: when the cache dir cannot be written, state moves to a private
    // per-user directory under the temp dir and the hook records as usual.
    const home = c.home();
    const sink = await c.sink();
    const blocker = join(c.tmp('blk-'), 'file');
    writeFileSync(blocker, 'not a directory');
    const tmp = c.tmp('tmpdir-');
    const env = hookEnv(c, home, sink.url, { XDG_CACHE_HOME: blocker, TMPDIR: tmp, AER_HOOK_TIMEOUT_MS: '6000' });
    const sid = randomUUID();
    const proj = c.tmp('proj-');
    await fire(c, env, { session_id: sid, cwd: proj, hook_event_name: 'SessionStart', source: 'startup' });
    await fire(c, env, { session_id: sid, cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't1' });
    await fire(c, env, { session_id: sid, cwd: proj, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: '' }, tool_use_id: 't1' });
    c.note(`requests: ${sink.requests.map((r) => `${r.method} ${r.path}`).join(', ')}`);
    c.assert.ok(phases(sink).includes('session_start'), 'session_start not recorded');
    c.assert.equal(byType(sink, 'tool.started').length, 1, 'tool.started was dropped with an unwritable store');
    c.assert.equal(byType(sink, 'tool.completed').length, 1, 'tool.completed was dropped with an unwritable store');
    c.assert.equal(opens(sink).length, 1, 'opens with an unwritable cache dir');
    const fallback = readdirSync(tmp).find((n) => n.startsWith('aer-hooks-'));
    c.assert.ok(fallback, `no private fallback dir under ${tmp}`);
    c.assert.equal(statSync(join(tmp, fallback)).mode & 0o077, 0, 'fallback dir is readable by others');
  });

  t.case('aer-hook: with nowhere to keep state, each event is still recorded on one session', async (c) => {
    const home = c.home();
    const sink = await c.sink();
    const blocker = join(c.tmp('blk-'), 'file');
    writeFileSync(blocker, 'not a directory');
    const env = hookEnv(c, home, sink.url, { XDG_CACHE_HOME: blocker, TMPDIR: blocker, XDG_RUNTIME_DIR: blocker });
    const sid = randomUUID();
    const proj = c.tmp('proj-');
    await fire(c, env, { session_id: sid, cwd: proj, hook_event_name: 'SessionStart', source: 'startup' });
    await fire(c, env, { session_id: sid, cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't1' });
    await fire(c, env, { session_id: sid, cwd: proj, hook_event_name: 'SessionEnd', reason: 'other' });
    c.assert.equal(sink.sessions.size, 1, 'sessions');
    c.assert.equal(byType(sink, 'tool.started').length, 1, 'tool.started');
    c.assert.equal(completes(sink).length, 1, 'completes');
  });

  // ── delivery under the conditions production has ─────────────────────────

  t.case('aer-hook: concurrent lead and subagent hooks under latency record everything once', async (c) => {
    const home = c.home();
    const sink = await c.sink();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    sink.route('POST', /^\/v1\/sessions$/, async () => { await wait(1500); return false; });
    sink.route('POST', /\/events$/, async () => { await wait(700); return false; });
    const env = hookEnv(c, home, sink.url, { AER_HOOK_TIMEOUT_MS: '10000' });
    const sid = randomUUID();
    const proj = c.tmp('proj-');
    const lead = { session_id: sid, cwd: proj, permission_mode: 'default' };
    const sub = (id) => ({ ...lead, agent_id: id, agent_type: 'Explore' });
    const start = fire(c, env, { ...lead, hook_event_name: 'SessionStart', source: 'startup' });
    await wait(300);
    const rest = [
      { ...lead, hook_event_name: 'UserPromptSubmit' },
      { ...lead, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'l1' },
      { ...sub('a1'), hook_event_name: 'SubagentStart' },
      { ...sub('a2'), hook_event_name: 'SubagentStart' },
      { ...sub('a1'), hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'x' }, tool_use_id: 's1' },
      { ...sub('a2'), hook_event_name: 'PreToolUse', tool_name: 'Glob', tool_input: { pattern: 'x' }, tool_use_id: 's2' },
      { ...sub('a1'), hook_event_name: 'SubagentStop' },
      { ...sub('a2'), hook_event_name: 'SubagentStop' },
      { ...lead, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {}, tool_use_id: 'l1' },
      { ...lead, hook_event_name: 'Stop' },
    ];
    await Promise.all([start, ...rest.map((p) => fire(c, env, p))]);
    await fire(c, env, { ...lead, hook_event_name: 'SessionEnd', reason: 'other' });
    c.assert.equal(opens(sink).length, 1, 'opens (each extra open mints a token toward the server cap)');
    c.assert.equal(completes(sink).length, 1, 'completes');
    c.assert.equal(byType(sink, 'tool.started').length, 3, 'tool.started');
    const ph = phases(sink);
    c.assert.equal(ph.filter((p) => p === 'subagent_start').length, 2, `subagent_start (${ph})`);
    c.assert.equal(ph.filter((p) => p === 'subagent_end').length, 2, `subagent_end (${ph})`);
    const seqs = sink.events().map((e) => e.payload?.seq).filter((n) => typeof n === 'number').sort((a, b) => a - b);
    c.assert.equal(seqs.join(','), seqs.map((_, i) => i + 1).join(','), 'seq is not unique and contiguous');
    const end = byType(sink, 'collector.report').find((e) => e.payload?.phase === 'session_end');
    c.assert.equal(end?.payload?.events_emitted, end?.payload?.seq, 'events_emitted on the closing report');
    c.assert.equal(end?.payload?.subagent_events_unattached, undefined, 'subagent events went unattached');
    c.assert.equal(end?.payload?.events_dropped_budget, undefined, 'events were dropped');
  });

  t.case('aer-hook: a subagent event with no lead is counted on the record, never opens one', async (c) => {
    const home = c.home();
    const sink = await c.sink();
    const env = hookEnv(c, home, sink.url);
    const sid = randomUUID();
    const proj = c.tmp('proj-');
    await fire(c, env, { session_id: sid, cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'x' }, tool_use_id: 'o1', agent_id: 'early-1' });
    c.assert.equal(sink.requests.length, 0, 'an orphan subagent event reached the API');
    await fire(c, env, { session_id: sid, cwd: proj, hook_event_name: 'SessionStart', source: 'startup' });
    await fire(c, env, { session_id: sid, cwd: proj, hook_event_name: 'SessionEnd', reason: 'other' });
    const reports = byType(sink, 'collector.report');
    c.assert.equal(reports.map((r) => r.payload?.subagent_events_unattached).join(','), '1,1', 'subagent_events_unattached on every report');
    c.assert.equal(opens(sink).length, 1, 'opens');
  });

  t.case('aer-hook: a session the server closed is replaced by the next event', async (c) => {
    const home = c.home();
    const sink = await c.sink();
    const env = hookEnv(c, home, sink.url);
    const sid = randomUUID();
    const proj = c.tmp('proj-');
    await fire(c, env, { session_id: sid, cwd: proj, hook_event_name: 'SessionStart', source: 'startup' });
    for (const s of sink.sessions.values()) s.status = 'completed'; // the server watchdog closed it
    await fire(c, env, { session_id: sid, cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't1' });
    const o = opens(sink);
    c.assert.equal(o.length, 2, 'opens');
    c.assert.equal(o[0].json.client_ref, o[1].json.client_ref, 'client_ref changed on reopen');
    const second = [...sink.sessions.values()].find((s) => s.status === 'running');
    c.assert.ok(second && second.events.some((e) => e.event_type === 'tool.started'), 'the tool event did not reach the new session');
  });

  // ── credentials from a file ───────────────────────────────────────────────

  t.case('aer-hooks install --env-file: the wired command records from the file alone', async (c) => {
    const home = c.home();
    const sink = await c.sink();
    const cfgDir = join(home, '.config', 'aer');
    mkdirSync(cfgDir, { recursive: true });
    const id = identity();
    const file = join(cfgDir, 'hooks.env');
    writeFileSync(file, Object.entries({ ...id, AER_BASE_URL: sink.url }).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
    chmodSync(file, 0o600);
    const loose = join(cfgDir, 'loose.env');
    writeFileSync(loose, `AER_API_KEY=${id.AER_API_KEY}\n`, { mode: 0o644 });
    chmodSync(loose, 0o644);
    const env = envFor(c, home);
    const bad = await c.bin('aer-hooks', ['install', 'claude-code', '--env-file', loose], { env, cwd: home });
    c.assert.equal(bad.code, 1, 'install accepted a world-readable credential file');
    c.assert.excludes(bad.stdout + bad.stderr, id.AER_API_KEY, 'install printed the key');
    const inst = await c.bin('aer-hooks', ['install', 'claude-code', '--env-file', file], { env, cwd: home });
    c.assert.exit(inst, 0, 'install --env-file');
    const cmd = wiredCommands(readJson(join(home, '.claude', 'settings.json'))).SessionStart.find((h) => /--harness/.test(h.command)).command;
    c.assert.includes(cmd, `--env-file '${file}'`, 'wired command');
    const sid = randomUUID();
    const proj = c.tmp('proj-');
    // No AER_* in the environment at all: everything comes from the file.
    for (const ev of ['SessionStart', 'SessionEnd']) {
      const r = await c.run('/bin/sh', ['-c', cmd], { env, input: JSON.stringify({ session_id: sid, cwd: proj, hook_event_name: ev }), timeoutMs: 20_000 });
      c.assert.exit(r, 0, `wired command on ${ev}`);
      c.assert.excludes(r.stderr, id.AER_API_KEY, 'stderr leaked the key');
    }
    c.assert.equal(opens(sink).length, 1, 'opens');
    c.assert.equal(opens(sink)[0].json.agent_id, id.AER_AGENT_ID, 'agent from the file');
    c.assert.equal(completes(sink).length, 1, 'completes');
    // status warns when a key is exported in the shell as well, without showing it.
    const st = await c.bin('aer-hooks', ['status', '--json'], { env: { ...env, AER_API_KEY: 'exported-matrix-key', AER_BASE_URL: sink.url }, cwd: home });
    const f = JSON.parse(st.stdout).hooks.stale_registrations.find((s) => s.reason === 'key_in_shell_env');
    c.assert.ok(f, `no key_in_shell_env finding: ${st.stdout}`);
    c.assert.excludes(st.stdout, 'exported-matrix-key', 'status printed the key value');
  });

  // ── the other harness payload shapes ──────────────────────────────────────

  t.case('aer-hook antigravity: recorded agy payloads are one record, opened once, bodies-off', async (c) => {
    const home = c.home();
    const sink = await c.sink();
    const env = hookEnv(c, home, sink.url);
    const cn = canaries('AG');
    const proj = c.tmp('proj-');
    const conv = randomUUID();
    const base = { artifactDirectoryPath: join(home, 'brain'), conversationId: conv, modelName: 'gemini-matrix-flash', transcriptPath: join(proj, 't.pb'), workspacePaths: [proj] };
    const agy = ['--harness', 'antigravity'];
    const steps = [
      ['PreInvocation', { ...base, initialNumSteps: 1, invocationNum: 0, userPrompt: cn.prompt }],
      ['PreToolUse', { ...base, stepIdx: 2, toolCall: { name: 'run_command', args: { CommandLine: `curl -s https://agy.example/${cn.path}` } } }],
      ['PostToolUse', { ...base, stepIdx: 2, toolCall: { name: 'run_command', args: { CommandLine: `curl -s https://agy.example/${cn.path}` } }, error: '' }],
      ['PreToolUse', { ...base, stepIdx: 3, toolCall: { name: 'write_file', args: { path: join(proj, 'x.txt'), content: cn.file } } }],
      ['PostToolUse', { ...base, stepIdx: 3, toolCall: { name: 'write_file', args: { path: join(proj, 'x.txt') } }, error: `failed: ${cn.result}` }],
      ['PostInvocation', { ...base, initialNumSteps: 1, invocationNum: 0 }],
      ['PreInvocation', { ...base, initialNumSteps: 4, invocationNum: 1, userPrompt: cn.prompt }],
      ['Stop', { ...base, error: '', executionNum: 1, fullyIdle: true, terminationReason: 'NO_TOOL_CALL' }],
    ];
    for (const [ev, payload] of steps) await fire(c, env, payload, [...agy, '--event', ev]);
    c.assert.equal(opens(sink).length, 1, 'opens');
    c.assert.equal(completes(sink).length, 1, 'completes');
    const start = byType(sink, 'collector.report').find((e) => e.payload?.phase === 'session_start');
    c.assert.equal(start?.payload?.harness, 'antigravity', 'harness');
    c.assert.equal(start?.payload?.model, 'gemini-matrix-flash', 'model');
    c.assert.equal(byType(sink, 'tool.started').map((e) => e.payload.tool).join(','), 'run_command,write_file', 'tool.started');
    c.assert.equal(byType(sink, 'file.written')[0]?.payload?.path, join(proj, 'x.txt'), 'file.written');
    const done = byType(sink, 'tool.completed');
    c.assert.equal(done.map((e) => e.payload.is_error).join(','), 'false,true', 'tool outcome');
    assertNoCanaries(sink.allText(), cn);
  });

  t.case('opencode plugin: the installed package records one session per opencode session, bodies-off', async (c) => {
    const home = c.home();
    const sink = await c.sink();
    const cn = canaries('OC');
    const id = identity();
    const r = await c.node(`
      import { aerOpencodePlugin } from '@adastracomputing/aer-hooks';
      const hooks = await aerOpencodePlugin({}, {}, ${JSON.stringify({ ...id, AER_BASE_URL: sink.url })});
      const s = 'ses_matrix_1';
      await hooks.event({ event: { type: 'session.created', properties: { info: { id: s, title: ${JSON.stringify(cn.prompt)} } } } });
      await hooks['tool.execute.before']({ tool: 'bash', sessionID: s, callID: 'c1' }, { args: { command: ${JSON.stringify(`git status # ${cn.args}`)} } });
      await hooks['tool.execute.after']({ tool: 'bash', sessionID: s, callID: 'c1', args: { command: 'x' } }, { title: 't', output: ${JSON.stringify(cn.result)}, metadata: {} });
      const msg = { id: 'msg_1', role: 'assistant', sessionID: s, modelID: 'model-matrix-oc', providerID: 'prov-matrix', tokens: { input: 321, output: 12 }, time: { created: 1 } };
      await hooks.event({ event: { type: 'message.updated', properties: { info: msg } } });
      await hooks.event({ event: { type: 'message.updated', properties: { info: { ...msg, time: { created: 1, completed: 2 } } } } });
      await hooks.event({ event: { type: 'message.part.updated', properties: { part: { text: ${JSON.stringify(cn.result)} } } } });
      await hooks.event({ event: { type: 'session.deleted', properties: { info: { id: s } } } });
      await hooks.dispose?.();
      console.log(JSON.stringify({ ok: true }));
    `, { home });
    c.assert.exit(r, 0, 'opencode plugin script');
    c.assert.equal(opens(sink).length, 1, 'opens');
    c.assert.equal(completes(sink).length, 1, 'completes');
    c.assert.equal(byType(sink, 'tool.started')[0]?.payload?.tool, 'bash', 'tool.started');
    c.assert.equal(byType(sink, 'tool.completed').length, 1, 'tool.completed');
    const llm = byType(sink, 'llm.completed');
    c.assert.equal(llm.length, 1, 'llm.completed once across streaming updates');
    c.assert.equal(llm[0]?.payload?.model, 'model-matrix-oc', 'model');
    c.assert.equal(llm[0]?.payload?.input_tokens, 321, 'input tokens');
    assertNoCanaries(sink.allText(), cn);
  });
}

