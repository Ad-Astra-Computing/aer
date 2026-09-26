/**
 * The Python SDK, installed with pip into a fresh virtualenv the way a
 * customer installs it: from a local copy of packages/sdk-py in local mode,
 * from the released git tag in registry mode (it is never published to PyPI).
 *
 * Python comes from nixpkgs through the github flake ref, so the run does not
 * depend on whatever python3 the host happens to have.
 */
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canaries, assertNoCanaries } from '../lib/harness.mjs';
import { run } from '../lib/proc.mjs';
import { deadPort } from '../lib/sink.mjs';

const PYTHON_REF = 'github:NixOS/nixpkgs/nixos-unstable#python312';
const GIT_URL = 'https://github.com/Ad-Astra-Computing/aer';
const SLOW = { timeoutMs: 600_000 };

/**
 * Nix itself runs with the invoking user's environment so its flake and
 * fetcher caches are reused; only the Python under test gets a temporary
 * HOME. AER_* variables never reach it either way.
 */
function nixEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AER_') && k !== 'NODE_OPTIONS'));
}

async function hasNix() {
  const r = await run('nix', ['--version'], { env: nixEnv(), timeoutMs: 20_000 });
  return r.code === 0;
}

/** The newest sdk-py-v* tag on the public repo, or null. */
let tagCache;
async function latestTag() {
  if (tagCache !== undefined) return tagCache;
  const r = await run('git', ['ls-remote', '--tags', `${GIT_URL}.git`, 'sdk-py-v*'], { timeoutMs: 60_000 });
  if (r.code !== 0) { tagCache = null; return null; }
  const tags = [...new Set(r.stdout.split('\n').map((l) => l.split('\t')[1]).filter(Boolean)
    .map((ref) => ref.replace('refs/tags/', '').replace('^{}', '')))];
  const ver = (t) => t.replace('sdk-py-v', '').split('.').map(Number);
  tags.sort((a, b) => {
    const x = ver(a); const y = ver(b);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  });
  tagCache = tags.pop() ?? null;
  return tagCache;
}

/**
 * Create a venv and pip-install the SDK. Returns { python, env, expected } or
 * { skip } when the environment cannot provide what the case needs.
 */
async function venv(c, env) {
  if (!(await hasNix())) return { skip: 'nix is not on PATH, so no pinned Python is available' };
  const dir = c.tmp('py-');
  const home = c.home();
  const penv = c.env(home, {
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PIP_CONFIG_FILE: '/dev/null',
    PIP_NO_INPUT: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  });
  const mk = await run('nix', ['shell', PYTHON_REF, '-c', 'python3', '-m', 'venv', join(dir, 'venv')], { env: nixEnv(), timeoutMs: 600_000 });
  c.assert.exit(mk, 0, 'python -m venv');
  const python = join(dir, 'venv', 'bin', 'python');

  let target;
  let expected;
  if (env.opts.source === 'local') {
    // Copy first: pip builds in place, and build output must not land in the repo.
    const src = join(dir, 'sdk-py');
    cpSync(join(env.repoRoot, 'packages', 'sdk-py'), src, { recursive: true, filter: (p) => !/(__pycache__|\.pytest_cache|\/dist$|\/build$)/.test(p) });
    target = src;
    expected = readFileSync(join(src, 'src', 'aer_sdk', '_version.py'), 'utf8').match(/__version__\s*=\s*"([^"]+)"/)[1];
  } else {
    const tag = await latestTag();
    if (!tag) return { skip: `could not list sdk-py-v* tags on ${GIT_URL}; the SDK is not on PyPI, so there is nothing else to install from` };
    target = `git+${GIT_URL}.git@${tag}#subdirectory=packages/sdk-py`;
    expected = tag.replace('sdk-py-v', '');
    c.note(`installed from ${tag}`);
  }
  const pip = await run(python, ['-m', 'pip', 'install', '--quiet', target], { env: penv, timeoutMs: 600_000 });
  c.assert.exit(pip, 0, `pip install ${target}`);
  const pyv = await run(python, ['--version'], { env: penv });
  c.note(`${pyv.stdout.trim()}; aer-sdk ${expected}`);
  return { python, env: penv, expected, dir };
}

