import { randomUUID } from 'node:crypto';
import { createReadStream, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir, hostname as osHostname } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { planInit, applyInit, runDoctor, type FsLike, type InitOptions } from './init.js';
import { cmdLogin } from './auth/login.js';
import { cmdLogout } from './auth/logout.js';
import { cmdWhoami } from './auth/whoami.js';
import { cmdLink, type AgentSummary } from './auth/link.js';
import { resolveAuth, resolveBaseUrl } from './auth/resolve.js';
import { runLiveChecks } from './doctor-live.js';
import { ingestJsonlStream } from './ingest.js';
import { runClaudeCodeImport } from './import/run.js';
import { verifyAer } from './verify.js';
import { runCommitmentsVerify } from './commitments-verify.js';
import { buildSmokeScript } from './smoke-script.js';
import { formatCliError, sanitizeForTerminal } from './cli-error.js';
import {
  listWebhooks,
  createWebhook,
  testWebhook,
  rotateWebhookSecret,
  deleteWebhook,
  listDeliveries,
} from './webhooks.js';
import {
  listAgents, createAgent,
  listSessions, getSession,
  listFindings, findingsRollup, listAudit,
  listAers, getAerMeta,
  getBaseline, retrainBaseline,
} from './tenant-ops.js';

const USAGE_TEXT = [
  'Usage:',
  '  aer --version                      print the installed version',
  '  aer init [--yes] [--dry-run] [--json] [--session process|task|server]',
  '           [--entry <script>] [--tenant <id>] [--agent <id>] [--env <id>] [--base-url <url>]',
  '           (wires @adastracomputing/aer-auto-node into this project: auto-instrumentation)',
  '  aer doctor [--json]                check config + live API reachability and tenant auth',
  '  aer smoke                          run a tiny instrumented workload end to end',
  '  aer login [--base-url <url>] [--no-browser]   sign in once per machine, save credentials',
  '  aer logout [--base-url <url>]      revoke the CLI key aer login minted and forget it locally',
  '  aer whoami [--base-url <url>]      show what aer login stored (never the key itself)',
  '  aer link [--agent <id> | --create-agent <name>] [--env <id>] [--base-url <url>]',
  '           (writes aer.config.json for this project from your aer login session)',
  '  aer ingest <file.jsonl | ->        (- = stdin)',
  '  aer import claude-code <file.jsonl | ->   (post-hoc; bodies-off; source_type=import)',
  '  aer verify <aer-id>',
  '  aer commitments verify --requests <file.json> (--aer <aer-id> | --bundle <file.json>) [--key <public-key.json>]',
  '           (offline: recompute content-commitment tags from YOUR key + plaintext and diff the bundle)',
  '  aer badge <aer-id>                 (prints markdown for embedding the AER badge)',
  '  aer agents list',
  '  aer agents create <name> [--framework <type>]',
  '  aer sessions list [--agent <id>] [--limit N]',
  '  aer sessions get <session-id>',
  '  aer findings recent [--limit N] [--severity critical|high|medium|low|info]',
  '  aer findings rollup [--days N] [--agent <id>]',
  '  aer aers list [--limit N] [--table]',
  '  aer download <aer-id> [-o file.json | --out file.json | -o -]   (public; no key)',
  '  aer aers get <aer-id>',
  '  aer baseline show <agent-id>',
  '  aer baseline retrain <agent-id> --last-n N | --sessions id1,id2,...',
  '  aer audit [--limit N]',
  '  aer webhooks list',
  '  aer webhooks create <url> [description] [--events findings.created,session.completed]',
  '  aer webhooks test <webhook-id>',
  '  aer webhooks rotate <webhook-id>',
  '  aer webhooks delete <webhook-id>',
  '  aer webhooks deliveries <webhook-id> [--limit N]',
  '',
  '  Pass --help (or -h) after any command to print this text and exit, without',
  '  writing anything or making a network call.',
  '',
  'aer ingest - required env:',
  '  AER_BASE_URL          e.g. https://api.aer.run',
  '  AER_SESSION_ID        uuid of the target session',
  '  AER_INGEST_TOKEN      bearer token returned by POST /v1/sessions',
  '',
  'aer import claude-code - required env (the ids fall back to aer.config.json):',
  '  AER_TENANT_API_KEY    tenant key, write role (or AER_API_KEY)',
  '  AER_TENANT_ID         tenant uuid',
  '  AER_AGENT_ID          agent uuid the imported session belongs to',
  '  AER_ENV_ID            environment uuid',
  '  AER_BASE_URL          optional; default https://api.aer.run',
  '  AER_AGENT_VERSION     optional; default "transcript-import"',
  '',
  'aer verify - required env:',
  '  AER_BASE_URL          e.g. https://api.aer.run',
  '',
  'aer commitments verify - network:',
  '  --bundle <file.json> is fully offline once the outer signature is checked.',
  '  That check needs either --key <public-key.json> (the object GET /v1/keys/:key_id',
  '  returns) or AER_BASE_URL to fetch the key; with neither, the command refuses to',
  '  run rather than report an unverified match. --aer <aer-id> always needs',
  '  AER_BASE_URL, since it has to fetch the bundle itself.',
  '  AER_COMMITMENT_KEY    your 32-byte hex key; never transmitted or logged',
  '',
  'aer doctor - reads (all optional; checks degrade with remediation):',
  '  AER_BASE_URL          API base; falls back to aer.config.json base_url',
  '  AER_API_KEY           tenant key for the auth check (or AER_TENANT_API_KEY)',
  '  AER_AGENT_ID          validate an agent id against the tenant (optional)',
  '',
  'aer webhooks - required env:',
  '  AER_BASE_URL          e.g. https://api.aer.run',
  '  AER_TENANT_API_KEY    tenant API key (or AER_API_KEY)',
  '',
  'Optional:',
  '  AER_BATCH_SIZE        (ingest) default 500',
].join('\n');

