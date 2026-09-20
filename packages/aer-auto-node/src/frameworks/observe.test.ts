import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { rank } from './observe.js';

// Run as real `node` subprocesses against the BUILT collector, not mocks. A
// loader hook only behaves like a loader hook in a process that is actually
// loading modules, and the artifact under test is the one we publish.
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
const harness = join(fixtures, 'harness.mjs');

function run(app: string): { observed: string[]; stderr: string } {
  const res = spawnSync(process.execPath, [harness, `./app-${app}.mjs`], {
    cwd: fixtures,
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(`harness exited ${res.status}: ${res.stderr}`);
  const line = res.stdout.split('\n').find((l) => l.startsWith('OBSERVED:'));
  return { observed: JSON.parse(line?.slice('OBSERVED:'.length) ?? '[]'), stderr: res.stderr };
}

beforeAll(() => {
  if (!existsSync(join(here, '..', '..', 'dist', 'frameworks', 'observe.js'))) {
    throw new Error('build the package before running this suite (pretest does)');
  }
});

describe('what the observer actually sees in a real process', () => {
  it('reports nothing for an agent that imports nothing', () => {
    // The collector requires the provider SDKs at bootstrap. If its own loads
    // counted, every agent on earth would report a framework.
    expect(run('none').observed).toEqual([]);
  });

  it('sees a CJS-entry package through the require cache', () => {
    expect(run('cjs').observed).toEqual(['langchain']);
  });

  it('sees an ESM-only package, which the require cache cannot', () => {
    expect(run('esm').observed).toEqual(['mastra']);
  });

  it('puts the orchestration framework ahead of the library it pulls in', () => {
    expect(run('both').observed).toEqual(['mastra', 'langchain']);
  });

  it('writes nothing to the agent stderr', () => {
    // The hooks API is release-candidate stability. A future Node printing a
    // warning into a customer process is something we want to hear about, so
    // this is a tripwire rather than a formality.
    expect(run('both').stderr).toBe('');
  });
});

describe('it degrades to nothing, never to a broken agent', () => {
  it('still runs the agent when the recorder throws on every resolve', () => {
    const out = execFileSync(process.execPath, [join(fixtures, 'harness-throwing.mjs'), './app-both.mjs'], {
      cwd: fixtures, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    // The app ran to completion, which is the only thing that matters here.
    expect(out).toContain('APP-COMPLETED');
  });

  const withHarness = (name: string, app: string): string =>
    execFileSync(process.execPath, [join(fixtures, name), `./app-${app}.mjs`], {
      cwd: fixtures, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });

  it('falls back to the require cache when the hooks API is missing', () => {
    // Node 20 has no registerHooks. The CJS half must carry on alone, and the
    // ESM-only case must come back empty rather than wrong: [] is what proves
    // the hook really was absent instead of quietly still installed.
    expect(withHarness('harness-no-hooks.mjs', 'cjs')).toContain('OBSERVED:["langchain"]');
    expect(withHarness('harness-no-hooks.mjs', 'esm')).toContain('OBSERVED:[]');
  });

  it('survives the hooks API throwing at registration', () => {
    expect(withHarness('harness-hooks-throw.mjs', 'cjs')).toContain('OBSERVED:["langchain"]');
    expect(withHarness('harness-hooks-throw.mjs', 'esm')).toContain('OBSERVED:[]');
  });
});

describe('the whole path, into the collector report', () => {
  function reported(app: string): string[] | null {
    const res = spawnSync(process.execPath, [join(fixtures, 'harness-collector.mjs'), `./app-${app}.mjs`], {
      cwd: fixtures, encoding: 'utf8',
    });
    if (res.status !== 0) throw new Error(`harness exited ${res.status}: ${res.stderr}`);
    const line = res.stdout.split('\n').find((l) => l.startsWith('REPORT:'));
    return JSON.parse(line?.slice('REPORT:'.length) ?? 'null');
  }

  it('carries the observed frameworks, ranked', () => {
    expect(reported('both')).toEqual(['mastra', 'langchain']);
    expect(reported('cjs')).toEqual(['langchain']);
    expect(reported('esm')).toEqual(['mastra']);
  });

  it('omits the key entirely when nothing loaded', () => {
    expect(reported('none')).toBeNull();
  });
});

describe('rank', () => {
  it('prefers an orchestration framework over the library beneath it', () => {
    expect(rank(['langchain', 'langgraph'])).toEqual(['langgraph', 'langchain']);
    expect(rank(['llamaindex', 'mastra'])).toEqual(['mastra', 'llamaindex']);
  });

  it('is alphabetical within a rank, so the answer is stable', () => {
    expect(rank(['mastra', 'langgraph'])).toEqual(['langgraph', 'mastra']);
    expect(rank(['langgraph', 'mastra'])).toEqual(['langgraph', 'mastra']);
  });

  it('dedupes, because two paths to one framework is one framework', () => {
    expect(rank(['langchain', 'langchain'])).toEqual(['langchain']);
  });

  it('puts an unranked name last rather than dropping it', () => {
    expect(rank(['something-new', 'langgraph'])).toEqual(['langgraph', 'something-new']);
  });
});
