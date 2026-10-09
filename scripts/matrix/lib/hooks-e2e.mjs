/**
 * Shared pieces of the suites that drive a real coding harness with the AER
 * hooks installed: the credential file, the installer run, and the questions
 * every one of them asks of the sink afterwards.
 */
import { writeFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { delay } from './proc.mjs';

export const HOOKS_PKG = '@adastracomputing/aer-hooks';

/** A fresh identity. The key is a fake: only a local sink ever sees it. */
export function identity() {
  return {
    AER_API_KEY: `aer_matrix_${randomUUID().replace(/-/g, '')}`,
    AER_TENANT_ID: randomUUID(),
    AER_AGENT_ID: randomUUID(),
    AER_ENV_ID: randomUUID(),
  };
}

/**
 * The credentials the way the hooks README recommends: an owner-only file the
 * hook reads for itself, so the harness and its agent never carry them.
 */
export function writeEnvFile(dir, values) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'hooks.env');
  writeFileSync(file, Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

/** `aer-hooks install <harness> --env-file <file>`, through the installed bin. */
export async function installHooks(c, harness, { env, envFile, dir, cwd }) {
  const args = ['install', harness, '--env-file', envFile];
  if (dir) args.push('--dir', dir);
  const r = await c.bin('aer-hooks', args, { env, cwd: cwd ?? env.HOME });
  c.assert.exit(r, 0, `aer-hooks install ${harness}`);
  return r;
}

export const opens = (sink) => sink.find('POST', '/v1/sessions');
export const completes = (sink) => sink.find('POST', /^\/v1\/sessions\/[^/]+\/complete$/);
export const byType = (sink, t) => sink.events().filter((e) => e.event_type === t);
// turn_start moved off collector.report onto its own oversight marker
// (human.input{kind:'prompt'}); every other phase still reports the old way.
export const phases = (sink) => [
  ...byType(sink, 'collector.report').map((e) => e.payload?.phase),
  ...byType(sink, 'human.input').filter((e) => e.payload?.kind === 'prompt').map(() => 'turn_start'),
];

/** Wait until `n` completions have arrived, or `ms` passes; returns the count. */
export async function completed(sink, n = 1, ms = 30_000) {
  for (const until = Date.now() + ms; completes(sink).length < n && Date.now() < until;) await delay(200);
  return completes(sink).length;
}

/** Wait until `pred(sink)` holds, or `ms` passes; returns the last value. */
export async function until(pred, ms = 30_000) {
  let v;
  for (const end = Date.now() + ms; !(v = pred()) && Date.now() < end;) await delay(200);
  return v;
}

/**
 * Make the sink answer as slowly as the real API does from a laptop: an open
 * takes a few seconds and every send a second and a half. This is what a
 * harness's SessionEnd budget has to be measured against; a loopback sink
 * that answers in a millisecond hides a hook that would be killed mid-send.
 */
export function realApiLatency(sink, { openMs = 2500, sendMs = 1500 } = {}) {
  sink.route('POST', /^\/v1\/sessions$/, async () => { await delay(openMs); return false; });
  sink.route('POST', /\/(events|complete)$/, async () => { await delay(sendMs); return false; });
}

/**
 * The one-record assertions every real-harness case makes, completion first,
 * so a run that loses its completion says exactly that.
 */
export async function assertOneCompletedRecord(c, sink, { id, harness, waitMs = 30_000 }) {
  const done = await completed(sink, 1, waitMs);
  c.assert.equal(done, 1, `records completed (${opens(sink).length} opened, phases ${phases(sink).join(',')})`);
  c.assert.equal(opens(sink).length, 1, 'sessions opened');
  const open = opens(sink)[0];
  c.assert.equal(open.headers.authorization, `Bearer ${id.AER_API_KEY}`, 'the key from the env file');
  c.assert.equal(open.json.tenant_id, id.AER_TENANT_ID, 'tenant_id');
  c.assert.equal(open.json.agent_id, id.AER_AGENT_ID, 'agent_id');
  c.assert.equal(open.json.environment_id, id.AER_ENV_ID, 'environment_id');
  c.assert.equal(open.json.collector?.name, 'aer-hooks', `collector at session open: ${JSON.stringify(open.json.collector)}`);
  c.assert.equal(open.json.collector?.version, c.install.version(HOOKS_PKG), 'collector version');
  const ev = sink.events();
  c.assert.ok(ev.length > 0, 'no events');
  c.assert.ok(ev.every((e) => e.source_type === 'harness'), `source_type: ${[...new Set(ev.map((e) => e.source_type))].join(', ')}`);
  const start = byType(sink, 'collector.report').find((e) => e.payload?.phase === 'session_start');
  c.assert.equal(start?.payload?.harness, harness, 'harness on the session_start marker');
  c.assert.ok(phases(sink).includes('session_end'), `the closing report never arrived (${phases(sink).join(',')})`);
  const sessionIds = new Set(sink.find('POST', /\/events$/).map((r) => r.path.split('/')[3]));
  c.assert.equal(sessionIds.size, 1, 'events spread over sessions');
  return { open: open.json, start };
}

/**
 * A short private directory under /tmp. Some harnesses put a unix socket
 * under their home, and a socket path is limited to about 100 bytes, which
 * the matrix's own nested temp dirs can exceed.
 */
export function shortTmp(c, prefix = 'mx-') {
  const base = existsSync('/tmp') ? '/tmp' : dirname(c.root);
  const dir = mkdtempSync(join(base, prefix));
  c.cleanup(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Kill every process whose command line names `marker` (a
 * case's unique temp path). A harness can leave a daemon behind, and a
 * daemon left running would outlive the case and keep writing.
 */
export function killByMarker(marker) {
  if (!marker || marker.length < 12 || !existsSync('/proc')) return 0;
  let n = 0;
  for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    if (Number(pid) === process.pid) continue;
    try {
      const cmd = readFileSync(join('/proc', pid, 'cmdline'), 'utf8');
      if (!cmd.includes(marker)) continue;
      process.kill(Number(pid), 'SIGKILL');
      n += 1;
    } catch { /* gone or not ours */ }
  }
  return n;
}

/**
 * Kill every process working in `dir` or below it. A program on a pty runs
 * in a session of its own, so killing the pty's process group does not reach
 * it; it would otherwise exit on the hangup a moment later, possibly after
 * the case has cleaned up, and write into what was just removed.
 */
export function killByCwd(dir) {
  if (!dir || dir.length < 12 || !existsSync('/proc')) return 0;
  let n = 0;
  for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    if (Number(pid) === process.pid) continue;
    try {
      const cwd = readlinkSync(join('/proc', pid, 'cwd'));
      if (cwd !== dir && !cwd.startsWith(`${dir}/`)) continue;
      process.kill(Number(pid), 'SIGKILL');
      n += 1;
    } catch { /* gone or not ours */ }
  }
  return n;
}