/** Run a Python script; the last stdout line is parsed as JSON. */
async function py(c, v, source, extraEnv = {}, timeoutMs = 120_000) {
  const file = join(v.dir, `case-${Math.random().toString(36).slice(2)}.py`);
  writeFileSync(file, source);
  const r = await run(v.python, [file], { env: { ...v.env, ...extraEnv }, timeoutMs });
  const last = r.stdout.trim().split('\n').pop();
  try { r.json = JSON.parse(last); } catch { r.json = undefined; }
  return r;
}

const PRELUDE = `
import json, os, sys, threading, time
from aer_sdk import AerClient, AerIngestError, create_session
BASE = os.environ["SINK"]
def open_session():
    return create_session(base_url=BASE, tenant_api_key="aer_test_key", tenant_id="00000000-0000-4000-8000-000000000001",
        agent_id="00000000-0000-4000-8000-000000000002", agent_version="1.0.0",
        environment_id="00000000-0000-4000-8000-000000000003", request_timeout_s=5)
`;

// Events the sink ACCEPTED. sink.events() also counts bodies of requests a
// fault rejected, which a retry then re-sends.
const sinkEvents = (sink) => [...sink.sessions.values()].flatMap((s) => s.events);

export default function register(registry, env) {
  const t = registry.suite('sdk-py', 'aer-sdk (python)');
  if (env.opts.skipPython) {
    t.skip('python SDK', 'skipped by --skip-python');
    return;
  }

  t.case('pip install: stdlib-only, version metadata matches the source of truth', async (c) => {
    const v = await venv(c, env);
    if (v.skip) return v;
    const r = await py(c, v, `
import importlib.metadata as m, aer_sdk, json
d = m.distribution("aer-sdk")
print(json.dumps({"meta": d.version, "mod": aer_sdk.__version__, "requires": d.requires or []}))
`);
    c.assert.exit(r, 0, 'metadata script');
    c.assert.equal(r.json.meta, v.expected, 'installed distribution version');
    c.assert.equal(r.json.mod, v.expected, 'aer_sdk.__version__');
    c.assert.equal(r.json.requires.length, 0, `Requires-Dist must be empty (stdlib only), got ${JSON.stringify(r.json.requires)}`);
  }, SLOW);

  t.case('session: open, emit, complete; User-Agent carries the version', async (c) => {
    const v = await venv(c, env);
    if (v.skip) return v;
    const sink = await c.sink();
    const r = await py(c, v, `${PRELUDE}
s = open_session()
with AerClient(base_url=BASE, session_id=s["agent_session_id"], ingest_token=s["ingest_token"]) as cl:
    cl.emit("tool.started", {"tool": "web_search"})
    cl.emit("tool.completed", {"tool": "web_search", "ok": True})
res = cl.complete()
print(json.dumps({"aer_id": res.get("aer_id"), "stats": cl.stats()}))
`, { SINK: sink.url });
    c.assert.exit(r, 0, 'session script');
    c.assert.ok(r.json?.aer_id, 'complete() returned no aer_id');
    c.assert.equal(sink.find('POST', '/v1/sessions').length, 1, 'session opens');
    c.assert.equal(sinkEvents(sink).length, 2, 'events at the sink');
    c.assert.equal(sink.find('POST', /\/complete$/).length, 1, '/complete calls');
    const ua = sink.requests.map((q) => q.headers['user-agent']);
    c.assert.ok(ua.every((u) => u === `aer-sdk-py/${v.expected}`), `User-Agent must be aer-sdk-py/${v.expected}, saw ${[...new Set(ua)].join(', ')}`);
    const ev = sinkEvents(sink)[0];
    c.assert.equal(ev.source_type, 'sdk', 'source_type');
  }, SLOW);

  t.case('burst: 2000 events arrive exactly once, then /complete', async (c) => {
    const v = await venv(c, env);
    if (v.skip) return v;
    const sink = await c.sink();
    const r = await py(c, v, `${PRELUDE}
s = open_session()
cl = AerClient(base_url=BASE, session_id=s["agent_session_id"], ingest_token=s["ingest_token"], flush_interval_ms=5)
for i in range(2000):
    cl.emit("tool.started", {"tool": "t%d" % i})
res = cl.complete()
print(json.dumps({"stats": cl.stats(), "aer_id": res.get("aer_id")}))
`, { SINK: sink.url }, 180_000);
    c.assert.exit(r, 0, 'burst script');
    const evs = sinkEvents(sink);
    c.assert.equal(evs.length, 2000, 'events at the sink');
    c.assert.equal(new Set(evs.map((e) => e.event_id)).size, 2000, 'unique event ids');
    c.assert.equal(new Set(evs.map((e) => e.payload.tool)).size, 2000, 'distinct payloads');
    c.assert.equal(r.json.stats.accepted, 2000, 'stats().accepted');
    c.assert.equal(sink.find('POST', /\/complete$/).length, 1, '/complete calls');
  }, SLOW);

  t.case('close/flush race: threaded emits against the background flusher lose nothing', async (c) => {
    const v = await venv(c, env);
    if (v.skip) return v;
    const sink = await c.sink();
    const r = await py(c, v, `${PRELUDE}
s = open_session()
cl = AerClient(base_url=BASE, session_id=s["agent_session_id"], ingest_token=s["ingest_token"], flush_interval_ms=1, batch_size=7)
def worker(n):
    for i in range(250):
        cl.emit("tool.started", {"tool": "w%d-%d" % (n, i)})
ts = [threading.Thread(target=worker, args=(n,)) for n in range(4)]
[t.start() for t in ts]
[t.join() for t in ts]
cl.close()
closed_err = None
try:
    cl.emit("tool.started", {"tool": "late"})
except RuntimeError as e:
    closed_err = str(e)
res = cl.complete()
print(json.dumps({"closed_err": closed_err, "aer_id": res.get("aer_id")}))
`, { SINK: sink.url }, 180_000);
    c.assert.exit(r, 0, 'race script');
    const evs = sinkEvents(sink);
    c.assert.equal(evs.length, 1000, 'events at the sink');
    c.assert.equal(new Set(evs.map((e) => e.payload.tool)).size, 1000, 'each event exactly once');
    c.assert.ok(r.json.closed_err, 'emit after close() must raise');
    c.assert.equal(sink.find('POST', /\/complete$/).length, 1, '/complete calls');
  }, SLOW);

  t.case('bodies-off: the crash path aborts and sends no exception text or buffered payloads', async (c) => {
    const v = await venv(c, env);
    if (v.skip) return v;
    const sink = await c.sink();
    const k = canaries('PY');
    const r = await py(c, v, `${PRELUDE}
s = open_session()
try:
    with AerClient(base_url=BASE, session_id=s["agent_session_id"], ingest_token=s["ingest_token"], flush_interval_ms=0) as cl:
        cl.emit("tool.started", {"tool": "shell"})
        raise ValueError(os.environ["CANARY_EXC"])
except ValueError:
    pass
print(json.dumps({"ok": True}))
`, { SINK: sink.url, CANARY_EXC: `${k.result} ${k.secret}`, AER_EXTRA_CONTEXT: k.prompt });
    c.assert.exit(r, 0, 'crash script');
    c.assert.equal(sink.find('POST', /\/abort$/).length, 1, '/abort calls on the crash path');
    c.assert.equal(sink.find('POST', /\/complete$/).length, 0, 'no /complete on the crash path');
    c.assert.equal(sinkEvents(sink).length, 0, 'the buffered events of a failed block are dropped, not sent');
    assertNoCanaries(sink.allText(), k);
    // The SDK must add nothing to the envelope beyond what the caller gave.
    const sink2 = await c.sink();
    const r2 = await py(c, v, `${PRELUDE}
s = open_session()
cl = AerClient(base_url=BASE, session_id=s["agent_session_id"], ingest_token=s["ingest_token"], flush_interval_ms=0)
cl.emit("llm.completed", {"model": "m", "input_tokens": 1, "output_tokens": 2, "ok": True})
cl.complete()
print("{}")
`, { SINK: sink2.url, AER_EXTRA_CONTEXT: k.prompt });
    c.assert.exit(r2, 0, 'envelope script');
    const [ev] = sinkEvents(sink2);
    c.assert.equal(Object.keys(ev).sort().join(','), 'agent_session_id,event_id,event_type,payload,severity_hint,source_type,timestamp_observed', 'event envelope keys');
    c.assert.equal(JSON.stringify(ev.payload), JSON.stringify({ model: 'm', input_tokens: 1, output_tokens: 2, ok: true }), 'payload passed through unchanged');
    assertNoCanaries(sink2.allText(), k);
  }, SLOW);

  t.case('sink down: create_session and complete() raise instead of passing silently', async (c) => {
    const v = await venv(c, env);
    if (v.skip) return v;
    const port = await deadPort();
    const r = await py(c, v, `${PRELUDE}
out = {}
try:
    open_session(); out["create"] = "returned"
except Exception as e:
    out["create"] = type(e).__name__
cl = AerClient(base_url=BASE, session_id="00000000-0000-4000-8000-00000000000a", ingest_token="t", flush_interval_ms=0, max_retries=1, retry_base_ms=1, request_timeout_s=3)
cl.emit("tool.started", {"tool": "x"})
t0 = time.time()
try:
    cl.complete(); out["complete"] = "returned"
except Exception as e:
    out["complete"] = type(e).__name__
out["secs"] = round(time.time() - t0, 2)
print(json.dumps(out))
`, { SINK: `http://127.0.0.1:${port}` }, 60_000);
    c.assert.exit(r, 0, 'sink-down script');
    c.note(`observed: create_session -> ${r.json.create}, complete -> ${r.json.complete} after ${r.json.secs} s`);
    c.assert.ok(r.json.create !== 'returned', 'create_session returned with the sink down');
    c.assert.ok(r.json.complete !== 'returned', 'complete() returned with the sink down: events silently dropped');
    c.assert.ok(r.json.secs < 30, 'complete() took too long to fail');
  }, SLOW);

  t.case('5xx retries then recovers with zero loss; 413 fails fast with a typed error', async (c) => {
    const v = await venv(c, env);
    if (v.skip) return v;
    const sink = await c.sink();
    sink.fault({ method: 'POST', path: /\/events$/, status: 503, times: 5 });
    const r = await py(c, v, `${PRELUDE}
s = open_session()
cl = AerClient(base_url=BASE, session_id=s["agent_session_id"], ingest_token=s["ingest_token"], flush_interval_ms=0, batch_size=100, max_retries=2, retry_base_ms=1)
for i in range(25):
    cl.emit("tool.started", {"tool": "t%d" % i})
# emit() flushes inline once a batch fills, so with a full batch the same
# AerIngestError would surface from emit() itself; this case keeps the batch
# open to observe the explicit flush.
first = None
try:
    cl.flush(); first = "ok"
except AerIngestError as e:
    first = "AerIngestError %s" % e.status
res = cl.complete()
print(json.dumps({"first": first, "aer_id": res.get("aer_id")}))
`, { SINK: sink.url }, 60_000);
    c.assert.exit(r, 0, '5xx script');
    c.note(`first flush under 503: ${r.json.first}`);
    const evs = sinkEvents(sink);
    c.assert.equal(evs.length, 25, 'events accepted after recovery (requeued, none lost)');
    c.assert.equal(new Set(evs.map((e) => e.payload.tool)).size, 25, 'no duplicates');
    c.assert.equal(sink.find('POST', /\/complete$/).length, 1, '/complete calls');

    const sink2 = await c.sink();
    sink2.fault({ method: 'POST', path: /\/events$/, status: 413, body: { error: 'batch_too_large' } });
    const r2 = await py(c, v, `${PRELUDE}
s = open_session()
cl = AerClient(base_url=BASE, session_id=s["agent_session_id"], ingest_token=s["ingest_token"], flush_interval_ms=0)
cl.emit("tool.started", {"tool": "x"})
out = {}
try:
    cl.complete(); out["complete"] = "returned"
except AerIngestError as e:
    out["complete"] = "AerIngestError %s" % e.status
print(json.dumps(out))
`, { SINK: sink2.url }, 60_000);
    c.assert.exit(r2, 0, '413 script');
    c.assert.equal(r2.json.complete, 'AerIngestError 413', '413 surfaces as AerIngestError(413)');
    c.assert.equal(sink2.find('POST', /\/events$/).length, 1, 'a 4xx is not retried');
  }, SLOW);

  t.case('refuses a plain-http base url for a remote host', async (c) => {
    const v = await venv(c, env);
    if (v.skip) return v;
    const r = await py(c, v, `
import json
from aer_sdk import AerClient
try:
    AerClient(base_url="http://example.invalid", session_id="s", ingest_token="t", flush_interval_ms=0)
    print(json.dumps({"err": None}))
except ValueError as e:
    print(json.dumps({"err": str(e)}))
`);
    c.assert.exit(r, 0, 'http script');
    c.assert.ok(r.json.err, 'http:// to a remote host was accepted');
  }, SLOW);
}
