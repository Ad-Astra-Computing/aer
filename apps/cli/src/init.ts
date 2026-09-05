// `aer init` / `aer doctor` core. Pure + injectable-fs so the plan/detection is
// fully unit-tested without touching disk. Wires the AER auto-collector into a
// Node project: writes config, an env template, an integration manifest a coding
// agent can consume, and NODE_OPTIONS=--import into the run scripts.
//
// Only AER_API_KEY is a secret (env only); non-secret identity lives in
// aer.config.json (ADR-008).

import { join } from 'node:path';

export interface FsLike {
  readFile(path: string): string | null;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
}

export interface InitOptions {
  cwd: string;
  yes?: boolean;
  dryRun?: boolean;
  json?: boolean;
  runtime?: string;
  entry?: string;
  session?: 'process' | 'task' | 'server';
  tenantId?: string;
  agentId?: string;
  envId?: string;
  baseUrl?: string;
}

export interface DetectResult {
  packageManager: string;
  nodeVersion?: string;
  entrypoints: string[];
  sdks: string[];
  adapters: string[];
}

export type FileAction = 'create' | 'overwrite' | 'append' | 'skip';
export interface PlannedFile { path: string; content: string; action: FileAction }
export interface ScriptChange { script: string; before: string; after: string }

export interface IntegrationManifest {
  schema: 'aer.integration.v1';
  runtime: 'node';
  package_manager: string;
  entrypoints: string[];
  instrumentation: { register: string; session_strategy: string; adapters: string[]; transport: string[] };
  env_required: string[];
  files_changed: string[];
  verify_command: string;
}

export interface InitPlan {
  cwd: string;
  detect: DetectResult;
  files: PlannedFile[];
  scriptChanges: ScriptChange[];
  manifest: IntegrationManifest;
}

const REGISTER = '@adastracomputing/aer-auto-node/register';
const NODE_OPTS = `NODE_OPTIONS="--import ${REGISTER}"`;
const DEFAULT_BASE_URL = 'https://api.aer.run';
const KNOWN_SDKS: Record<string, string | null> = {
  openai: 'openai',
  '@anthropic-ai/sdk': 'anthropic',
  ai: 'vercel', // Vercel AI SDK
  langchain: null, // adapter is future work
};
const TRANSPORT = ['fetch', 'http', 'https', 'child_process'];
// Scripts that plausibly run the agent (we wire instrumentation into these).
const RUNNABLE = new Set(['start', 'dev', 'serve', 'main', 'agent']);

function readJson(fs: FsLike, path: string): Record<string, unknown> | null {
  const raw = fs.readFile(path);
  if (!raw) return null;
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
}

export function detect(fs: FsLike, cwd: string): DetectResult {
  const pkg = readJson(fs, join(cwd, 'package.json')) ?? {};
  const deps = {
    ...(pkg['dependencies'] as Record<string, string> | undefined ?? {}),
    ...(pkg['devDependencies'] as Record<string, string> | undefined ?? {}),
  };

  const lockfiles: Array<[string, string]> = [
    ['pnpm-lock.yaml', 'pnpm'], ['package-lock.json', 'npm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'],
  ];
  let packageManager = 'unknown';
  for (const [file, mgr] of lockfiles) {
    if (fs.exists(join(cwd, file))) { packageManager = mgr; break; }
  }

  const scripts = (pkg['scripts'] as Record<string, string> | undefined) ?? {};
  const entrypoints = Object.keys(scripts).filter((s) => RUNNABLE.has(s));

  const sdks = Object.keys(deps).filter((d) => d in KNOWN_SDKS);
  const adapters = [...new Set(sdks.map((d) => KNOWN_SDKS[d]).filter((a): a is string => !!a))];

  const engines = pkg['engines'] as { node?: string } | undefined;
  const nvmrc = fs.readFile(join(cwd, '.nvmrc'));
  const nodeVersion = engines?.node ?? (nvmrc ? nvmrc.trim() : undefined);

  return {
    packageManager,
    ...(nodeVersion ? { nodeVersion } : {}),
    entrypoints,
    sdks,
    adapters,
  };
}