const DEFAULT_BASE_URL = 'https://api.aer.run';

// Printed when a variable a command needs is unset, in place of the whole
// usage text, which never said which one was missing.
const ENV_HELP: Record<string, string> = {
  AER_TENANT_API_KEY: 'an API key with the write role, created at https://aer.run/settings (or AER_API_KEY)',
  AER_TENANT_ID: 'your tenant id, shown at https://aer.run/settings',
  AER_AGENT_ID: 'the agent the session belongs to, shown on its page at https://aer.run/agents',
  AER_ENV_ID: 'any lowercase UUID naming where the agent runs; aer init generates one',
};

function missingEnv(command: string, missing: string[]): never {
  console.error(`${command} needs ${missing.length === 1 ? 'this variable' : 'these variables'} set:`);
  for (const name of missing) console.error(`  ${name.padEnd(20)}${ENV_HELP[name] ?? ''}`);
  console.error('\nThe ids can also come from aer.config.json in this directory, which aer init writes.');
  console.error('Or run `aer login` once per machine and `aer link` once per project instead of setting these.');
  process.exit(64);
}

interface ProjectConfig { tenant_id?: string; agent_id?: string; env_id?: string; base_url?: string }

// The identity aer init wrote for this project. A value it left as a
// placeholder counts as unset, so the error names it rather than the server.
function projectConfig(): ProjectConfig {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(join(process.cwd(), 'aer.config.json'), 'utf8')); } catch { return {}; }
  if (!raw || typeof raw !== 'object') return {};
  const out: ProjectConfig = {};
  for (const key of ['tenant_id', 'agent_id', 'env_id', 'base_url'] as const) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === 'string' && value !== '' && !value.startsWith('REPLACE_WITH_')) out[key] = value;
  }
  return out;
}

// Claude Code keeps one transcript per session in a folder named for the
// project directory, every character outside [A-Za-z0-9] turned into '-'.
// history.jsonl beside it is prompt history, not a transcript.
function transcriptHint(cwd: string): string {
  const lines = [
    'aer import claude-code needs a transcript file.',
    'Claude Code keeps one per session under ~/.claude/projects/<project>/<session-id>.jsonl,',
    'where <project> is the project directory with each / replaced by -.',
  ];
  const slug = cwd.replace(/[^A-Za-z0-9]/g, '-');
  const dir = join(homedir(), '.claude', 'projects', slug);
  let newest: string[] = [];
  try {
    newest = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, 3)
      .map(({ f }) => `  ~/.claude/projects/${slug}/${f}`);
  } catch { /* no transcripts for this directory */ }
  if (newest.length > 0) lines.push('', 'The newest for this directory:', ...newest);
  return lines.join('\n');
}

