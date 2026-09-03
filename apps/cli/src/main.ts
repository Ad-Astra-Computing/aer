#!/usr/bin/env node
import { createReadStream, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { planInit, applyInit, runDoctor, type FsLike, type InitOptions } from './init.js';
import { runLiveChecks } from './doctor-live.js';
import { ingestJsonlStream } from './ingest.js';
import { runClaudeCodeImport } from './import/run.js';
import { verifyAer } from './verify.js';
import { runCommitmentsVerify } from './commitments-verify.js';
import { buildSmokeScript } from './smoke-script.js';
import { formatCliError } from './cli-error.js';
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

function usage(): never {
  console.error(
    [
      'Usage:',
      '  aer init [--yes] [--dry-run] [--json] [--session process|task|server]',
      '           [--entry <script>] [--tenant <id>] [--agent <id>] [--env <id>] [--base-url <url>]',
      '           — wire @adastracomputing/aer-auto-node into this project (auto-instrumentation)',
      '  aer doctor [--json]                — check config + live API reachability and tenant auth',
      '  aer smoke                          — run a tiny instrumented workload end to end',
      '  aer ingest <file.jsonl | ->        (- = stdin)',
      '  aer import claude-code <file.jsonl | ->   (post-hoc; bodies-off; source_type=import)',
      '  aer verify <aer-id>',
      '  aer commitments verify --requests <file.json> (--aer <aer-id> | --bundle <file.json>)',
      '           — offline: recompute content-commitment tags from YOUR key + plaintext and diff the bundle',
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
      '  aer baseline retrain <agent-id> --last-n N | --sessions id1,id2,…',
      '  aer audit [--limit N]',
      '  aer webhooks list',
      '  aer webhooks create <url> [description] [--events findings.created,session.completed]',
      '  aer webhooks test <webhook-id>',
      '  aer webhooks rotate <webhook-id>',
      '  aer webhooks delete <webhook-id>',
      '  aer webhooks deliveries <webhook-id> [--limit N]',
      '',
      'aer ingest — required env:',
      '  AER_BASE_URL          e.g. https://api.aer.run',
      '  AER_SESSION_ID        uuid of the target session',
      '  AER_INGEST_TOKEN      bearer token returned by POST /v1/sessions',
      '',
      'aer import claude-code — required env:',
      '  AER_BASE_URL          e.g. https://api.aer.run',
      '  AER_TENANT_API_KEY    tenant key (write role; creates the session)',
      '  AER_TENANT_ID         tenant uuid',
      '  AER_AGENT_ID          agent uuid the imported session belongs to',
      '  AER_ENV_ID            environment uuid',
      '  AER_AGENT_VERSION     optional; default "transcript-import"',
      '',
      'aer verify — required env:',
      '  AER_BASE_URL          e.g. https://api.aer.run',
      '',
      'aer commitments verify — required env:',
      '  AER_BASE_URL          e.g. https://api.aer.run (only with --aer)',
      '  AER_COMMITMENT_KEY    your 32-byte hex key; never transmitted or logged',
      '',
      'aer doctor — reads (all optional; checks degrade with remediation):',
      '  AER_BASE_URL          API base; falls back to aer.config.json base_url',
      '  AER_API_KEY           tenant key for the auth check (or AER_TENANT_API_KEY)',
      '  AER_AGENT_ID          validate an agent id against the tenant (optional)',
      '',
      'aer webhooks — required env:',
      '  AER_BASE_URL          e.g. https://api.aer.run',
      '  AER_TENANT_API_KEY    tenant API key',
      '',
      'Optional:',
      '  AER_BATCH_SIZE        (ingest) default 500',
    ].join('\n'),
  );
  process.exit(64);
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

function cmdInit(args: string[]): void {
  const has = (f: string): boolean => args.includes(f);
  const flag = (f: string): string | undefined => readFlag(args, f);
  const env = process.env;
  const session = flag('--session');
  const entry = flag('--entry');
  const tenantId = flag('--tenant') ?? env['AER_TENANT_ID'];
  const agentId = flag('--agent') ?? env['AER_AGENT_ID'];
  const envId = flag('--env') ?? env['AER_ENV_ID'];
  const baseUrl = flag('--base-url') ?? env['AER_BASE_URL'];

  const opts: InitOptions = {
    cwd: process.cwd(),
    yes: has('--yes'),
    dryRun: has('--dry-run'),
    json: has('--json'),
    ...(session === 'process' || session === 'task' || session === 'server' ? { session } : {}),
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
      console.error('Plan (dry run — nothing written):');
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
    console.error('smoke: not configured — run `aer doctor` and fix the failing checks first.');
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

async function main(): Promise<void> {
  const [, , command, sub, ...rest] = process.argv;
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
    } catch (err) {
      console.error(formatCliError(err));
      process.exit(1);
    }
    return;
  }

  if (command === 'import') {
    // Only Claude Code transcripts today; `sub` is the format selector.
    if (sub !== 'claude-code') usage();
    const file = rest[0];
    if (!file) usage();
    const apiKey = process.env['AER_TENANT_API_KEY'];
    const tenantId = process.env['AER_TENANT_ID'];
    const agentId = process.env['AER_AGENT_ID'];
    const environmentId = process.env['AER_ENV_ID'];
    const agentVersion = process.env['AER_AGENT_VERSION'];
    const batchSize = process.env['AER_BATCH_SIZE'] ? Number(process.env['AER_BATCH_SIZE']) : undefined;
    if (!baseUrl || !apiKey || !tenantId || !agentId || !environmentId) usage();

    const stream = file === '-' ? process.stdin : createReadStream(file);
    const summary = await runClaudeCodeImport({
      stream,
      baseUrl,
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
    // Validate the AER exists (probe metadata endpoint or canonical bundle).
    // canonical is public, so no auth needed.
    const probe = await fetch(`${baseUrl}/v1/aers/${aerId}/canonical`, { method: 'HEAD' });
    if (probe.status === 404) {
      console.error(`AER not found: ${aerId}`);
      process.exit(2);
    }
    const badgeUrl = `${baseUrl}/v1/aers/${aerId}/badge.svg`;
    const consoleHost = baseUrl.replace(/^https?:\/\/aer-api\./, 'https://aer.');
    const verifyUrl = `${consoleHost}/verify?aer=${aerId}`;
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
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/aers/${aerId}/bundle`);
    if (!res.ok) {
      console.error(`Failed: ${res.status} ${await res.text()}`);
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
    if (!baseUrl) usage();
    // The key comes from the environment and is never passed on the command line,
    // transmitted or logged. Output is tags + booleans only, never the plaintext.
    const { result, exitCode } = await runCommitmentsVerify(rest, {
      baseUrl,
      commitmentKey: process.env['AER_COMMITMENT_KEY'],
    });
    console.log(JSON.stringify(result, null, 2));
    if (exitCode !== 0) process.exit(exitCode);
    return;
  }

  if (command === 'agents' || command === 'sessions' || command === 'findings' || command === 'audit' || command === 'aers' || command === 'baseline') {
    const apiKey = process.env['AER_TENANT_API_KEY'];
    if (!baseUrl || !apiKey) usage();
    const opts = { baseUrl, apiKey };

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
    const apiKey = process.env['AER_TENANT_API_KEY'];
    if (!baseUrl || !apiKey) usage();
    const opts = { baseUrl, apiKey };

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

main().catch((err) => {
  console.error(formatCliError(err));
  process.exit(1);
});