export function planInit(fs: FsLike, opts: InitOptions): InitPlan {
  const cwd = opts.cwd;
  const det = detect(fs, cwd);
  const sessionStrategy = opts.session ?? 'process';
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;

  // ── files ────────────────────────────────────────────────────────────────
  const files: PlannedFile[] = [];

  const configPath = join(cwd, 'aer.config.json');
  const config = {
    schema: 'aer.config.v1',
    tenant_id: opts.tenantId ?? 'REPLACE_WITH_TENANT_ID',
    agent_id: opts.agentId ?? 'REPLACE_WITH_AGENT_ID',
    env_id: opts.envId ?? 'REPLACE_WITH_ENV_ID',
    base_url: baseUrl,
    session: { strategy: sessionStrategy },
    capture: { adapters: det.adapters },
  };
  files.push({
    path: configPath,
    content: JSON.stringify(config, null, 2) + '\n',
    action: fs.exists(configPath) ? 'skip' : 'create',
  });

  const envPath = join(cwd, '.env.example');
  const envContent = [
    '# AER - the ONLY secret. Everything else lives in aer.config.json.',
    'AER_API_KEY=',
    '',
    '# Optional CI overrides for the non-secret identity in aer.config.json:',
    '# AER_TENANT_ID=',
    '# AER_AGENT_ID=',
    '# AER_ENV_ID=',
    '# AER_BASE_URL=',
    '',
  ].join('\n');
  const existingEnv = fs.readFile(envPath);
  files.push({
    path: envPath,
    content: existingEnv && !existingEnv.includes('AER_API_KEY')
      ? existingEnv.replace(/\s*$/, '\n') + '\n' + envContent
      : envContent,
    action: !existingEnv ? 'create' : existingEnv.includes('AER_API_KEY') ? 'skip' : 'append',
  });

  // ── script wiring ──────────────────────────────────────────────────────────
  const pkg = readJson(fs, join(cwd, 'package.json')) ?? {};
  const scripts = (pkg['scripts'] as Record<string, string> | undefined) ?? {};
  // --entry names a SPECIFIC script; unlike the auto-detected entrypoints
  // (which are just a best-effort guess, silently skipped if absent), a
  // user-supplied --entry that does not exist is almost certainly a typo and
  // must fail loudly rather than silently produce a no-op "success".
  if (opts.entry !== undefined && !(opts.entry in scripts)) {
    throw new Error(
      `--entry "${opts.entry}" not found in package.json scripts (available: ${Object.keys(scripts).join(', ') || 'none'})`,
    );
  }
  const targets = opts.entry ? [opts.entry] : det.entrypoints;
  const scriptChanges: ScriptChange[] = [];
  for (const name of targets) {
    const before = scripts[name];
    if (!before || before.includes(REGISTER)) continue;
    scriptChanges.push({ script: name, before, after: `${NODE_OPTS} ${before}` });
  }

  // ── docs ───────────────────────────────────────────────────────────────────
  // Always regenerated on a real run (so it reflects current detection state),
  // but the planned label must still say "create" when the file is not yet on
  // disk: a dry-run consumer decides from this label whether the run is safe,
  // and "overwrite" implies content it does not have would be destroyed.
  const integrationMdPath = join(cwd, 'AER_INTEGRATION.md');
  const integrationMd = buildIntegrationMd(det, sessionStrategy, baseUrl, scriptChanges);
  files.push({ path: integrationMdPath, content: integrationMd, action: fs.exists(integrationMdPath) ? 'overwrite' : 'create' });

  const agentsPath = join(cwd, 'AGENTS.md');
  const existingAgents = fs.readFile(agentsPath);
  const agentsSection = buildAgentsSection();
  if (!existingAgents) {
    files.push({ path: agentsPath, content: `# Agent guide\n\n${agentsSection}`, action: 'create' });
  } else if (!existingAgents.includes('aer-auto-node')) {
    files.push({ path: agentsPath, content: existingAgents.replace(/\s*$/, '\n') + '\n' + agentsSection, action: 'append' });
  } else {
    files.push({ path: agentsPath, content: existingAgents, action: 'skip' });
  }

  // ── manifest ─────────────────────────────────────────────────────────────
  // package.json is only actually written when there is at least one script
  // to wire - listing it unconditionally previously claimed a change that
  // never happened (e.g. an unmatched --entry with no other pending edits).
  const filesChanged = [
    ...(scriptChanges.length > 0 ? ['package.json'] : []),
    ...files.filter((f) => f.action !== 'skip').map((f) => f.path.slice(cwd.length + 1)),
  ];
  const manifest: IntegrationManifest = {
    schema: 'aer.integration.v1',
    runtime: 'node',
    package_manager: det.packageManager,
    entrypoints: targets,
    instrumentation: { register: REGISTER, session_strategy: sessionStrategy, adapters: det.adapters, transport: TRANSPORT },
    env_required: ['AER_API_KEY'],
    files_changed: [...new Set(filesChanged)],
    verify_command: 'npx @adastracomputing/aer doctor',
  };
  const manifestPath = join(cwd, 'aer.integration.json');
  files.push({ path: manifestPath, content: JSON.stringify(manifest, null, 2) + '\n', action: fs.exists(manifestPath) ? 'overwrite' : 'create' });

  return { cwd, detect: det, files, scriptChanges, manifest };
}

export function applyInit(fs: FsLike, plan: InitPlan): void {
  for (const f of plan.files) {
    if (f.action === 'skip') continue;
    fs.writeFile(f.path, f.content);
  }
  if (plan.scriptChanges.length > 0) {
    const pkgPath = join(plan.cwd, 'package.json');
    const raw = fs.readFile(pkgPath);
    if (raw) {
      const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
      pkg.scripts = pkg.scripts ?? {};
      for (const c of plan.scriptChanges) pkg.scripts[c.script] = c.after;
      fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    }
  }
}