function usage(): never {
  console.error(USAGE_TEXT);
  process.exit(64);
}

// Printed for --help/-h. Distinct from usage(): exits 0 (this was an explicit,
// successful request for help, not a usage error) and writes to stdout, since
// that is where a coding agent or script expects successful output to land.
function printHelp(): never {
  console.log(USAGE_TEXT);
  process.exit(0);
}

function readFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

const realFs: FsLike = {
  readFile: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
  writeFile: (p, c) => writeFileSync(p, c),
  exists: (p) => existsSync(p),
};

const REGISTER = '@adastracomputing/aer-auto-node/register';
const SESSION_STRATEGIES = ['process', 'task', 'server'] as const;

function cmdInit(args: string[]): void {
  const has = (f: string): boolean => args.includes(f);
  const flag = (f: string): string | undefined => readFlag(args, f);
  const env = process.env;
  const session = flag('--session');
  // A typo here (e.g. "tsak") must fail loudly, not silently fall back to the
  // default strategy: a coding agent scripting `aer init` has no other way to
  // notice the value was ignored.
  if (session !== undefined && !(SESSION_STRATEGIES as readonly string[]).includes(session)) {
    console.error(`invalid --session value "${session}" (expected one of: ${SESSION_STRATEGIES.join(', ')})\n`);
    usage();
  }
  const entry = flag('--entry');
  const tenantId = flag('--tenant') ?? env['AER_TENANT_ID'];
  const agentId = flag('--agent') ?? env['AER_AGENT_ID'];
  // Nothing issues an environment id and nothing registers it: it is a name
  // you give one place your agents run. Generate one rather than leaving a
  // placeholder the reader has no way to resolve.
  const envId = flag('--env') ?? env['AER_ENV_ID'] ?? randomUUID();
  const baseUrl = flag('--base-url') ?? env['AER_BASE_URL'];

  const opts: InitOptions = {
    cwd: process.cwd(),
    yes: has('--yes'),
    dryRun: has('--dry-run'),
    json: has('--json'),
    ...(session !== undefined ? { session: session as (typeof SESSION_STRATEGIES)[number] } : {}),
    ...(entry ? { entry } : {}),
    ...(tenantId ? { tenantId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(envId ? { envId } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };

  const plan = planInit(realFs, opts);

  if (opts.dryRun) {
    if (opts.json) {
      console.log(JSON.stringify({
        manifest: plan.manifest,
        files: plan.files.map((f) => ({ path: f.path, action: f.action })),
        scriptChanges: plan.scriptChanges,
      }, null, 2));
    } else {
      console.error('Plan (dry run, nothing written):');
      for (const f of plan.files) console.error(`  ${f.action.padEnd(9)} ${f.path}`);
      for (const c of plan.scriptChanges) console.error(`  script    ${c.script}: ${c.after}`);
    }
    return;
  }

  applyInit(realFs, plan);
  if (opts.json) {
    console.log(JSON.stringify(plan.manifest, null, 2));
  } else {
    console.error('AER wired in:');
    for (const f of plan.files) if (f.action !== 'skip') console.error(`  ${f.action.padEnd(9)} ${f.path}`);
    for (const c of plan.scriptChanges) console.error(`  script    ${c.script}`);
    console.error('\nNext: set AER_API_KEY, fill identity in aer.config.json, then `aer doctor`.');
  }
}

async function cmdDoctor(args: string[]): Promise<void> {
  const env = process.env;
  const config = runDoctor(realFs, { cwd: process.cwd(), env });
  // Package-independent live checks: API reachability + tenant auth. Run only
  // when a base URL is configured (env or aer.config.json), so a pure-config
  // check still works offline.
  const cfg = (() => {
    try { return JSON.parse(realFs.readFile(`${process.cwd()}/aer.config.json`) ?? '{}') as { base_url?: string; agent_id?: string }; }
    catch { return {}; }
  })();
  const baseUrl = env['AER_BASE_URL'] ?? cfg.base_url;
  const live = await runLiveChecks({
    baseUrl,
    apiKey: env['AER_API_KEY'] ?? env['AER_TENANT_API_KEY'],
    agentId: env['AER_AGENT_ID'] ?? cfg.agent_id,
  });

  const checks = [...config.checks, ...live.checks];
  const ok = config.ok && live.ok;
  if (args.includes('--json')) {
    console.log(JSON.stringify({ ok, checks }, null, 2));
  } else {
    for (const c of checks) console.error(`${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`);
    console.error(ok ? '\nOK' : '\nFAILED');
  }
  if (!ok) process.exit(1);
}

async function cmdSmoke(): Promise<void> {
  // Best-effort connectivity check: run a trivial instrumented workload that
  // makes one fetch + one subprocess, and report. Requires AER_API_KEY + a
  // valid aer.config.json identity (run `aer doctor` first).
  const doctor = runDoctor(realFs, { cwd: process.cwd(), env: process.env });
  if (!doctor.ok) {
    console.error('smoke: not configured, run `aer doctor` and fix the failing checks first.');
    process.exit(1);
  }
  const cfg = JSON.parse(realFs.readFile(`${process.cwd()}/aer.config.json`) ?? '{}') as { base_url?: string };
  const target = process.env['AER_BASE_URL'] ?? cfg.base_url ?? 'https://api.aer.run';
  const script = buildSmokeScript(target);
  const code: number = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', REGISTER, '-e', script], { stdio: 'inherit' });
    child.on('exit', (c) => resolve(c ?? -1));
    child.on('error', () => resolve(-1));
  });
  console.error(code === 0 ? 'smoke: instrumented workload ran (check the AER console for a new session).' : `smoke: workload exited ${code}`);
  if (code !== 0) process.exit(1);
}

// argv is the command's own arguments (no node/script path), so tests can
// drive `main` directly without touching the real process.argv.

// Resolution order for every tenant-authenticated command: flag (none of
// these take one directly today), then AER_TENANT_API_KEY/AER_API_KEY, then
// aer.config.json, then the credentials file aer login wrote. See
// auth/resolve.ts. Exits with the same usage-error shape as before aer login
// existed when nothing resolves.
function requireTenantAuth(commandLabel: string): { baseUrl: string; apiKey: string } {
  const cfg = projectConfig();
  const auth = resolveAuth({ env: process.env, cfg, defaultBaseUrl: DEFAULT_BASE_URL });
  if (!auth.apiKey) {
    console.error(`${commandLabel} needs a tenant API key: set AER_TENANT_API_KEY (or AER_API_KEY), or run \`aer login\` and \`aer link\`.`);
    process.exit(64);
  }
  if (auth.expired) {
    console.error('Stored credentials have expired; run `aer login` again.');
    process.exit(1);
  }
  return { baseUrl: auth.baseUrl, apiKey: auth.apiKey };
}

// Best-effort display detection for `aer login`'s browser auto-open: never
// required, since the flow must work headless over SSH.
function hasDisplay(): boolean {
  if (process.platform === 'darwin' || process.platform === 'win32') return true;
  return !!(process.env['DISPLAY'] || process.env['WAYLAND_DISPLAY']);
}

function openBrowserBestEffort(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => { /* opening a browser is a convenience only */ });
  child.unref();
}

