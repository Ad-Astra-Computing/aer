// The site says AER instruments the OpenAI and Anthropic SDKs. The adapter
// unit tests assert against objects we wrote, so they cannot fail when a
// vendor changes shape.
//
// A real subprocess and not vitest: module resolution is the thing under test,
// and the runner's resolution is not the customer's.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cleanEnv } from './env.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
const register = join(here, '..', '..', 'aer-auto-node', 'dist', 'register.js');

const FAKE_KEY = 'not-a-real-key';

let api: Server;
let baseUrl: string;

beforeAll(async () => {
  api = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/sessions') {
        res.statusCode = 201;
        res.end(JSON.stringify({
          agent_session_id: '01950000-0000-7000-8000-00000000aaaa',
          ingest_token: 'ingest-token',
        }));
        return;
      }
      captured.push(body);
      res.end(JSON.stringify({ accepted: 1 }));
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => api.close(() => r(null)));
});

const captured: string[] = [];

interface Ev { event_type: string; payload: Record<string, unknown> }

async function runAgent(app = 'llm-app.mjs'): Promise<{ adapters: string[]; events: Ev[]; raw: string }> {
  captured.length = 0;
  const child = spawn(process.execPath, ['--import', register, join(fixtures, app)], {
    cwd: fixtures,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: cleanEnv({
      FAKE_KEY,
      AER_BASE_URL: baseUrl,
      AER_API_KEY: FAKE_KEY,
      AER_TENANT_ID: '01950000-0000-7000-8000-000000000001',
      AER_AGENT_ID: '01950000-0000-7000-8000-000000000002',
      AER_ENV_ID: '01950000-0000-7000-8000-000000000003',
    }),
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += String(d)));
  child.stderr.on('data', (d) => (stderr += String(d)));
  const code = await new Promise<number>((r) => child.on('exit', (c) => r(c ?? -1)));
  if (code !== 0) throw new Error(`agent exited ${code}: ${stderr}`);

  const line = stdout.split('\n').find((l) => l.startsWith('ADAPTERS:'));
  const raw = captured.join('\n');
  const events = captured.flatMap((b) => {
    try {
      const parsed: unknown = JSON.parse(b);
      return Array.isArray(parsed) ? (parsed as Ev[]) : [];
    } catch { return []; }
  });
  return { adapters: JSON.parse(line?.slice('ADAPTERS:'.length) ?? '[]'), events, raw };
}

describe('a real agent using the real SDKs', () => {
  it('records the OpenAI call with the model and the vendor tokens', async () => {
    const { adapters, events } = await runAgent();
    expect(adapters).toContain('openai');

    const requested = events.find(
      (e) => e.event_type === 'llm.requested' && e.payload['provider'] === 'openai',
    );
    const completed = events.find(
      (e) => e.event_type === 'llm.completed' && e.payload['provider'] === 'openai',
    );
    // Before the ESM fix these were absent while `adapters` still said openai:
    // the record claimed coverage it did not have.
    expect(requested?.payload['model']).toBe('gpt-4o-mini');
    expect(completed?.payload['input_tokens']).toBe(11);
    expect(completed?.payload['output_tokens']).toBe(3);
  });

  it('records the Anthropic call with the model and the vendor tokens', async () => {
    const { adapters, events } = await runAgent();
    expect(adapters).toContain('anthropic');

    const completed = events.find(
      (e) => e.event_type === 'llm.completed' && e.payload['provider'] === 'anthropic',
    );
    expect(completed?.payload['model']).toBe('claude-sonnet-4-5');
    expect(completed?.payload['input_tokens']).toBe(7);
    expect(completed?.payload['output_tokens']).toBe(2);
  });

  it('records one llm.completed per call, not one per patched copy', async () => {
    // Both the CJS and the ESM copy are patched. One client has one prototype
    // chain, so one call must still produce one record.
    const { events } = await runAgent();
    const completions = events.filter((e) => e.event_type === 'llm.completed');
    expect(completions.length).toBe(2);
  });

  it('records no prompt, no reply and no key', async () => {
    const { raw } = await runAgent();
    expect(raw).not.toContain('THE-PROMPT-TEXT');
    expect(raw).not.toContain('THE-REPLY-TEXT');
    expect(raw).not.toContain(FAKE_KEY);
  });
});

describe('a real agent using the real Vercel AI SDK', () => {
  it('records a generateText call with the model and the vendor tokens', async () => {
    // `ai`'s own namespace is sealed, so the facade cannot be wrapped. The
    // provider model classes underneath it are ordinary classes, and one step
    // of generateText is one real model call, which is the unit a record
    // wants anyway.
    const { adapters, events } = await runAgent('vercel-app.mjs');
    expect(adapters).toContain('vercel-provider');

    const completed = events.find((e) => e.event_type === 'llm.completed');
    expect(completed?.payload['model']).toBe('claude-sonnet-4-5');
    expect(completed?.payload['input_tokens']).toBe(5);
    expect(completed?.payload['output_tokens']).toBe(4);
  });

  it('records no prompt, no reply and no key', async () => {
    const { raw } = await runAgent('vercel-app.mjs');
    expect(raw).not.toContain('THE-PROMPT-TEXT');
    expect(raw).not.toContain('THE-REPLY-TEXT');
    expect(raw).not.toContain(FAKE_KEY);
  });
});