// ── doctor ───────────────────────────────────────────────────────────────────

export interface DoctorOptions { cwd: string; env: Record<string, string | undefined> }
export interface DoctorCheck { name: string; ok: boolean; detail: string }
export interface DoctorReport { ok: boolean; checks: DoctorCheck[] }

export function runDoctor(fs: FsLike, opts: DoctorOptions): DoctorReport {
  const checks: DoctorCheck[] = [];
  const pkg = readJson(fs, join(opts.cwd, 'package.json')) ?? {};
  const deps = {
    ...(pkg['dependencies'] as Record<string, string> | undefined ?? {}),
    ...(pkg['devDependencies'] as Record<string, string> | undefined ?? {}),
  };
  const scripts = (pkg['scripts'] as Record<string, string> | undefined) ?? {};

  const installed = '@adastracomputing/aer-auto-node' in deps;
  checks.push({
    name: 'package_installed',
    ok: installed,
    detail: installed ? 'found @adastracomputing/aer-auto-node' : 'add @adastracomputing/aer-auto-node (npm i -D @adastracomputing/aer-auto-node)',
  });

  const wired = Object.values(scripts).some((s) => s.includes(REGISTER)) ||
    (opts.env['NODE_OPTIONS'] ?? '').includes(REGISTER);
  checks.push({
    name: 'register_wired',
    ok: wired,
    detail: wired ? 'register loaded via --import' : `add ${NODE_OPTS} to your start script (run \`aer init\`)`,
  });

  const cfg = readJson(fs, join(opts.cwd, 'aer.config.json'));
  const cfgOk = !!cfg && typeof cfg['tenant_id'] === 'string' && !String(cfg['tenant_id']).startsWith('REPLACE_') &&
    typeof cfg['agent_id'] === 'string' && !String(cfg['agent_id']).startsWith('REPLACE_') &&
    typeof cfg['env_id'] === 'string' && !String(cfg['env_id']).startsWith('REPLACE_');
  checks.push({
    name: 'config_present',
    ok: cfgOk,
    detail: cfgOk ? 'aer.config.json has tenant/agent/env identity' : 'aer.config.json missing or has placeholder identity',
  });

  // Accept AER_TENANT_API_KEY as a fallback: the live tenant-auth check
  // (runLiveChecks in doctor-live.ts) and the CLI help text both already
  // treat the two as interchangeable - this config-only check must agree,
  // or `aer doctor` can report a false failure while auth itself succeeds.
  const keyOk = !!(opts.env['AER_API_KEY'] ?? opts.env['AER_TENANT_API_KEY']);
  checks.push({
    name: 'api_key_present',
    ok: keyOk,
    detail: keyOk ? 'API key is set' : 'export AER_API_KEY=<key> (or AER_TENANT_API_KEY)',
  });

  return { ok: checks.every((c) => c.ok), checks };
}

// ── doc builders ─────────────────────────────────────────────────────────────

function buildIntegrationMd(det: DetectResult, session: string, baseUrl: string, changes: ScriptChange[]): string {
  return [
    '# AER integration',
    '',
    'This project is instrumented with the AER auto-collector. It records what the',
    'agent actually does (network, LLM turns, tool calls, processes, dependencies)',
    'with zero manual `emit()`.',
    '',
    '## How it runs',
    '',
    `Instrumentation loads via \`--import ${REGISTER}\` (wired into ${changes.map((c) => '`' + c.script + '`').join(', ') || 'your run scripts'} as \`NODE_OPTIONS\`).`,
    '',
    '## Configure',
    '',
    `1. Set the only secret: \`export AER_API_KEY=<key>\` (see \`.env.example\`).`,
    `2. Fill identity in \`aer.config.json\` (tenant_id / agent_id / env_id). Base URL: ${baseUrl}.`,
    `3. Verify: \`npx @adastracomputing/aer doctor\`.`,
    '',
    '## Detected',
    '',
    `- package manager: ${det.packageManager}`,
    `- session strategy: ${session}`,
    `- SDK adapters: ${det.adapters.join(', ') || 'none detected'}`,
    `- transport patches: ${TRANSPORT.join(', ')}`,
    '',
    '## Note',
    '',
    'Patch-based capture observes `globalThis.fetch` and default-import property',
    'access (`import cp from \'node:child_process\'; cp.spawn(...)`). Named imports',
    'are not captured in v1.',
    '',
  ].join('\n');
}

function buildAgentsSection(): string {
  return [
    '## AER auto-instrumentation',
    '',
    'This project uses `@adastracomputing/aer-auto-node`. The collector loads via',
    '`--import @adastracomputing/aer-auto-node/register` (wired into the run scripts).',
    'Set `AER_API_KEY` (the only secret); identity is in `aer.config.json`.',
    'Verify with `npx @adastracomputing/aer doctor`. Do not add manual `emit()` calls -',
    'capture is automatic.',
    '',
  ].join('\n');
}