async function promptAgentChoice(agents: AgentSummary[]): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('Pick an agent:');
    agents.forEach((a, i) => console.log(`  [${i}] ${a.name ?? a.agent_id} (${a.agent_id})`));
    const answer = await rl.question('> ');
    const idx = Number.parseInt(answer.trim(), 10);
    return Number.isNaN(idx) ? -1 : idx;
  } finally {
    rl.close();
  }
}

/**
 * This package's version, reported so a support conversation can start from the
 * code that actually ran. Read from package.json rather than restated here: a
 * release bumps the manifest, and a second copy would name the previous one.
 */
function ownVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    if (typeof version === 'string' && version.length > 0) return version;
  } catch {
    /* saying nothing useful beats naming the wrong version */
  }
  return 'unknown';
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  // --version before anything else, for the same reason as --help: asking a
  // binary what it is must never write a file or make a network call.
  if (argv.includes('--version') || argv.includes('-V')) {
    console.log(ownVersion());
    return;
  }

  // --help/-h anywhere in the invocation must print usage and exit before any
  // other command handling runs, so probing --help can never write a file or
  // make a network call.
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
  }

  const [command, sub, ...rest] = argv;
  const baseUrl = process.env['AER_BASE_URL'];

  if (command === 'init') {
    cmdInit([sub, ...rest].filter((x): x is string => !!x));
    return;
  }

  if (command === 'doctor') {
    await cmdDoctor([sub, ...rest].filter((x): x is string => !!x));
    return;
  }

  if (command === 'smoke') {
    await cmdSmoke();
    return;
  }

  if (command === 'login') {
    const args = [sub, ...rest].filter((x): x is string => x !== undefined);
    const baseUrlFlag = readFlag(args, '--base-url');
    const noBrowser = args.includes('--no-browser');
    const code = await cmdLogin(
      { baseUrlFlag, noBrowser },
      {
        env: process.env,
        defaultBaseUrl: DEFAULT_BASE_URL,
        clientVersion: ownVersion(),
        hostname: () => osHostname(),
        hasDisplay,
        openBrowser: openBrowserBestEffort,
        print: (l) => console.log(l),
        printErr: (l) => console.error(l),
      },
    );
    if (code !== 0) process.exit(code);
    return;
  }

  if (command === 'logout') {
    const args = [sub, ...rest].filter((x): x is string => x !== undefined);
    const baseUrlFlag = readFlag(args, '--base-url');
    const resolvedBaseUrl = resolveBaseUrl({ env: process.env, cfg: projectConfig(), baseUrlFlag, defaultBaseUrl: DEFAULT_BASE_URL });
    const code = await cmdLogout(
      { baseUrl: resolvedBaseUrl },
      { env: process.env, print: (l) => console.log(l), printErr: (l) => console.error(l) },
    );
    if (code !== 0) process.exit(code);
    return;
  }

  if (command === 'whoami') {
    const args = [sub, ...rest].filter((x): x is string => x !== undefined);
    const baseUrlFlag = readFlag(args, '--base-url');
    const resolvedBaseUrl = resolveBaseUrl({ env: process.env, cfg: projectConfig(), baseUrlFlag, defaultBaseUrl: DEFAULT_BASE_URL });
    const code = cmdWhoami(
      { baseUrl: resolvedBaseUrl },
      { env: process.env, print: (l) => console.log(l), printErr: (l) => console.error(l) },
    );
    if (code !== 0) process.exit(code);
    return;
  }

  if (command === 'link') {
    const args = [sub, ...rest].filter((x): x is string => x !== undefined);
    const agentId = readFlag(args, '--agent');
    const createAgentName = readFlag(args, '--create-agent');
    const envIdFlag = readFlag(args, '--env');
    const baseUrlFlag = readFlag(args, '--base-url');
    const code = await cmdLink(
      {
        ...(agentId ? { agentId } : {}),
        ...(createAgentName ? { createAgentName } : {}),
        ...(envIdFlag ? { envId: envIdFlag } : {}),
        ...(baseUrlFlag ? { baseUrlFlag } : {}),
      },
      {
        cwd: process.cwd(),
        env: process.env,
        defaultBaseUrl: DEFAULT_BASE_URL,
        isTTY: !!process.stdin.isTTY && !!process.stdout.isTTY,
        print: (l) => console.log(l),
        printErr: (l) => console.error(l),
        readFile: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
        writeFile: (p, c) => writeFileSync(p, c),
        randomUUID,
        promptChoice: promptAgentChoice,
      },
    );
    if (code !== 0) process.exit(code);
    return;
  }

  if (command === 'ingest') {
    const file = sub;
    if (!file) usage();
    const sessionId = process.env['AER_SESSION_ID'];
    const token = process.env['AER_INGEST_TOKEN'];
    const batchSize = process.env['AER_BATCH_SIZE'] ? Number(process.env['AER_BATCH_SIZE']) : undefined;
    if (!baseUrl || !sessionId || !token) usage();

    // '-' means read from stdin; otherwise treat as a file path
    const stream = file === '-' ? process.stdin : createReadStream(file);
    try {
      const summary = await ingestJsonlStream({
        stream,
        baseUrl,
        sessionId,
        token,
        ...(batchSize !== undefined ? { batchSize } : {}),
      });
      console.log(JSON.stringify(summary, null, 2));
      if (summary.rejected > 0 && summary.errors && summary.errors.length > 0) {
        console.error(`rejected events, first ${summary.errors.length} of ${summary.rejected}:`);
        for (const e of summary.errors) console.error(`  [${e.index}] ${sanitizeForTerminal(e.message)}`);
      }
    } catch (err) {
      console.error(formatCliError(err));
      process.exit(1);
    }
    return;
  }

  if (command === 'import') {
    // Only Claude Code transcripts today; `sub` is the format selector.
    if (sub !== 'claude-code') {
      console.error('aer import needs the format before the file: aer import claude-code <file.jsonl>');
      process.exit(64);
    }
    const file = rest[0];
    if (!file) {
      console.error(transcriptHint(process.cwd()));
      process.exit(64);
    }
    const cfg = projectConfig();
    const auth = resolveAuth({ env: process.env, cfg, defaultBaseUrl: DEFAULT_BASE_URL });
    const apiKey = auth.apiKey;
    const tenantId = auth.tenantId;
    const agentId = process.env['AER_AGENT_ID'] || cfg.agent_id;
    const environmentId = process.env['AER_ENV_ID'] || cfg.env_id;
    const agentVersion = process.env['AER_AGENT_VERSION'];
    const batchSize = process.env['AER_BATCH_SIZE'] ? Number(process.env['AER_BATCH_SIZE']) : undefined;
    const missing = Object.entries({
      AER_TENANT_API_KEY: apiKey,
      AER_TENANT_ID: tenantId,
      AER_AGENT_ID: agentId,
      AER_ENV_ID: environmentId,
    }).filter(([, value]) => !value).map(([name]) => name);
    if (!apiKey || !tenantId || !agentId || !environmentId) missingEnv('aer import claude-code', missing);
    if (auth.expired) {
      console.error('Stored credentials have expired; run `aer login` again.');
      process.exit(1);
    }
    if (file !== '-' && !existsSync(file)) {
      console.error(`cannot read ${file}: no such file`);
      process.exit(1);
    }

    const stream = file === '-' ? process.stdin : createReadStream(file);
    const summary = await runClaudeCodeImport({
      stream,
      baseUrl: auth.baseUrl,
      apiKey,
      tenantId,
      agentId,
      environmentId,
      ...(agentVersion ? { agentVersion } : {}),
      ...(batchSize !== undefined ? { batchSize } : {}),
    });
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (command === 'badge') {
    const aerId = sub;
    if (!aerId || !baseUrl) usage();
    const encodedAerId = encodeURIComponent(aerId);
    // Validate the AER exists (probe metadata endpoint or canonical bundle).
    // canonical is public, so no auth needed.
    const probe = await fetch(`${baseUrl}/v1/aers/${encodedAerId}/canonical`, { method: 'HEAD' });
    if (probe.status === 404) {
      console.error(`AER not found: ${aerId}`);
      process.exit(2);
    }
    const badgeUrl = `${baseUrl}/v1/aers/${encodedAerId}/badge.svg`;
    const consoleHost = baseUrl.replace(/^https?:\/\/aer-api\./, 'https://aer.');
    const verifyUrl = `${consoleHost}/verify?aer=${encodedAerId}`;
    console.log(`Badge URL:`);
    console.log(`  ${badgeUrl}`);
    console.log();
    console.log(`Markdown (drop into README.md):`);
    console.log(`  [![AER](${badgeUrl})](${verifyUrl})`);
    console.log();
    console.log(`HTML:`);
    console.log(`  <a href="${verifyUrl}"><img src="${badgeUrl}" alt="AER"></a>`);
    return;
  }

  if (command === 'download') {
    const aerId = sub;
    if (!aerId || !baseUrl) usage();
    const outPath = readFlag(rest, '-o') ?? readFlag(rest, '--out') ?? `${aerId}.json`;
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/aers/${encodeURIComponent(aerId)}/bundle`);
    if (!res.ok) {
      console.error(`Failed: ${res.status} ${sanitizeForTerminal(await res.text())}`);
      process.exit(1);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (outPath === '-') {
      process.stdout.write(bytes);
    } else {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(outPath, bytes);
      console.error(`Wrote ${bytes.byteLength} bytes to ${outPath}`);
    }
    return;
  }

  if (command === 'verify') {
    const aerId = sub;
    if (!aerId || !baseUrl) usage();

    try {
      const result = await verifyAer({ baseUrl, aerId });
      console.log(JSON.stringify(result, null, 2));
      if (!result.verified) process.exit(1);
    } catch (err) {
      console.error(formatCliError(err));
      process.exit(1);
    }
    return;
  }

  if (command === 'commitments' && sub === 'verify') {
    // AER_BASE_URL is NOT required here: --bundle with --key is fully offline.
    // runCommitmentsVerify itself enforces that a network source or a --key
    // file is available before it will report anything as matched.
    // The key comes from the environment and is never passed on the command line,
    // transmitted or logged. Output is tags + booleans only, never the plaintext.
    const { result, exitCode } = await runCommitmentsVerify(rest, {
      ...(baseUrl ? { baseUrl } : {}),
      commitmentKey: process.env['AER_COMMITMENT_KEY'],
    });
    console.log(JSON.stringify(result, null, 2));
    if (exitCode !== 0) process.exit(exitCode);
    return;
  }

  if (command === 'agents' || command === 'sessions' || command === 'findings' || command === 'audit' || command === 'aers' || command === 'baseline') {
    // A command without its subcommand used to fall through to the whole usage
    // text, which reads as the tool ignoring you. Name what is missing.
    if (sub === undefined || sub.startsWith('-')) {
      console.error(`aer ${command} needs a subcommand, for example: aer ${command} list\n`);
      usage();
    }
    const opts = requireTenantAuth(`aer ${command}`);

    if (command === 'agents' && sub === 'list') {
      console.log(JSON.stringify(await listAgents(opts), null, 2));
      return;
    }
    if (command === 'agents' && sub === 'create') {
      const name = rest[0];
      if (!name) usage();
      const frameworkType = readFlag(rest, '--framework');
      console.log(JSON.stringify(await createAgent({
        ...opts, name, ...(frameworkType ? { frameworkType } : {}),
      }), null, 2));
      return;
    }
    if (command === 'sessions' && sub === 'list') {
      const agentId = readFlag(rest, '--agent');
      const limitArg = readFlag(rest, '--limit');
      const limit = limitArg ? parseInt(limitArg, 10) : undefined;
      console.log(JSON.stringify(await listSessions({
        ...opts,
        ...(agentId ? { agentId } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }), null, 2));
      return;
    }
    if (command === 'sessions' && sub === 'get') {
      const sessionId = rest[0];
      if (!sessionId) usage();
      console.log(JSON.stringify(await getSession({ ...opts, sessionId }), null, 2));
      return;
    }
    if (command === 'findings' && sub === 'recent') {
      const limitArg = readFlag(rest, '--limit');
      const severity = readFlag(rest, '--severity');
      const limit = limitArg ? parseInt(limitArg, 10) : undefined;
      console.log(JSON.stringify(await listFindings({
        ...opts,
        ...(limit !== undefined ? { limit } : {}),
        ...(severity ? { severity } : {}),
      }), null, 2));
      return;
    }
    if (command === 'findings' && sub === 'rollup') {
      const daysArg = readFlag(rest, '--days');
      const agentId = readFlag(rest, '--agent');
      const days = daysArg ? parseInt(daysArg, 10) : undefined;
      console.log(JSON.stringify(await findingsRollup({
        ...opts,
        ...(days !== undefined ? { days } : {}),
        ...(agentId ? { agentId } : {}),
      }), null, 2));
      return;
    }
    if (command === 'aers' && sub === 'list') {
      const limitArg = readFlag(rest, '--limit');
      const limit = limitArg ? parseInt(limitArg, 10) : undefined;
      const wantTable = rest.includes('--table');
      const res = await listAers({
        ...opts,
        ...(limit !== undefined ? { limit } : {}),
      }) as { aers: Array<{ aer_id: string; generated_at: string; anchored?: boolean; verification_status: string }>; next_cursor: string | null };
      if (wantTable) {
        console.log(['aer_id', 'badge', 'status', 'generated_at'].join('\t'));
        for (const a of res.aers) {
          console.log([
            a.aer_id,
            a.anchored ? 'anchored' : 'signed',
            a.verification_status,
            a.generated_at,
          ].join('\t'));
        }
        if (res.next_cursor) console.log(`\n# more: --cursor ${res.next_cursor}`);
      } else {
        console.log(JSON.stringify(res, null, 2));
      }
      return;
    }
    if (command === 'aers' && sub === 'get') {
      const aerId = rest[0];
      if (!aerId) usage();
      console.log(JSON.stringify(await getAerMeta({ ...opts, aerId }), null, 2));
      return;
    }
    if (command === 'baseline' && sub === 'show') {
      const agentId = rest[0];
      if (!agentId) usage();
      console.log(JSON.stringify(await getBaseline({ ...opts, agentId }), null, 2));
      return;
    }
    if (command === 'baseline' && sub === 'retrain') {
      const agentId = rest[0];
      if (!agentId) usage();
      const lastNArg = readFlag(rest, '--last-n');
      const sessionsArg = readFlag(rest, '--sessions');
      // tenant_id is required by the retrain endpoint; pull it from the agents list
      const agentsRes = (await listAgents(opts)) as { agents: Array<{ agent_id: string; tenant_id: string }> };
      const tenantId = agentsRes.agents.find((a) => a.agent_id === agentId)?.tenant_id;
      if (!tenantId) {
        console.error(`agent not found for this tenant: ${agentId}`);
        process.exit(1);
      }
      console.log(JSON.stringify(await retrainBaseline({
        ...opts, agentId, tenantId,
        ...(lastNArg ? { lastN: parseInt(lastNArg, 10) } : {}),
        ...(sessionsArg ? { sessionIds: sessionsArg.split(',').map((s) => s.trim()) } : {}),
      }), null, 2));
      return;
    }
    if (command === 'audit') {
      // /audit takes optional --limit; sub may be '--limit' or the value
      const args = sub ? [sub, ...rest] : rest;
      const limitArg = readFlag(args, '--limit');
      const limit = limitArg ? parseInt(limitArg, 10) : undefined;
      console.log(JSON.stringify(await listAudit({
        ...opts,
        ...(limit !== undefined ? { limit } : {}),
      }), null, 2));
      return;
    }
    usage();
  }

  if (command === 'webhooks') {
    const opts = requireTenantAuth('aer webhooks');

    if (sub === 'list') {
      console.log(JSON.stringify(await listWebhooks(opts), null, 2));
      return;
    }
    if (sub === 'create') {
      const url = rest[0];
      if (!url) usage();
      // 'description' is optional and positional; --events is a flag
      const description = rest[1] && !rest[1].startsWith('--') ? rest[1] : undefined;
      const eventsFlag = readFlag(rest, '--events');
      const eventTypes = eventsFlag ? eventsFlag.split(',').map((s) => s.trim()) : undefined;
      console.log(JSON.stringify(await createWebhook({
        ...opts, url,
        ...(description ? { description } : {}),
        ...(eventTypes ? { eventTypes } : {}),
      }), null, 2));
      return;
    }
    if (sub === 'test') {
      const webhookId = rest[0];
      if (!webhookId) usage();
      console.log(JSON.stringify(await testWebhook({ ...opts, webhookId }), null, 2));
      return;
    }
    if (sub === 'rotate') {
      const webhookId = rest[0];
      if (!webhookId) usage();
      console.log(JSON.stringify(await rotateWebhookSecret({ ...opts, webhookId }), null, 2));
      return;
    }
    if (sub === 'delete') {
      const webhookId = rest[0];
      if (!webhookId) usage();
      await deleteWebhook({ ...opts, webhookId });
      console.log(`deleted ${webhookId}`);
      return;
    }
    if (sub === 'deliveries') {
      const webhookId = rest[0];
      if (!webhookId) usage();
      const limitArg = readFlag(rest, '--limit');
      const limit = limitArg ? parseInt(limitArg, 10) : undefined;
      console.log(JSON.stringify(await listDeliveries({
        ...opts, webhookId, ...(limit !== undefined ? { limit } : {}),
      }), null, 2));
      return;
    }
    usage();
  }

  usage();
}

